'use strict';

const path = require('path');
const fs = require('fs');
const spawn = require('child_process').spawn;
const once = require('one-time');
const npm = require.resolve('./npm');

exports.install = function (opts, args, callback) {
  const { log, spec, installPath } = opts;
  const done = once(callback);
  const env = Object.keys(process.env).reduce((acc, key) => {
    acc[key] = process.env[key];
    return acc;
  }, {});

  env.NODE_ENV = ~['prod', 'latest'].indexOf(spec.env)
    ? 'production'
    : 'development';

  const logs = {
    stdout: path.join(installPath, 'stdout.log'),
    stderr: path.join(installPath, 'stderr.log')
  };

  log.info('npm logs available for spec: %s', spec.name, spec, logs);

  // Danger zone - spawn the child process running ./npm.js
  const child = spawn(process.execPath, ['--max_old_space_size=8192', npm]
    .filter(Boolean).concat(cliArgs(args)).concat(['install']), {
    env: env
  });

  function onFileError(type, path) {
    return (err) => {
      log.error(`npm install ${type} filestream error for ${path}`, {
        message: err.message,
        stack: err.stack,
        code: err.code
      });
    };
  }

  child.on('error', done);
  child.stderr.pipe(fs.createWriteStream(logs.stderr))
    .on('error', onFileError('stderr', logs.stderr));
  child.stdout.pipe(fs.createWriteStream(logs.stdout))
    .on('error', onFileError('stdout', logs.stdout));

  child.on('close', (code) => {
    if (code !== 0) {
      return fs.readFile(logs.stderr, 'utf8', function (err, text) {
        const msg = text || (err && err.message) || `Could not read ${installPath / logs.stderr}`;
        done(new Error(`npm exited with code ${code} ${msg}`));
      });
    }

    return done();
  });
};

function cliArgs(options) {
  return Object.keys(options).map((key) => {
    return `--${key}=${options[key]}`;
  });
}
