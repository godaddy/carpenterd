/* eslint max-nested-callbacks: 0 */
/* eslint no-invalid-this: 0 */
/* eslint max-statements: 0 */
'use strict';

const Writer = require('../../mocks').Writer;
const sinon = require('sinon');

describe('Construct', function () {
  this.timeout(3E4);

  const Progress = require('../../../lib/construct/progress');
  const assume = require('assume');
  const path = require('path');
  const fs = require('fs');
  const rip = require('rip-out');
  const uuid = '87e29af5-094f-48fd-bafa-42e59f88c472';
  assume.use(require('assume-sinon'));

  const statusTopic = 'some-status-topic';
  const queueingTopic = 'queue-the-build';
  let app = require('../../../lib');
  let construct;

  before(function (done) {
    app.start({
      logger: {
        level: 'critical'
      },
      ensure: true,
      config: {
        file: path.join(__dirname, '..', '..', 'config.json'),
        overrides: {
          http: 0
        }
      }
    }, function (error, application) {
      app = application;
      app.construct.nsq = app.construct.nsq || {};
      app.construct.nsq.writer = app.construct.nsq.writer || new Writer();
      app.construct.statusTopic = statusTopic;
      app.construct.topic = queueingTopic;
      construct = app.construct;

      done(error);
    });
  });

  after(function (done) {
    app.close(done);
  });
  afterEach(function () {
    sinon.restore();
  });

  function assertNsqLocaleProgress(writerSpy, locale, buildType, promote = false) {
    const commonPayload = {
      name: 'test',
      env: 'dev',
      buildType,
      locale
    };

    assume(writerSpy).is.calledWithMatch(statusTopic, {
      ...commonPayload,
      eventType: 'event',
      message: sinon.match(`Queuing ${buildType} build for test`)
    });
    assume(writerSpy).is.calledWithMatch(statusTopic, {
      ...commonPayload,
      eventType: 'event',
      message: sinon.match('Successfully queued build')
    });

    assume(writerSpy).is.calledWithMatch(queueingTopic, {
      ...rip(commonPayload, 'buildType'),
      type: commonPayload.buildType,
      promote
    });
  }

  it('is exposed as singleton instance and wraps gjallarhorn child orchestration', function () {
    assume(construct).is.an('object');
  });

  it('has warehouse models reference', function () {
    assume(construct.models).to.be.an('object');
    assume(construct.models).to.have.property('Package');
  });

  describe('#valid', function () {
    it('is a function', function () {
      assume(construct.valid).to.be.a('function');
      assume(construct.valid).to.have.length(1);
    });

    it('checks the validatity of an uuid v4', function () {
      assume(construct.valid('87e29af5-094f-48fd-bafa-42e59f88c472')).to.equal(true);
      assume(construct.valid('1')).to.equal(false);
    });
  });

  describe('#specs', function () {
    let local;

    function data() {
      return {
        'name': 'test',
        'type': 'something silly',
        'dist-tags': { latest: '1.0.0' },
        'env': 'staging',
        'versions': {
          '1.0.0': {
            name: 'test',
            build: 'browserify',
            webpack: '/path/to/config.js',
            version: '1.0.0'
          }
        }
      };
    }

    it('is a function', function () {
      assume(construct.specs).to.be.a('asyncfunction');
      assume(construct.specs).to.have.length(1);
    });

    it('returns build specifications bffs understands', async function () {
      const result = await construct.specs(data());
      assume(result).to.be.a('object');
      assume(result).to.have.property('type', 'browserify');
      assume(result).to.have.property('version', '1.0.0');
      assume(result).to.have.property('env', 'test');
      assume(result).to.have.property('name', 'test');
      assume(result).to.have.property('entry');
    });

    it('will not default to any build specifications', async function () {
      local = data();
      local.build = 'unknown';
      delete local.versions;

      const result = await construct.specs(local);
      assume(result).to.have.property('type');
      assume(result).to.have.property('entry');
    });

    it('can also use keywords to identify the build type', async function () {
      local = data();

      local.versions['1.0.0'].keywords = ['es2016'];
      delete local.versions['1.0.0'].build;

      const result = await construct.specs(local);
      assume(result).to.have.property('type', 'es6');
    });

    it('will check properties on package.json', async function () {
      local = data();

      delete local.versions['1.0.0'].build;
      const result = await construct.specs(local);
      assume(result).to.be.a('object');
      assume(result).to.have.property('type', 'webpack');
      assume(result).to.have.property('version', '1.0.0');
      assume(result).to.have.property('env', 'test');
      assume(result).to.have.property('name', 'test');
      assume(result).to.have.property('entry', '/path/to/config.js');
    });

    it('will only supply paths to data.entry if the property matches a builder', async function () {
      local = data();

      delete local.versions['1.0.0'].build;
      local.versions['1.0.0'].webpack = {
        some: 'unsave object'
      };

      const result = await construct.specs(local);

      assume(result).to.be.a('object');
      assume(result).to.have.property('version', '1.0.0');
      assume(result).to.have.property('env', 'test');
      assume(result).to.have.property('name', 'test');
      assume(result).to.have.property('entry');

    });
  });

  describe('#buildOne', function () {
    it('should run buildOne and succeed', function (done) {
      const spec = {
        name: 'test',
        version: '1.0.0',
        env: 'dev',
        type: 'webpack'
      };

      construct.buildOne(spec, function (err) {
        assume(err).is.falsey();
        done();
      });
    });

    it('writes out the expected nsq messages', function (done) {
      const writerSpy = sinon.spy(construct.nsq.writer, 'publish');
      const progress = construct.buildOne({
        name: 'test',
        version: '1.0.0',
        env: 'dev',
        type: 'webpack',
        locale: 'en-LOL'
      }, function (error) {
        assume(error).to.be.falsey();

        // We end the work as soon as everything is queued, even though we may still end up doing a bit more
        setTimeout(() => {
          // start, progress, finished, and actual queueing + progress end
          assume(writerSpy).is.called(4);

          assertNsqLocaleProgress(writerSpy, 'en-LOL', 'webpack', true);

          assume(writerSpy).is.calledWithMatch(statusTopic, {
            eventType: 'queued',
            name: 'test',
            env: 'dev',
            buildType: 'webpack',
            total: 1,
            message: 'Builds Queued'
          });

          done();
        }, 100);
      });

      assume(progress).to.be.instanceof(Progress);
    });
  });

  describe('#_buildError', function () {
    it('should execte _buildError and succeed', function () {
      const spec = {
        name: 'test',
        version: '1.0.0',
        env: 'dev',
        type: 'webpack'
      };

      construct._buildError(new Error('whatever'), spec);
    });
  });

  describe('#getLocales', function () {
    const localeData = {
      'dist-tags': { latest: '1.0.0' },
      'versions': {
        '1.0.0': {
          locales: ['en-GB', 'nl-NL', 'de-DE']
        }
      }
    };

    it('is a function', function () {
      assume(construct.getLocales).to.be.a('function');
      assume(construct.getLocales).to.have.length(1);
    });

    it('extracts the package.json from the payload', async function () {
      const locales = await construct.getLocales(localeData);
      assume(locales).to.be.an('array');
      assume(locales).to.include('nl-NL');
    });

    it('defaults to en-US if no locale is specified', async function () {
      delete localeData.versions['1.0.0'].locales;

      const locales = await construct.getLocales(localeData);
      assume(locales).to.be.an('array');
      assume(locales).to.include('en-US');
    });

    it('generates an intersection of locales for all dependencies', async function () {
      const get = construct.models.Package.get;
      const packages = {
        myPackage: {
          name: 'myPackage',
          locales: ['en-GB', 'nl-NL', 'de-DE'],
          dependencies: {
            subsub: '1.0.0'
          }
        },
        subsub: {
          name: 'subsub',
          locales: ['en-GB', 'nl-NL', 'en-US']
        }
      };

      construct.models.Package.get = function (name, cb) {
        cb(null, packages[name]);
      };

      localeData.versions['1.0.0'].dependencies = {
        myPackage: 'some latest version',
        react: '0.13.3'
      };

      const locales = await construct.getLocales(localeData);
      assume(locales).to.be.an('array');
      assume(locales).to.include('en-GB');
      assume(locales).to.include('nl-NL');
      assume(locales).to.not.include('de-DE');
      construct.models.Package.get = get;
    });
  });

  describe('#extractPackage', function () {
    it('is a function', function () {
      assume(construct.extractPackage).to.be.a('function');
      assume(construct.extractPackage).to.have.length(1);
    });

    it('extracts the package.json from the payload', function () {
      const pkg = construct.extractPackage({
        'dist-tags': { latest: '1.0.0' },
        'versions': {
          '1.0.0': {
            name: 'test'
          }
        }
      });

      assume(pkg).to.be.an('object');
      assume(pkg).to.have.property('name', 'test');
    });
  });

  describe('#purge', function () {
    it('is a function', function () {
      assume(construct.purge).to.be.a('function');
      assume(construct.purge).to.have.length(0);
    });

    it('will remove folders that have exceeded timeout duration * retries', function (done) {
      const config = construct.app.config.get('builder');
      const timeout = config.timeout;

      fs.mkdir(path.join(config.target, uuid), function (error) {
        if (error) return done(error);

        construct.timeout = -1;
        construct.purge();

        return construct.once('purge', function (err, n) {
          assume(err).to.be.falsey();
          assume(n).to.equal(1);

          fs.readdir(config.target, function (e, files) {
            assume(e).to.be.falsey();
            assume(files.filter(construct.valid)).to.have.length(0);
            construct.timeout = timeout;

            done();
          });
        });
      });
    });
  });

  describe('#build', function () {
    it('is a function', function () {
      assume(construct.build).to.be.a('function');
      assume(construct.build).to.have.length(2);
    });

    it('launches a build process and returns a progress stream', function (done) {
      const prepareStub = sinon.stub(Object.getPrototypeOf(construct), 'prepare').resolves({});
      const progress = construct.build({
        promote: false,
        data: {
          'name': 'test',
          'versions': {
            '1.0.0': {
              name: 'test',
              keywords: [
                'es6'
              ]
            }
          },
          'dist-tags': {
            latest: '1.0.0'
          }
        }
      }, function (error) {
        assume(error).to.be.falsey();
        assume(prepareStub).is.called(1);
        done();
      });

      assume(progress).to.be.instanceof(Progress);
    });

    it('returns early if the package.json has a build flag that is set to false', function (done) {
      const progress = construct.build({
        promote: false,
        data: {
          'name': 'test',
          'dist-tags': {
            latest: '1.0.0'
          },
          'versions': {
            '1.0.0': {
              build: false
            }
          }
        }
      }, function (error) {
        assume(error).to.be.falsey();
        done();
      });

      progress.stream.once('data', function (data) {
        data = JSON.parse(data);

        assume(data).to.have.property('progress', -1);
        assume(data).to.have.property('message', 'ignored');
        assume(data).to.have.property('event', 'task');
      });
    });

    it('writes out the expected nsq messages', function (done) {
      const writerSpy = sinon.spy(construct.nsq.writer, 'publish');
      const constructProto = Object.getPrototypeOf(construct);
      const prepareStub = sinon.stub(constructProto, 'prepare').resolves({});
      const getLocalesStub = sinon.stub(constructProto, 'getLocales').resolves(['en-LOL', 'not-REAL']);

      const progress = construct.build({
        promote: false,
        data: {
          'name': 'test',
          'versions': {
            '1.0.0': {
              name: 'test',
              keywords: [
                'es6'
              ]
            }
          },
          'dist-tags': {
            latest: '1.0.0'
          }
        }
      }, function (error) {
        assume(error).to.be.falsey();
        assume(prepareStub).is.called(1);
        assume(getLocalesStub).is.called(1);
        // We end the work as soon as everything is queued, even though we may still end up doing a bit more
        setTimeout(() => {
          // start, progress, finished, and actual queueing per locale (en-LOL, not-REAL) and progress start/end
          assume(writerSpy).is.called(9);

          assertNsqLocaleProgress(writerSpy, 'en-LOL', 'es6');
          assertNsqLocaleProgress(writerSpy, 'not-REAL', 'es6');

          assume(writerSpy).is.calledWithMatch(statusTopic, {
            eventType: 'queued',
            name: 'test',
            env: 'dev',
            buildType: 'es6',
            total: 2,
            message: 'Builds Queued'
          });

          done();
        }, 100);
      });

      assume(progress).to.be.instanceof(Progress);
    });
  });
});
