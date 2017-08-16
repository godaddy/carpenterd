/* eslint max-nested-callbacks: 0 */
/* eslint max-params: 0 */
'use strict';

const EventEmitter = require('events').EventEmitter;
const intersect = require('lodash.intersection');
const assign = require('object-assign');
const Progress = require('./progress');
const through = require('through2');
const uuid = require('node-uuid');
const crypto = require('crypto');
const mkdirp = require('mkdirp');
const async = require('async');
const errs = require('errs');
const rmrf = require('./rmrf');
const tar = require('tar-fs');
const once = require('one-time');
const path = require('path');
const util = require('util');
const npm = require('./npm');
const zlib = require('zlib');
const omit = require('lodash.omit');
const fs = require('fs');
const os = require('os');
const workers = require('workers-factory');

//
// Available build systems.
//
const available = [
  'browserify',
  'webpack',
  'es6',
  'npm'
];

//
// Map environment values from natives to bffs.
//
const envs = {
  production: 'prod',
  development: 'dev',
  staging: 'test',
  latest: 'prod',
  test: 'test',
  prod: 'prod',
  dev: 'dev'
};

const fullEnvs = new Map([
  ['prod', 'production'],
  ['latest', 'production'], // why? my gut tells me this should be development:
  ['dev', 'development'],
  ['test', 'test'],
  ['production', 'production'],
  ['development', 'development']
]);

/**
 * Construct the builder orchestrator, provide options and a factory loader.
 *
 * @Constructor
 * @param {Slay} app Slay/Express instance.
 * @param {Object} options Optional.
 * @api public
 */
function Constructor(app, options) {
  EventEmitter.call(this, options);

  this.app = app;
  this.cdnup = app.cdnup;
  this.models = app.models;
  this.throttle = options.throttle || app.config.get('throttle') || 10;

  //
  // Clean the configured temporary build folder, use a 1:1 mapping with the build
  // timeout. Do not run the cleaning if running in development. Default to 15
  // minutes to prevent a interval of 0.
  //
  if (app.config.get('env') !== 'development') setInterval(
    this.purge.bind(this),
    app.config.get('builder').timeout || 15 * 6E4
  );
}

//
// Extend Constructor with event emitting capacities.
//
util.inherits(Constructor, EventEmitter);
Constructor.prototype.emits = require('emits');

/**
 * Initiate a new build process as child through Gjallarhorn.
 *
 * @param {Object} data Package data.
 * @param {Function} done Completion callback.
 * @returns {Progress} Expose created progress instance.
 * @api public
 */
Constructor.prototype.build = function build(data, done) {
  const config = this.app.config.get('builder');
  const progress = new Progress(done);
  const constructor = this;
  const app = this.app;

  //
  // Compile build specifications from the data.
  //
  app.contextLog.info('compile build spec for %s', data.name, {
    name: data.name
  });

  constructor.specs(data, function specifications(error, spec) {
    if (error) {
      return void progress.fail(error);
    }
    //
    // No-build flag was added to the package.json to indicate there are no build
    // requirements for this package. This should however trigger dependant builds
    // so return early without error.
    //
    if (!spec.type || spec.build === false) {
      app.contextLog.info('ignoring build, does not meet criteria', spec);
      return progress.ignore();
    }
    //
    // Supply additional configuration. Data will be handed of to the spawned child
    // processes and should not be used elsewhere to prevent contamination of data.
    //
    const content = constructor.content(data, spec);
    spec.source = config.source;
    spec.target = config.target;
    spec.npm = app.config.get('npm');

    app.contextLog.info('Prepare build for all locales, unpack, npm install, repack for %s', spec.name, spec);

    constructor.prepare(spec, content, function (err, paths) {
      if (err) return done(err);

      //
      // Give the child process the path to the tarball to extract which
      // contains the `npm.install`
      //
      spec.content = paths.tarball;

      app.contextLog.info('building %s with spec', data.name, spec);
      //
      //
      // When we are all said and done, end the progress stream
      //
      function finish() {
        app.contextLog.info('Clean up build artifacts for %s', spec.name, spec);
        constructor.cleanup(Object.keys(paths).map(key => paths[key]), (err) => {
          if (err) return done(err);
          app.contextLog.info('Finished build for %s', spec.name, spec);
          progress.end();
        });
      }

      return void async.eachLimit(spec.locales, constructor.throttle, function buildPerLocale(locale, next) {
        const id = uuid.v4();
        //
        // There are 3 events per ID. This is a stub of progress before we
        // remove it in the next pass of the refactor as progress will need to
        // exist in an external service. We use 4 here so that the `finished`
        // event is the only 100 which gets sent when done is called
        //
        progress.start(id, 4);
        const current = assign({
          locale: locale,
          id: id
        }, omit(spec, 'locales'));

        app.withBreadcrumb({
          buildID: id,
          locale: locale,
          name: data.name
        }, app.contextLog.info, function runBuild() {
          app.contextLog.info('Start build for locale %s', locale, {
            locale: locale,
            name: spec.name,
            version: spec.version,
            env: spec.env,
            id: id
          });
          current.destDir = path.join(os.tmpdir(), `${current.id}-publish`);
          /**
          * Report the error to the developer before ending the async loop.
          *
          * @param {Error} err Failed step of the build process.
          * @api private
          */
          function step(err) {
            if (err) {
              progress.fail(err, id);
            }

            next(err);
          }

          app.contextLog.info('Start fresh build', {
            locale: locale,
            name: spec.name,
            version: spec.version,
            env: spec.env,
            id: id
          });

          //
          // Launch the build process with the specifications and attach
          // a supervisor to communicate all events back to the developer.
          //
          progress.write({
            progress: true,
            id: id,
            message: `Running ${current.type} build ${current.name}`
          });
          return void constructor._runBuild(current, function build(error, data) {
            if (error) {
              app.contextLog.error('Build %s for %s env: %s failed %j', current.id, current.name, current.env, data);
              return step(error);
            }
            app.contextLog.info('%s build %s for %s env: %s, locale: %s finished', current.type, current.id, current.name, current.env, current.locale);

            progress.write({
              progress: true,
              id: id,
              message: `${spec.type} build finished on ${spec.name}, storing assets`
            });
            constructor.emit('store', current, progress, data);
            constructor.store(current, data, function (err) {
              if (err) {
                return step(error);
              }
              progress.write({
                progress: true,
                id: id,
                message: `assets stored for ${current.name} env: ${current.env} locale: ${current.locale}`
              });
              //
              // We have finished 1 out of the n number of builds based on
              // number of locales
              //
              app.contextLog.info('Finished building locale %s', locale, {
                locale: locale,
                env: spec.env,
                version: spec.version,
                name: spec.name,
                id: id
              });

              progress.done(id);
              return void step();
            });
          });
        });
      }, finish);
    });
  });

  return progress;
};

/**
 * Cleanup the given paths given an array of them
 *
 * @param {Array} paths Paths that need to be removed
 * @param {function} fn Completion function
 */
Constructor.prototype.cleanup = function cleanup(paths, fn) {
  paths = Array.isArray(paths) ? paths : [paths];
  async.each(paths, (path, next) => rmrf(path, next), fn);
};

/**
 * Prepare the build by unpacking, running npm install and then creating
 * a tarball to be used for extraction when running the actual build.
 *
 * @param {Object} spec Specification object for the given build
 * @param {String} content Base64 string representing the package content
 * @param {Function} next Completion callback.
 * @api public
 */
Constructor.prototype.prepare = function prepare(spec, content, next) {
  const config = this.app.config.get('builder');
  const outputRoot = config.install || path.join(os.tmpdir(), 'install');
  const tarRoot = config.tarballs || path.join(os.tmpdir(), 'tarballs');
  const uniq = `${encodeURIComponent(spec.name)}-${spec.version}-${spec.env}-${crypto.randomBytes(5).toString('hex')}`;
  const outputPath = path.join(outputRoot, uniq);
  const tarball = path.join(tarRoot, uniq + '.tgz');
  const app = this.app;

  app.contextLog.info('Prepare build for all locales: mkdirp %s', spec.name, spec);

  async.parallel([
    async.apply(mkdirp, outputRoot),
    async.apply(mkdirp, tarRoot)
  ], (err) => {
    if (err) return next(err);

    //
    // First see if this package has already been built for a different env, we
    // should only build a single version once
    //
    this.checkAndDownload(spec, { tarball }, (err, paths) => {
      if (err) {
        return err.install
          ? this.npmInstall(spec, content, { output: outputPath, tarball }, next)
          : next(err);
      }

      next(null, paths);
    });
  });
};

/**
 * Check to see if this package version combo exists and download and use that
 * tarball instead if it does
 *
 * @function checkAndDownload
 * @param {Object} spec - specification for build
 * @param {Object} paths - paths object
 * @param {Function} next - go to the next step and run builds
 * @returns {undefined}
 * @api private
 */
Constructor.prototype.checkAndDownload = function checkAndDownload(spec, paths, next) {
  const app = this.app;
  if (!this.cdnup) {
    app.contextLog.info('%s: cdnup not configured. Skip download attempt.', spec.name);
    return void next(errs.create({
      message: 'cdnup is not configured',
      install: true
    }));
  }

  const pkgcloud = this.cdnup.client;
  const filename = `${encodeURIComponent(spec.name)}-${spec.version}.tgz`;

  return void pkgcloud.getFile(this.cdnup.bucket, filename, (err, file) => {
    if (err || !file) {
      app.contextLog.info('%s: tarball %s not found in remote storage', spec.name, filename);
      return void next(errs.create({
        message: 'Tarball not found',
        install: true
      }));
    }

    function onError(err) {
      app.contextLog.error('Tarball download error for %s: %s', spec.name, err.message);
      next(err);
    }

    function onFinish() {
      app.contextLog.info('Tarball download ok for %s: %s', spec.name, paths.tarball);
      next(null, paths);
    }

    pkgcloud.download({
      container: this.cdnup.bucket,
      remote: filename
    }).pipe(fs.createWriteStream(paths.tarball))
      .once('error', onError)
      .on('finish', onFinish);
  });
};

/**
 * Performs a full npm install & repack operation:
 * 1. Unpack the npm publish payload tarball
 * 2. Run `npm install` in that directory
 * 3. Create a new tarball from that directory (this includes node_modules)
 * 4. Upload that re-packed tarball to S3-compatible CDN
 *
 * @param   {Object} spec - specification for build
 * @param   {String} content – base64 encoded tarball content
 * @param   {Object} paths - paths object
 * @param   {Function} next - go to the next step and run builds
 */
Constructor.prototype.repack = function repack(spec, content, paths, next) {
  const outputPath = paths.output;
  const tarball = paths.tarball;
  const pkgDir = path.join(outputPath, 'package');

  app.contextLog.info('Begin npm install & tarball repack', spec.name, spec);
  async.series({
    unpack: this.unpack.bind(this, { content, outputPath }),
    install: this.install.bind(this, spec, pkgDir),
    pack: this.pack.bind(this, pkgDir, tarball),
    upload: this.upload.bind(this, spec, tarball)
  }, (err) => {
    if (err) return next(err);

    next(null, { install: outputPath, tarball });
  });
}

/**
 * Take the given source directory and create a tarball at the target directory
 *
 * @param {String} source Source directory
 * @param {String} target Target directory
 * @param {Function} next Completion callback.
 * @api public
 */
Constructor.prototype.pack = function pack(source, target, next) {
  const done = once(next);
  tar.pack(source)
    .once('error', done)
    .pipe(zlib.Gzip()) // eslint-disable-line new-cap
    .once('error', done)
    .pipe(fs.createWriteStream(target))
    .once('error', done)
    .once('finish', done);
};

/**
 * Unpack the base64 string content into a proper directory of code
 *
 * @param {Object} opts Options for process
 * @param {Function} next Completion callback.
 * @api public
 */
Constructor.prototype.unpack = function unpack(opts, next) {
  const stream = through();

  stream
    .pipe(zlib.Unzip()) // eslint-disable-line new-cap
    .once('error', next)
    .pipe(tar.extract(opts.outputPath))
    .once('error', next)
    .once('finish', next);

  stream.end(new Buffer(opts.content, 'base64'));
};

/**
 * Upload the given file to our configured endpoint
 *
 * @param {Object} spec Defines this package
 * @param {String} tarball Path to tarball
 * @param {Function} next Optional completion callback.
 *
 * @returns {undefined} Nothing special
 * @api public
 */
Constructor.prototype.upload = function upload(spec, tarball, next) {
  if (!this.cdnup) return setImmediate(next);
  const app = this.app;
  const filePath = `${encodeURIComponent(spec.name)}-${spec.version}.tgz`;

  //
  // TODO: We ccould also check to see if the asset exists before we try and upload
  //
  const logOpts = assign({ tarball }, spec);
  this.cdnup.upload(tarball, filePath, (err, url) => {
    if (err) {
      return app.contextLog.error('Failed to upload tarball for package',
        assign({ error: err.message }, logOpts));
    }

    app.contextLog.info('Uploaded tarball for package', assign({ url }, logOpts));
    next();
  });
};

/**
 * Install the dependencies of the package with npm.
 * Uses the provided environment.
 *
 * @param {Object} spec Spec
 * @param {String} base Path to the package to install
 * @param {Function} next Completion callback.
 * @api public
 */
Constructor.prototype.install = function install(spec, base, next) {
  const npmData = spec.npm;

  npm.install(assign({
    base: base,
    prefix: base,
    env: spec.env
  }, npmData), next || function () {});
};

/**
 * Extract package content from the JSON body.
 *
 * @param {Object} data Package data.
 * @param {Object} spec Descriptive package information.
 * @returns {String} base64 encoded string.
 * @api private
 */
Constructor.prototype.content = function content(data, spec) {
  const name = spec.name + '-' + spec.version + '.tgz';

  data = data || {};
  data._attachments = data._attachments || {};
  data._attachments[name] = data._attachments[name] || {};

  return data._attachments[name].data || '';
};

/**
 * Get the package.json content from the payload.
 *
 * @param {Object} data Payload content.
 * @returns {Object} Package.json
 * @api private
 */
Constructor.prototype.extractPackage = function extractPackage(data) {
  data = data || {};

  //
  // JUST IN CASE we get a cassandra based data piece we check for distTags
  // first
  //
  const version = (data.distTags || data['dist-tags'] || {}).latest;
  return (data.versions || {})[version] || {};
};

/**
 * Get allowed locales from the package.json.
 *
 * @param {Object} data Build specifications.
 * @param {Function} done Completion callback.
 * @api private
 */
Constructor.prototype.getLocales = function getLocales(data, done) {
  const constructor = this;
  const app = this.app;
  const cache = [];
  let locales = [];
  let queue;

  /**
   * Fetch the package.json of each dependency, ignore already fetched dependencies
   * to prevent circular dependencies from filling up the queue eternally.
   *
   * @param {Object} pkg Package.json object
   * @param {Function} next Completion callback.
   * @api private
   */
  function getDependencies(pkg, next) {
    cache.push(pkg.name);

    //
    // Push locales if they are defined as array.
    //
    if (Array.isArray(pkg.locales)) {
      locales.push(pkg.locales.filter(Boolean));
    }

    //
    // Fetch the package.json of each dependency and add
    // the processed package.json to the queue.
    //
    async.each(Object.keys(pkg.dependencies || {}).filter(function filterDeps(name) {
      return !~cache.indexOf(name);
    }), function fetch(name, fn) {
      constructor.models.Package.get(name, function getPackage(err, pkgData) {
        if (err) return void fn(err);

        queue.push(pkgData || {});
        return void fn();
      });
    }, next);
  }

  //
  // Setup the queue to get all dependencies per package and push the main
  // package.json as first task.
  //
  app.contextLog.info('calculate locales for %s', data.name, {
    name: data.name
  });

  queue = async.queue(getDependencies, 100);
  queue.push(this.extractPackage(data));

  //
  // The async queue completed, calculate the intersect of all locale lists.
  // Fallback to `en-US` if no intersecting locales remain.
  //
  queue.drain = function complete() {
    locales = intersect.apply(intersect, locales);
    app.contextLog.info('calculated locales for %s', data.name, {
      locales: locales,
      name: data.name
    });

    done(null, locales.length ? locales : ['en-US']);
  };
};

/**
 * Extract descriptive package information from the JSON body.
 *
 * @param {Object} data Package data.
 * @param {Function} callback Completion callback.
 * @api private
 */
Constructor.prototype.specs = function specs(data, callback) {
  const app = this.app;
  const classification = {
    es6: ['es2017', 'es2016', 'es2015', 'es6'],
    browserify: ['browserify'],
    webpack: ['webpack'],
    npm: ['npm']
  };

  let entry;
  let type;

  const pkg = this.extractPackage(data);

  type = fitting(pkg, {
    keyword: 'build',
    classification: classification
  });

  function done(err, spec) {
    if (err) {
      app.contextLog.error('error constructing spec', err);
      return void callback(err);
    }

    return void callback(err, spec);
  }

  //
  // Try to infer the build system from package.json properties if no
  // build system type has been found yet.
  //
  if (!type) {
    const properties = Object.keys(pkg);
    type = Object.keys(classification).filter(function checkProperties(key) {
      return ~properties.indexOf(key) && typeof pkg[key] === 'string';
    })[0];
  }

  //
  // Only use the build property as entry if it is a path or file location,
  // config objects should be ignored.
  //
  if (typeof pkg[type] === 'string') {
    entry = pkg[type];
  }

  //
  // Read the dependency tree and each package.json to determine locales.
  //

  this.getLocales(data, function foundPossibleLocales(error, locales) {
    if (error) {
      return void done(error);
    }

    return void done(null, {
      type: available[available.indexOf(type)],
      env: envs[data.env] || 'dev',
      build: pkg.build !== false,
      version: pkg.version,
      locales: locales,
      name: pkg.name,
      entry: entry
    });
  });
};

/**
 * Register the end results of the Build File Finder Service.
 *
 * @param {Object} spec Build data.
 * @param {Object} files File data.
 * @param {Function} callback continuation function
 * @api private
 */
Constructor.prototype.store = function store(spec, files, callback) {
  const app = this.app;

  app.contextLog.info('Storing file in BFFS', spec);
  app.bffs.publish(spec, files, function (error) {
    if (error) {
      app.contextLog.error('Failed to store files', {
        message: error.message,
        locale: spec.locale,
        id: spec.id,
        name: spec.name,
        version: spec.version
      });
      return callback(error);
    }

    //
    // XXX: Do this for now since we want to do a best effort clean here and
    // `purge` does not cover the same directory. We technically need them to be
    // different to prevent a possible race condition as we dont know when this
    // completes
    //
    rmrf(spec.destDir, function () {});
    app.contextLog.info('Published to BFFS: metadata, compressed and plain content', spec);
    callback();

  });
};

/**
 * Check the validity of the uuid. Allows defensive querying,
 * e.g. ignore invalid ids asap.
 *
 * @param {String} id Unique id v4.
 * @returns {Boolean} Valid uuid or not.
 * @api public
 */
Constructor.prototype.valid = function valid(id) {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i.test(id);
};

/**
 * Helper method that cleans the temporary build folder.
 *
 * @api private
 */
Constructor.prototype.purge = function purge() {
  const app = this.app;
  const constructor = this;
  const config = app.config.get('builder');
  const age = config.timeout * (config.retries + 2);

  fs.readdir(config.target, function readTarget(error, files) {
    if (error || !files) {
      app.contextLog.error(error);
      return;
    }

    files = files.filter(constructor.valid);
    async.reduce(files, 0, function removeUUIDFolders(i, file, next) {
      file = path.join(config.target, file);

      fs.stat(file, function getAge(err, stat) {
        if (err) return void next(err);

        //
        // Be defensive and use modified time to determine if the folder is older
        // than age (max build time * the numer of attempts + 1). This should
        // prevent child content from being accidently removed at the last
        // millisecond, which could result in a failed build.
        //
        if (Date.now() - age <= new Date(stat.mtime).getTime()) {
          return next(null, i);
        }

        return void rmrf(file, function removed(rmError) {
          next(rmError, i + 1);
        });
      });
    }, function done(err, n) {
      if (err) {
        app.contextLog.error(err);
        return void constructor.emit('purge', error, 0);
      }

      app.contextLog.info('Purged %s outdated files from temporary target location', n);
      return void constructor.emit('purge', null, n);
    });
  });
};

Constructor.prototype._runBuild = function _build(spec, callback) {
  const app = this.app;

  const opts = assign({}, spec, {
    processEnv: assign({}, process.env, {
      NODE_ENV: fullEnvs.get(spec.env),
      LOCALE: spec.locale,
      WRHS_LOCALE: spec.locale
    })
  });
  app.contextLog.info('Building %s with %s with locale %s', spec.name, spec.type, spec.locale);
  const worker = workers[spec.type];
  worker(opts, callback);
};

//
// Expose the builder instance.
//
module.exports = function preboot(app, options, done) {
  const config = app.config.get('builder');

  app.construct = new Constructor(app, config);
  done();
};

//
// Extract the type of build we are doing
//
function fitting(data, options) {
  options = options || {};

  //
  // Allow additional rules to be defined and merge against the default.
  //
  var classy = options.classification,
    keyword = options.keyword || 'check',
    match = '';

  //
  // The classification can also be read directly from the data.
  // Allow opt-in for a `keyword`. This defaults to the `check` property.
  //
  if (data[keyword] in classy) return data[keyword];

  //
  // Check if there are keywords in the package.json that gives some intel on
  // which project/team created these packages.
  //
  if (!Array.isArray(data.keywords)) data.keywords = [];

  Object.keys(classy).some(function each(project) {
    var keywords = classy[project];

    if (keywords.some(function some(keyword) {
      return !!~data.keywords.indexOf(keyword);
    })) return !!(match = project);

    return false;
  });

  return match;
}
