/* eslint no-sync: 0 */
'use strict';

const HttpsAgent = require('https').Agent;
const HttpAgent = require('http').Agent;
const { format, transports } = require('winston');

const agentDefaults = {
  keepAlive: true
};

class Agents {
  constructor(opts) {
    const http = new HttpAgent(opts);
    const https = new HttpsAgent(opts);
    this.http = http;
    this.https = https;
    this['https:'] = https;
    this['http:'] = http;
  }
}

function agents(app, options) {
  const opts = app.config.get('agent') || options.agent || agentDefaults;
  return new Agents(opts);
}

module.exports = function preboot(app, options, next) {
  //
  // Setup the child ochestration and other helpers.
  //
  app.agents = agents(app, options);

  app.preboot(require('slay-config')());

  app.preboot(require('slay-log')({
    format: format.combine(
      format.timestamp(),
      format.splat(),
      format.json()
    ),
    transports: [
      new (transports.Console)()
    ]
  }));

  app.preboot(require('slay-contextlog'));
  app.preboot(require('./database'));
  app.preboot(require('./cdnup'));
  app.preboot(require('./nsq.js'));
  app.preboot(require('./npm'));
  app.preboot(require('../construct/bffs'));
  app.preboot(require('./scheduler'));
  app.preboot(require('../construct'));
  app.preboot(require('./terminate'));
  app.preboot(require('./feedsme'));

  next();
};
