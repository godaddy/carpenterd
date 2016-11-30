'use strict';
//
// Return 404 middleware.
//
module.exports = function getFourofour(app) {
  /**
   * Handle unknown routes.
   *
   * @param {HTTPRequest} req Incoming HTTP request.
   * @param {HTTPResponse} res HTTP Response stream.
   * @param {Function} next Completion callback.
   * @public
   */
  return function fourofour(req, res) {
    app.contextLog.error('Not found: %s - %s', req.method, req.url);

    res.status(404).end();
  };
};
