const EE = require('events');
const async = require('async');
const once = require('one-time');
const Lookup = require('../lookup');
const nsqStream = require('nsq-stream');
const from = require('from2');
const util = require('util');

const assign = Object.assign;

util.inherits(Scheduler, EE);

/**
 * Scheduler
 * @public
 * @constructor
 * @param {Object} options - Configuration object
 * @param {Object} options.log - Logger
 * @param {Object} options.nsq - NSQ object
 * @param {String} options.topic - NSQ topic to dispatch onto
 * @param {Object} options.models - Data models
 * @param {Number} [options.concurrency=5] - Number of jobs to run concurrently
 * @param {Number} [options.interval=3600000] - Default interval between catch-up jobs in ms
 */
function Scheduler(options) {
  EE.call(this);
  this.log = options.log;
  this.nsq = options.nsq;
  this.topic = options.topic;
  this.models = options.models;
  this.conc = options.concurrency || 5;
  this.defaultInterval = options.interval || 60 * 60 * 1000;

  this.intervals = new Map();
}

/**
 * Set an interval to schedule catch up jobs for the given env
 * @public
 * @function setInterval
 * @param {String} env - Environment
 * @param {Number} [time] - milliseconds of interval
 */
Scheduler.prototype.setInterval = function interval(env, time) {
  time = time || this.defaultInterval;
  const intervalId = setInterval(() => {
    this.emit('schedule');
    this.schedule(env, (err, counts) => {
      if (err) return this.log.error('Failed to schedule jobs for %s', env, {
        error: err.message,
        stack: err.stack
      });
      this.emit('scheduled', err, counts);
      this.log.info('Successfully scheduled catch up jobs for %s', env, counts);
    });
  }, time);

  this.intervals.set(env, intervalId);
};

/**
 * Clear the given setIntervals for the given env or all of them
 * @public
 * @function clear
 * @param {String} [env] - Optional env to pass
 * @returns {undefined}
 */
Scheduler.prototype.clear = function clear(env) {
  if (env) return this._clear(env);
  for (const key of this.intervals.keys()) {
    this._clear(key);
  }
};

/**
 * Core clearing of setIntervals that cleans up map value as well
 * @private
 * @function _clear
 * @param {String} env - Environment
 */
Scheduler.prototype._clear = function (env) {
  if (this.intervals.has(env)) clearInterval(this.intervals.get(env));
  this.intervals.delete(env);
};

/**
 * Schedule catch up jobs for the given environment over nsq
 * @public
 * @function schedule
 * @param {String} env - Environment to schedule for
 * @param {Function} callback - Continuation to call when completed
 */
Scheduler.prototype.schedule = function schedule(env, callback) {
  const counts = {};
  function done(err) {
    if (err) return callback(err);
    callback(null, counts);
  }
  //
  // Scheduling algorithm
  //
  // 1. Fetch all packages.
  // 2. Fetch all build-heads for each package for a given environment
  // 3. If a build head version is less than any of its peer build heads,
  //    trigger a build for that given locale
  //
  this.packages((err, packages) => {
    if (err) return callback(err);
    async.eachLimit(packages, this.conc, (pkg, next) => {
      const cb = once(next);
      const name = pkg.name;
      this.models.BuildHead.findAll({ name, env }, (err, heads) => {
        if (err) return cb(err);
        if (!heads || !heads.length) return cb();

        const lookup = new Lookup(pkg, heads);
        const writer = nsqStream.createWriteStream(this.nsq.writer, this.topic);

        const missing = lookup.missing();
        const len = missing.length;
        this.log.info('%d missing builds. triggering new builds for %s', len, name);
        counts[name] = len;

        from.obj(missing)
          .pipe(writer)
          .on('error', cb)
          .once('finish', cb);
      });
    }, done);
  });
};

/**
 * Fetch all packages we currently have stored using our special cache table
 * for fast fetches
 * @public
 * @function packages
 * @param {Function} callback - Continuation function to call when completed
 */
Scheduler.prototype.packages = function packages(callback) {
  this.models.PackageCache.findAll({ partitioner: 'cached' }, callback);
};


/**
 * scheduler preboot
 * @param {slay.App} app Slay application
 * @param {Object} options Additional configuration
 * @param {Function} callback Continuation function
 */
module.exports = function schedboot(app, options, callback) {
  app.scheduler = new Scheduler(assign({
    models: app.models,
    nsq: app.nsq,
    log: app.log,
    topic: app.config.get('nsq:topic')
  }, options, app.config.get('scheduler')));

  callback();
};

module.exports.Scheduler = Scheduler;
