'use strict';

const bodyParser = require('body-parser');
const pid = process.pid;
let rid = -1;

const healthcheck = /healthcheck/;

//
// Add middlewares.
//
module.exports = function middleware(app, options, done) {
  app.perform('middleware', function performAfter(next) {
    app.use(bodyParser.urlencoded(app.config.get('json')));
    app.use(bodyParser.json(app.config.get('json')));

    app.use(function httpLogger(req, res, next) {
      rid++;
      // reduce # of healthcheck logs which can get a bit out of hand
      if (healthcheck.test(req.url) && rid % 50 !== 0) return next();
      app.withBreadcrumb({
        pid: pid,
        request: rid
      }, app.contextLog.info, () => {
        app.contextLog.info('%s request - %s', req.method, req.url);
        next();
      });
    });

    app.after('actions', function postRouting(next) {
      app.contextLog.verbose('Adding post-routing middleware');

      app.use(require('./404')(app));

      next();
    });

    next();
  }, done);
};
