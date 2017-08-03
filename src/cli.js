'use strict';

var _ = require('underscore'),
    minimist = require('minimist'),
    Synchronizer = require('./Synchronizer'),
    argvOpts, argv, argsFailed, options;

argvOpts = {
   string: [ 'master', 'slaves', 'ignore-atts', 'starting-key' ],
   'boolean': [ 'write-missing', 'write-differing', 'delete-extra' ],
   'default': {
      'write-missing': false,
      'write-differing': false,
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
   argv['starting-key'] = JSON.parse(argv['starting-key']);
}

if (argsFailed) {
   process.exit(1); // eslint-disable-line no-process-exit
}

options = {
   writeMissing: argv['write-missing'],
   writeDiffering: argv['write-differing'],
   deleteExtra: argv['delete-extra'],
   ignoreAtts: argv['ignore-atts'],
   startingKey: argv['starting-key'],
};

if (_.isNumber(argv['scan-limit'])) {
   options.scanLimit = parseInt(argv['scan-limit'], 10);
}

new Synchronizer(argv.master, argv.slaves, options).run().done();
