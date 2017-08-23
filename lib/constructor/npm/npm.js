'use strict';

const argv = require('minimist')(process.argv.slice(2));
const url = require('url');
const npm = require('npm');

function parse(opts) {
  const config = {};
  const parsed = url.parse(opts.registry || '');
  if (parsed.auth || opts._auth) {
    config._auth = new Buffer(parsed.auth || opts._auth, 'utf8').toString('base64');
  }

  parsed.auth = null;
  config.registry = parsed.format();
  config['always-auth'] = true;
  //
  // TODO: Make sure we are sharing npm cache with other children
  //
  if (opts.prefix) config.prefix = opts.prefix;
  config.production = false;
  config.loglevel = 'http';

  return config;
}

function Npm(opts) {
  if (!this) return new Npm(opts);
  this.config = parse(opts);
  this.env = opts.env;
  this.base = opts.base;
}

Npm.prototype.run = function (cmd, callback) {
  var self = this;
  npm.load(this.config, function npmConfigLoaded(error) {
    if (error) return void callback(error);

    //
    // Temporary hack to add custom headers to the npm-registry-client.
    // TODO: remove this hack once headers can be specified through load/config.
    //
    const _authify = npm.registry.authify;
    npm.registry.authify = function authify(authed, parsed, headers, credentials) {

      //
      // Setup header for install in provided environment.
      //
      headers['registry-environment'] = self.env;
      return _authify.call(npm.registry, authed, parsed, headers, credentials);
    };

    return void npm[cmd](self.base, self.base, callback);
  });
};

var cmd = argv._[0];

new Npm(argv)
  .run(cmd, (err) => {
    if (err) {
      console.error(err);
      return process.exit(1);
    }
    return process.exit(0);
  });


