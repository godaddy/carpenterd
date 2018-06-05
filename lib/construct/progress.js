'use strict';

const through = require('through2');
const once = require('one-time');
const StatusWriter = require('./status-writer');

/**
 * Stream the build progress which can be streamed to chunk-encoding responses.
 *
 * @Constructor
 * @param {Object} opts Options
 * @param {Object} [opts.nsq] The nsq options
 * @param {Object} [opts.nsq.writer] The optional NSQ writer to also write
 * @param {string} [opts.nsq.topic] The topic used to write the NSQ message
 * @param {Object} [opts.metadata] Additional metadata
 * @param {Function} fn Completion callback.
 * @api private
 */
function Progress(opts = {}, fn) {
  this.fn = once(fn || function nope() {});
  this.statusWriter = new StatusWriter(opts);

  //
  // Prepare counters for progress reports.
  //
  this.map = Object.create(null);

  //
  // Create a readable and writable stream.
  //
  this.stream = through();
}

/**
 * We actually have a single stream that tracks progress for `n` builds so we
 * need to handle that.
 *
 * @param {String} id Unique v4 id.
 * @api pubic
 */
Progress.prototype.init = function init(id) {
  this.map[id] = {
    n: 0,
    total: 0
  };
};

/**
 * Write the error and end the stream.
 *
 * @param {Error} error Failure in the build process.
 * @param {String} id Optional unique id v4.
 * @param {Object} [opts] Options object to be merged into the write
 * @param {String} [opts.locale] Locale of the build being started
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.fail = function fail(error, id, opts = {}) {
  //
  // Could be an object or string
  // TODO: Use something like `errs`
  //
  if (!(error instanceof Error)) {
    error = typeof error !== 'string'
      ? error.message || error.code + ': ' + error.path
      : error;

    error = new Error(error);
  }

  return this.write({
    ...opts,
    message: error.message,
    event: 'error'
  }, id);
};

/**
 * Start progress with some default data.
 *
 * @param {String} id Optional unique id v4.
 * @param {Number} n Optional number of steps to configure the progress instance
 * @param {Object} [opts] Options object to be merged into the write
 * @param {String} [opts.locale] Locale of the build being started
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.start = function start(id, n, opts = {}) {
  this.init(id);

  if (n) this.steps(id, n);

  return this.write({
    ...opts,
    event: 'task',
    message: 'start',
    progress: 0
  }, id);
};

/**
 * Increment total with n steps for progress indication.
 *
 * @param {String} id Optional unique id v4.
 * @param {Number} n Steps to add.
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.steps = function steps(id, n) {
  if (!this.map[id]) this.init(id);
  this.map[id].total += n;

  return this;
};

/**
 * End progress with some default data and end the stream.
 *
 * @param {String} id Optional unique id v4.
 * @param {Object} [opts] Options object to be merged into the write
 * @param {String} [opts.locale] Locale of the build being started
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.done = function done(id, opts = {}) {
  this.statusWriter.buildsCompleted++;
  this.cleanup(id);
  return this.write({
    ...opts,
    event: 'task',
    message: 'finished',
    progress: 100
  }, id);
};

/**
 * Notify the build was not executed but ignored.
 *
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.ignore = function ignore() {
  this.fn();
  this.cleanup();
  this.statusWriter.end('ignored');
  return this.write({
    event: 'task',
    message: 'ignored',
    progress: -1
  }).end();
};

/**
 * Write the JSON progress data to the stream.
 *
 * @param {Object} data JSON data to send to the user. If a string is sent it's assumed that is the message being written.
 * @param {String} id Optional unique id v4.
 * @param {Object} [options] Options object
 * @param {Boolean} [options.skipNsq] True if no NSQ event should be written, typically used for end-states
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.write = function write(data, id, options = {}) {
  if (typeof (data) === 'string') {
    data = { message: data };
  } else if (typeof data !== 'object') {
    data = {};
  }
  id = data.id || id;

  if (data.progress && this.map[id]) {
    this.map[id].n++;
    data.progress = this.state(id);
  }

  data.id = data.id || id || 'generic';
  data.timestamp = Date.now();

  if (!this.stream._writableState.ended) {
    this.stream.write(
      new Buffer(JSON.stringify(data) + '\n', 'utf-8')
    );
  }

  if (!options || !options.skipNsq) this.statusWriter.write(data);

  return this;
};

/**
 * Calculate the progress for the provided build.
 *
 * @param {String} id Unique id v4.
 * @returns {Number} Progress.
 * @api public
 */
Progress.prototype.state = function state(id) {
  if (!this.map[id]) return 0;
  return Math.round((this.map[id].n / this.map[id].total) * 100);
};

/**
 * Close the stream.
 *
 * @param {Error} err Optional error
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.end = function end(err) {
  this.fn(err);

  if (err) this.write({
    message: err.message,
    type: 'error'
  }, null, { skipNsq: true });

  this.stream.end();
  this.statusWriter.end(err ? 'error' : 'queued', err);

  return this;
};

/**
 * Delete all build progress per id.
 *
 * @param {String} id Optional unique id v4.
 * @api public
 */
Progress.prototype.cleanup = function cleanup(id) {
  if (id) delete this.map[id];
  else { Object.keys(this.map).forEach(key => delete this.map[key]); }
};

/**
 * Wrap the pipe method to ensure the stream is resumed.
 *
 * @param {Stream} destination Writable stream.
 * @returns {Stream} provided destination.
 * @api public
 */
Progress.prototype.pipe = function pipe(destination) {
  return this.stream.pipe(destination);
};

//
// Export the Progress constructor.
//
module.exports = Progress;
