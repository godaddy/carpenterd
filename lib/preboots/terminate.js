'use strict';

module.exports = function preboot(app, options, done) {
  /**
   * Log the error and end the current request.
   *
   * @param {HTTPResponse} res Repsonse.
   * @param {Error} error Critical error.
   * @api public
   */
  app.terminate = function terminate(res, error) {
    error = error || {};

    app.log.error(error.message);
    res.status(error.code || 500).end(error.message);
  };

  done();
};
