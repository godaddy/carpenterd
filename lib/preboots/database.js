'use strict';

const { DynamoDB } = require('aws-sdk');
const dynamo = require('dynamodb-x');
const AwsLiveness = require('aws-liveness');
const wrhs = require('warehouse-models');

module.exports = function (app, options, done) {
  const ensure = app.config.get('ensure') || options.ensure;
  const dynamoDriver = new DynamoDB(app.config.get('database'));

  dynamo.dynamoDriver(dynamoDriver);
  app.models = wrhs(dynamo);
  app.database = dynamo;

  new AwsLiveness().waitForServices({
    clients: [dynamoDriver],
    waitSeconds: 60
  }).then(function () {
    if (!ensure) return done();
    app.models.ensure(done);
  }).catch(done);
};
