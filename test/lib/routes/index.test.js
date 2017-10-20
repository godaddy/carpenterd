/* eslint max-nested-callbacks: 0 */
'use strict';

const hyperquest = require('hyperquest');
const assume = require('assume');
const path = require('path');
const nock = require('nock');
const url = require('url');
const fs = require('fs');
const sinon = require('sinon');
const Writer = require('../../mocks').Writer;

const Agent = require('http').Agent;

const agent = new Agent({ keepAlive: true });

const application = require('../../../lib/');

describe('Application routes', function () {
  this.timeout(5E5); // eslint-disable-line
  let app;

  const payload = path.join(__dirname, '..', '..', 'fixtures', 'payload-0.0.0.json');
  const configFile = path.join(__dirname, '..', '..', 'config.json');
  function getPayload(filepath) {
    return JSON.parse(fs.readFileSync(filepath)); // eslint-disable-line
  }

  function nockFeedme() {
    nock(app.config.get('feedsme'))
      .post('/change')
      .reply(200, function reply(uri, body) {
        body = JSON.parse(body);

        const pkgjson = getPayload(payload);

        assume(body).is.a('object');
        assume(body.name).equals(pkgjson.name);
        assume(body.version).equals(pkgjson.version);
        assume(body.dependencies).deep.equals(pkgjson.dependencies);

        nock.cleanAll();
        return { ok: true };
      });
  }

  before(function (done) {
    application.start({
      logger: {
        level: 'critical'
      },
      ensure: true,
      config: {
        file: configFile,
        overrides: {
          http: {
            hostname: '127.0.0.1',
            port: 0,
            timeout: 12000000
          },
          builder: {
            topic: 'build'
          }
        }
      }
    }, function (error, appInstance) {
      if (error) return done(error);
      app = appInstance;
      app.nsq = app.nsq || {};
      app.nsq.writer = app.nsq.writer || new Writer();
      app.construct.nsq = app.nsq;
      done(error);
    });
  });

  after(function (done) {
    agent.destroy();
    app.close(done);
  });

  function createRequest(method, pathname, next) {
    const socket = app.servers.http.address();
    const target = {};
    target.port = socket.port;
    target.hostname = '127.0.0.1';

    method = method || 'get';
    target.protocol = 'http:';
    target.pathname = pathname;

    return hyperquest[method](url.format(target), {
      agent: agent,
      headers: {
        'Content-Type': 'application/json'
      }
    }, next);
  }

  describe('/build', function () {
    function validateMessages(data) {
      data = JSON.parse(data);

      assume(data.task).to.not.equal('ignored');
      assume(data).to.have.property('progress');
      assume(data).to.have.property('message');
      assume(data.progress).to.be.a('number');
      assume(data.progress).to.not.equal(-1);
      assume(data.timestamp).to.be.a('number');
      assume(data.id).to.be.a('string');
    }

    it('accepts npm publish JSON payloads and returns finished task messages', function (done) {
      nockFeedme();

      fs.createReadStream(payload)
        .pipe(createRequest('post', 'build'))
        .on('error', done)
        .on('end', done)
        .on('data', validateMessages);
    });

    it('returns an error if payload expectations are not satisfied', function (done) {
      const data = getPayload(payload);

      delete data._attachments;

      const post = createRequest('post', 'build').on('error', done).on('data', function (resData) {
        assume(resData).to.be.an('buffer');
        assume(resData.toString()).to.include('"_attachments" is required');

        done();
      });

      post.end(new Buffer(JSON.stringify(data)));
    });

    it('can create minified builds', function (done) {
      const data = getPayload(payload);
      const spy = sinon.spy(app.construct.nsq.writer, 'publish');
      nockFeedme();
      data.env = 'prod';

      const post = createRequest('post', 'build')
        .on('error', done)
        .on('data', validateMessages)
        .on('end', done);

      post.end(new Buffer(JSON.stringify(data)));

      app.construct.once('queued', function (topic, spec) {
        assume(topic).equals('build');
        assume(spy.called);
        assume(spec.name).equals(data.name);
        assume(spec.env).equals(data.env);
        assume(spec.type);
        assume(spec.version);
        spy.restore();
      });
    });

    it('can run multiple builds for different locales', function (done) {
      const data = getPayload(payload);
      const cache = {};

      let calledOnce = true;
      nockFeedme();

      data.versions['0.0.0'].locales = ['en-US', 'en-GB'];
      const post = createRequest('post', 'build')
        .on('error', done)
        .on('data', function (resData) {
          resData = JSON.parse(resData);
          assume(resData).to.have.property('id');
          assume(app.construct.valid(resData.id)).to.equal(true);
          if (!cache[resData.id]) cache[resData.id] = 0;
          cache[resData.id]++;
        })
        .on('end', function () {
          assume(calledOnce).to.equal(true);
          assume(Object.keys(cache)).to.have.length(2);

          for (const id of Object.keys(cache)) {
            assume(cache[id]).to.equal(3);
          }

          calledOnce = false;
          done();
        });

      post.end(new Buffer(JSON.stringify(data)));
    });

    it('sends the payload to the feedsme service after a successful build', function (next) {

      nockFeedme();

      fs.createReadStream(payload).pipe(createRequest('post', 'build'))
        .on('data', validateMessages)
        .on('end', next)
        .on('error', next);
    });
  });

});
