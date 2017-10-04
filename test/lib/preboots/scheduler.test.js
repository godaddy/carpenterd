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

  let app = require('../../../lib');
  let sandbox;

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
    }, function (err, application) {
      app = application;
      app.nsq = app.nsq || {};
      app.nsq.writer = app.nsq.writer || new Writer();
      console.log(app.scheduler);
      app.scheduler.nsq = app.nsq;
      scheduler = app.scheduler
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
  })

  it('should trigger a single build for each package when running schedule', function (done) {
    sandbox.stub(scheduler, 'packages').yieldsAsync(null, clone(packages));
    const headStub = sandbox.stub(scheduler.bffs.heads);
    headStub.onCall(0).yieldsAsync(null, heads.missing['my-client-side-package']);
    headStub.onCall(1).yieldsAsync(null, heads.missing['my-other-client-side-package']);

    scheduler.schedule('test', function (err, counts) {
      console.dir(arguments);
      done();
    });
  });

});
