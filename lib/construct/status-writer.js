const { performance } = require('perf_hooks');
const nsqStream = require('nsq-stream');

const eventTypes = {
  error: 'error',
  default: 'event'
};

/**
 * Writes to the status-api NSQ topic
 *
 * @class StatusWriter
 */
class StatusWriter {
  /**
   * Constructor for StatusWriter
   *
   * @param {Object} opts Options
   * @param {Object} [opts.nsq] The nsq options
   * @param {Object} [opts.nsq.writer] The optional NSQ writer to also write
   * @param {string} [opts.nsq.topic] The topic used to write the NSQ message
   * @param {Object} [opts.metadata] Additional metadata
   * @constructor
   */
  constructor(opts) {
    const { nsq = {} } = opts || {};
    this.log = opts.log || { info: function () {}, error: function () {} };
    this.nsqStream = nsq.writer && nsq.topic && nsqStream.createWriteStream(nsq.writer, nsq.topic);
    if (this.nsqStream) this.nsqStream.on('error', this._connectionError.bind(this));
    this.metadata = opts && opts.metadata || {};
    this.buildsCompleted = 0;
    this.timings = new Map();
  }

  /**
   * Error handler for nsqStream. This should really never get called but its
   * for the just in case
   *
   * @param {Error} error Error object from the stream
   * @private
   */
  _connectionError(error) {
    this.log.error('Error from nsq-stream writing status after retries', { message: error.message, stack: error.stack });
  }

  /**
   * Writes a message to the status API nsq stream, also starts a performance
   * timer to track duration for some event
   *
   * @param {String} key The key to use to start a new performance timer
   * @param {Object|String?} data Data for the event to write, an object or a
   * string to be used for the message, if none is provided, one will be constructed based off the key
   * @public
   */
  writeStart(key, data) {
    this.timings.set(key, performance.now());
    this.write(null, data || `'${key}' starting`);
  }

  /**
   * Writes a message to the status API nsq stream, stops the performance
   * timer and adds the timing information to the status message. The
   * status message will follow a standard format. The type of status
   * message written will be based on whether an error was passed.
   *
   * @param {String} key The key used to when starting the performance timer
   * @param {Error?} err The error (if any). Passing an error will cause
   * this to be written as an error event.
   * @public
   */
  writeMaybeError(key, err) {
    if (err) {
      this.write(key, {
        message: `ERROR: '${key}' exited with code: ${err}.`,
        details: err,
        event: eventTypes.error
      });
      return;
    }

    this.write(key);
  }

  /**
   * Wraps a callback function with a status writer that will complete a performance timer
   *
   * @param {String} key The key used when starting the performance timer
   * @param {Function} done The function to call after writing the event
   * @returns {Function} A new callback function that wraps the given callback.
   * @public
   */
  writeWrap(key, done) {
    return (err, data) => {
      this.writeMaybeError(key, err);
      done(err, data);
    };
  }

  /**
   * Stops the performance timer and returns the timing information.
   *
   * @param {String} key The key used when starting the performance timer
   * @returns {Object} The performance timing
   * @private
   */
  getTiming(key) {
    const timing = performance.now() - this.timings.get(key);
    this.timings.delete(key);
    return timing;
  }

  /**
   * Writes an event to the status API nsq stream.
   *
   * @param {String?} key The key used when starting the performance timer.
   * If providing, timing information will be added to the status message
   * @param {Object|String} data Data for the event to write, an object or a string to be used for the message
   * @param {String} [data.locale] The locale for the build
   * @param {String} [data.message] The human-readable message being written
   * @param {Number} [data.progress] The calculated progress for this build
   * @returns {undefined} Nothing whatsoever
   * @public
   */
  write(key, data) {
    if (!this._isWriteable()) {
      return;
    }

    if (key && !data) {
      data = { message: `'${key}' completed successfully` };
    }

    if (!data) {
      return;
    }

    if (typeof data === 'string') {
      data = { message: data };
    }

    const payload = {
      eventType: data.event === 'error' ? eventTypes.error : eventTypes.default,
      message: data.message,
      locale: data.locale,
      details: data.details
    };

    if (key) {
      payload.timing = this.getTiming(key);
    }

    this.nsqStream.write(this._makeSpec(payload));
  }

  /**
   * Writes the end status to the status API nsq stream.
   *
   * @param {String} type The event type (ignored, error, queued)
   * @param {Error} [err] The error object that caused the end to occur
   * @public
   */
  end(type, err) {
    if (!this._isWriteable()) {
      return;
    }

    this.nsqStream.end(this._makeSpec({
      eventType: type,
      total: this.buildsCompleted,
      message: err ? err.message : 'Builds Queued'
    }));
  }

  /**
   * Test to see if writes should be allowed
   *
   * @returns {Boolean} True if writes are allowed
   * @private
   */
  _isWriteable() {
    return this.nsqStream && !this.nsqStream._writableState.ended;
  }

  /**
   * Creates a spec to be written to the nsq stream
   *
   * @param {Object} [otherFields={}] Additional fields of the spec to add, overwrites defaults
   * @returns {Object} The constructed spec
   * @private
   */
  _makeSpec(otherFields = {}) {
    const { name, env, version, type: buildType } = this.metadata || {};
    return {
      eventType: eventTypes.default,
      name,
      env,
      version,
      buildType,
      ...otherFields
    };
  }
}

module.exports = StatusWriter;

