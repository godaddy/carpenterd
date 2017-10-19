const path = require('path');
const fs = require('fs');
const url = require('url');

const assign = Object.assign;

/**
 * Make a global npmrc to use as the userconfig for npm installs
 *
 * @param {slay.App} app Global app object
 * @param {Object} options Configuration
 * @param {Function} next Completion object
 */
module.exports = function npmboot(app, options, next) {
  const opts = assign({ base: app.rootDir },
    options,
    app.config.get('npm'));

  createNpmrc(opts, (err, npmrc) => {
    if (err) return next(err);
    app.npmrc = npmrc;
    next();
  });

};

module.exports.createNpmrc = createNpmrc;

/**
 * Write an npmrc file with a given file
 * @function createNpmrc
 * @param {Object} opts - options for creating the npmrc
 * @param {Function} callback - Continuation function when completed
 */
function createNpmrc(opts, callback) {
  const parsed = url.parse(opts.registry || '');
  parsed.auth = null;

  let auth = '_auth=';
  let hasAuth = false;
  if (parsed.auth || opts.auth) {
    auth += new Buffer(parsed.auth || opts.auth, 'utf8').toString('base64');
    hasAuth = true;
  }

  const npmrc = `
  registry=${parsed.format()}
  ${hasAuth ? auth : ''}
  loglevel=${opts.loglevel}`;
  const npmrcPath = path.join(opts.base, '.npmrc');

  fs.writeFile(npmrcPath, npmrc, (err) => {
    if (err) return callback(err);
    callback(null, npmrcPath);
  });
}
