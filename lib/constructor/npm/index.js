'use strict';

const spawn = require('child_process').spawn;
const once = require('one-time');
const bl = require('bl');
const npm = require.resolve('./npm');

exports.install = function (options, callback) {
  const done = once(callback);
  const env = Object.keys(process.env).reduce((acc, key) => {
    acc[key] = process.env[key];
    return acc;
  }, {});

  let errorLogs = '';
  env.NODE_ENV = ~['prod', 'latest'].indexOf(options.env) ? 'production' : 'development';

  // Danger zone
  const child = spawn(process.execPath, ['--max_old_space_size=8192', npm]
      .filter(Boolean).concat(cliArgs(options)).concat(['install']), {
    env: env
  });

  child.on('error', done);

  child.stderr.pipe(bl((err, body) => {
    /* eslint consistent-return: 0 */
    if (err) return done(err);
    errorLogs = body.toString();
  }));

  child.on('close', (code) => {
    if (code !== 0) {
      return done(new Error(`npm exited with code ${code} ${errorLogs}`));
    }

    return done();
  });
};

function cliArgs(options) {
  return Object.keys(options).map((key) => {
    return `--${key}=${options[key]}`;
  });
}
