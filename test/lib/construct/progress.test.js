'use strict';
/* eslint max-statements: 0 */

describe('Progress', function () {
  const Progress = require('../../../lib/construct/progress');
  const uuid = '87e29af5-094f-48fd-bafa-42e59f88c472';
  const Stream = require('stream');
  const rip = require('rip-out');
  const assume = require('assume');
  const sinon = require('sinon');
  assume.use(require('assume-sinon'));

  const nsqTopic = 'not-the-real-status-topic';
  let progress;
  let nsqProgress;
  let writerSpy;
  const nsqMetadata = {
    name: 'somePkg',
    env: 'lol',
    version: '1.2.3.4.5',
    type: 'tessellate'
  };
  const nsqExpected = {
    ...rip(nsqMetadata, 'type'),
    buildType: nsqMetadata.type,
    locale: 'lol-CAT'
  };

  function extend(options, streamId, next) {
    progress.write = function (data, id) {
      /* eslint callback-return: 0 */
      assume(id).equals(streamId);
      assume(data).to.be.an('object');

      for (const key of Object.keys(options)) {
        assume(data).to.have.property(key, options[key]);
      }

      if (typeof next === 'function') next();

      return progress;
    };
  }

  beforeEach(function () {
    progress = new Progress();
    const writer = { publish: function () {} };
    nsqProgress = new Progress({
      nsq: {
        topic: nsqTopic,
        writer: writer
      },
      metadata: nsqMetadata
    });
    writerSpy = sinon.spy(writer, 'publish');
  });

  afterEach(function () {
    progress = null;
    nsqProgress = null;
    writerSpy = null;
  });

  it('is exposed as constructor', function () {
    assume(Progress).is.an('function');
    assume(progress).to.be.instanceof(Progress);
  });

  describe('#fail', function () {
    it('is a function', function () {
      assume(progress.fail).to.be.a('function');
      assume(progress.fail).to.have.length(2);
    });

    it('writes the the error to stream', function (done) {
      const msg = 'testing message';

      extend({
        event: 'error',
        message: msg
      }, uuid, done);

      progress.fail(new Error(msg), uuid);
    });

    it('converts strings to errors', function (done) {
      const msg = 'no error will be converted';

      extend({
        event: 'error',
        message: msg
      }, uuid, done);

      progress.fail(msg, uuid);
    });

    it('can handle native node errors', function (done) {
      const err = {
        code: 'ENOENT',
        path: '/some/test/file'
      };

      extend({
        event: 'error',
        message: err.code + ': ' + err.path
      }, uuid, done);

      progress.fail(err, uuid);
    });
  });

  describe('#start', function () {
    it('is a function', function () {
      assume(progress.start).to.be.a('function');
      assume(progress.start).to.have.length(2);
    });

    it('writes default start object data to stream', function (done) {
      extend({
        event: 'task',
        message: 'start',
        progress: 0
      }, uuid, done);

      progress.start(uuid);
    });

    it('ignores start event when writing to NSQ', function () {
      nsqProgress.start(uuid, 2, { locale: nsqExpected.locale });
      assume(writerSpy).is.not.calledWithMatch(nsqTopic, {
        eventType: 'event',
        message: sinon.match(`start\nProgress: 0`),
        ...nsqExpected
      });
    });
  });

  describe('#done', function () {
    it('is a function', function () {
      assume(progress.done).to.be.a('function');
      assume(progress.done).to.have.length(1);
    });

    it('writes default start object data to stream', function (done) {
      extend({
        event: 'task',
        message: 'Successfully queued build',
        progress: 100
      }, uuid, done);

      progress.done(uuid);
    });

    it('writes done event to nsq stream', function () {
      nsqProgress.done(uuid, { locale: nsqExpected.locale });
      assume(writerSpy).is.calledWithMatch(nsqTopic, {
        eventType: 'event',
        message: sinon.match(`Successfully queued build`),
        ...nsqExpected
      });
    });
  });

  describe('#ignore', function () {
    it('is a function', function () {
      assume(progress.ignore).to.be.a('function');
      assume(progress.ignore).to.have.length(0);
    });

    it('writes ignore data to stream', function (done) {
      /* eslint no-undefined: 0 */
      extend({
        event: 'task',
        message: 'ignored',
        progress: -1
      }, undefined, done);

      progress.ignore();
    });

    it('writes ignore event to nsq stream', function () {
      nsqProgress.buildsCompleted = 0;
      nsqProgress.ignore();

      assume(writerSpy).is.calledWithMatch(nsqTopic, {
        eventType: 'ignored',
        total: 0,
        message: 'Builds Queued',
        ...rip(nsqExpected, 'locale')
      });
    });
  });

  describe('#steps', function () {
    it('is a function', function () {
      assume(progress.steps).to.be.a('function');
      assume(progress.steps).to.have.length(2);
    });

    it('increments the total counter and one', function () {
      progress.start(uuid);
      assume(progress.map[uuid].total).to.equal(0);

      progress.steps(uuid, 5);
      assume(progress.map[uuid].total).to.equal(5);

      progress.steps(uuid, 3);
      assume(progress.map[uuid].total).to.equal(8);
    });
  });

  describe('#end', function () {
    it('is a function', function () {
      assume(progress.end).to.be.a('function');
      assume(progress.end).to.have.length(1);
    });

    it('ends the stream', function () {
      assume(progress.stream._writableState.ended).to.equal(false);
      assume(progress.stream._readableState.ended).to.equal(false);
      progress.end();

      assume(progress.stream._writableState.ended).to.equal(true);
      assume(progress.stream._readableState.ended).to.equal(true);
    });

    it('writes end event to nsq stream', function () {
      nsqProgress.statusWriter.buildsCompleted = 7;
      nsqProgress.end();

      assume(writerSpy).is.calledWithMatch(nsqTopic, {
        eventType: 'queued',
        total: 7,
        message: 'Builds Queued',
        ...rip(nsqExpected, 'locale')
      });
    });

    it('writes end event with error to nsq stream', function () {
      nsqProgress.statusWriter.buildsCompleted = 1;
      const errorMessage = 'printer on fire';
      nsqProgress.end(new Error(errorMessage));

      assume(writerSpy).is.calledWithMatch(nsqTopic, {
        eventType: 'error',
        total: 1,
        message: errorMessage,
        ...rip(nsqExpected, 'locale')
      });
    });
  });

  describe('#state', function () {
    it('is a function', function () {
      assume(progress.state).to.be.a('function');
      assume(progress.state).to.have.length(1);
    });

    it('returns the total progress for found ids', function () {
      progress.map.first = {};
      progress.map.first.n = 3;
      progress.map.first.total = 10;

      assume(progress.state('first')).to.equal(30);
      assume(progress.state('unknown')).to.equal(0);
    });
  });

  describe('#pipe', function () {
    it('is a function', function () {
      assume(progress.pipe).to.be.a('function');
      assume(progress.pipe).to.have.length(1);
    });

    it('will pipe to the destination and can start the stream', function () {
      const s = new Stream();

      progress.stream.pipe = function (destination) {
        assume(destination).to.equal(s);
        return destination;
      };

      const result = progress.pipe(s);
      assume(result).to.equal(s);
      assume(result).to.be.instanceof(Stream);

      progress.start();
      const start = JSON.parse(progress.stream._readableState.buffer.head.data.toString());
      assume(start).to.have.property('message', 'start');
      assume(start).to.have.property('event', 'task');
      assume(start).to.have.property('progress', 0);
    });
  });
});
