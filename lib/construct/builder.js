const uuid = require('node-uuid');
const assign = require('object-assign');
const omit = require('lodash.omit');

class Builder {
  constructor(context) {
    this.context = context;
  }

  /**
   *
   * Handle logging and resetting of state for a given build
   * @function _buildError
   * @param {Error} err - Error that occurred
   * @param {Object} spec - Build spec
   * @api private
   */
  _buildError(err, spec) {
    const { app } = this.context;
    app.contextLog.error('Build error occurred, someone should know %s', err.message, {
      name: spec.name,
      env: spec.env,
      version: spec.version
    });
    const key = this.context._key(spec);

    delete this.context.failures[key];
    // We could send a notification of some sort here
  }

  /**
  * Initiate a new build process as child through Gjallarhorn.
   * @param  {Object} object build options
   * @param  {Boolean}  options.promote  Should the build be promoted?
   * @param  {Object}  options.data     package data
   * @param  {Progress}  options.progress Expose created progress instance
   * @returns {Promise} completion handler
   * @api public
   */
  async build({ promote, data, progress }) {
    // will likely need to this.unpack here
    // which means we need to create paths earlier
    let spec;
    try {
      spec = await this.context.specs(data);
    } catch (error) {
      return void progress.fail(error);
    }

    const { statusWriter } = progress;
    spec.promote = promote;
    statusWriter.metadata = spec;

    /**
     * No-build flag was added to the package.json to indicate there are no
     * build requirements for this package. This should however trigger
     * dependent builds so return early without error.
     */
    if (!spec.type || spec.build === false) {
      this.context.app.contextLog.info('ignoring build, does not meet criteria', spec);
      return progress.ignore();
    }

    /**
     * Supply additional configuration. Data will be handed off to the spawne
     * child processes and should not be used elsewhere to prevent contamination
     * of data.
     */
    const content = this.content(data, spec);
    spec.source = this.context.source;
    spec.target = this.context.target;

    const paths = await this.context.prepare(spec, content, statusWriter);

    //
    // Give the child process the path to the tarball to extract which
    // contains the `npm.install`
    //
    this.context.app.contextLog.info('building %s with spec', spec.name, spec);
    const statusKey = 'Queueing all builds';

    statusWriter.writeStart(statusKey);

    const tasks = spec.locales.map(async locale => {
      await this.buildPerLocale({
        progress,
        locale,
        spec
      });
    });

    try {
      await Promise.all(tasks);
      statusWriter.write(statusKey);
    } catch (err) {
      this._buildError(err, spec);
      this.context.app.contextLog.info('Clean up build artifacts for %s', spec.name, spec);
    }

    // When we are all said and done, end the progress stream
    const buildErr = await this.context.cleaner.cleanup(Object.keys(paths).map(key => paths[key]));
    progress.end(buildErr);
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
   * Downloads the package tarball based on the given `spec`, builds that `spec`
   * given the written tarball and reports back via a progress stream
   * @param  {Object}   opts Options for the locale-specific build.
   * @param    {String} opts.locale   BCP-47 locale name (e.g. en-US, fr, etc).
   * @param    {Object} opts.spec     Specification object for the given build.
   * @param    {Stream} opts.progress Progress "pseudo-stream" to report build progress on.
   * @returns {Promise} completion handler
   * @api private
   */
  buildPerLocale({ progress, spec, locale }) {
    const { app, topic } = this.context;
    const id = uuid.v4();

    /**
    * There are 3 events per ID. This is a stub of progress before we
    * remove it in the next pass of the refactor as progress will need to
    * exist in an external service. We use 2 here so that the `finished`
    * event is the only 100 which gets sent when done is called
    */
    progress.start(id, 2, { locale });
    const current = assign({ locale, id }, omit(spec, 'locales'));

    app.contextLog.info('Start build for locale %s', locale, {
      locale,
      name: spec.name,
      version: spec.version,
      env: spec.env,
      promote: spec.promote,
      id
    });

    /**
     * Launch the build process with the specifications and attach
     * a supervisor to communicate all events back to the developer.
     */
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

    this.context.emit('queue', topic, freshSpec);
    return new Promise((resolve, reject) => {
      this.context.nsq.writer.publish(topic, freshSpec, (err) => {
        if (err) {
          app.contextLog.error('Build queue %s for %s env: %s failed %j', current.id, current.name, current.env);
          const key = this.context._key(spec);
          progress.fail(err, id, { locale });
          app.contextLog.error('Error in step %s for %s: %s', err.stack, spec.name, err.message, {
            locale,
            name: spec.name,
            version: spec.version,
            env: spec.env,
            promote: spec.promote,
            id
          });

          this.context.failures[key] = this.context.failures[key] || 0;
          if (++this.context.failures[key] >= this.context.maxFailures) {
            return reject(err);
          }
          return resolve();
        }

        this.context.emit('queued', topic, freshSpec);
        app.contextLog.info('Finished queuing locale %s', locale, {
          locale: locale,
          env: spec.env,
          version: spec.version,
          name: spec.name,
          id: id
        });

        progress.done(id, { locale });
        resolve();
      });
    });
  }
}

module.exports = Builder;
