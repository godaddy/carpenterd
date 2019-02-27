'use strict';

const App = exports.App = require('./app');
const path = require('path');

/*
 * Create a new application and start it.
 *
 * @param {Object} options Optional configuration.
 * @param {Function} done Completion callback.
 * @api public
 */
exports.start = function start(options, done) {
  if (!done && typeof options === 'function') {
    done = options;
    options = {};
  }

  const app = new App(path.join(__dirname, '..'), options);

  app.start(function started(error) {
    done(error, app);
  });
};
