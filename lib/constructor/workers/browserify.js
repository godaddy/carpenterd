'use strict';

const browserify = require('browserify');
const Factory = require('../factory');
const path = require('path');

/**
 * Execute browserify build.
 *
 * @param {Function} next Completion callback
 * @api public
 */
const run = module.exports = function run(next) {
  const config = this.pkg.browserify || {};
  const entry = this.entry;
  const output = {};

  config.basedir = this.base;
  const content = browserify(config.files || entry, config);

  //
  // Exclude options were provided.
  //
  if (Array.isArray(config.exclude)) {
    config.exclude.forEach(content.exclude, content);
  }

  //
  // Deliberatly ignore errors inside the bundle callback, as it can be called
  // multiple times for each error that is emitted. Return after a single error
  // has been emitted.
  //
  content.bundle(function bundled(error, buffer) {
    if (error) return;

    output[path.basename(entry)] = buffer;
    next(null, output);
  }).once('error', next);
};

/**
 * Setup factory line.
 *
 * @param {Object} data Builder options, package location etc.
 * @api private
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
