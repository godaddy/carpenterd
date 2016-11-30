/* eslint max-nested-callbacks: 0 */
/* eslint max-params: 0 */
'use strict';

const EventEmitter = require('events').EventEmitter;
const spawn = require('child_process').spawn;
const intersect = require('lodash.intersection');
const Gjallarhorn = require('gjallarhorn');
const assign = require('object-assign');
const Progress = require('./progress');
const through = require('through2');
const uuid = require('node-uuid');
const crypto = require('crypto');
const mkdirp = require('mkdirp');
const async = require('async');
const rmrf = require('./rmrf');
const tar = require('tar-fs');
const once = require('one-time');
const errs = require('errs');
const path = require('path');
const util = require('util');
const npm = require('./npm');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');

//
// Available build systems.
//
const available = [
  'browserify',
  'webpack',
  'es6'
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
 * @param {Gjallarhorn} horn Child process manager.
 * @param {Object} options Optional.
 * @api public
 */
function Constructor(app, horn, options) {
  const constructor = this;

  EventEmitter.call(this, options);

  this.app = app;
  this.horn = horn;
  this.models = app.models;
  this.throttle = options.throttle || app.config.get('throttle') || 10;

  this.on('error', function errored(spec, progress, data) {
    app.bffs.stop(spec, function removedId(err) {
      data = errs.create(err || data);

      app.contextLog.error('Build %s failed %j', spec.id, data);
      progress.fail(data, spec.id);
    });
  });

  this.on('task', function task(spec, progress, data) {
    app.contextLog.info('Task %s completed, progress %j', data.message, progress.state(spec.id), spec);
    progress.write(data, spec.id);
  });

  this.on('store', function store(spec, progress, data) {
    constructor.store(spec, data);
  });

  this.on('length', function length(spec, progress, data) {
    const amount = Math.floor(data.length);
    progress.steps(spec.id, amount);
  });

  this.on('clear', this.emits('cleared'));

  //
  // Clean the configured temporary build folder, use a 1:1 mapping with the build
  // timeout. Do not run the cleaning if running in development. Default to 15
  // minutes to prevent a interval of 0.
  //
  if (app.config.get('env') !== 'development') setInterval(
    this.purge.bind(this),
    app.config.get('builder').timeout || 15 * 6E4
  );
}

//
// Extend Constructor with event emitting capacities.
//
util.inherits(Constructor, EventEmitter);
Constructor.prototype.emits = require('emits');

/**
 * Get the child by unique id from the active stack.
 *
 * @param {String} id Unique id v4.
 * @returns {Round} Active Gjallarhorn child.
 * @api public
 */
Constructor.prototype.get = function get(id) {
  if (!this.valid(id)) return false;

  return this.horn.active.filter(function filter(build) {
    return build.spec.id === id;
  })[0];
};

/**
 * Check if the current active builds of Gjallarhorn contain the uuid.
 *
 * @param {String} id Unique id v4.
 * @returns {Boolean} Has child with uuid.
 * @api public
 */
Constructor.prototype.has = function has(id) {
  if (!this.valid(id)) return false;

  return this.horn.active.some(function some(build) {
    return build.spec.id === id;
  });
};

/**
 * Check the validity of the uuid. Allows defensive querying,
 * e.g. ignore invalid ids asap.
 *
 * @param {String} id Unique id v4.
 * @returns {Boolean} Valid uuid or not.
 * @api public
 */
Constructor.prototype.valid = function valid(id) {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i.test(id);
};

/**
 * Initiate a new build process as child through Gjallarhorn.
 *
 * @param {Object} data Package data.
 * @param {Function} done Completion callback.
 * @returns {Progress} Expose created progress instance.
 * @api public
 */
Constructor.prototype.build = function build(data, done) {
  const config = this.app.config.get('builder');
  const progress = new Progress(done);
  const bffs = this.app.bffs;
  const constructor = this;
  const app = this.app;

  //
  // Compile build specifications from the data.
  //
  app.contextLog.info('compile build spec for %s', data.name, {
    name: data.name
  });

  constructor.specs(data, function specifications(error, spec) {
    if (error) {
      return void progress.fail(error);
    }
    //
    // No-build flag was added to the package.json to indicate there are no build
    // requirements for this package. This should however trigger dependant builds
    // so return early without error.
    //
    if (!spec.type || spec.build === false) {
      app.contextLog.info('ignoring build, does not meet criteria', spec)
      return progress.ignore();
    }
    //
    // Supply additional configuration. Data will be handed of to the spawned child
    // processes and should not be used elsewhere to prevent contamination of data.
    //
    const content = constructor.content(data, spec);
    spec.source = config.source;
    spec.target = config.target;
    spec.npm = app.config.get('npm');

    app.contextLog.info('Prepare build for all locales, unpack, npm install, repack for %s', spec.name, spec);

    constructor.prepare(spec, content, function (err, paths) {
      if (err) return done(err);

      //
      // Give the child process the path to the tarball to extract which
      // contains the `npm.install`
      //
      spec.content = paths.tarball;

      app.contextLog.info('building %s with spec', data.name, spec);
      //
      //
      // When we are all said and done, end the progress stream
      //
      function finish() {
        app.contextLog.info('Clean up build artifacts for %s', spec.name, spec);
        constructor.cleanup(Object.keys(paths).map(key => paths[key]), (err) => {
          if (err) return done(err);
          app.contextLog.info('Finished build for %s', spec.name, spec);
          progress.end();
        })
      }

      return void async.eachLimit(spec.locales, constructor.throttle, function buildPerLocale(locale, next) {
        const id = uuid.v4();
        progress.start(id);
        const current = assign({
          locale: locale,
          id: id
        }, spec);

        app.withBreadcrumb({
          buildID: id,
          locale: locale,
          name: data.name
        }, app.contextLog.info, function runBuild() {
          app.contextLog.info('Start build for locale %s', locale, {
            locale: locale,
            name: spec.name,
            version: spec.version,
            env: spec.env,
            id: id
          });
          current.destDir = path.join(os.tmpdir(), `${current.id}-publish`);
          /**
          * Report the error to the developer before ending the async loop.
          *
          * @param {Error} err Failed step of the build process.
          * @api private
          */
          function step(err) {
            if (err) {
              progress.fail(err, id);
            }

            next(error);
          }

          //
          // Check if an existing build was running for the same package
          // specifications and environment and simply cancel that build.
          // Assume if running builds cannot be stopped or do not exist that a
          // build can be safely started.
          //
          app.contextLog.info('Destroy any active build for same spec', {
            locale: locale,
            name: spec.name,
            version: spec.version,
            env: spec.env,
            id: id
          });

          constructor.destroy(current, function destroyed(err) {
            if (err) {
              app.contextLog.error('Failed to destroy active build', {
                locale: locale,
                name: spec.name,
                env: spec.env,
                message: err.message,
                stack: err.stack
              });

              return void step(err);
            }

            app.contextLog.info('Start fresh build', {
              locale: locale,
              name: spec.name,
              version: spec.version,
              env: spec.env,
              id: id
            });

            //
            // The same build id for a locale is used for all three build
            // retries. Hence the build id is cached for 3* the configured
            // seconds.
            //
            return void bffs.start(current, id, config.timeout * 3 / 1E3, function started(bffsError) {
              if (bffsError) {
                return void step(bffsError);
              }

              //
              // Launch the build process with the specifications and attach
              // a supervisor to communicate all events back to the developer.
              //
              return void constructor.horn.launch(current, {
                message: constructor.supervise(current, progress)
              }, function build() {
                app.contextLog.info('Finished building %s', id, {
                  locale: locale,
                  version: spec.version,
                  env: spec.env,
                  name: spec.name,
                  id: id
                });

                bffs.stop(current, function stopped(error) {
                  if (error) {
                    app.contextLog.error('Failed to stop/remove build', {
                      locale: locale,
                      env: spec.env,
                      version: spec.version,
                      name: spec.name,
                      id: id
                    });

                    return void step(error);
                  }

                  //
                  // We have finished 1 out of the n number of builds based on
                  // number of locales
                  //
                  app.contextLog.info('Finished building locale %s', locale, {
                    locale: locale,
                    env: spec.env,
                    version: spec.version,
                    name: spec.name,
                    id: id
                  });

                  progress.done(id);
                  return void step();
                });
              });
            });
          });
        });
      }, finish);
    });
  });

  return progress;
};

/**
 * Cleanup the given paths given an array of them
 *
 * @param {Array} paths Paths that need to be removed
 * @param {function} fn Completion function
 */
Constructor.prototype.cleanup = function cleanup(paths, fn) {
  paths = Array.isArray(paths) ? paths : [paths];
  async.each(paths, (path, next) => rmrf(path, next), fn);
};

/**
 * Prepare the build by unpacking, running npm install and then creating
 * a tarball to be used for extraction when running the actual build.
 *
 * @param {Object} spec Specification object for the given build
 * @param {String} content Base64 string representing the package content
 * @param {Function} next Completion callback.
 * @api public
 */
Constructor.prototype.prepare = function prepare(spec, content, next) {
  const config = this.app.config.get('builder');
  const outputRoot = config.install || path.join(os.tmpdir(), 'install');
  const tarRoot = config.tarballs || path.join(os.tmpdir(), 'tarballs');
  const uniq = `${encodeURIComponent(spec.name)}-${spec.version}-${spec.env}-${crypto.randomBytes(5).toString('hex')}`;
  const outputPath = path.join(outputRoot, uniq);
  const tarPath = path.join(tarRoot, uniq + '.tgz');

  async.parallel([
    async.apply(mkdirp, outputRoot),
    async.apply(mkdirp, tarRoot)
  ], (err) => {
    if (err) return next(err);

    const pkgDir = path.join(outputPath, 'package');
    async.series({
      unpack: this.unpack.bind(this, { content, outputPath }),
      install: this.install.bind(this, spec, pkgDir),
      pack: this.pack.bind(this, pkgDir, tarPath)
    }, (err) => {
      if (err) return next(err);
      next(null, { install: outputPath, tarball: tarPath });
    });
  });
};

/**
 * Take the given source directory and create a tarball at the target directory
 *
 * @param {String} source Source directory
 * @param {String} target Target directory
 * @param {Function} next Completion callback.
 * @api public
 */
Constructor.prototype.pack = function pack(source, target, next) {
  const done = once(next);
  tar.pack(source)
    .once('error', done)
    .pipe(zlib.Gzip())
    .once('error', done)
    .pipe(fs.createWriteStream(target))
    .once('error', done)
    .once('finish', done);
};

/**
 * Unpack the base64 string content into a proper directory of code
 *
 * @param {Object} opts Options for process
 * @param {Function} next Completion callback.
 * @api public
 */
Constructor.prototype.unpack = function unpack(opts, next) {
  const stream = through();

  stream
    .pipe(zlib.Unzip())
    .once('error', next)
    .pipe(tar.extract(opts.outputPath))
    .once('error', next)
    .once('finish', next);

  stream.end(new Buffer(opts.content, 'base64'));
};

/**
 * Install the dependencies of the package with npm.
 * Uses the provided environment.
 *
 * @param {Object} spec Spec
 * @param {String} base Path to the package to install
 * @param {Function} next Completion callback.
 * @api public
 */
Constructor.prototype.install = function install(spec, base, next) {
  const npmData = spec.npm;

  npm.install(Object.assign({
    base: base,
    prefix: base,
    env: spec.env
  }, npmData), next || function () {});
};

/**
 * Extract package content from the JSON body.
 *
 * @param {Object} data Package data.
 * @param {Object} spec Descriptive package information.
 * @returns {String} base64 encoded string.
 * @api private
 */
Constructor.prototype.content = function content(data, spec) {
  const name = spec.name + '-' + spec.version + '.tgz';

  data = data || {};
  data._attachments = data._attachments || {};
  data._attachments[name] = data._attachments[name] || {};

  return data._attachments[name].data || '';
};

/**
 * Get the package.json content from the payload.
 *
 * @param {Object} data Payload content.
 * @returns {Object} Package.json
 * @api private
 */
Constructor.prototype.extractPackage = function extractPackage(data) {
  data = data || {};

  //
  // JUST IN CASE we get a cassandra based data piece we check for distTags
  // first
  //
  const version = (data.distTags || data['dist-tags'] || {}).latest;
  return (data.versions || {})[version] || {};
};

/**
 * Get allowed locales from the package.json.
 *
 * @param {Object} data Build specifications.
 * @param {Function} done Completion callback.
 * @api private
 */
Constructor.prototype.getLocales = function getLocales(data, done) {
  const constructor = this;
  const app = this.app;
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
  function getDependencies(pkg, next) {
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
    }), function fetch(name, fn) {
      constructor.models.Package.get(name, function getPackage(err, pkgData) {
        if (err) return void fn(err);

        queue.push(pkgData || {});
        return void fn();
      });
    }, next);
  }

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
};

/**
 * Extract descriptive package information from the JSON body.
 *
 * @param {Object} data Package data.
 * @param {Function} callback Completion callback.
 * @api private
 */
Constructor.prototype.specs = function specs(data, callback) {
  const app = this.app;
  const classification = {
    es6: ['es2017', 'es2016', 'es2015', 'es6'],
    browserify: ['browserify'],
    webpack: ['webpack']
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
};

/**
 * Kill the gjallerhorn child process by id.
 *
 * @param {Object} spec Package details.
 * @param {Error} error Optional error message, used in cancel.
 * @param {Array} messages Optional additional messages.
 * @param {Function} done Completion callback.
 * @api public
 */
Constructor.prototype.destroy = function destroy(spec, error, messages, done) {
  const constructor = this;
  const app = this.app;

  if (typeof error === 'function') {
    done = error;
    error = null;
  }

  if (typeof messages === 'function') {
    done = messages;
    messages = null;
  }

  //
  // Fetch the build id from cache by specifications.
  //
  app.bffs.partial(spec, function found(err, running) {
    if (err) {
      return void done(err);
    }

    return void constructor._stopWorker(spec, running, done);
  });
};

/**
 * Stop a worker child process given an id
 *
 * @param {Object} spec Specification object
 * @param {id} id Id of child process
 * @param {Error} error Error to be passed to Gjhallahorn
 * @param {Array} messages An array of messages to also pass to Gjhallahorn
 * @param {Function} done Completion callback
 * @api private
 */
Constructor.prototype._stopWorker = function _stopWorker(spec, id, error, messages, done) {
  const constructor = this;
  const app = this.app;
  const config = app.config.get('builder');
  const target = config.target;

  if (typeof error === 'function') {
    done = error;
    error = null;
  }

  if (typeof messages === 'function') {
    done = messages;
    messages = null;
  }

  const child = constructor.get(id);
  //
  // XXX: Should we error in the case where we get an invalid child or just ignore?
  //
  app.bffs.stop(spec, function clearBuilds(err) {
    if (err || !child || !('id' in child)) return void done(err);

    return constructor.horn.clear(child.id, error, messages, (e) => {
      constructor.cleanup(path.join(target, id), (er) => {
        done(e || er);
      });
    });
  });
};

/**
 * Cancel all the builds that are currently running that match a given spec
 *
 * @param {Object} spec Package details
 * @param {Error} error Error message to be passed to Gjhallahorn
 * @param {Function} done Completion callback
 * @api public
 */
Constructor.prototype.destroyAll = function cancel(spec, error, done) {
  const app = this.app;

  if (typeof error === 'function') {
    done = error;
    error = null;
  }

  app.bffs.active(spec, (err, jobs) => {
    if (err) return void done(err);

    //
    // Use bffs respec to unpack the full spec including locale for each active
    // job. This fixed a bug where we were not properly removing jobs from redis
    // when we stopped the worker. This was hard to test for because of the
    // raciness of the job finishing and it being cancelled
    //
    return void async.eachSeries(jobs, (job, next) => {
      this._stopWorker(
        app.bffs.respec(job.key), job.value, error, next
      );
    }, done);
  });
};


/**
 * Supervise all messages Gjallerhorn childs.
 *
 * @param {Object} spec Build data.
 * @param {Stream} progress Writable stream.
 * @returns {Function} Message handler.
 * @api private
 */
Constructor.prototype.supervise = function supervise(spec, progress) {
  const constructor = this;
  const app = constructor.app;

  /**
   * Delegate what to do with each type of message coming from factories.
   * The data will already be JSON.parsed by node. Without using a custom parser
   * Buffers will not be instantiated. This recreates Buffers, so binary data
   * is passed around on the main thread and not some weird stringifed Buffers.
   *
   * @param {Object} data Factory data send from the child process.
   * @api private
   */
  return function handler(data) {
    data = data || {};

    //
    // Instantiate Buffers one level deep.
    //
    for (const key of Object.keys(data)) {
      if (data[key] && data[key].type === 'Buffer') {
        data[key] = new Buffer(data[key].data);
      }
    }

    app.contextLog.debug('Received %s message from child %s', data.event, spec.id);
    constructor.emit(data.event || 'error', spec, progress, data);
  };
};

/**
 * Register the end results of the Build File Finder Service.
 *
 * @param {Object} spec Build data.
 * @param {Object} data File data.
 * @api private
 */
Constructor.prototype.store = function store(spec, data) {
  const app = this.app;

  app.contextLog.info('Storing file in BFFS', spec);
  app.bffs.publish(spec, data.files, function (error) {
    if (error) {
      app.contextLog.error(error);
      return;
    }

    //
    // XXX: Do this for now since we want to do a best effort clean here and
    // `purge` does not cover the same directory. We technically need them to be
    // different to prevent a possible race condition as we dont know when this
    // completes
    //
    rmrf(spec.destDir, function () {});
    app.contextLog.info('Published to BFFS: metadata, compressed and plain content', spec);

  });
};

/**
 * Helper method that cleans the temporary build folder.
 *
 * @api private
 */
Constructor.prototype.purge = function purge() {
  const app = this.app;
  const constructor = this;
  const config = app.config.get('builder');
  const age = config.timeout * (config.retries + 2);

  fs.readdir(config.target, function readTarget(error, files) {
    if (error || !files) {
      app.contextLog.error(error);
      return;
    }

    files = files.filter(constructor.valid);
    async.reduce(files, 0, function removeUUIDFolders(i, file, next) {
      file = path.join(config.target, file);

      fs.stat(file, function getAge(err, stat) {
        if (err) return void next(err);

        //
        // Be defensive and use modified time to determine if the folder is older
        // than age (max build time * the numer of attempts + 1). This should
        // prevent child content from being accidently removed at the last
        // millisecond, which could result in a failed build.
        //
        if (Date.now() - age <= new Date(stat.mtime).getTime()) {
          return next(null, i);
        }

        return void rmrf(file, function removed(rmError) {
          next(rmError, i + 1);
        });
      });
    }, function done(err, n) {
      if (err) {
        app.contextLog.error(err);
        return void constructor.emit('purge', error, 0);
      }

      app.contextLog.info('Purged %s outdated files from temporary target location', n);
      return void constructor.emit('purge', null, n);
    });
  });
};

//
// Expose the builder instance.
//
module.exports = function preboot(app, options, done) {
  const config = app.config.get('builder');

  //
  // Setup a new constructor and supply gjallarhorn as child process manager.
  // The `scaffolder` method will setup child process adn expose the build
  // specifications to the child.
  //
  app.construct = new Constructor(app, new Gjallarhorn(config).reload(function scaffolder(data) {
    const silent = app.config.get('env') !== 'development' || app.config.get('logger').silent;
    const env = Object.keys(process.env).reduce((acc, key) => { // eslint disable-line
      acc[key] = process.env[key]; // eslint disable-line
      return acc;
    }, {});
    const type = data.type;

    //
    // Allow a builder to run as production if the destination environment is `prod`
    //
    env.NODE_ENV = ~['prod', 'latest'].indexOf(data.env) ? 'production' : 'development';
    env.CATCH_EXCEPTIONS = true;
    env.LOCALE = env.WRHS_LOCALE = data.locale;

    //
    // Spin up factory build, the spawn stdio options will mute npm output.
    //
    app.contextLog.info('Running %s builder for: %s with locale %s', type, data.name, data.locale);
    const scaffold = spawn(process.execPath, [path.join(__dirname, 'workers', type + '.js')], {
      stdio: silent ? ['ignore', 'ignore', 'ignore', 'ipc'] : [0, 1, 2, 'ipc'],
      env: env
    });

    scaffold.send(data);
    return scaffold;
  }), config);

  done();
};

//
// Extract the type of build we are doing
//
function fitting(data, options) {
  options = options || {};

  //
  // Allow additional rules to be defined and merge against the default.
  //
  var classy =options.classification,
      keyword = options.keyword || 'check',
      match = '';

  //
  // The classification can also be read directly from the data.
  // Allow opt-in for a `keyword`. This defaults to the `check` property.
  //
  if (data[keyword] in classy) return data[keyword];

  //
  // Check if there are keywords in the package.json that gives some intel on
  // which project/team created these packages.
  //
  if (!Array.isArray(data.keywords)) data.keywords = [];

  Object.keys(classy).some(function each(project) {
    var keywords = classy[project];

    if (keywords.some(function some(keyword) {
      return !!~data.keywords.indexOf(keyword);
    })) return !!(match = project);

    return false;
  });

  return match;
}
