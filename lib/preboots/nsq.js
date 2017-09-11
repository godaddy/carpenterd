const nsq = require('nsq.js-k8');

module.exports = function nsqboot(app, options, callback) {
  //
  // So we will need a good way to get the IP addresses for the nslookupd
  //
  const config = app.config.get('nsq');
  if (!config) return callback();
  let finished = false;
  //
  // NSQLOOKUPD doesnt quite get it right when fetching hosts.
  // We manually add the full DNS extension so the given hostname works in
  // every namespace.
  //
  config.addrModify = function (addr) {
    if (!config.nsqdHostExt) return addr;
    let [host, port] = addr.split(':');
    host = `${host}.${config.nsqdHostExt}`;
    return [host, port].join(':');
  };

  app.nsq = {};
  const writer = app.nsq.writer = nsq.writer(config);

  writer.on('error response', function (err) {
    app.log.error('nsq error response: %s', err.message);
  });

  writer.on('error', function (err) {
    if (finished) return app.log.error('nsq error: %s', err.message);
    finished = true;
    callback(err);
  });

  writer.on('ready', function () {
    if (finished) return app.log.info('nsq ready called after preboot');
    finished = true;
    callback();
  });

};
