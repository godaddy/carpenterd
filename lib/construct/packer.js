const through = require('through2');
const once = require('one-time');
const zlib = require('zlib');
const tar = require('tar-fs');

class Packer {

  /**
   * Unpack the base64 string content into a proper directory of code
   * @param  {Object} options options for the process
   * @param  {String} options.content TBD
   * @param  {String} options.installPath TBD
   * @param  {Object} options.statusWriter TBD
   * @returns {Promise} completion handler
   */
  _unpack(options) {
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

  unpack(options) {
    return next => {
      this._unpack(options)
        .then(next)
        .catch(next);
    };
  }

  bind() {

  }

  pack(source, target, statusWriter, next) {

  }

  upload() {
    console.log('wt')
  }

}

module.exports = Packer;
