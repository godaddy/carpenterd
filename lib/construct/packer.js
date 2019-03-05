const through = require('through2');
const once = require('one-time');
const retry = require('retryme');
const zlib = require('zlib');
const npm = require('./npm');
const tar = require('tar-fs');
const path = require('path');

class Packer {
  constructor(options) {
    this.retry = options.retry;
    this.log = options.log;
    this.cdnup = options.cdnup;
    this.npmrc = options.npmrc
  }

  /**
   * Unpack the base64 string content into a proper directory of code
   * @param  {Object} options options for the process
   * @param  {String} options.content TBD
   * @param  {String} options.installPath TBD
   * @param  {Object} options.statusWriter TBD
   * @returns {Promise} completion handler
   */
  unpack(options) {
    const { content, installPath, statusWriter } = options;
    const stream = through();
    const statusKey = 'unpacking';
    statusWriter.writeStart(statusKey);

    return new Promise((resolve, reject) => {
      const succeed = once(statusWriter.writeWrap(statusKey, resolve));
      const fail = once(statusWriter.writeWrap(statusKey, reject));

      stream
        .pipe(zlib.Unzip()) // eslint-disable-line new-cap
        .once('error', fail)
        .pipe(tar.extract(installPath))
        .once('error', fail)
        .once('finish', succeed);

      stream.end(Buffer.from(content, 'base64'));
    });
  }

  /**
   * Install the dependencies of the package with npm.
   * Uses the provided environment.
   *
   * @param {Object} options configuration
   * @param {Object} options.spec Spec
   * @param {String} options.installPath os.tmpdir base path to run the install in.
   * @param {StatusWriter} options.statusWriter The writer for the status-api
   *
   * @returns {Promise} completion handler
   */
  install({ spec, installPath, statusWriter }) {
    const pkgDir = path.join(installPath, 'package');
    const statusKey = 'npm install-all';

    statusWriter.writeStart(statusKey);
    const op = retry.op(this.retry);
    return new Promise((resolve) => {
      op.attempt(next => {
        npm.install({
          log: this.log,
          userconfig: this.npmrc,
          installPath,
          pkgDir,
          spec,
          statusWriter
        }, next);
      }, statusWriter.writeWrap(statusKey, (err) => {
        err ? reject(err) : resolve();
      }));
    });
  }

  /**
   * Upload the given file to our configured endpoint
   *
   * @param {Object} options configuration
   * @param {Object} options.spec Defines this package
   * @param {String} options.tarball Path to tarball
   * @param {StatusWriter} options.statusWriter The writer for the status-api
   *
   * @returns {Promise} completion handler
   */
  upload({ spec, tarball, statusWriter }) {
    if (!this.cdnup) return Promise.resolve();
    const statusKey = 'uploading';
    statusWriter.writeStart(statusKey);
    const filePath = `${encodeURIComponent(spec.name)}-${spec.version}.tgz`;

    const logOpts = { tarball, ...spec };
    return new Promise((resolve) => {
      this.cdnup.upload(tarball, filePath, (err, url) => {
        statusWriter.writeMaybeError(statusKey, err);

        if (err) {
          return this.log.error(
            'Failed to upload tarball for package',
            { error: err.message, ...logOpts }
          );
        }

        this.log.info('Uploaded tarball for package', { url, ...logOpts });
        resolve();
      });
    });
  }

  perform(method, options) {
    return next => this[method](options)
      .then(next)
      .catch(next);
  }
}

module.exports = Packer;
