/*jshint camelcase: false */
/*jshint newcap: false */

'use strict';

var _ = require('underscore');
var HttpStatus = require('http-status-codes');
var storageBlobClient = require('./storageblobclient');
var config = require('./service');

// Default Config
var LOCATION = 'East US';
var LOCATION_CHINA = 'China East';
var RESOURCE_GROUP_NAME_PREFIX = 'cloud-foundry-';
var STORAGE_ACCOUNT_NAME_PREFIX = 'cf';
var CONTAINER_NAME_PREFIX = 'cloud-foundry-';
var ACCOUNT_TYPE = 'Standard_LRS';

var ServiceError = function(err) {
  var error = {};
  if (_.has(err, 'statusCode')) {
    error = {
      statusCode: err.statusCode,
      code: err.code,
      description: err.message,
    };
  } else {
    error = {
      statusCode: HttpStatus.BAD_REQUEST,
      code: HttpStatus.getStatusText(HttpStatus.BAD_REQUEST),
      description: err.message,
    };
  }
  return error;
};

var Handlers = {};

Handlers.catalog = function(log, params, next) {
  log.debug('Catalog params: %j', params);

  var reply = config;
  next(null, reply);
};

Handlers.provision = function(log, params, next) {
  log.debug('Provision params: %j', params);

  var instanceId = params.instance_id;
  var reqParams = params.parameters || {};

  var resourceGroupName = _.has(reqParams, 'resource_group_name') ? reqParams.resource_group_name : RESOURCE_GROUP_NAME_PREFIX + instanceId;
  var storageAccountName = _.has(reqParams, 'storage_account_name') ? reqParams.storage_account_name : STORAGE_ACCOUNT_NAME_PREFIX + instanceId.replace(/-/g, '').slice(0, 22);

  var location;
  if (_.has(reqParams, 'location')) {
    location = reqParams.location;
  } else {
    location = LOCATION;
    if (params.azure.environment === 'AzureChinaCloud') {
      location = LOCATION_CHINA;
    }
  }

  var accountType = _.has(reqParams, 'account_type') ? reqParams.account_type : ACCOUNT_TYPE;

  var groupParameters = {
    location: location
  };
  var accountParameters = reqParams.parameters || {
    location: location,
    accountType: accountType,
  };

  storageBlobClient.init(params.azure);

  storageBlobClient.provision(resourceGroupName, groupParameters,
    storageAccountName, accountParameters,
    function(err, results) {
      if (err) {
        var error = ServiceError(err);
        log.error('%j', error);
        return next(error);
      } else {
        var reply = {
          statusCode: HttpStatus.ACCEPTED,
          code: HttpStatus.getStatusText(HttpStatus.ACCEPTED),
          value: {}
        };
        var result = {
          resourceGroupResult: results[0],
          storageAccountResult: results[1]
        };
        next(null, reply, result);
      }
    });
};

Handlers.poll = function(log, params, next) {
  log.debug('Poll params: %j', params);

  var instanceId = params.instance_id;
  var reqParams = params.parameters || {};

  var provisioningResult = JSON.parse(params.provisioning_result);
  var resourceGroupName = provisioningResult.resourceGroupResult.resourceGroupName;
  var storageAccountName = provisioningResult.storageAccountResult.storageAccountName;

  storageBlobClient.init(params.azure);

  storageBlobClient.poll(resourceGroupName, storageAccountName, function(err, state) {
    var reply = {
      state: '',
      description: '',
    };

    var lastOperation = params.last_operation;
    if (lastOperation == 'provision') {
      if (!err) {
        log.info('Getting the provisioning state of the storage account %s: %j', storageAccountName, state);

        if (state == 'Creating' || state == 'ResolvingDNS') {
          reply.state = 'in progress';
          reply.description = 'Creating the storage account, state: ' + state;
        } else if (state == 'Succeeded') {
          reply.state = 'succeeded';
          reply.description = 'Creating the storage account, state: ' + state;
        }
      } else {
        var error = ServiceError(err);
        log.error(error);
        return next(error);
      }
    } else if (lastOperation == 'deprovision') {
      if (!err) {
        reply.state = 'in progress';
        reply.description = 'Deleting the storage account';
      } else if (err.statusCode == HttpStatus.NOT_FOUND) {
        reply.state = 'succeeded';
        reply.description = 'Deleting the storage account';
      } else {
        var error = ServiceError(err);
        log.error(error);
        return next(error);
      }
    }
    reply = {
      statusCode: HttpStatus.OK,
      code: HttpStatus.getStatusText(HttpStatus.OK),
      value: reply,
    };
    next(null, reply, provisioningResult);
  });
};

Handlers.deprovision = function(log, params, next) {
  log.debug('Deprovision params: %j', params);

  var instanceId = params.instance_id;
  var reqParams = params.parameters || {};

  var provisioningResult = JSON.parse(params.provisioning_result);
  var resourceGroupName = provisioningResult.resourceGroupResult.resourceGroupName;
  var storageAccountName = provisioningResult.storageAccountResult.storageAccountName;

  storageBlobClient.init(params.azure);

  storageBlobClient.deprovision(resourceGroupName, storageAccountName, function(err) {
    if (err) {
      var error = ServiceError(err);
      log.error(error);
      return next(error);
    } else {
      var reply = {
        statusCode: HttpStatus.ACCEPTED,
        code: HttpStatus.getStatusText(HttpStatus.ACCEPTED),
        value: {}
      };
      next(null, reply, provisioningResult);
    }
  });
};

Handlers.bind = function(log, params, next) {
  log.debug('Bind params: %j', params);

  var instanceId = params.instance_id;
  var reqParams = params.parameters || {};

  var containerName = CONTAINER_NAME_PREFIX + instanceId;
  if (reqParams.hasOwnProperty('container_name') && reqParams.container_name !== '') {
    containerName = reqParams.container_name;
  }

  var provisioningResult = JSON.parse(params.provisioning_result);
  var resourceGroupName = provisioningResult.resourceGroupResult.resourceGroupName;
  var storageAccountName = provisioningResult.storageAccountResult.storageAccountName;

  storageBlobClient.init(params.azure);

  storageBlobClient.bind(resourceGroupName, storageAccountName, containerName,
    function(err, primaryAccessKey, secondaryAccessKey) {
      if (err) {
        var error = ServiceError(err);
        log.error(error);
        return next(error);
      } else {
        var reply = {
          statusCode: HttpStatus.CREATED,
          code: HttpStatus.getStatusText(HttpStatus.CREATED),
          value: {
            credentials: {
              storage_account_name: storageAccountName,
              container_name: containerName,
              primary_access_key: primaryAccessKey,
              secondary_access_key: secondaryAccessKey,
            }
          },
        };
        var result = {};
        next(null, reply, result);
      }
    });
};

Handlers.unbind = function(log, params, next) {
  log.debug('Unbind params: %j', params);

  var instanceId = params.instance_id;
  var reqParams = params.parameters || {};

  var provisioningResult = JSON.parse(params.provisioning_result);
  var resourceGroupName = provisioningResult.resourceGroupResult.resourceGroupName;
  var storageAccountName = provisioningResult.storageAccountResult.storageAccountName;

  storageBlobClient.init(params.azure);

  storageBlobClient.unbind(resourceGroupName, storageAccountName, function(err) {
    if (err) {
      var error = ServiceError(err);
      log.error(error);
      return next(error);
    } else {
      var reply = {
        statusCode: HttpStatus.OK,
        code: HttpStatus.getStatusText(HttpStatus.OK),
        value: {},
      };
      var result = {};
      next(null, reply, result);
    }
  });
};

module.exports = Handlers;
