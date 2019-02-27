const Feedsme = require('feedsme-api-client');
const url = require('url');

/*
 * Simply setup the feedsme api client
 */
module.exports = function feedme(app, options, callback) {
  const uri = app.config.get('feedsme');
  const proto = url.parse(uri).protocol;

  app.feedsme = new Feedsme({
    agent: app.agents[proto],
    uri: uri
  });

  callback();
};
