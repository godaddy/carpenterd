/* eslint max-nested-callbacks: 0 */
/* eslint no-invalid-this: 0 */
/* eslint no-sync: 0 */
/* eslint consistent-return: 0 */
'use strict';

describe('Factory', function () {
  this.timeout(5E4);
  const browserifyworker = require('../../../lib/constructor/workers/browserify');
  const webpackworker = require('../../../lib/constructor/workers/webpack');
  const es6worker = require('../../../lib/constructor/workers/es6');
  const Factory = require('../../../lib/constructor/factory');
  const exec = require('child_process').exec;
  const map = require('../../fixtures/map');
  const assume = require('assume');
  const async = require('async');
  const path = require('path');
  const zlib = require('zlib');
  const toml = require('toml');
  const fs = require('fs');
  let factory;

  //
  // Define common specifications for build.
  //
  function config(name) {
    return {
      source: path.join(__dirname, '..', '..', 'fixtures'),
      target: '/tmp',
      clean: false,
      minify: true,
      env: 'test',
      name: name,
      id: name, // normally an uuid.
      npm: {
        registry: 'https://registry.npmjs.org',
        loglevel: 'silent'
      }
    };
  }

  //
  // Install both fixture packages. Can't be done in main process due to
  // npm's horrible design, execute some silly commands.
  //
  before(function (done) {
    const base = path.join(__dirname, '..', '..', '..');
    const locations = ['es6', 'webpack', 'browserify', 'other'];

    this.timeout(6E5);

    async.each(locations, (name, next) =>
      exec([
        'cd',
        path.join(base, 'test', 'fixtures', name),
        '&&',
        path.join(base, 'node_modules', '.bin', 'npm'),
        'install .'
      ].join(' '), next), function (error) {
        if (error) return done(error);
        done();
      }
    );
  });

  beforeEach(function () {
    factory = new Factory(config('es6'), es6worker);
  });

  afterEach(function () {
    process.removeAllListeners('message');
    factory = null;
  });

  it('is exposed as constructor', function () {
    assume(Factory).is.an('function');
    assume(factory).to.be.instanceof(Factory);
  });

  it('stores some required values on its instance', function () {
    assume(factory).to.have.property('data');
    assume(factory).to.have.property('output');
    assume(factory).to.have.property('base', path.join(__dirname, '..', '..', 'fixtures', 'es6'));
  });

  describe('#init', function () {
    it('is a function', function () {
      assume(factory.init).to.be.a('function');
      assume(factory.init).to.have.length(1);
    });

    it('safely reads the package.json and entry file', function (done) {
      factory.data.entry = 'sum.js';

      factory.init(function () {
        assume(factory.pkg).to.be.an('object');
        assume(factory.pkg).to.have.property('name', 'test');
        assume(factory.pkg).to.have.property('description', 'ES6 React Test module');
        assume(factory.pkg.dependencies).to.have.property('react', '~0.13.3');

        assume(factory.entry).to.be.a('string');
        assume(factory.entry).to.include('test/fixtures/es6/sum.js');

        done();
      });
    });

    it('defaults to the `main` property of the package.json as entry file', function (done) {
      factory.init(function () {
        assume(factory.entry).to.be.a('string');
        assume(factory.entry).to.include('test/fixtures/es6/index.jsx');

        done();
      });
    });
  });

  describe('#exists', function () {
    it('is a function', function () {
      assume(factory.exists).to.be.a('function');
      assume(factory.exists).to.have.length(1);
    });

    it('checks if the entry file exists', function (done) {
      factory.init(function () {
        factory.exists(function (error, stat) {
          assume(error).to.equal(null);
          assume(stat.size).to.be.above(0);
          done();
        });
      });
    });
  });

  describe('#read', function () {
    it('is a function', function () {
      assume(factory.read).to.be.a('function');
      assume(factory.read).to.have.length(1);
    });

    it('reads the entry file as utf-8', function (done) {
      factory.init(function () {
        factory.read(function (error) {
          assume(error).is.falsey();
          assume(factory.source).to.be.a('string');
          assume(factory.source).to.include('return <p>Build an ES6 React component.</p>;');
          done();
        });
      });
    });
  });

  describe('#assemble', function () {
    function run(local, done) {
      local.init(function (error) {
        if (error) return done(error);

        local.read(function (error) {
          if (error) return done(error);

          local.assemble(function (error) {
            if (error) return done(error);

            local.pack(function (error) {
              assume(error).to.equal(null);

              assume(local.output).to.be.an('object');
              assume(local.compressed).to.be.an('object');

              done(error, local);
            });
          });
        });
      });
    }

    it('is a function', function () {
      assume(factory.assemble).to.be.a('function');
      assume(factory.assemble).to.have.length(1);
    });

    it('runs the build, transpiles es6 and gzips the data', function (done) {
      this.timeout(5000);

      run(factory, function (error, factory) {
        if (error) return done(error);

        const output = factory.output['index.jsx'].toString('utf-8');
        const compressed = factory.compressed['index.jsx'];

        assume(factory.base).to.include('es6');
        assume(output).to.include('Build an ES6 React component');
        assume(output).to.include('return _react.React.createElement(');
        assume(output).to.include('_inherits(Test, _React$Component);');

        // test for gzip header magic numbers and deflate compression
        assume(compressed[0]).to.equal(31);
        assume(compressed[1]).to.equal(139);
        assume(compressed[2]).to.equal(8);

        assume(zlib.gunzipSync(compressed).toString('utf-8')).to.equal(output)

        done();
      });
    });

    it('can run browserify builds', function (done) {
      this.timeout(5000);

      run(new Factory(config('browserify'), browserifyworker), function (error, factory) {
        if (error) return done(error);

        const output = factory.output['index.jsx'].toString('utf-8');
        const compressed = factory.compressed['index.jsx'];

        assume(factory.base).to.include('browserify');
        assume(output).to.include('Browserify an ES6 React component');
        assume(output).to.include('return _react.React.createElement(');
        assume(output).to.include('_inherits(Test, _React$Component);');
        assume(output).to.include('require=="function"&&require');

        // test for gzip header magic numbers and deflate compression
        assume(compressed[0]).to.equal(31);
        assume(compressed[1]).to.equal(139);
        assume(compressed[2]).to.equal(8);

        assume(zlib.gunzipSync(compressed).toString('utf-8')).to.equal(output);

        done();
      });
    });

    it('can run webpack builds', function (done) {
      const data = config('webpack');

      this.timeout(5000);
      data.entry = 'webpack.config.js';

      run(new Factory(data, webpackworker), function (error, factory) {
        if (error) return done(error);

        const output = factory.output['bundle.js'].toString('utf-8');
        const compressed = factory.compressed['bundle.js'];

        assume(factory.base).to.include('webpack');
        assume(output).to.include('Webpack an ES6 React component');
        assume(output).to.include('return _react.React.createElement(');
        assume(output).to.include('_inherits(Test, _React$Component);');

        // test for gzip header magic numbers and deflate compression
        assume(compressed[0]).to.equal(31);
        assume(compressed[1]).to.equal(139);
        assume(compressed[2]).to.equal(8);

        assume(zlib.gunzipSync(compressed).toString('utf-8')).to.equal(output)

        done();
      });
    });

    it('can run more complicated webpack builds with multiple output files', function (done) {
      const data = config('other');

      this.timeout(5000);
      data.entry = 'webpack.config.js';

      run(new Factory(data, webpackworker), function (error, factory) {
        if (error) return done(error);

        assume(Object.keys(factory.output)).to.have.length(4);
        assume(Object.keys(factory.compressed)).to.have.length(4);

        done();
      });
    });
  });

  describe('#stock', function () {
    it('is a function', function () {
      assume(factory.stock).to.be.a('function');
      assume(factory.stock).to.have.length(3);
    });

    it('stores content as Buffer on the output collection', function () {
      factory.stock('test.js', 'some content');

      assume(Object.keys(factory.output).length).to.equal(1);
      assume(factory.output['test.js']).to.be.instanceof(Buffer);
      assume(factory.output['test.js'].toString()).to.equal('some content');
    });
  });

  describe('#minify', function () {
    beforeEach(function () {
      factory.data.env = 'prod';
    });

    it('is a function', function () {
      assume(factory.minify).to.be.a('function');
      assume(factory.minify).to.have.length(1);
    });

    it('will skip minify if `env` is prod or the `minify` flag is false', function (done) {
      factory.data.env = 'staging';

      factory.minify(function () {
        assume(Object.keys(factory.output).length).to.equal(0);

        factory.data.minify = false;
        factory.minify(function () {
          assume(Object.keys(factory.output).length).to.equal(0);

          done();
        });
      });
    });

    it('will skip minification of unknown files', function (done) {
      factory.data.env = 'prod';
      factory.output = {
        'index.unknown': 'var test = true; function boolier(change) { test = !!change; }'
      };

      factory.minify(function (error) {
        assume(error).to.be.falsey();
        assume(factory.output).to.be.an('object');
        assume(factory.output['index.unknown']).to.be.instanceof(Buffer);
        assume(factory.output['index.unknown'].toString()).to.equal(factory.output['index.unknown'].toString());
        done();
      });
    });

    it('can minify JS', function (done) {
      factory.data.env = 'prod';
      factory.output = {
        'index.js.map': JSON.stringify(map),
        'index.js': 'var test = true; function boolier(change) { test = !!change; }'
      };

      factory.minify(function (error) {
        if (error) return done(error);

        const sourceMap = JSON.parse(factory.output['index.min.js.map'].content);
        assume(factory.output).to.be.an('object');
        assume(factory.output['index.min.js'].content).to.be.instanceof(Buffer);
        assume(factory.output['index.min.js'].content.toString()).to.include('function boolier(t){test=!!t}var test=!0;');
        assume(factory.output['index.min.js'].content.toString()).to.include('\n//# sourceMappingURL=index.min.js.map');
        assume(factory.output['index.min.js'].fingerprint).to.equal('81f4d1d4136aaec3e75e54e626a420bf');
        assume(factory.output['index.min.js.map'].content).to.be.instanceof(Buffer);

        assume(sourceMap).to.be.an('object');
        assume(sourceMap).to.have.property('version', 3);
        assume(sourceMap).to.have.property('file', 'index.min.js');
        assume(sourceMap).to.have.property('mappings', 'AAA0B,QAATA,SAAAA,GACVA,OAAOC,EADY,GAAAC,OAAA');
        done();
      });
    });

    it('can minify with additional `wrhs.toml` options', function (done) {
      factory.data.env = 'prod';

      factory.config = toml.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'wrhs.toml'))
      );

      factory.output = {
        'index.js.map': JSON.stringify(map),
        'index.js': 'var test = true; function boolier(change) { test = !!change; }'
      };

      factory.minify(function (error) {
        if (error) return done(error);

        assume(factory.output).to.be.an('object');
        assume(factory.output['index.min.js'].content).to.be.instanceof(Buffer);
        assume(factory.output['index.min.js'].content.toString()).to.include('function n(n){a=!!n}var a=!0;');
        assume(factory.output['index.min.js'].fingerprint).to.equal('925a9e5153bc095668727d0bf6c425f8');
        done();
      });

    });

    it('can minify CSS', function (done) {
      factory.output = {
        'base.css': 'span { margin: 0px; font-size: 12px; color: #FFFFFF; }'
      };

      factory.minify(function (error) {
        if (error) return done(error);

        assume(factory.output).to.be.an('object');
        assume(factory.output['base.min.css'].content).to.be.instanceof(Buffer);
        assume(factory.output['base.min.css'].content.toString()).to.include('span{margin:0;font-size:12px;color:#FFF}');
        assume(factory.output['base.min.css'].content.toString()).to.include('/*# sourceMappingURL=base.min.css.map */');
        assume(factory.output['base.min.css'].fingerprint).to.equal('c1ca21d1fe09e2816067d80e3d9368bd');
        assume(factory.output['base.min.css.map'].content).to.be.instanceof(Buffer);
        done();
      });
    });

    it('can minify HTML', function (done) {
      factory.output = {
        'view.html': '<h1 class=""  draggable="true">some additional cleaning</h1>\n\n   <span>\ntest</span>'
      };

      factory.minify(function (error) {
        if (error) return done(error);

        assume(factory.output).to.be.an('object');
        assume(factory.output['view.html']).to.be.instanceof(Buffer);
        assume(factory.output['view.html'].toString()).to.equal(
          '<h1 draggable>some additional cleaning</h1><span>test</span>'
        );

        done();
      });
    });
  });

  describe('#line', function () {
    this.timeout(3E4);
    it('is a function', function () {
      assume(factory.line).to.be.a('function');
      assume(factory.line).to.have.length(1);
    });

    it('runs the stack in the scope of factory and emits messages', function (done) {
      const old = process.exit;

      process.exit = function noop(code) {
        assume(code).to.equal(0);

        process.exit = old;
        done();
      };

      process.send = function (data, fn) {
        assume(data).to.be.an('object');
        assume(data).to.have.property('event');
        switch (data.event) {
          case 'task':
            assume(data).to.have.property('message');
            assume(data).to.have.property('progress');
            assume(data.progress).to.be.between(0, 100);
          break;

          case 'store':
            assume(data).to.have.property('files');
            assume(data.files).is.an('object');
            assume(data.files.files).is.an('array');
          break;

          default:
          break;
        }

        if (fn && typeof fn === 'function') fn();
      };

      factory.init(function (error) {
        if (error) return done(error);

        factory.line([
          function method1(next) {
            assume(this).to.equal(factory);
            assume(next).to.be.a('function');
            next();
          },
          function method2(next) {
            assume(this).to.equal(factory);
            assume(next).to.be.a('function');
            next();
          }
        ], done);
      });
    });
  });

  describe('#scrap', function () {
    it('is a function', function () {
      assume(factory.scrap).to.be.a('function');
      assume(factory.scrap).to.have.length(1);
    });

    it('sends the error to the main process and exits', function (done) {
      const old = process.exit;

      process.exit = function noop(code) {
        assume(code).to.equal(1);

        process.exit = old;
        done();
      };

      process.send = function (error, cb) {
        assume(error).to.be.instanceof(Error);
        assume(error.message).to.equal('test');
        assume(error.event).to.equal('error');
        assume(error.name).to.equal('Error');

        cb();
      };

      factory.scrap(new Error('test'));
    });
  });
});
