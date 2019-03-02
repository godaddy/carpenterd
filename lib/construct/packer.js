const through = require('through2');
const once = require('one-time');
const zlib = require('zlib');
const tar = require('tar');

class Packer {
  constructor(options) {
    this.retry = options.retry;
    this.log = options.log;
    this.cdnup = options.cdnup;
  }

  /**
   * Unpack the base64 string content into a proper directory of code
   * @param  {Object} options options for the process
   * @param  {String} options.content TBD
   * @param  {String} options.installPath TBD
   * @param  {StatusWriter} options.statusWriter The writer for the status-api
   * @returns {Promise} completion handler
   */
  _unpack({ content, installPath, statusWriter }) {
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

  unpack(options, next) {
    return next => {
      this._unpack(options)
        .then(next)
        .catch(next);
    }
  }

  install() {

  }

  /**
   * Take the given source directory and create a tarball at the target directory
   *
   * @param {Object} options configuration
   * @param {String} options.source Source directory
   * @param {String} options.target Target directory
   * @param {StatusWriter} options.statusWriter The writer for the status-api
   * @returns {Promise} completion handler
   */
  _pack({ source, target, statusWriter }) {
    const statusKey = 'packing';
    statusWriter.writeStart(statusKey);

    return new Promise((resolve, reject) => {
      const succeed = once(statusWriter.writeWrap(statusKey, resolve));
      const fail = once(statusWriter.writeWrap(statusKey, reject));
      tar.pack(source)
        .once('error', fail)
        .pipe(zlib.Gzip()) // eslint-disable-line new-cap
        .once('error', fail)
        .pipe(fs.createWriteStream(target))
        .once('error', fail)
        .once('finish', succeed);
    });
  }

  pack(options, next) {
    return next => {
      this._pack(options)
        .then(next)
        .catch(next);
    }
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
  _upload({ spec, tarball, statusWriter }) {
    if (!this.cdnup) return;
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
            { { error: err.message }, ...logOpts }
          );
        }

        this.log.info('Uploaded tarball for package', assign(
          { { url }, ...logOpts }
        );
        resolve();
      });
    })
  }

  upload(options, next) {
    return next => {
      this._upload(options)
        .then(next)
        .catch(next);
    }
  }
}

module.exports = Packer;
