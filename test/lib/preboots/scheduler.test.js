/* eslint max-nested-callbacks: 0 */
/* eslint no-invalid-this: 0 */

const Writer = require('../../mocks').Writer;
const clone = require('clone');
const assume = require('assume');
const sinon = require('sinon');
const packages = require('../../fixtures/packages.json');
const heads = require('../../fixtures/heads');
const path = require('path');

describe('Scheduler', function () {
  this.timeout(5E4);
  let app = require('../../../lib');
  let sandbox;
  let scheduler;

  before(function (done) {
    app.start({
      logger: {
        level: 'critical'
      },
      ensure: true,
      config: {
        file: path.join(__dirname, '..', '..', 'config.json'),
        overrides: {
          http: 0,
          scheduler: {
            topic: 'testing'
          }
        }
      }
    }, function (err, application) {
      if (err) return done(err);
      app = application;
      app.nsq = app.nsq || {};
      app.nsq.writer = app.nsq.writer || new Writer();
      app.scheduler.nsq = app.nsq;
      scheduler = app.scheduler;
      done();
    });
  });


  after(function (done) {
    app.close(done);
  });

  beforeEach(function () {
    sandbox = sinon.sandbox.create();
  });

  afterEach(function () {
    sandbox.restore();
  });

  it('setInterval should schedule a job that completes', function (done) {
    sandbox.stub(scheduler.models.PackageCache, 'findAll').yieldsAsync(null, clone(packages));
    const headStub = sandbox.stub(scheduler.models.BuildHead, 'findAll');
    headStub.onCall(0).yieldsAsync(null, clone(heads.same['my-client-side-package']));
    headStub.onCall(1).yieldsAsync(null, clone(heads.same['my-other-client-side-package']));

    scheduler.once('scheduled', (err, counts) => {
      const keys = Object.keys(counts);
      assume(keys.length).equals(2);
      keys.forEach(k => {
        assume(counts[k]).equals(0);
      });
      scheduler.clear('test');
      done();
    });
    scheduler.setInterval('test', 1000);
  });

  it('clear should clear any setIntervals that have been called', function () {
    scheduler.setInterval('test');
    scheduler.setInterval('prod');
    scheduler.setInterval('dev');
    assume(Array.from(scheduler.intervals.keys()).length).equals(3);
    scheduler.clear();
    assume(Array.from(scheduler.intervals.keys()).length).equals(0);
  });

  it('should trigger a single build for each package when running schedule', function (done) {
    sandbox.stub(scheduler.models.PackageCache, 'findAll').yieldsAsync(null, clone(packages));
    const headStub = sandbox.stub(scheduler.models.BuildHead, 'findAll');
    headStub.onCall(0).yieldsAsync(null, clone(heads.missing['my-client-side-package']));
    headStub.onCall(1).yieldsAsync(null, clone(heads.missing['my-other-client-side-package']));

    scheduler.schedule('test', function (err, counts) {
      assume(err).is.falsey();
      const keys = Object.keys(counts);
      assume(keys.length).equals(2);
      keys.forEach(k => {
        assume(counts[k]).equals(1);
      });
      done();
    });
  });

  it('should trigger zero builds when there are no behind packages', function (done) {
    sandbox.stub(scheduler.models.PackageCache, 'findAll').yieldsAsync(null, clone(packages));
    const headStub = sandbox.stub(scheduler.models.BuildHead, 'findAll');
    headStub.onCall(0).yieldsAsync(null, clone(heads.same['my-client-side-package']));
    headStub.onCall(1).yieldsAsync(null, clone(heads.same['my-other-client-side-package']));

    scheduler.schedule('test', function (err, counts) {
      assume(err).is.falsey();
      const keys = Object.keys(counts);
      assume(keys.length).equals(2);
      keys.forEach(k => {
        assume(counts[k]).equals(0);
      });
      done();
    });
  });

});
