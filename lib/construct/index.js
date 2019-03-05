/* eslint max-params: 0 */
'use strict';

const EventEmitter = require('events').EventEmitter;
const intersect = require('lodash.intersection');
const assign = require('object-assign');
const Progress = require('./progress');
const { promisify } = require('util')
const through = require('through2');
const Packer = require('./packer');
const uuid = require('node-uuid');
const crypto = require('crypto');
const mkdirp = require('mkdirp');
const async = require('async');
const errs = require('errs');
const fitting = require('./fitting');
const rmrf = require('./rmrf');
const tar = require('tar-fs');
const once = require('one-time');
const path = require('path');
const npm = require('./npm');
const zlib = require('zlib');
const omit = require('lodash.omit');
const fs = require('fs');
const os = require('os');
const retry = require('retryme');
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
    const progress = new Progress({
      nsq: {
        writer: this.nsq.writer,
        topic: this.statusTopic
      }
    }, done);
    const { app } = this;
    const { statusWriter } = progress;

    //
    // Compile build specifications from the data.
    //
    app.contextLog.info('compile build spec for %s', data.name, {
      name: data.name
    });

    // will likely need to this.unpack here
    // which means we need to create paths earlier
    //

    // MAKE ASYNC/AWAIT
    this.specs(data, (error, spec) => {
      if (error) {
        return void progress.fail(error);
      }

      spec.promote = promote;
      statusWriter.metadata = spec;

      //
      // No-build flag was added to the package.json to indicate there are no build
      // requirements for this package. This should however trigger dependant builds
      // so return early without error.
      //
      if (!spec.type || spec.build === false) {
        app.contextLog.info('ignoring build, does not meet criteria', spec);
        return progress.ignore();
      }
      //
      // Supply additional configuration. Data will be handed off to the spawned child
      // processes and should not be used elsewhere to prevent contamination of data.
      //
      const content = this.content(data, spec);
      spec.source = this.source;
      spec.target = this.target;

      // MAKE ASYNC/AWAIT
      this.prepare(spec, content, statusWriter, (err, paths) => {
        if (err) return done(err);

        //
        // Give the child process the path to the tarball to extract which
        // contains the `npm.install`
        //
        app.contextLog.info('building %s with spec', spec.name, spec);
        const statusKey = 'Queueing all builds';

        //
        //
        // When we are all said and done, end the progress stream
        //
        const finish = (err) => {
          if (err) this._buildError(err, spec);
          app.contextLog.info('Clean up build artifacts for %s', spec.name, spec);
          this.cleanup(Object.keys(paths).map(key => paths[key]), (err) => {
            progress.end(err);
            if (err) return done(err);
            app.contextLog.info('Finished build for %s', spec.name, spec);
          });
        };

        statusWriter.writeStart(statusKey);
        // MAKE ASYNC/AWAIT
        return void async.each(spec.locales, (locale, next) => {
          this.buildPerLocale({
            progress,
            locale,
            spec
          }, next);
        }, statusWriter.writeWrap(statusKey, finish));
      });
    });

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
   *
   * Handle logging and resetting of state for a given build
   * @function _buildError
   * @param {Error} err - Error that occurred
   * @param {Object} spec - Build spec
   */
  _buildError(err, spec) {
    const { app } = this;
    app.contextLog.error('Build error occurred, someone should know %s', err.message, {
      name: spec.name,
      env: spec.env,
      version: spec.version
    });
    const key = this._key(spec);

    delete this.failures[key];

    // We could send a notification of some sort here
  }

  /**
   * Builds the `opts.spec` for the given `opts.locale` and reports progress
   * to the Progress "pseudo-stream" at `opts.progress`.
   * @param  {Object}   spec Options for the locale-specific build.
   * @param    {String} spec.locale The locale for the given build
   * @param    {String} spec.version The version of the package being built
   * @param    {String} spec.name The name of the package being built
   * @param    {String} spec.env The environment the package is being built for
   * @param    {String} spec.type The type of build we are running
   * @param  {Function} next Continuation to respond to when complete.
   * @returns {Stream} progress stream
   */
  // MAKE ASYNC/AWAIT
  buildOne(spec, next) {
    const { app } = this;
    const progress = new Progress({
      nsq: {
        writer: this.nsq.writer,
        topic: this.statusTopic
      },
      metadata: spec
    }, next);
    const locale = spec.locale;

    // for api compatability. buildOne is v1 and should always promote
    spec.promote = true;

    //
    // When we are all said and done, end the progress stream
    //
    function finish(error) {
      app.contextLog.info('Finished queuing builds for %s', spec.name, spec);
      progress.end(error);
    }

    //
    // Set other required bits on spec
    //
    spec.type = spec.type || 'webpack';

    this.buildPerLocale({
      locale,
      progress,
      spec
    }, finish);

    return progress;
  }

  /**
   * Downloads the package tarball based on the given `spec`, builds that `spec`
   * given the written tarball and reports back via a progress stream
   * @function buildPerLocale
   * @param  {Object}   opts Options for the locale-specific build.
   * @param    {String} opts.locale   BCP-47 locale name (e.g. en-US, fr, etc).
   * @param    {Object} opts.spec     Specification object for the given build.
   * @param    {Stream} opts.progress Progress "pseudo-stream" to report build progress on.
   * @param  {Function} next Continuation to respond to when complete.
   * @returns {undefined}
   */
  buildPerLocale(opts, next) {
    const { progress, spec, locale } = opts;
    const { app, topic } = this;
    const id = uuid.v4();

    //
    // There are 3 events per ID. This is a stub of progress before we
    // remove it in the next pass of the refactor as progress will need to
    // exist in an external service. We use 2 here so that the `finished`
    // event is the only 100 which gets sent when done is called
    //
    progress.start(id, 2, { locale });
    const current = assign({
      locale,
      id
    }, omit(spec, 'locales'));

    app.contextLog.info('Start build for locale %s', locale, {
      locale: locale,
      name: spec.name,
      version: spec.version,
      env: spec.env,
      promote: spec.promote,
      id: id
    });

    /**
      * Report the error to the developer before ending the async loop.
      *
      * @param {Error} err Failed step of the build process.
      * @param {String} type Type of error
      * @returns {undefined}
      * @api private
      */
    const step = (err, type) => {
      const key = this._key(spec);
      if (err) {
        progress.fail(err, id, { locale });
        app.contextLog.error('Error in step %s for %s: %s', type, spec.name, err.message, {
          locale: locale,
          name: spec.name,
          version: spec.version,
          env: spec.env,
          promote: spec.promote,
          id: id
        });

        this.failures[key] = this.failures[key] || 0;
        if (++this.failures[key] >= this.maxFailures)
          return next(err);
      }
      next();
    };

    //
    // Launch the build process with the specifications and attach
    // a supervisor to communicate all events back to the developer.
    //
    progress.write({
      locale,
      progress: true,
      message: `Queuing ${current.type} build for ${current.name}`,
      id
    });

    const freshSpec = {
      name: spec.name,
      env: spec.env,
      version: spec.version,
      locale: locale,
      type: spec.type,
      promote: spec.promote
    };

    this.emit('queue', topic, freshSpec);
    // MAKE ASYNC/AWAIT
    return this.nsq.writer.publish(topic, freshSpec, (err) => {
      if (err) {
        app.contextLog.error('Build queue %s for %s env: %s failed %j', current.id, current.name, current.env);
        return step(err);
      }

      this.emit('queued', topic, freshSpec);
      app.contextLog.info('Finished queuing locale %s', locale, {
        locale: locale,
        env: spec.env,
        version: spec.version,
        name: spec.name,
        id: id
      });

      progress.done(id, { locale });
      return void step();
    });

  }

  /**
   * Cleanup the given paths given an array of them
   *
   * @param {Array} paths Paths that need to be removed
   * @param {function} fn Completion function
   * @async
   */
  cleanup(paths, fn) {
    const { app } = this;
    paths = Array.isArray(paths) ? paths : [paths];
    // MAKE ASYNC/AWAIT
    async.each(paths, (path, next) => {
      app.contextLog.info('Cleanup path: %s', path);
      rmrf(path, next);
    }, fn);
  }

  /**
   * Prepare the build by unpacking, running npm install and then creating
   * a tarball to be used for extraction when running the actual build.
   *
   * @param {Object} spec Specification object for the given build
   * @param {String} content Base64 string representing the package content
   * @param {StatusWriter} statusWriter The writer for the status-api
   * @param {Function} next Completion callback.
   * @api public
   */
  prepare(spec, content, statusWriter, next) {
    const { app } = this;
    app.contextLog.info('Prepare build for all locales: %s', spec.name, spec);

    // MAKE ASYNC/AWAIT
    this._createPaths(spec, (err, paths) => {
      if (err) return next(err);

      //
      // First see if this package has already been built for a different env, we
      // should only build a single version once
      //
      this.checkAndDownload(spec, paths, async (err) => {
        if (err) {
          if(err.install) {
            await this.repack(spec, content, paths, statusWriter)
          } else {
            next(err);
          }
        }

        next(null, paths);
      });
    });
  }

  /**
   * Check to see if this package version combo exists and download and use that
   * tarball instead if it does
   *
   * @function checkAndDownload
   * @param {Object} spec - specification for build
   * @param {Object} paths - paths object
   * @param {Function} next - go to the next step and run builds
   * @returns {undefined}
   * @api private
   */
  checkAndDownload(spec, paths, next) {
    const { app } = this;
    if (!this.cdnup) {
      app.contextLog.info('%s: cdnup not configured. Skip download attempt.', spec.name);
      return void next(errs.create({
        message: 'cdnup is not configured',
        install: true
      }));
    }

    const pkgcloud = this.cdnup.client;
    const filename = `${encodeURIComponent(spec.name)}-${spec.version}.tgz`;

    // MAKE ASYNC/AWAIT
    return void pkgcloud.getFile(this.cdnup.bucket, filename, (err, file) => {
      if (err || !file) {
        app.contextLog.info('%s: tarball %s not found in remote storage', spec.name, filename);
        return void next(errs.create({
          message: 'Tarball not found',
          install: true
        }));
      }

      function onError(err) {
        app.contextLog.error('Tarball download error for %s: %s', spec.name, err.message);
        next(err);
      }

      function onFinish() {
        app.contextLog.info('Tarball download ok for %s: %s', spec.name, paths.tarball);
        next();
      }

      pkgcloud.download({
        container: this.cdnup.bucket,
        remote: filename
      }).pipe(fs.createWriteStream(paths.tarball))
        .once('error', onError)
        .on('finish', onFinish);
    });
  }

  /**
   * Performs a full npm install & repack operation:
   * 1. Unpack the npm publish payload tarball
   * 2. Run `npm install` in that directory
   * 3. Create a new tarball from that directory (this includes node_modules)
   * 4. Upload that re-packed tarball to S3-compatible CDN
   *
   * @param   {Object} spec - specification for build
   * @param   {String} content – base64 encoded tarball content
   * @param   {Object} paths - paths object
   * @param   {StatusWriter} statusWriter - The writer for the status-api
   */
  async repack(spec, content, paths, statusWriter) {
    const { tarball, installPath } = paths;
    const pkgDir = path.join(installPath, 'package');
    const { app } = this;

    app.contextLog.info('Begin npm install & tarball repack', spec.name, spec);

    await this.packer.unpack({ content, installPath, statusWriter });
    await this.packer.install({ spec, installPath, statusWriter });
    // no idea why this doesn't transfer well but I'll move it over later
    // when I have time to debug it
    await new Promise((resolve, reject) => {
      this.pack(pkgDir, tarball, statusWriter, (err) => {
        err ? reject(err) : resolve();
      });
    });
    await this.packer.upload({spec, tarball, statusWriter});

    return { install: installPath, tarball };
  }

  /**
   * Take the given source directory and create a tarball at the target directory
   *
   * @param {String} source Source directory
   * @param {String} target Target directory
   * @param {StatusWriter} statusWriter The writer for the status-api
   * @param {Function} next Completion callback.
   * @api public
   */
  pack(source, target, statusWriter, next) {
    const statusKey = 'packing';
    const done = once(statusWriter.writeWrap(statusKey, next));
    statusWriter.writeStart(statusKey);
    // MAKE ASYNC/AWAIT (wrap as promise)
    tar.pack(source)
      .once('error', done)
      .pipe(zlib.Gzip()) // eslint-disable-line new-cap
      .once('error', done)
      .pipe(fs.createWriteStream(target))
      .once('error', done)
      .once('finish', done);
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
   * @param {Function} done Completion callback.
   * @api private
   */
  getLocales(data, done) {
    const { app } = this;
    const cache = [];
    let locales = [];
    let queue;

    /**
     * Fetch the package.json of each dependency, ignore already fetched dependencies
     * to prevent circular dependencies from filling up the queue eternally.
     *
     * @param {Object} pkg Package.json object
     * @param {Function} next Completion callback.
     * @api private
     */
    // MAKE ASYNC/AWAIT
    const getDependencies = (pkg, next) => {
      cache.push(pkg.name);

      //
      // Push locales if they are defined as array.
      //
      if (Array.isArray(pkg.locales)) {
        locales.push(pkg.locales.filter(Boolean));
      }

      //
      // Fetch the package.json of each dependency and add
      // the processed package.json to the queue.
      //
      async.each(Object.keys(pkg.dependencies || {}).filter(function filterDeps(name) {
        return !~cache.indexOf(name);
      }), (name, fn) => {
        this.models.Package.get(name, (err, pkgData) => {
          if (err) return void fn(err);

          queue.push(pkgData || {});
          return void fn();
        });
      }, next);
    };

    //
    // Setup the queue to get all dependencies per package and push the main
    // package.json as first task.
    //
    app.contextLog.info('calculate locales for %s', data.name, {
      name: data.name
    });

    queue = async.queue(getDependencies, 100);
    queue.push(this.extractPackage(data));

    //
    // The async queue completed, calculate the intersect of all locale lists.
    // Fallback to `en-US` if no intersecting locales remain.
    //
    queue.drain = function complete() {
      locales = intersect.apply(intersect, locales);
      app.contextLog.info('calculated locales for %s', data.name, {
        locales: locales,
        name: data.name
      });

      done(null, locales.length ? locales : ['en-US']);
    };
  }

  /**
   * Extract descriptive package information from the JSON body.
   *
   * @param {Object} data Package data.
   * @param {Function} callback Completion callback.
   * @api private
   */
  specs(data, callback) {
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

    function done(err, spec) {
      if (err) {
        app.contextLog.error('error constructing spec', err);
        return void callback(err);
      }

      return void callback(err, spec);
    }

    //
    // Try to infer the build system from package.json properties if no
    // build system type has been found yet.
    //
    if (!type) {
      const properties = Object.keys(pkg);
      type = Object.keys(classification).filter(function checkProperties(key) {
        return ~properties.indexOf(key) && typeof pkg[key] === 'string';
      })[0];
    }

    //
    // Only use the build property as entry if it is a path or file location,
    // config objects should be ignored.
    //
    if (typeof pkg[type] === 'string') {
      entry = pkg[type];
    }

    //
    // Read the dependency tree and each package.json to determine locales.
    //
    // MAKE ASYNC/AWAIT
    this.getLocales(data, function foundPossibleLocales(error, locales) {
      if (error) {
        return void done(error);
      }

      return void done(null, {
        type: available[available.indexOf(type)],
        env: envs[data.env] || 'dev',
        build: pkg.build !== false,
        version: pkg.version,
        locales: locales,
        name: pkg.name,
        entry: entry
      });
    });
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
   * @param {function} next Completion function
   */
  _createPaths(spec, next) {
    const { app, installRoot, tarRoot } = this;
    const uniq = `${encodeURIComponent(spec.name)}-${spec.version}-${spec.env}-${crypto.randomBytes(5).toString('hex')}`;
    const installPath = path.join(installRoot, uniq);
    const tarball = path.join(tarRoot, uniq + '.tgz');
    const paths = { installPath, tarball };

    app.contextLog.info('Create paths for %s spec: %s@%s', spec.env, spec.name, spec.version, paths);

    // MAKE ASYNC/AWAIT Promise.all
    async.parallel([
      async.apply(mkdirp, installRoot),
      async.apply(mkdirp, tarRoot)
    ], (err) => next(err, paths));
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
