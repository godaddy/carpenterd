'use strict';

const fingerprinter = require('fingerprinting');
const tryParse = require('json-try-parse');
const uglifyjs = require('uglify-js');
const safe = require('safe-regex');

/**
 * Minify JS.
 *
 * @param {Object} options Content (compiled JS) and filepath.
 * @param {Function} done Completion callback.
 * @api public
 */
module.exports = function uglify(options, done) {
  const config = options.minify || {};
  const mangleProperties = config.mangleProperties;
  const filename = options.file.replace('.js', '.min.js');
  const map = `${filename}.map`;

  if (mangleProperties && mangleProperties.regex && safe(mangleProperties.regex)) {
    config.mangleProperties.regex = new RegExp(mangleProperties.regex);
  }

  //
  // Mangle can be `true` or an `object`, only change the default if mangle was
  // passed from the `wrhs.toml` configuration.
  //
  if ('mangle' in config) {
    config.mangle = typeof config.mangle === 'object'
      ? Object.assign({}, config.mangle)
      : config.mangle;
  }

  //
  // Provide a few more size restricting defaults and clone the objects to
  // prevent polution of the wrhs.toml.
  //
  config.parse = Object.assign({ bare_returns: true }, config.parse || {});
  config.compress =  Object.assign({ reduce_vars: true }, config.compress || {});

  const results = uglifyjs.minify(options.content.toString('utf-8'), Object.assign({}, config, {
    mangleProperties: config.mangleProperties && Object.assign({}, config.mangleProperties),
    inSourceMap: options.map && tryParse(options.map),
    outSourceMap: map,
    fromString: true
  }));

  //
  // Get hash for content. The sourceMap and JS content need to be stored under the same hash.
  //
  const fingerprint = fingerprinter(options.file, { content: results.code, map: true });

  done(null, {
    content: results.code,
    fingerprint: fingerprint.id,
    filename: filename
  }, {
    [map]: {
      content: results.map,
      fingerprint: fingerprint.id
    }
  });
};
