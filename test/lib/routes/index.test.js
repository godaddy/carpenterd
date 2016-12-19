/* eslint max-nested-callbacks: 0 */
'use strict';

const hyperquest = require('hyperquest');
const assume = require('assume');
const path = require('path');
const nock = require('nock');
const zlib = require('zlib');
const url = require('url');
const fs = require('fs');

const Agent = require('http').Agent;

const agent = new Agent({ keepAlive: true, timeout: 12000000 });

let app = require('../../../lib/');

describe('Application routes', function () {
  this.timeout(3E5); // eslint-disable-line

  const payload = path.join(__dirname, '..', '..', 'fixtures', 'payload-0.0.0.json');
  const configFile = path.join(__dirname, '..', '..', 'config.json')
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
    app.start({
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
          }
        }
      }
    }, function (error, appInstance) {
      app = appInstance;
      done(error);
    });
  });

  after(function (done) {
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

      assume(data).to.have.property('event', 'task');
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

      nockFeedme();
      data.env = 'prod';

      const post = createRequest('post', 'build')
        .on('error', done)
        .on('data', validateMessages)
        .on('end', done);

      post.end(new Buffer(JSON.stringify(data)));

      app.construct.once('store', function store(spec, progress, resData) {
        const file = resData.files.files[0];

        assume(file.compressed).is.a('string');
        assume(file.content).is.a('string');

        const output = fs.readFileSync(file.content, 'utf8'); // eslint-disable-line no-sync
        const compressed = fs.readFileSync(file.compressed); // eslint-disable-line no-sync

        assume(output).to.include(
          'value:function(){return _react.React.createElement("p",null,"Browserify'
        );

        // test for gzip header magic numbers and deflate compression
        assume(compressed[0]).to.equal(31);
        assume(compressed[1]).to.equal(139);
        assume(compressed[2]).to.equal(8);

        assume(zlib.gunzipSync(compressed).toString('utf-8')).to.equal(output); // eslint-disable-line
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
            assume(cache[id]).to.equal(10);
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

  describe('/cancel', function () {
    it('accepts name and version parameters', function (done) {
      createRequest('get', '/cancel/test/1.0.0', function (err, res) {
        assume(err).to.be.falsey();
        res.once('end', done);
      }).on('data', function (data) {
        assume(data).to.be.instanceof(Buffer);
        assume(data.toString()).to.equal('build test@1.0.0 cancelled');
      });
    });

    it('will cancel a running build for a specified environment', function (done) {
      const data = getPayload(payload);
      let called = false;

      nockFeedme();
      data.env = 'prod';

      //
      // Add locales to the payload
      //
      const pkg = app.construct.extractPackage(data);
      pkg.locales = ['en-US', 'en-CA'];

      const post = createRequest('post', 'build')
        .on('data', function (resData) {
          resData = JSON.parse(resData);

          //
          // Only try to cancel when the build is actually started
          // not too soon, cutoff is arbitrary.
          //
          if (resData.progress < 20 || called) return;
          called = true;

          const child = app.construct.get(resData.id);
          assume(app.construct.has(resData.id)).to.equal(true);
          assume(child.spec).to.have.property('type', 'es6');
          assume(child.spec).to.have.property('env', 'prod');
          assume(child.spec).to.have.property('name', 'test');
          assume(child.spec).to.have.property('version', '0.0.0');

          createRequest('get', '/cancel/test/0.0.0/prod', function (err, res) {
            assume(err).to.be.falsey();
            //
            // Ensure the build directory was cleaned.
            //
            res.once('end', function () {
              fs.stat(path.join(app.config.get('builder').target, resData.id), function (err) {
                assume(err).is.an('error');
                assume(err.message).to.include('no such file or directory, stat');
                assume(app.construct.has(resData.id)).to.equal(false);
                done();
              });
            });
          }).on('data', function (cancelData) {
            assume(cancelData).to.be.instanceof(Buffer);
            assume(cancelData.toString()).to.equal('build test@0.0.0 cancelled');
          });
        });

      post.end(new Buffer(JSON.stringify(data)));
    });
  });
});
