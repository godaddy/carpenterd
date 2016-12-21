'use strict';

const Cdnup = require('cdnup');

/**
 *
 * Preboot to setuo an optional instance of cdnup for uploading fully built npm
 * package tarballs to an `s3` compatible store.
 * @param {slay.App} app App instance
 * @param {Object} options Configurable options
 * @param {Function} done Continuation function when finished
 *
 * @returns {undefined} nothing special
 *
 */
module.exports = function (app, options, done) {
  //
  // Remark: (jcrugzz) do we have a more meaningful config name?
  //
  const config = app.config.get('cdnup') || options.cdnup;
  if (!config) return done();

  app.cdnup = new Cdnup(config.bucket, config);
  done();
};
