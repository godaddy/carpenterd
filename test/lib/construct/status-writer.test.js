/* eslint max-nested-callbacks: 0 */
const StatusWriter = require('../../../lib/construct/status-writer');
const nsqStream = require('../../../lib/construct/nsq-stream');
const assume = require('assume');
const sinon = require('sinon');
const { performance } = require('perf_hooks');
assume.use(require('assume-sinon'));

describe('StatusWriter', function () {
  let writer;
  let mockNsqWriter, mockWriteStream;
  const metadata = {
    name: 'SomeName',
    env: 'test',
    version: '1.2.3-4',
    type: 'webpack'
  };
  const defaultMessage = {
    eventType: 'event',
    locale: sinon.match.falsy,
    details: sinon.match.falsy,
    name: metadata.name,
    env: metadata.env,
    version: metadata.version,
    buildType: metadata.type
  };
  const defaultTopic = 'SomeTopic';

  beforeEach(function () {
    mockNsqWriter = { publish: sinon.stub() }; // Not an accurate stub, just a placeholder

    mockWriteStream = {
      write: sinon.stub(),
      end: sinon.stub(),
      on: sinon.stub(),
      _writableState: {}
    };

    sinon.stub(nsqStream, 'createWriteStream').returns(mockWriteStream);

    writer = new StatusWriter({
      nsq: {
        writer: mockNsqWriter,
        topic: defaultTopic
      },
      metadata
    });
  });

  afterEach(function () {
    sinon.restore();
  });


  describe('constructor', function () {
    it('sets up writer with topic', function () {
      assume(writer).exists();
      assume(nsqStream.createWriteStream).calledWith(mockNsqWriter, defaultTopic);
    });

    it('doesn\'t create stream if no writer', function () {
      sinon.reset();
      writer = new StatusWriter({
        nsq: {
          topic: defaultTopic
        },
        metadata
      });
      assume(nsqStream.createWriteStream).was.not.called();
    });

    it('doesn\'t create stream if no topic', function () {
      sinon.reset();
      writer = new StatusWriter({
        nsq: {
          writer: mockNsqWriter
        },
        metadata
      });
      assume(nsqStream.createWriteStream).was.not.called();
    });

    it('sets up metadata', function () {
      assume(writer).exists();
      assume(writer.metadata).to.be.equal(metadata);
    });

    it('doesn\'t need metadata', function () {
      writer = new StatusWriter({
        nsq: {
          writer: mockNsqWriter,
          topic: defaultTopic
        }
      });
      assume(writer.metadata).to.deep.equal({});
    });
  });

  describe('.write', function () {
    it('noops without a writeStream', function () {
      writer.nsqStream = null;

      writer.write(null, 'foo');

      assume(mockWriteStream.write).was.not.called();
    });

    it('noops without key and data', function () {
      writer.write(null, null);

      assume(mockWriteStream.write).was.not.called();
    });

    it('can write simple strings as messages', function () {
      writer.write(null, 'some string');

      assume(mockWriteStream.write).was.calledWithMatch({
        ...defaultMessage,
        message: 'some string'
      });
    });

    it('can write objects', function () {
      writer.write(null, {
        message: 'much message',
        locale: 'do-GE',
        details: 'very detail'
      });

      assume(mockWriteStream.write).was.calledWithMatch({
        ...defaultMessage,
        message: 'much message',
        locale: 'do-GE',
        details: 'very detail'
      });
    });

    it('writes timing information if given a key', function () {
      writer.timings.set('theNotTooDistantFuture', performance.now() - 20);
      writer.write('theNotTooDistantFuture', 'There was a guy named Joel');

      assume(mockWriteStream.write).was.calledWithMatch({
        ...defaultMessage,
        message: 'There was a guy named Joel',
        timing: sinon.match.number
      });
    });

    it('writes a complete event when just a key is provided', function () {
      writer.timings.set('scienceFacts', performance.now() - 20);
      writer.write('scienceFacts');

      assume(mockWriteStream.write).was.calledWithMatch({
        ...defaultMessage,
        message: `'scienceFacts' completed successfully`,
        timing: sinon.match.number
      });
    });

    it('clears timer for the given key', function () {
      writer.timings.set('eats', performance.now() - 50);
      writer.timings.set('breathes', performance.now() - 40);
      writer.timings.set('scienceFacts', performance.now() - 20);
      writer.write('scienceFacts');

      assume(writer.timings.has('scienceFacts')).is.false();
      assume(writer.timings.has('eats')).is.true();
      assume(writer.timings.has('breathes')).is.true();
    });

    it('can write Errors', function () {
      writer.write(null, {
        message: 'How does he eat and breathe?',
        event: 'error'
      });

      assume(mockWriteStream.write).was.calledWithMatch({
        ...defaultMessage,
        message: 'How does he eat and breathe?',
        eventType: 'error'
      });
    });
  });

  describe('end', function () {
    it('noops if no stream', function () {
      writer.nsqStream = null;

      writer.end('foo');

      assume(mockWriteStream.end).was.not.called();
    });

    it('writes an end', function () {
      writer.buildsCompleted = 8675309;
      writer.end('foo');

      assume(mockWriteStream.end).was.calledWithMatch({
        ...defaultMessage,
        eventType: 'foo',
        total: 8675309,
        message: 'Builds Queued'
      });
    });

    it('can end on an error', function () {
      writer.buildsCompleted = 8675309;
      writer.end('error', new Error('Jenny don\'t change your number'));

      assume(mockWriteStream.end).was.calledWithMatch({
        ...defaultMessage,
        eventType: 'error',
        total: 8675309,
        message: 'Jenny don\'t change your number'
      });
    });
  });

  describe('writeStart', function () {
    it('writes a status message and starts a timer', function () {
      assume(writer.timings.has('myKey')).to.be.false();
      writer.writeStart('myKey', 'some string');

      assume(mockWriteStream.write).was.calledWithMatch({
        ...defaultMessage,
        message: 'some string'
      });

      assume(writer.timings.has('myKey')).to.be.true();
      assume(writer.timings.get('myKey')).is.a('number');
    });

    it('writes a default status message', function () {
      assume(writer.timings.has('myKey')).to.be.false();
      writer.writeStart('myKey');

      assume(mockWriteStream.write).was.calledWithMatch({
        ...defaultMessage,
        message: `'myKey' starting`
      });

      assume(writer.timings.has('myKey')).to.be.true();
      assume(writer.timings.get('myKey')).is.a('number');
    });
  });

  describe('writeMaybeError', function () {
    it('writes a default event if no error', function () {
      writer.timings.set('scienceFacts', performance.now() - 20);
      writer.writeMaybeError('scienceFacts');

      assume(mockWriteStream.write).was.calledWithMatch({
        ...defaultMessage,
        message: `'scienceFacts' completed successfully`,
        timing: sinon.match.number
      });
    });

    it('writes an error event if error passed', function () {
      writer.timings.set('scienceFacts', performance.now() - 20);
      const error = new Error('How does he eat and breathe?');
      writer.writeMaybeError('scienceFacts', error);

      assume(mockWriteStream.write).was.calledWithMatch({
        ...defaultMessage,
        eventType: 'error',
        message: `ERROR: 'scienceFacts' exited with code: Error: How does he eat and breathe?.`,
        details: sinon.match(details => details && details.message === error.message),
        timing: sinon.match.number
      });
    });
  });

  describe('writeWrap', function () {
    it('returns a callback-wrapped function that writes a default event if no error', function (done) {
      writer.timings.set('scienceFacts', performance.now() - 20);
      const newCallback = writer.writeWrap('scienceFacts', function (err, data) {
        assume(err).is.falsey();
        assume(data).to.equal('la la la');

        assume(mockWriteStream.write).was.calledWithMatch({
          ...defaultMessage,
          message: `'scienceFacts' completed successfully`,
          timing: sinon.match.number
        });

        done();
      });

      assume(newCallback).is.a('function');
      newCallback(null, 'la la la');
    });

    it('returns a callback-wrapped function that writes an error event if error passed', function (done) {
      writer.timings.set('scienceFacts', performance.now() - 20);
      const error = new Error('How does he eat and breathe?');
      const newCallback = writer.writeWrap('scienceFacts', function (err, data) {
        assume(err).is.truthy();
        assume(err.message).to.equal(error.message);
        assume(data).to.equal('la la la');

        assume(mockWriteStream.write).was.calledWithMatch({
          ...defaultMessage,
          eventType: 'error',
          message: `ERROR: 'scienceFacts' exited with code: Error: How does he eat and breathe?.`,
          details: sinon.match(details => details && details.message === error.message),
          timing: sinon.match.number
        });

        done();
      });

      assume(newCallback).is.a('function');
      newCallback(error, 'la la la');
    });
  });
});
