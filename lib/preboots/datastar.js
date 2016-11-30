'use strict';

const Datastar = require('datastar');
const wrhs = require('warehouse-models');

module.exports = function (app, options, done) {
  const ensure = app.config.get('ensure') || options.ensure;

  const datastar = app.datastar = new Datastar(app.config.get('datastar') || {
    config: app.config.get('cassandra')
  });

  app.models = wrhs(datastar);
  if (!ensure) return datastar.connect(done);

  //
  // Connect and then ensure models.
  // This will ensure we have our keyspace if we have `keyspaceOptions`
  // and then ensure we have tables in that keyspace
  //
  datastar.connect((err) => {
    if (err) return done(err);
    app.models.ensure(done);
  });
};
