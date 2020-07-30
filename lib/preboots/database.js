'use strict';

const { DynamoDB } = require('aws-sdk');
const dynamo = require('dynamodb-x');
const AwsLiveness = require('aws-liveness');
const wrhs = require('warehouse-models');

module.exports = function (app, options, done) {
  const ensure = app.config.get('ensure') || options.ensure;

  const region = app.config.get('DATABASE_REGION')
    || app.config.get('AWS_REGION')
    || app.config.get('database:region')
    || (app.get('database') || {}).region;
  // Used mainly for localstack usage
  const endpoint = app.config.get('DYNAMO_ENDPOINT')
    || app.config.get('database:endpoint')
    || (app.get('database') || {}).endpoint;

  const dynamoDriver = new DynamoDB({ region, endpoint });

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
