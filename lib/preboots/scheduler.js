const async = require('async');
const once = require('one-time');
const semver = require('semver');
const from = require('from2');

const assign = Object.assign;

function Scheduler(options) {
  this.bffs = options.bffs;
  this.nsq = options.nsq;
  this.models = options.models;
  this.conc = options.concurrency;
}

Scheduler.prototype.schedule = function schedule(env, callback) {

  //
  // Scheduling algorithm
  //
  // 1. Fetch all packages.
  // 2. Fetch all build-heads for each package for a given environment
  // 3. If a build head version is less than any of its peer build heads,
  //    trigger a build for that given locale
  //
  this.packages(opts, (err, packages) => {
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
    this.pkg.extended.build // derive this somehowe
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
};
