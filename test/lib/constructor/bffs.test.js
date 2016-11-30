'use strict';

describe('BFFS', function () {
  const assume = require('assume');
  const path = require('path');
  const BFFS = require('bffs');

  let app = require('../../../lib');
  let bffs;

  this.timeout(3E4) // eslint-disable-line

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
      bffs = app.bffs;

      done(error);
    });
  });

  after(function (done) {
    app.close(done);
  });

  it('is exposed as singleton instance', function () {
    assume(app.bffs).is.an('object');
    assume(app.bffs).to.equal(bffs);
    assume(app.bffs).to.be.instanceof(BFFS);
  });

  it('provides an interface to the build files finder service', function () {
    assume(bffs.build).to.be.a('function');
    assume(bffs.search).to.be.a('function');
    assume(bffs.publish).to.be.a('function');
  });
});
