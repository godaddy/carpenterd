/* eslint max-params: 0 */
'use strict';

const EventEmitter = require('events').EventEmitter;
const intersect = require('lodash.intersection');
const Progress = require('./progress');
const { promisify } = require('util');
const Cleaner = require('./cleaner');
const Builder = require('./builder');
const Packer = require('./packer');
const crypto = require('crypto');
const mkdirp = require('mkdirp');
const mkdirpAsync = promisify(mkdirp);
const async = require('async');
const errs = require('errs');
const fitting = require('./fitting');
const rmrf = require('./rmrf');
const path = require('path');
const fs = require('fs');
const os = require('os');
const emits = require('emits');

//
// Available build systems.
//
const available = [
  'browserify',
  'webpack',
  'es6',
  'npm'
];

//
// Map environment values from natives to bffs.
//
const envs = {
  production: 'prod',
  development: 'dev',
  staging: 'test',
  latest: 'prod',
  test: 'test',
  prod: 'prod',
  dev: 'dev'
};

/**
 * Construct the builder orchestrator, provide options and a factory loader.
 *
 * @Constructor
 * @param {Slay} app Slay/Express instance.
 * @param {Object} options Optional.
 * @api public
 */
class Constructor extends EventEmitter {
  constructor(app, options) {
    super(options);

    this.app = app;
    this.cdnup = app.cdnup;
    this.models = app.models;
    this.throttle = options.throttle || app.config.get('throttle') || 10;
    // Default to max 2s backoff and 1 retry attempt
    this.retry = options.retry || app.config.get('build:retry') || { retries: 1, max: 2000 };
    this.maxFailures = options.maxFailures || app.config.get('maxFailures') || 2;
    this.failures = {};

    this.timeout = options.timeout || 15 * 6E4;
    this.purgeRetries = (options.retries || 0) + 5;

    this.source = options.source;
    this.target = options.target || os.tmpdir();
    this.rootDir = options.target || this.target;
    this.installRoot = options.install || path.join(this.rootDir, 'install');
    this.tarRoot = options.tarballs || path.join(this.rootDir, 'tarballs');

    this.nsq = app.nsq;
    this.topic = options.topic || app.config.get('nsq:topic');
    this.statusTopic = options.statusTopic || app.config.get('nsq:statusTopic');
    //
    // Clean the configured temporary build folder, use a 1:1 mapping with the build
    // timeout. Do not run the cleaning if running in development. Default to 15
    // minutes to prevent a interval of 0.
    //
    if (app.config.get('env') !== 'development') setInterval(
      this.purge.bind(this),
      this.timeout
    );
    this.emits = emits;
    this.packer = new Packer({
      retry: this.retry,
      log: app.contextLog,
      cdnup: this.cdnup,
      npmrc: app.npmrc
    });
    this.cleaner = new Cleaner({
      log: app.contextLog
    });
    this.builder = new Builder(this);
  }

  /**
   * Initiate a new build process as child through Gjallarhorn.
   *
   * @param {Object} opts Build options.
   * @param {Object} opts.data Package data.
   * @param {Boolean} opts.promote Should the build be promoted?
   * @param {Function} done Completion callback.
   * @returns {Progress} Expose created progress instance.
   * @api public
   */
  build({ promote, data }, done) {
    const { app } = this;
    const progress = new Progress({
      nsq: {
        writer: this.nsq.writer,
        topic: this.statusTopic,
        log: app.contextLog
      }
    }, done);

    //
    // Compile build specifications from the data.
    //
    app.contextLog.info('compile build spec for %s', data.name, {
      name: data.name
    });

    this.builder.build({ promote, data, progress })
      .then(() => {/* we don't care about the output */})
      .catch(err => done(err));

    return progress;
  }


  /**
   *
   * Create a key based on the spec that is unique to the set of builds
   * @function _key
   * @param {Object} spec - Build spec
   * @returns {String} unique key for given build
   */
  _key(spec) {
    return [spec.name, spec.env, spec.version].join('!');
  }

  /**
   * Prepare the build by unpacking, running npm install and then creating
   * a tarball to be used for extraction when running the actual build.
   *
   * @param {Object} spec Specification object for the given build
   * @param {String} content Base64 string representing the package content
   * @param {StatusWriter} statusWriter The writer for the status-api
   * @api public
   */
  async prepare(spec, content, statusWriter) {
    const { app } = this;
    app.contextLog.info('Prepare build for all locales: %s', spec.name, spec);

    const paths = await this._createPaths(spec);

    //
    // First see if this package has already been built for a different env, we
    // should only build a single version once
    //
    try {
      await this.checkAndDownload(spec, paths);
    } catch (err) {
      if (err.install) {
        await this.packer.repack(spec, content, paths, statusWriter);
      } else {
        throw err;
      }
    }

    return paths;
  }

  /**
   * Check to see if this package version combo exists and download and use that
   * tarball instead if it does
   *
   * @function checkAndDownload
   * @param {Object} spec - specification for build
   * @param {Object} paths - paths object
   * @returns {Promise} completion handler
   * @api private
   */
  checkAndDownload(spec, paths) {
    return new Promise((resolve, reject) => {
      const { app } = this;

      if (!this.cdnup) {
        app.contextLog.info('%s: cdnup not configured. Skip download attempt.', spec.name);
        return reject(errs.create({
          message: 'cdnup is not configured',
          install: true
        }));
      }

      const pkgcloud = this.cdnup.client;
      const filename = `${encodeURIComponent(spec.name)}-${spec.version}.tgz`;

      pkgcloud.getFile(this.cdnup.bucket, filename, (err, file) => {
        if (err || !file) {
          app.contextLog.info('%s: tarball %s not found in remote storage', spec.name, filename);
          return reject(errs.create({
            message: 'Tarball not found',
            install: true
          }));
        }

        function onError(err) {
          app.contextLog.error('Tarball download error for %s: %s', spec.name, err.message);
          reject(err);
        }

        function onFinish() {
          app.contextLog.info('Tarball download ok for %s: %s', spec.name, paths.tarball);
          resolve();
        }

        pkgcloud.download({
          container: this.cdnup.bucket,
          remote: filename
        }).pipe(fs.createWriteStream(paths.tarball))
          .once('error', onError)
          .on('finish', onFinish);
      });
    });
  }

  /**
   * Extract package content from the JSON body.
   *
   * @param {Object} data Package data.
   * @param {Object} spec Descriptive package information.
   * @returns {String} base64 encoded string.
   * @api private
   */
  content(data, spec) {
    const name = spec.name + '-' + spec.version + '.tgz';

    data = data || {};
    data._attachments = data._attachments || {};
    data._attachments[name] = data._attachments[name] || {};

    return data._attachments[name].data || '';
  }

  /**
   * Get the package.json content from the payload.
   *
   * @param {Object} data Payload content.
   * @returns {Object} Package.json
   * @api private
   */
  extractPackage(data) {
    data = data || {};

    //
    // JUST IN CASE we get a cassandra based data piece we check for distTags
    // first
    //
    const version = (data.distTags || data['dist-tags'] || {}).latest;
    return (data.versions || {})[version] || {};
  }

  /**
   * Get allowed locales from the package.json.
   *
   * @param {Object} data Build specifications.
   * @returns {Promise} completion handler
   * @api private
   */
  getLocales(data) {
    return new Promise((resolve) => {
      const { app } = this;
      const cache = [];
      let locales = [];
      let queue;

      /**
       * Setup the queue to get all dependencies per package and push the main
       * package.json as first task.
       */
      app.contextLog.info('calculate locales for %s', data.name, {
        name: data.name
      });

      /**
      * Fetch the package.json of each dependency, ignore already fetched dependencies
      * to prevent circular dependencies from filling up the queue eternally.
      *
      * @param {Object} pkg Package.json object
      * @param {Function} next Completion callback.
      * @api private
      */
      const getDependencies = (pkg, next) => {
        cache.push(pkg.name);

        // Push locales if they are defined as array.
        if (Array.isArray(pkg.locales)) {
          locales.push(pkg.locales.filter(Boolean));
        }

        /**
         * Fetch the package.json of each dependency and add the processed
         * package.json to the queue.
         */
        async.each(Object.keys(pkg.dependencies || {})
          .filter(name => !~cache.indexOf(name)), (name, fn) => {
          this.models.Package.get(name, (err, pkgData) => {
            if (err) return void fn(err);

            queue.push(pkgData || {});
            return void fn();
          });
        }, next);
      };


      queue = async.queue(getDependencies, 100);
      queue.push(this.extractPackage(data));

      /**
       * The async queue completed, calculate the intersect of all locale lists.
       * Fallback to `en-US` if no intersecting locales remain.
       */
      queue.drain = function complete() {
        locales = intersect.apply(intersect, locales);
        app.contextLog.info('calculated locales for %s', data.name, {
          locales: locales,
          name: data.name
        });

        resolve(locales.length ? locales : ['en-US']);
      };
    });
  }

  /**
   * Extract descriptive package information from the JSON body.
   *
   * @param {Object} data Package data.
   * @returns {Promise} completion handler
   * @api private
   */
  async specs(data) {
    const { app } = this;
    const classification = {
      es6: ['es2017', 'es2016', 'es2015', 'es6'],
      browserify: ['browserify'],
      webpack: ['webpack'],
      npm: ['npm']
    };

    let entry;
    let type;

    const pkg = this.extractPackage(data);

    type = fitting(pkg, {
      keyword: 'build',
      classification: classification
    });


    /**
     * Try to infer the build system from package.json properties if no build
     * system type has been found yet.
     */
    if (!type) {
      const properties = Object.keys(pkg);
      type = Object.keys(classification).filter(function checkProperties(key) {
        return ~properties.indexOf(key) && typeof pkg[key] === 'string';
      })[0];
    }

    /**
     * Only use the build property as entry if it is a path or file location,
     * config objects should be ignored.
     */
    if (typeof pkg[type] === 'string') {
      entry = pkg[type];
    }


    // Read the dependency tree and each package.json to determine locales.
    let locales;
    try {
      locales = await this.getLocales(data);
    } catch (e) {
      app.contextLog.error('error constructing spec', e);
      throw e;
    }

    return {
      type: available[available.indexOf(type)],
      env: envs[data.env] || 'dev',
      build: pkg.build !== false,
      version: pkg.version,
      locales: locales,
      name: pkg.name,
      entry: entry
    };
  }

  /**
   * Check the validity of the uuid. Allows defensive querying,
   * e.g. ignore invalid ids asap.
   *
   * @param {String} id Unique id v4.
   * @returns {Boolean} Valid uuid or not.
   * @api public
   */
  valid(id) {
    return /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i.test(id);
  }

  /**
   * Helper method that cleans the temporary build folder.
   * @api private
   */
  purge() {
    const { app, target } = this;
    const age = this.timeout * this.purgeRetries;

    fs.readdir(target, (error, files) => {
      if (error || !files) {
        app.contextLog.error('Error reading files to purge from %s: %s', target, error || 'No files found');
        return;
      }

      files = files.filter(this.valid);
      // MAKE ASYNC/AWAIT
      async.reduce(files, 0, (i, file, next) => {
        file = path.join(target, file);

        fs.stat(file, function getAge(err, stat) {
          if (err) return void next(null, i);

          //
          // Be defensive and use modified time to determine if the folder is older
          // than age (max build time * the numer of attempts + 1). This should
          // prevent child content from being accidently removed at the last
          // millisecond, which could result in a failed build.
          //
          if (Date.now() - age <= new Date(stat.mtime).getTime()) {
            app.contextLog.info('Skip purge of file: %s', file);
            return next(null, i);
          }

          app.contextLog.info('Purge outdated file: %s', file);
          return void rmrf(file, function removed(rmError) {
            next(rmError, i + 1);
          });
        });
      }, (err, n) => {
        if (err) {
          app.contextLog.error(err);
          return void this.emit('purge', error, 0);
        }

        app.contextLog.info('Purged %s outdated files from temporary target location', n);
        return void this.emit('purge', null, n);
      });
    });
  }

  /**
   * Create the given paths for a tarball download or npm install
   *
   * @param {Object} spec Build specification
   * @returns {Promise} Completion handler
   * @api private
   */
  async _createPaths(spec) {
    const { app, installRoot, tarRoot } = this;
    const uniq = `${encodeURIComponent(spec.name)}-${spec.version}-${spec.env}-${crypto.randomBytes(5).toString('hex')}`;
    const installPath = path.join(installRoot, uniq);
    const tarball = path.join(tarRoot, uniq + '.tgz');
    const paths = { installPath, tarball };

    app.contextLog.info('Create paths for %s spec: %s@%s', spec.env, spec.name, spec.version, paths);

    await Promise.all([
      mkdirpAsync(installRoot),
      mkdirpAsync(tarRoot)
    ]);

    return paths;
  }
}

//
// Expose the builder instance.
//
module.exports = function preboot(app, options, done) {
  const config = app.config.get('builder');
  app.construct = new Constructor(app, config);
  done();
};
