'use strict';
/* eslint no-sync: 0 */

const HttpsAgent = require('https').Agent;
const HttpAgent = require('http').Agent;
const winston = require('winston');

module.exports = function preboot(app, options, next) {
  //
  // Setup the child ochestration and other helpers.
  //
  app.agents = agents(app, options);

  app.preboot(require('slay-config')());

  app.preboot(require('slay-log')({
    transports: [
      new (winston.transports.Console)({
        raw: app.env !== 'local'
      })
    ]
  }));

  app.preboot(require('slay-contextlog'));
  app.preboot(require('./datastar'));
  app.preboot(require('./cdnup'));
  app.preboot(require('../constructor/bffs'));
  app.preboot(require('../constructor'));
  app.preboot(require('./terminate'));
  app.preboot(require('./feedsme'));

  next();
};

const agentDefaults = {
  keepAlive: true
};

function agents(app, options) {
  const opts = app.config.get('agent') || options.agent || agentDefaults;
  return new Agents(opts);
}

function Agents(opts) {
  const http = new HttpAgent(opts);
  const https = new HttpsAgent(opts);
  this.http = http;
  this.https = https;
  this['https:'] = https;
  this['http:'] = http
}
