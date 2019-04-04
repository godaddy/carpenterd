const through = require('through2');
const once = require('one-time');
const retry = require('retryme');
const zlib = require('zlib');
const npm = require('./npm');
const tar = require('tar-fs');
const path = require('path');
const fs = require('fs');

class Packer {
  constructor(options) {
    this.retry = options.retry;
    this.log = options.log;
    this.cdnup = options.cdnup;
    this.npmrc = options.npmrc;
  }

  /**
   * Unpack the base64 string content into a proper directory of code
   * @param  {Object} options options for the process
   * @param  {String} options.content base64 encoded string content
   * @param  {String} options.installPath path to installation destination
   * @param  {Object} options.statusWriter object to write with
   * @returns {Promise} completion handler
   */
  unpack({ content, installPath, statusWriter }) {
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
    return new Promise((resolve, reject) => {
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

  /**
   * Take the given source directory and create a tarball at the target directory
   *
   * @param {String} pkgDir Source directory
   * @param {String} tarball Target directory
   * @param {StatusWriter} statusWriter The writer for the status-api
   *
   * @returns {Promise} completion handler
   * @api public
   */
  pack({ pkgDir, tarball, statusWriter }) {
    return new Promise((resolve, reject) => {
      const statusKey = 'packing';
      const succeed = once(statusWriter.writeWrap(statusKey, resolve));
      const fail = once(statusWriter.writeWrap(statusKey, reject));
      statusWriter.writeStart(statusKey);

      tar.pack(pkgDir)
        .once('error', fail)
        .pipe(zlib.Gzip()) // eslint-disable-line new-cap
        .once('error', fail)
        .pipe(fs.createWriteStream(tarball))
        .once('error', fail)
        .once('finish', succeed);
    });
  }

  /**
   * Performs a full npm install & repack operation:
   * 1. Unpack the npm publish payload tarball
   * 2. Run `npm install` in that directory
   * 3. Create a new tarball from that directory (this includes node_modules)
   * 4. Upload that re-packed tarball to S3-compatible CDN
   *
   * @param   {Object} spec - specification for build
   * @param   {Object} paths - paths object
   * @param   {StatusWriter} statusWriter - The writer for the status-api
   */
  async repack(spec, paths, statusWriter) {
    const { tarball, installPath } = paths;
    const pkgDir = path.join(installPath, 'package');

    this.log.info('Beginning npm install & tarball repack & upload', spec.name, spec);

    await this.install({ spec, installPath, statusWriter });
    await this.pack({ pkgDir, tarball, statusWriter });
    await this.upload({ spec, tarball, statusWriter });
  }
}

module.exports = Packer;
