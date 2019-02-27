const BFFS = require('bffs');

module.exports = function preboot(app, options, done) {
  //
  // Load the store configuration, make sure this module is not required before
  // the app.config is initialized.
  //

  //
  // Instantiate the Builds Files Finder Service and expose it as a singleton
  // so the connection is reused.
  //
  app.bffs = new BFFS({
    prefix: app.config.get('bffs:prefix'),
    datastar: app.datastar,
    models: app.models,
    cdn: app.config.get('bffs:cdn')
  });

  return void done();
};
