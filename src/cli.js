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
   string: [ 'master', 'slaves', 'ignore-atts', 'starting-key', 'profile', 'role-arn', 'mfa-serial', 'mfa-token' ],
   'boolean': [ 'write-missing', 'write-differing', 'scan-for-extra', 'delete-extra' ],
   'default': {
      'write-missing': false,
      'write-differing': false,
      'scan-for-extra': false,
      'delete-extra': false,
   },
   alias: {
      master: 'm',
      slaves: [ 's', 'slave' ],
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

if (_.isNumber(argv['batch-read-limit'])) {
   options.batchReadLimit = parseInt(argv['batch-read-limit'], 10);
} else {
   options.batchReadLimit = 50;
}

if (_.isNumber(argv.parallel)) {
   options.parallel = parseInt(argv.parallel, 10);
}

if (!_.isEmpty(argv.profile)) {
   console.log('Setting AWS credentials provider to use profile %s', argv.profile);
   AWS.config.credentials = new AWS.SharedIniFileCredentials({ profile: argv.profile });
}

if (!_.isEmpty(argv['role-arn'])) {
   (function() {
      var params = { RoleArn: argv['role-arn'] };

      if (_.isEmpty(argv['mfa-serial'])) {
         console.log('Assuming role %s', params.RoleArn);
      } else {
         params.SerialNumber = argv['mfa-serial'];
         params.TokenCode = argv['mfa-token'];
         console.log('Assuming role %s with MFA %s (%s)', params.RoleArn, params.SerialNumber, params.TokenCode);
      }

      AWS.config.credentials = new AWS.TemporaryCredentials(params);
      // See jthomerson comments on https://github.com/aws/aws-sdk-js/issues/1064
      // And subsequently: https://github.com/aws/aws-sdk-js/issues/1664
      startupPromise = Q.ninvoke(AWS.config.credentials, 'refresh');
   }());
}

startupPromise
   .then(function() {
      return new Synchronizer(argv.master, argv.slaves, options).run();
   })
   .done();
