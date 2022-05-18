#!/usr/bin/env node
'use strict';

var _ = require('underscore'),
    Q = require('q'),
    AWS = require('aws-sdk'),
    minimist = require('minimist'),
    Synchronizer = require('./Synchronizer'),
    startupPromise = Q.when(),
    argvOpts, argv, argsFailed, options;

argvOpts = {
   string: [
      'master',
      'slaves',
      'ignore-atts',
      'starting-key',
      'profile',
      'role-arn',
      'mfa-serial',
      'mfa-token',
      'slave-profile',
      'slave-role-arn',
      'slave-mfa-serial',
      'slave-mfa-token',
   ],
   'boolean': [ 'write-missing', 'write-differing', 'scan-for-extra', 'delete-extra', 'verbose' ],
   'default': {
      'verbose': false,
      'write-missing': false,
      'write-differing': false,
      'scan-for-extra': false,
      'delete-extra': false,
   },
   alias: {
      master: 'm',
      slaves: [ 's', 'slave' ],
      verbose: 'v',
      'ignore-atts': [ 'ignore', 'ignore-att' ],
   },
};

argv = minimist(process.argv.slice(2), argvOpts);

function mapTableName(type, name) {
   var parts = name.split(':');

   if (parts.length !== 2) {
      console.log('Your table name must be supplied in two parts: "<region>:<table-name>"');
      console.log('This %s table does not meet that requirement:', type, name);
      argsFailed = true;
   }

   return { region: parts[0], name: parts[1] };
}

if (_.isEmpty(argv.master)) {
   console.log('Must supply a master table: --master <region>:<table>');
   argsFailed = true;
} else if (_.isArray(argv.master)) {
   console.log('Can only supply one master table. You supplied:', argv.master);
   argsFailed = true;
} else {
   argv.master = mapTableName('master', argv.master);
}

if (_.isEmpty(argv.slaves)) {
   console.log('Must supply one or more slave tables: --slave <region>:<table>');
   console.log('Or: --slave <region>:<table> --slave <region>:<table>');
   argsFailed = true;
} else if (!_.isArray(argv.slaves)) {
   argv.slaves = [ argv.slaves ];
}

if (_.isEmpty(argv['ignore-atts'])) {
   argv['ignore-atts'] = [];
} else if (!_.isArray(argv['ignore-atts'])) {
   argv['ignore-atts'] = [ argv['ignore-atts'] ];
}

argv.slaves = _.map(argv.slaves, mapTableName.bind(null, 'slave'));

if (_.isEmpty(argv['starting-key'])) {
   argv['starting-key'] = undefined;
} else {
   if (argv.parallel) {
      console.log('ERROR: --starting-key can not be used when using --parallel');
      console.log('because each segment would need its own starting key.');
      argsFailed = true;
   }

   argv['starting-key'] = JSON.parse(argv['starting-key']);
}

if (argsFailed) {
   process.exit(1); // eslint-disable-line no-process-exit
}

options = {
   verbose: argv.verbose,
   writeMissing: argv['write-missing'],
   writeDiffering: argv['write-differing'],
   deleteExtra: argv['delete-extra'],
   scanForExtra: argv['scan-for-extra'],
   ignoreAtts: argv['ignore-atts'],
   startingKey: argv['starting-key'],
};

if (_.isNumber(argv['scan-limit'])) {
   options.scanLimit = parseInt(argv['scan-limit'], 10);
}

options.batchReadLimit = _.isNumber(argv['batch-read-limit']) ? parseInt(argv['batch-read-limit'], 10) : 50;

options.maxRetries = _.isNumber(argv['max-retries']) ? parseInt(argv['max-retries'], 10) : 10;

options.retryDelayBase = _.isNumber(argv['retry-delay-base']) ? parseInt(argv['retry-delay-base'], 10) : 50;

if (_.isNumber(argv.parallel)) {
   options.parallel = parseInt(argv.parallel, 10);
}

function setupRoleRelatedCredentials(argPrefix, msg, masterCreds) {
   var params = { RoleArn: argv[argPrefix + 'role-arn'] },
       creds = masterCreds;

   if (_.isEmpty(params.RoleArn)) {
      return creds;
   }

   if (_.isEmpty(argv[argPrefix + 'mfa-serial'])) {
      console.log('Assuming role %s %s', params.RoleArn, msg);
   } else {
      params.SerialNumber = argv[argPrefix + 'mfa-serial'];
      params.TokenCode = argv[argPrefix + 'mfa-token'];
      console.log('Assuming role %s with MFA %s (%s) %s', params.RoleArn, params.SerialNumber, params.TokenCode, msg);
   }

   creds = new AWS.TemporaryCredentials(params, masterCreds);

   // See jthomerson comments on https://github.com/aws/aws-sdk-js/issues/1064
   // And subsequently: https://github.com/aws/aws-sdk-js/issues/1664
   startupPromise = startupPromise.then(function() {
      return Q.ninvoke(creds, 'refresh');
   });

   return creds;
}

// Set up master table (SDK default) credentials
if (!_.isEmpty(argv.profile)) {
   console.log('Setting AWS credentials provider to use profile %s', argv.profile);
   AWS.config.credentials = new AWS.SharedIniFileCredentials({ profile: argv.profile });
}

AWS.config.credentials = setupRoleRelatedCredentials('', 'for master', AWS.config.credentials);

if (!_.isEmpty(argv['slave-profile'])) {
   if (argv['slave-profile'].indexOf('localhost') > -1) {
      console.log('Using localhost endpoint.');
      options.localhostTarget = argv['slave-profile'];
   } else {
      console.log('Setting AWS credentials provider to use profile %s for slaves', argv['slave-profile']);
      options.slaveCredentials = new AWS.SharedIniFileCredentials({ profile: argv['slave-profile'] });
   }
}

options.slaveCredentials = setupRoleRelatedCredentials('slave-', 'for slaves', options.slaveCredentials || AWS.config.credentials);

startupPromise
   .then(function() {
      return new Synchronizer(argv.master, argv.slaves, options).run();
   })
   .done();
