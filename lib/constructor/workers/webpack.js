'use strict';

const Factory = require('../factory');
const walk = require('walk').walk;
const path = require('path');
const resolve = require('resolve');
const fs = require('fs');
const execFile = require('child_process').execFile;

/**
 * Execute webpack build.
 *
 * @param {Function} next Completion callback
 * @returns {void}
 * @api public
 */
const run = module.exports = function run(next) {
  const dist = path.join(this.base, 'dist');
  const files = {};
  let called = false;

  /**
   * Handle errors from walk.
   *
   * @param {String} root Dirname of file or directory.
   * @param {Object} stat Stat of file or directory, error is attached.
   * @returns {void}
   * @api private
   */
  function errorHandler(root, stat) {
    if (called) return;
    called = true;
    next(stat.error);
  }

  function done() {
    if (called) return;
    called = true;
    next.apply(next, arguments);
  }

  //
  // Read the file from disk and add it to the object that will be returned to
  // the caller
  //
  function read(fullPath, name, cb) {
    fs.readFile(fullPath, 'utf-8', function readFile(err, content) {
      if (err) {
        return void cb(err);
      }

      files[name] = content;
      return void cb();
    });

  }


  webpack(this.base, this.entry, function webpacked(error) {
    if (error) {
      return void done(error);
    }

    return void walk(dist)
      .once('nodeError', errorHandler)
      .once('directoryError', errorHandler)
      .once('end', () => done(null, files))
      .on('file', function found(root, file, cb) {
        //
        // Ignore minified files that were found in the directory
        //
        if (file.name.indexOf('.min.') !== -1) return void cb();
        return read(path.join(root, file.name), file.name, cb);
      });
  });
};

/**
 * Setup factory line.
 *
 * @param {Object} data Builder options, package location etc.
 * @api public
 */
process.once('message', function build(data) {
  data.entry = data.entry || 'webpack.config.js';

  const factory = new Factory(data, run);

  factory.line([
    factory.unpack,
    factory.init,
    factory.exists,
    factory.read,
    factory.assemble,
    factory.minify,
    factory.pack,
    factory.clean
  ]);
});

/**
 * execFile a child process for the webpack build
 *
 * @param {String} base The path of the project we are building
 * @param {String} config Path to the webpack config file
 * @param {Function} callback Continuation callback
 * @returns {undefined}
 */
function webpack(base, config, callback) {
  return void resolve('webpack', { basedir: base }, (_, res) => {
    const root = res || require.resolve('webpack');
    const webpackPath = path.join(root, '..', '..', 'bin', 'webpack.js');
    execFile(process.execPath, [webpackPath, `--config ${config}`, '--bail'], {
      cwd: base,
      env: process.env // eslint-disable-line
    }, function (err, stdout, stderr) {
      if (err) {
        err.output = stdout + stderr;
        return callback(err);
      }
      // TODO: What should we check in the output to determine error? Does
      // webpack output to stderr properly?
      return callback();
    });
  });
}
