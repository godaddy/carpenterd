const nsqStream = require('nsq-stream');

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
    const { nsq = {}} = opts || {};
    this.nsqStream = nsq.writer && nsq.topic && nsqStream.createWriteStream(nsq.writer, nsq.topic);
    this.metadata = opts && opts.metadata || {};
    this.buildsCompleted = 0;
  }

  /**
   * Writes an event to the status API nsq stream.
   *
   * @param {Object|String} data Data for the event to write, an object or a string to be used for the message
   * @param {String} [data.locale] The locale for the build
   * @param {String} [data.message] The human-readable message being written
   * @param {Number} [data.progress] The calculated progress for this build
   * @returns {undefined} Nothing whatsoever
   * @public
   */
  write(data) {
    if (!data || !this._isWriteable()) {
      return;
    }

    if (typeof data === 'string') {
      data = { message: data };
    }

    // Intercept the internal error messages so we send a proper error message
    // over NSQ
    if (data.event && data.event === 'error') {
      return void this.writeError(data);
    }

    const payload = {
      message: data.message,
      locale: data.locale,
      details: data.details
    };

    this.nsqStream.write(this._makeSpec(payload));
  }

  /**
   * Writes an error status to the status API nsq stream
   *
   * @param {Object|String} data The error message or object describing it
   * @public
   */
  writeError(data) {
    if (!data || !this._isWriteable()) {
      return;
    }

    if (typeof data === 'string') {
      data = { message: data };
    }

    const payload = {
      eventType: 'error',
      message: data.message,
      locale: data.locale,
      details: data.details
    };

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
      eventType: 'event',
      name,
      env,
      version,
      buildType,
      ...otherFields
    };
  }
}

module.exports = StatusWriter;
