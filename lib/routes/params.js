'use strict';

module.exports = function parameterize(app) {
  //
  // @param :id. Used in
  // /cancel/:id
  //
  app.routes.param('id', function paramId(req, res, next, id) {
    const construct = app.construct;

    if (typeof id !== 'string' || !construct.valid(id) || !construct.has(id)) {
      return void app.terminate(res, new Error('Build ' + id + ' not found'));
    }

    req.id = id;
    return void next();
  });
};
