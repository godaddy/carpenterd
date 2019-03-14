class Builder {
  constructor(context) {
    // figure we actually need
    this.context = context;
  }

  /**
  * Initiate a new build process as child through Gjallarhorn.
   * @param  {Object} object configuration
   * @param  {Boolean}  options.promote  TBD
   * @param  {Object}  options.data     TBD
   * @param  {Progress}  options.progress TBD
   * @returns {Promise} completion handler
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

    //
    // No-build flag was added to the package.json to indicate there are no build
    // requirements for this package. This should however trigger dependant builds
    // so return early without error.
    //
    if (!spec.type || spec.build === false) {
      this.context.app.contextLog.info('ignoring build, does not meet criteria', spec);
      return progress.ignore();
    }
    //
    // Supply additional configuration. Data will be handed off to the spawned child
    // processes and should not be used elsewhere to prevent contamination of data.
    //
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

    const tasks = spec.locales.map(locale => {
      return new Promise((resolve, reject) => {
        this.context.buildPerLocale({
          progress,
          locale,
          spec
        }, (err, result) => err ? reject(err) : resolve(result));
      });
    });

    try {
      await Promise.all(tasks);
      statusWriter.write(statusKey);
    } catch (err) {
      this.context._buildError(err, spec);
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
}

module.exports = Builder;
