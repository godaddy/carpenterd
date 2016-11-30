'use strict';

const cleancss = require('./minifiers/cleancss');
const minimize = require('./minifiers/minimize');
const uglifyjs = require('./minifiers/uglifyjs');
const fingerprinter = require('fingerprinting');
const rmrf = require('./rmrf');
const mkdirp = require('mkdirp');
const async = require('async');
const tar = require('tar-fs');
const errs = require('errs');
const zlib = require('zlib');
const path = require('path');
const toml = require('toml');
const fs = require('fs');
const os = require('os');

//
// Map of extensions.
//
const extensions = {
  '.html': '.html',
  '.less': '.css',
  '.styl': '.css',
  '.map': '.map',
  '.css': '.css',
  '.jsx': '.js',
  '.js': '.js'
};

/**
 * Setup a factory instance that performs the build with the provide runner.
 *
 * @Constructor
 * @param {Object} data Specifications for the build.
 * @param {Function} run Custom build runner.
 * @api public
 */
function Factory(data, run) {
  if (typeof data !== 'object' || typeof run !== 'function' || !data.name) {
    this.scrap(new Error('Factory received invalid options'));
  }

  //
  // Store build metadata.
  //
  this.base = path.join(data.source, data.id);
  this.dest = data.destDir || path.join(os.tmpdir(), `${data.id}-publish`);

  //
  // Default the config to empty
  //
  this.config = { files: {} };
  this.output = {};
  this.data = data;
  this.run = run;

  //
  // Ensure temporary files are cleaned when required to do so.
  //
  process.once('message', msg => {
    if (msg.clear !== true) return;

    this.clean(function (error) {
      if (error) return error;
      return void process.send({ event: 'clear' });
    });
  });

  //
  // Catch UncaughtExceptions if the child was spawned from the constructor
  // as factory. Some test instantiate this constructor directly.
  //
  if (process.env.CATCH_EXCEPTIONS) {
    process.once('uncaughtException', this.scrap.bind(this));
  }
}

/**
 * Unpack the provided tarball.
 *
 * @param {Function} next Completion callback.
 * @api public
 */
Factory.prototype.unpack = function unpack(next) {
  const outputPath = path.join(this.data.target, this.data.id);

  //
  // We receive the path to the tarball of the content of package being built
  // from the master process and unpack -> build it as part of our role as the worker
  // process.
  //
  fs.createReadStream(this.data.content)
    .once('error', next)
    .pipe(zlib.Unzip())
    .once('error', next)
    .pipe(tar.extract(outputPath))
    .once('error', next)
    .once('finish', next);

};

/**
 * Setup factory, read the package.json (safely) and extract the
 * `main` property if required.
 *
 * @param {Function} next Completion callback.
 * @api public
 */
Factory.prototype.init = function init(next) {
  const entry = this.data.entry;
  const base = this.base;
  const factory = this;
  //
  // Read the package.json AND the wrhs.cfg
  //
  async.parallel([
    function packJson(fn) {
      fs.readFile(path.join(base, 'package.json'), 'utf-8', function read(error, content) {
        if (error) return void fn(error);

        try {
          factory.pkg = JSON.parse(content);
          factory.entry = path.join(base, entry || factory.pkg.main);
        } catch (err) {
          return fn(err);
        }

        return fn();
      });
    },
    function whrsCfg(fn) {
      fs.readFile(path.join(base, 'wrhs.toml'), 'utf-8', function readme(error, content) {
        if (error && error.code === 'ENOENT') return void fn();
        if (error) return fn(error);

        try {
          factory.config = toml.parse(content);
        } catch (err) {

          return fn(err);
        }

        return fn();
      });
    }
  ], function (err) {
    if (err) return void factory.scrap(err);

    return void next();
  });
};

/**
 * Check if the provided entry file exists.
 *
 * @param {Function} next Completion callback.
 * @api public
 */
Factory.prototype.exists = function exists(next) {
  fs.stat(this.entry, next);
};

/**
 * Read the entry file. By default this is the `main` property
 * in the package.json.
 *
 * @param {Function} next Completion callback.
 * @api public
 */
Factory.prototype.read = function read(next) {
  const factory = this;

  fs.readFile(factory.entry, 'utf-8', function (error, content) {
    if (error) return void next(error);

    factory.source = content;
    return void next();
  });
};

/**
 * Minify the content, use the extension for content detection.
 *
 * @param {Function} next Completion callback.
 * @returns {void}
 * @api public
 */
Factory.prototype.minify = function minify(next) {
  const files = this.output;
  const factory = this;

  //
  // Build not targetted at production or minify was explicitly denied.
  //
  if (factory.data.env !== 'prod' || factory.data.minify === false) {
    return void next();
  }

  return void async.each(Object.keys(files), function each(file, cb) {
    const ext = path.extname(file);
    const options = {
      content: files[file],
      minify: factory.config.minify,
      map: files[`${ file }.map`],
      file
    };

    /**
     * Store the minified CSS/JS/HTML content.
     *
     * @param {Error} error Error returned from minifier
     * @param {String|Buffer} content Minified content.
     * @param {Object} supplementary Optional generated files, e.g. sourcemaps.
     * @returns {void}
     * @api private
     */
    function minified(error, content, supplementary) {
      if (error) return void cb(error);

      factory.stock(file, content);

      //
      // Add additional generated files to the factory output.
      //
      if (typeof supplementary === 'object') {
        Object.keys(supplementary).forEach(file => {
          factory.stock(file, supplementary[file])
        });
      }

      return void cb();
    }

    //
    // Only minify known extensions, if unknown skip it.
    //
    switch (ext) {
      case '.js': uglifyjs(options, minified); break;
      case '.jsx': uglifyjs(options, minified); break;
      case '.css': cleancss(options, minified); break;
      case '.less': cleancss(options, minified); break;
      case '.styl': cleancss(options, minified); break;
      case '.html': minimize(options, minified); break;
      default: minified(null, factory.output[file]);
    }
  }, next);
};

/**
 * Run the provided build script.
 *
 * @param {Function} next Completion callback.
 * @api public
 */
Factory.prototype.assemble = function assemble(next) {
  const factory = this;

  /**
   * After running store the amount of output files read and convert
   * each file to a Buffer.
   *
   * @param {Error} error
   * @param {String|Array} content Content of each outputted file.
   * @api private
   */
  factory.run(function ran(error, content) {
    if (error) return void next(error);

    for (const file of Object.keys(content)) {
      factory.stock(file, content[file]);
    }

    return void next();
  });
};

/**
 * Compress the content of each output file.
 *
 * @param {Function} next Completion callback.
 * @api public
 */
Factory.prototype.pack = function pack(next) {
  const factory = this;

  factory.compressed = {};
  async.each(Object.keys(factory.output), function compress(file, cb) {
    const src = factory.output[file];

    zlib.gzip(src.content || src, function done(error, compressed) {
      if (error) return void cb(error);

      factory.compressed[file] = compressed;
      return void cb();
    });
  }, next);
};

/**
 * Clean the temporary directory from disk.
 *
 * @param {Function} next Completion callback.
 * @returns {void}
 * @api public
 */
Factory.prototype.clean = function clean(next) {
  if (!this.data || this.data.clean === false) {
    return void next();
  }

  return rmrf(path.join(this.data.source, this.data.id), next);
};

/**
 * Run the assembly line with scope series and expose results to the main thread.
 *
 * @param {Array} stack Factory functions to run in order.
 * @api public
 */
Factory.prototype.line = function line(stack) {
  const factory = this;

  const steps = stack.length;

  async.eachSeries(stack, function execute(fn, next) {
    fn.call(factory, function task(error) {
      if (error) return void next(error);
      process.send({
        event: 'length',
        length: Math.floor(100 / steps)
      });

      process.send({
        event: 'task',
        message: fn.name,
        progress: true
      });

      return void next();
    });
  }, function processed(error) {
    if (error) return void factory.scrap(error);

    return void factory.files((err, files) => {
      if (err) return void factory.scrap(err);

      return void process.send({
        event: 'store',
        files: files
      }, function done(err) {
        if (err) return void factory.scrap(err);

        return void process.exit(0); // eslint-disable-line
      });
    });
  });
};

/**
 * Write files to disk for uploading to CDN properly
 * XXX: Choose a strategy in the future where we dont read buffers into memory
 * when we don't have to IE when we dont to minify and such
 *
 * @param {Function} fn Continuation function
 * @returns {void}
 * @api private
 */
Factory.prototype.files = function files(fn) {
  var factory = this;

  mkdirp(this.dest, (err) => {
    if (err) return fn(err);

    return async.map(Object.keys(factory.output || {}), function map(file, next) {
      const extension = path.extname(file);
      const isSourceMap = extension === '.map';
      const src = factory.output[file];
      const fullPath = path.join(factory.dest, file);

      async.parallel([
        fs.writeFile.bind(fs, fullPath, src.content || src),
        !isSourceMap && fs.writeFile.bind(fs, fullPath + '.gz', factory.compressed[file])
      ].filter(Boolean), (err) => {
        if (err) return fn(err);

        return next(null, {
          content: fullPath,
          compressed: fullPath + '.gz',
          fingerprint: src.fingerprint || fingerprinter(factory.entry, { content: src }).id,
          filename: src.filename || file,
          extension: extensions[extension] || extension
        });
      });
    }, (err, files) => {
      if (err) return fn(err);
      return fn(null, {
        config: factory.config,
        files
      });
    });
  });
};

/**
 * Add a new file to the output of the factory. The content will always be
 * converted to a Buffer to ensure consistency.
 *
 * @param {String} filename Basename of the file.
 * @param {String|Buffer|Object} src File content.
 * @param {String} encoding Content encoding, defaults to utf-8.
 * @api private
 */
Factory.prototype.stock = function stock(filename, src, encoding) {
  encoding = encoding || 'utf-8';

  /**
   * Transform the content to a Buffer;
   *
   * @param {String|Buffer} content File content.
   * @returns {Buffer} Transformed content.
   * @api private
   */
  function buffer(content) {
    return !Buffer.isBuffer(content) ? new Buffer(content, encoding) : content
  }

  if (Object.hasOwnProperty.call(src, 'content')) src.content = buffer(src.content);
  else { src = buffer(src); }

  this.output[filename] = src;
};

/**
 * Simple error handler, exposes the error to the main thread to
 * acknowledge the user, also exits the child process to allow for retries.
 *
 * @param {Error} error Error from any factory step.
 * @api private
 */
Factory.prototype.scrap = function scrap(error) {
  this.clean(function cleaned(err) {
    error = err || error;

    const msg = errs.merge(error, {
      message: error.message,
      event: 'error'
    });

    if (typeof process.send === 'function') {
      return void process.send(msg, process.exit.bind(process, 1));
    }

    return void process.exit(1); // eslint-disable-line
  });
};

//
// Expose the Factory constructor.
//
module.exports = Factory;
