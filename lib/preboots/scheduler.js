/* eslint max-params: 0*/
const EE = require('events');
const async = require('async');
const once = require('one-time');
const semver = require('semver');
const nsqStream = require('nsq-stream');
const from = require('from2');
const util = require('util');

const assign = Object.assign;

util.inherits(Scheduler, EE);

/**
 * Scheduler
 * @constructor
 * @param {Object} options - Configuration object
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
 * @function setInterval
 * @param {String} env - Environment
 * @param {Number} time - milliseconds of interval
 * @returns {undefined}
 */
Scheduler.prototype.setInterval = function interval(env, time) {
  time = time || this.defaultInterval;
  const int = setInterval(() => {
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

  this.intervals.set(env, int);
};

/**
 * Clear the given setIntervals for the given env or all of them
 * @function clear
 * @param {String} env - Optional env to pass
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
 * @function _clear
 * @api private
 * @param {String} env - Environment
 * @returns {undefined}
 */
Scheduler.prototype._clear = function (env) {
  clearInterval(this.intervals.get(env));
  this.intervals.delete(env);
};

/**
 * Schedule catch up jobs for the given environment over nsq
 * @function schedule
 * @api public
 * @param {String} env - Environment to schedule for
 * @param {Function} callback - Continuation to call when completed
 * @returns {undefined}
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
      const fn = once(next);
      const name = pkg.name;
      this.models.BuildHead.findAll({ name, env }, (err, heads) => {
        if (err) return fn(err);
        if (!heads || !heads.length) return fn();

        const lookup = new Lookup(pkg, heads);
        const writer = nsqStream.createWriteStream(this.nsq.writer, this.topic);

        const missing = lookup.missing();
        const len = missing.length;
        this.log.info('%d missing builds. triggering new builds for %s', len, name);
        counts[name] = len;

        from.obj(missing)
          .pipe(writer)
          .on('error', fn)
          .once('finish', fn);
      });
    }, done);
  });
};

/**
 * Fetch all packages we currently have stored using our special cache table
 * for fast fetches
 * @function packages
 * @api public
 * @param {Function} fn - Continuation function to call when completed
 * @returns {undefined}
 */
Scheduler.prototype.packages = function packs(fn) {
  this.models.PackageCache.findAll({ partitioner: 'cached' }, fn);
};

/**
 * Lookup Object for parsing build heads
 * @constructor
 * @param {Object} pkg - package object
 * @param {Object} heads - build heads for a given package in the fetched env
 */
function Lookup(pkg, heads) {
  this.pkg = pkg;
  this.heads = heads;
  this.latest = this.order(heads);
}

/**
 * Compute and order the heads to return the latest version
 * @function order
 * @param {Array} heads - Array of head objects
 * @returns {String} latest version of the set
 */
Lookup.prototype.order = function order(heads) {
  return heads.filter(Boolean)
    .sort((a, b) => {
      return semver.lt(a.version, b.version) ? -1 : 1;
    }).reduce((latest, v) => {
      return semver.lt(latest, v.version)
        ? v.version
        : latest;
    }, '0.0.0');
};

/**
 * Compute objects to be sent over nsq for missing builds
 * @function missing
 * @returns {Array} of spec objects to be sent to nsq
 */
Lookup.prototype.missing = function () {
  return this.heads.map((head) => {
    return semver.lt(head.version, this.latest)
      ? this.specify(head)
      : null;
  }).filter(Boolean);
};

/**
 * Create a spec object given a head object and internal data
 * @function specify
 * @param {Object} head - A given head object from a missing build
 * @returns {Spec} object to be sent to nsq
 */
Lookup.prototype.specify = function specify(head) {
  return new Spec(
    head.name,
    head.env,
    this.latest,
    head.locale,
    this.pkg.extended.build
  );
};

/**
 * Spec Object
 * @constructor
 * @param {String} name - name of package
 * @param {String} env - env of package
 * @param {String} version - version of package
 * @param {String} locale - locale of package
 * @param {String} type - build type
 */
function Spec(name, env, version, locale, type) {
  this.name = name;
  this.env = env;
  this.version = version;
  this.locale = locale;
  this.type = type;
}

/**
 * scheduler preboot
 * @param {slay.App} app Slay application
 * @param {Object} options Additional configuration
 * @param {Function} next Continuation function
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
module.exports.Spec = Spec;
module.exports.Lookup = Lookup;
