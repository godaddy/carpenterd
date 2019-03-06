'use strict';

const spawn = require('child_process').spawn;
const once = require('one-time');
const bl = require('bl');

function rmrf(filePath, next) {
  const done = once(function onError(err) {
    if (err && err.message.includes('No such file or directory')) {
      return next();
    }
    if (err) return next(err);
    return next();
  });

  let errorLogs = '';

  const child = spawn('rm', ['-rf', filePath], {
    env: process.env
  });

  child.on('error', done);

  child.stderr.pipe(bl((err, buff) => {
    /* eslint consistent-return: 0 */
    if (err) return done(err);
    errorLogs = buff.toString();
  }));

  child.on('close', (code) => {
    if (code !== 0) {
      return done(new Error(`rm -rf exited with code ${code} ${errorLogs}`));
    }

    return done();
  });
};

module.exports = rmrf;
module.exports.async = function(filePath) {
  return new Promise((resolve, reject) => {
    rmrf(filePath, (err) => {
      err ? reject(err) : resolve();
    });
  });
}
