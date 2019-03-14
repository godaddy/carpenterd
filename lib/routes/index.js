'use strict';

const joi = require('joi');
const errs = require('errs');

const buildSchema = joi.object().keys({
  'name': joi.string().required(),
  'dist-tags': joi.object().required(),
  '_attachments': joi.object().required()
}).unknown(true);

const buildV2Schema = joi.object().keys({
  promote: joi.boolean(),
  data: joi.object().keys({
    'name': joi.string().required(),
    'dist-tags': joi.object().required(),
    '_attachments': joi.object().required()
  }).unknown(true)
});

//
// Define routes.
//
module.exports = function routes(app, options, done) {
  app.perform('actions', function performRoutes(next) {
    app.contextLog.verbose('Adding application routes');

    //
    // ### /healthcheck
    // Simple healthcheck
    //
    app.routes.get('/healthcheck(.html)?', function (req, res) {
      res.end('ok');
    });

    app.routes.post('/catchup', function catchup(req, res) {
      const env = req.body.env;
      if (!env) {
        return app.terminate(res, errs.create('No env specified', {
          code: 400
        }));
      }

      // MAKE ASYNC/AWAIT
      app.scheduler.schedule(env, (err, counts) => {
        if (err) return app.terminate(res, err);

        app.contextLog.info('Scheduled catch up builds', counts);
        return res.status(201).json(counts);
      });
    });

    //
    // TODO: Add some retry to the API client underneath
    //
    function change({ data, promote }) {
      // A specific indicator so that we know it was a publish that didn't come from feedsme
      if (!data.env) data.__published = true;

      // MAKE ASYNC/AWAIT
      app.feedsme.change(data.env || 'dev', { data: { data, promote } }, function posted(error) {
        return error
          ? app.contextLog.error('Failed to process changes', error)
          : app.contextLog.info('Changes processed');
      });
    }

    //
    // ### /v2/build
    // Trigger a build and optionally promote it. This route assume `npm publish`
    // like JSON that contains the package.json and the package's content as binary
    // blob in `attachments`.
    //
    app.routes.post('/v2/build', function buildV2(req, res) {
      //
      // Check some basic properties that always should be present.
      //
      joi.validate(req.body || {}, buildV2Schema, function validated(error, buildOpts) {
        if (error) {
          return void app.terminate(res, error);
        }

        // MAKE ASYNC/AWAIT
        return app.construct.build(buildOpts, function building(err) {
          if (err) {
            return void app.contextLog.error('Failed to build', err);
          }

          app.contextLog.info('Build finished, sending change for %s', buildOpts.data.name);
          return void change(buildOpts);
        }).pipe(res);
      });
    });

    //
    // ### /build
    // Trigger a build. This route assume `npm publish` like JSON that contains
    // the package.json and the package's content as binary blob in `attachments`.
    //
    app.routes.post('/build', function build(req, res) {
      //
      // Check some basic properties that always should be present.
      //
      joi.validate(req.body || {}, buildSchema, function validated(error, data) {
        const promote = true; // always promote for v1

        if (error) {
          return void app.terminate(res, error);
        }

        // MAKE ASYNC/AWAIT
        return app.construct.build({ data, promote }, function building(err) {
          if (err) {
            return void app.contextLog.error('Failed to build', err);
          }

          app.contextLog.info('Build finished, sending change for %s', data.name);
          return void change({ data, promote });
        }).pipe(res);
      });
    });

    next();
  }, done);
};
