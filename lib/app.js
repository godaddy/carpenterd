'use strict';

const slay = require('slay');
const util = require('util');

/**
 * @constructor App
 *  @param {string} root - Root directory of app
 *  @param {Object} opts - configuration options
 * @returns {undefined}
 */
const App = module.exports = function App(root, opts) {
  slay.App.call(this, root, opts);

  this.env = process.env.NODE_ENV || 'development'; // eslint disable-line
  //
  // Load configuration and merge with provided options.
  //
  this.agents = {};

  this.after('close', this._onClose.bind(this));
};

util.inherits(App, slay.App);


/**
 * Close datastar when the app closes.
 *
 * @param {Slay} app Application.
 * @param {Object} options Optional configuration.
 * @param {Function} fn Completion callback.
 * @api private
 */
App.prototype._onClose = function onClose(app, options, fn) {
  Object.keys(app.agents).forEach(key => {
    app.agents[key].destroy();
  });

  if (app.redis) app.redis.disconnect();

  if (app.datastar) app.datastar.close(fn);
  else { setImmediate(fn); }
}
