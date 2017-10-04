const async = require('async');
const once = require('one-time');
const semver = require('semver');
const from = require('from2');

const assign = Object.assign;

function Scheduler(options) {
  this.bffs = options.bffs;
  this.nsq = options.nsq;
  this.topic = options.topic;
  this.models = options.models;
  this.conc = options.concurrency;
  this.defaultInterval = options.interval;

  this.intervals = new Map();
}

Scheduler.prototype.setInterval = function interval(env, time) {
  time = time || this.defaultInterval;
  const int = setInterval(() => {
    this.schedule(env, (err, counts) => {
      if (err) return this.log.error('Failed to schedule jobs for %s', env, {
        error: err.message,
        stack: err.stack
      });
      this.log.info('Successfully scheduled catch up jobs', counts)
    });
  }, time);

  this.intervals.set(env, int);
};

Scheduler.prototype.clear = function clear(env) {
  if (env) return this._clear(env);
  for (let key of this.intervals.keys()) {
    this._clear(key);
  }
};

Scheduler.prototype._clear = function (env) {
  clearInterval(this.intervals.get(env));
  this.intervals.delete(env);
};

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
      this.bffs.heads({ name, env }, (err, heads) => {
        if (err) return fn(err);
        if (!heads || !heads.length) return fn();

        const lookup = new Lookup(pkg, heads);
        const writer = nsqStream.createWriteStream(this.nsq.writer, this.topic);

        const missing = lookup.missing();
        this.log.info('%d missing builds. triggering new builds', missing.length);
        from.obj(missing)
          .pipe(writer)
          .on('error', fn)
          .once('finish', fn);
      });
    }, callback);
  });
};

Scheduler.prototype.packages = function packs(fn) {
  this.models.PackageCache.findAll({ partitioner: 'cached' }, fn);
};

function Lookup(pkg, heads) {
  this.pkg = pkg;
  this.heads = heads;
  this.latest = this.order(heads);
}

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

Lookup.prototype.missing = function () {
  return this.heads.map((head) => {
    return semver.lt(head.version, this.latest)
      ? this.specify(head)
      : null;
  }).filter(Boolean);
};

Lookup.prototype.specify = function specify(head) {
  return new Spec(
    head.name,
    head.env,
    this.latest,
    head.locale,
    this.pkg.extended.build
  );
};

function Spec(name, env, version, locale, type) {
  this.name = name;
  this.env = env;
  this.version = version;
  this.locale = locale;
  this.type = type;
}

module.exports = function schedboot(app, options, callback) {
  app.scheduler = new Scheduler(assign({
    bffs: app.bffs,
    models: app.models,
    nsq: app.nsq,
    log: app.log,
    topic: app.config.get('nsq:topic')
  }, options, app.config.get('scheduler')));
  console.log('wtf');
  callback();
};

module.exports.Scheduler = Scheduler;
module.exports.Spec = Spec;
module.exports.Lookup = Lookup;
