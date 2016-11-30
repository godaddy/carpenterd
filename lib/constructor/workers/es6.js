'use strict';

const Factory = require('../factory');
const babel = require('babel');
const path = require('path');

/**
 * Execute es6 build.
 *
 * @param {Function} next Completion callback
 * @api public
 */
const run = module.exports = function run(next) {
  const output = {};

  output[path.basename(this.entry)] = babel.transform(this.source).code;
  next(null, output);
};

/**
 * Setup factory line.
 *
 * @param {Object} data Builder options, package location etc.
 * @api public
 */
process.once('message', function build(data) {
  const factory = new Factory(data, run);

  factory.line([
    factory.unpack,
    factory.init,
    factory.exists,
    factory.read,
    factory.assemble,
    factory.minify,
    factory.pack,
    factory.clean
  ]);
});
