/* eslint max-nested-callbacks: 0 */
/* eslint no-invalid-this: 0 */
'use strict';

describe('Constructor', function () {
  this.timeout(3E4);

  const Progress = require('../../../lib/constructor/progress');
  const Gjallarhorn = require('gjallarhorn');
  const assume = require('assume');
  const path = require('path');
  const fs = require('fs');
  const uuid = '87e29af5-094f-48fd-bafa-42e59f88c472';

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
      construct = app.construct;

      //
      // Push a fake child into gjallarhorn.
      //
      construct.horn.active.push({
        id: 1,
        spec: {
          additional: 'specs',
          id: uuid
        }
      });

      done(error);
    });
  });

  after(function (done) {
    app.close(done);
  });

  it('is exposed as singleton instance and wraps gjallarhorn child orchestration', function () {
    assume(construct).is.an('object');
    assume(construct).to.have.property('horn');
    assume(construct.horn).to.be.instanceof(Gjallarhorn);
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

  describe('#get', function () {
    it('is a function', function () {
      assume(construct.get).to.be.a('function');
      assume(construct.get).to.have.length(1);
    });

    it('retrieves the child process by uuid', function () {
      const result = construct.get(uuid);

      assume(result).to.be.an('object');
      assume(result.spec).to.have.property('additional', 'specs');
      assume(result).to.have.property('id', 1);
    });
  });

  describe('#has', function () {
    it('is a function', function () {
      assume(construct.has).to.be.a('function');
      assume(construct.has).to.have.length(1);
    });

    it('checks if the child process exists by uuiid', function () {
      assume(construct.has(uuid)).to.equal(true);
      assume(construct.has(1)).to.equal(false);
    });
  });

  describe('#destroy', function () {
    it('is a function', function () {
      assume(construct.destroy).to.be.a('function');
      assume(construct.destroy).to.have.length(4);
    });

    it('calls the clear method of gjallarhorn', function (done) {
      construct.horn.clear = function stub(id) {
        assume(id).to.equal(1);
      };

      construct.destroy({
        name: 'check-clear',
        version: '1.0.0',
        env: 'test'
      }, function (err) {
        assume(err).to.be.falsey();
        done();
      });
    });

    it('ignores invalid uuid', function (done) {
      let called = false;

      construct.horn.clear = function stub() {
        called = true;
      };

      construct.destroy({
        name: 'invalid id',
        version: '1.0.0',
        env: 'test'
      }, function () {
        assume(called).to.equal(false);
        done();
      });
    });
  });

  describe('#specs', function () {
    let local;

    function data() {
      return {
        name: 'test',
        type: 'something silly',
        'dist-tags': { latest: '1.0.0' },
        env: 'staging',
        versions: {
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
      assume(construct.specs).to.be.a('function');
      assume(construct.specs).to.have.length(2);
    });

    it('returns build specifications bffs understands', function (done) {
      construct.specs(data(), function (err, result) {
        assume(err).to.be.falsey();
        assume(result).to.be.a('object');
        assume(result).to.have.property('type', 'browserify');
        assume(result).to.have.property('version', '1.0.0');
        assume(result).to.have.property('env', 'test');
        assume(result).to.have.property('name', 'test');
        assume(result).to.have.property('entry');

        done();
      });
    });

    it('will not default to any build specifications', function (done) {
      local = data();
      local.build = 'unknown';
      delete local.versions;

      construct.specs(local, function (err, result) {
        assume(err).to.be.falsey();
        assume(result).to.have.property('type');
        assume(result).to.have.property('entry');

        done();
      });
    });

    it('can also use keywords to identify the build type', function (done) {
      local = data();

      local.versions['1.0.0'].keywords = ['es2016'];
      delete local.versions['1.0.0'].build;

      construct.specs(local, function (err, result) {
        assume(err).to.be.falsey();
        assume(result).to.have.property('type', 'es6');

        done();
      });
    });

    it('will check properties on package.json', function (done) {
      local = data();

      delete local.versions['1.0.0'].build;
      construct.specs(local, function (err, result) {
        assume(err).to.be.falsey();
        assume(result).to.be.a('object');
        assume(result).to.have.property('type', 'webpack');
        assume(result).to.have.property('version', '1.0.0');
        assume(result).to.have.property('env', 'test');
        assume(result).to.have.property('name', 'test');
        assume(result).to.have.property('entry', '/path/to/config.js');

        done();
      })
    });

    it('will only supply paths to data.entry if the property matches a builder', function (done) {
      local = data();

      delete local.versions['1.0.0'].build;
      local.versions['1.0.0'].webpack = {
        some: 'unsave object'
      };

      construct.specs(local, function (err, result) {
        assume(err).to.be.falsey();
        assume(result).to.be.a('object');
        assume(result).to.have.property('version', '1.0.0');
        assume(result).to.have.property('env', 'test');
        assume(result).to.have.property('name', 'test');
        assume(result).to.have.property('entry');

        done();
      });
    });
  });

  describe('#getLocales', function () {
    const localeData = {
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          locales: ['en-GB', 'nl-NL', 'de-DE']
        }
      }
    };

    it('is a function', function () {
      assume(construct.getLocales).to.be.a('function');
      assume(construct.getLocales).to.have.length(2);
    });

    it('extracts the package.json from the payload', function (done) {
      construct.getLocales(localeData, function (error, locales) {
        assume(error).to.be.falsey();

        assume(locales).to.be.an('array');
        assume(locales).to.include('nl-NL');

        done();
      });
    });

    it('defaults to en-US if no locale is specified', function (done) {
      delete localeData.versions['1.0.0'].locales

      construct.getLocales(localeData, function (error, locales) {
        assume(error).to.be.falsey();

        assume(locales).to.be.an('array');
        assume(locales).to.include('en-US');

        done();
      });
    });

    it('generates an intersection of locales for all dependencies', function (done) {
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
      }

      localeData.versions['1.0.0'].dependencies = {
        myPackage: 'some latest version',
        react: '0.13.3'
      };

      construct.getLocales(localeData, function (error, locales) {
        assume(error).to.be.falsey();

        assume(locales).to.be.an('array');
        assume(locales).to.include('en-GB');
        assume(locales).to.include('nl-NL');
        assume(locales).to.not.include('de-DE');

        construct.models.Package.get = get;
        done();
      });
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
        versions: {
          '1.0.0': {
            name: 'test'
          }
        }
      });

      assume(pkg).to.be.an('object');
      assume(pkg).to.have.property('name', 'test');
    });
  });

  describe('#supervise', function () {
    it('is a function');
    it('returns a message handler for gjallarhorn');
    it('emits events on the instance based on data');
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

        construct.app.config.set('builder:timeout', -1);
        construct.purge();

        return construct.once('purge', function (err, n) {
          assume(err).to.be.falsey();
          assume(n).to.equal(1);

          fs.readdir(config.target, function (e, files) {
            assume(e).to.be.falsey();
            assume(files.filter(construct.valid)).to.have.length(0);
            construct.app.config.set('builder:timeout', timeout);

            done();
          });
        });
      });
    });
  });

  describe('#build', function () {
    before(function () {
      construct.horn.launch = function (data, handler, next) {
        assume(data).to.have.property('id');
        assume(construct.valid(data.id)).to.equal(true);
        next();
      };
    });

    it('is a function', function () {
      assume(construct.build).to.be.a('function');
      assume(construct.build).to.have.length(2);
    });

    it('launches a build process and returns a progress stream', function () {
      assume(construct.build({
        name: 'test',
        versions: {
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
      })).to.be.instanceof(Progress);
    });

    it('returns early if the package.json has a build flag that is set to false', function (done) {
      const progress = construct.build({
        name: 'test',
        'dist-tags': {
          latest: '1.0.0'
        },
        versions: {
          '1.0.0': {
            build: false
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

    it('provides a supervise message handler to gjallarhorn');
    it('writes a start and end message to the progress stream');
  });
});
