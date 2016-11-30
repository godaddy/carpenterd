'use strict';

const Minimize = require('minimize');

/**
 * Minify HTML, remove whitespace, remove redundant attribute values and quotes.
 *
 * @param {Object} options Content (compiled HTML) and filepath.
 * @param {Function} done Completion callback.
 * @api public
 */
module.exports = function minimize(options, done) {
  new Minimize().parse(options.content, done);
};
