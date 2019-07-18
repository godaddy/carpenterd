const { Writable } = require('stream');
const retry = require('retryme');

/**
 * @class NsqRetryWriteStream
 */
class NsqRetryWriteStream extends Writable {
  /**
   * @param {Object} options For the stream
   *  @param {String} options.topic Topic to publish to on nsq
   *  @param {Writer} options.writer NsqWriter to use for publishing
   *  @param {Ojbect} options.retryOpts RetryOptions configured for this;
   * @constructor
   */
  constructor({ topic, writer, retryOpts = { retries: Infinity, min: 300, max: 5000 }, ...opts }) {
    super({ objectMode: true, ...opts });
    this.topic = topic;
    this.writer = writer;
    this.retryOpts = retryOpts;
  }
  /**
   * _write function to do the retryable publish for the nsq writer via the
   * stream interface
   *
   * @param {Object} data Payload to be published to nsq
   * @param {String} enc Useless encoding meant for other stream types
   * @param {Function} cb Continuation
   */
  _write(data, enc, cb) {
    retry.op(this.retryOpts).attempt((next) => {
      this.writer.publish(this.topic, data, next);
    }, cb)
  }
}

exports.createWriteStream = function createWriteStream(writer, topic) {
  return new NsqRetryWriteStream({ writer, topic });
};

exports.NsqRetryWriteStream = NsqRetryWriteStream;
