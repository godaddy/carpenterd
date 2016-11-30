'use strict';

const Redis = require('ioredis');
const BFFS = require('bffs');

module.exports = function preboot(app, options, done) {
  //
  // Load the store configuration, make sure this module is not required before
  // the app.config is initialized.
  //
  const config = app.config.get('redis');
  if (!config || !config.uri) {
    return void done(new Error('Missing required config: redis.uri.'));
  }

  app.redis = new Redis(config.uri)
    .on('error', err => app.contextLog.error('redis error', err))
    .on('connecting', () => app.contextLog.info('redis connecting'))
    .on('connect', () => app.contextLog.info('redis connected'))
    .on('reconnecting', () => app.contextLog.info('redis reconnecting'))
    .on('ready', () => app.contextLog.info('redis ready'))
    .on('close', () => app.contextLog.info('redis connection closed'))
    .on('end', () => app.contextLog.info('redis connection ended'));

  //
  // Instantiate the Builds Files Finder Service and expose it as a singleton
  // so the connection is reused.
  //
  app.bffs = new BFFS({
    prefix: app.config.get('bffs:prefix'),
    datastar: app.datastar,
    models: app.models,
    store: app.redis,
    cdn: app.config.get('bffs:cdn')
  });

  return void done();
};
