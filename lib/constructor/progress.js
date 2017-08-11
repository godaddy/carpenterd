'use strict';

const through = require('through2');
const once = require('one-time');

/**
 * Stream the build progress which can be streamed to chunk-encoding responses.
 *
 * @Constructor
 * @param {Function} fn Completion callback.
 * @api private
 */
function Progress(fn) {
  this.fn = once(fn || function nope() {});

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
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.fail = function fail(error, id) {
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

  this.fn(error);
  this.cleanup();

  return this.write({
    message: error.message,
    event: 'error'
  }, id).end();
};

/**
 * Start progress with some default data.
 *
 * @param {String} id Optional unique id v4.
 * @param {Number} n Optional number of steps to configure the progress instance
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.start = function start(id, n) {
  this.init(id);

  if (n) this.steps(id, n);

  return this.write({
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
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.done = function done(id) {
  this.cleanup(id);
  return this.write({
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
  return this.write({
    event: 'task',
    message: 'ignored',
    progress: -1
  }).end();
};

/**
 * Write the JSON progress data to the stream.
 *
 * @param {Object} data JSON data to send to the user.
 * @param {String} id Optional unique id v4.
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.write = function write(data, id) {
  if (typeof data !== 'object') {
    data = {};
  }

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
}

/**
 * Close the stream.
 *
 * @returns {Progress} fluent interface
 * @api public
 */
Progress.prototype.end = function end() {
  this.fn();

  this.stream.end();

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
