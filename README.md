# Silvermine DynamoDB Table Sync

[![Build Status](https://travis-ci.org/silvermine/dynamodb-table-sync.svg?branch=master)](https://travis-ci.org/silvermine/dynamodb-table-sync)
[![Coverage Status](https://coveralls.io/repos/github/silvermine/dynamodb-table-sync/badge.svg?branch=master)](https://coveralls.io/github/silvermine/dynamodb-table-sync?branch=master)
[![Dependency Status](https://david-dm.org/silvermine/dynamodb-table-sync.svg)](https://david-dm.org/silvermine/dynamodb-table-sync)
[![Dev Dependency Status](https://david-dm.org/silvermine/dynamodb-table-sync/dev-status.svg)](https://david-dm.org/silvermine/dynamodb-table-sync#info=devDependencies&view=table)


## What is it?

A script that will scan two or more DynamoDB tables and report the differences to you.
Optionally, it will also synchronize them by writing updates to the slave table to keep it
in sync with the master table.


## How do I use it?

Here's an example of how you can use this script:

```bash
node src/cli.js \
   --master us-east-1:my-dynamodb-table \
   --slave us-west-2:my-dynamodb-table \
   --slave eu-west-1:my-dynamodb-table \
   --write-missing \
   --write-differing
```

Using the arguments shown above, the synchronizer would scan your master table (the table
in the us-east-1 region), and check that every item in the master table exists in each of
your two slave tables (in us-west-2 and eu-west-1 in this example). Because we supplied
both the `--write-missing` and `--write-differing` flags, it would write to the slaves any
items that the slave was missing or where the slave's item differed from the master's
item.


### Running in Docker

Build the image:

```sh
docker-compose build
```

Then run the container:

```sh
docker-compose run \
   --rm \
   --user node \
   --volume "${HOME}/.aws:/home/node/.aws"
   -e AWS_ACCESS_KEY_ID="XXXXX" \
   -e AWS_SECRET_ACCESS_KEY="ZZZZZ" \
   dynamodb_table_sync \
   src/cli.js \
   --master us-east-1:my-dynamodb-table \
   --slave us-west-2:my-dynamodb-table \
   --slave eu-west-1:my-dynamodb-table \
   --write-missing \
   --write-differing
```


### Installing Globally

By installing the library globally (e.g. `npm install -g @silvermine/dynamodb-table-sync`),
you will get a `dynamodb-table-sync` executable in your node bin folder. Assuming you have
the node bin folder in your path (you probably do if you've ever installed any other npm
package globally), then you can simply run the command from any folder like this:

```bash
dynamodb-table-sync -m us-east-1:my-dynamodb-table -s eu-west-1:my-dynamodb-table
```

Of course, you can use any CLI arguments you want to regardless of where you run the
script from.


### Using Silvermine DynamoDB Table Sync as a Library

You can also use this codebase as a library. Here's a brief example of how to do so:

```js
var Synchronizer = require('@silvermine/dynamodb-table-sync'),
    synchronizer;

synchronizer = new Synchronizer(
   { region: 'us-east-1', name: 'my-master-table-name' },
   [
      { region: 'us-west-2', name: 'my-slave-1-table-name' },
      { region: 'eu-west-1', name: 'my-slave-2-table-name' },
   ],
   {
      writeMissing: true,
      writeDiffering: true,
   },
);

synchronizer.run()
   .then(() => {
      console.info('Done!');
   })
   .catch((err) => {
      console.error(`Failed: ${err.message}`, err.stack);
      process.exit(1);
   });
```

See the comments in [src/Synchronizer.js] for more documentation on names of options.
Since options all map to CLI arguments, see the list of CLI arguments below for details on
what each option is used for.


## Command Line Flags

Note that everywhere that a table is supplied as a command line argument, it should be in
the form `<region>:<table-name>`.

   * `--master` (or `-m`) **required**: region and name of the table that should be
     treated as the master table. This is the table that will be scanned to find items
     that are missing or different in each of the tables listed as "slaves".
   * `--slave` (or `-s`) **at least one required**: region and name of a table that should
     have the same content as the master table.
      * Note that you can supply this argument as many times as needed if you want to
        compare the master table to multiple slaves.
      * Also note that all tables (the master and all slaves) must have the same key
        schema since we create a key from the items returned by the master table and use
        that key to look up items on the slave table(s).
   * `--starting-key`: A JSON string of the key to start the scan at. This allows you to
     restart a scan that had failed previously by supplying one of the previous keys that
     was logged. Example: `--starting-key '{"hashKey":"abc","rangeKey":"xyz"}'`
   * `--ignore` (or `--ignore-att`): An attribute that should be ignored when comparing an
     item from the master table and the corresponding item in the slave table.
      * As an example of where this might be used, if items are written to each of your
        regions independently, and each writer sets its own `lastModified` field, this
        field will differ between regions, but all the other fields/attributes on the item
        should be the same between regions. In that case you could specify `--ignore
        lastModified` so that the `lastModified` field is not compared when comparing
        items.
      * Note that you can supply this argument as many times as needed if you want to
        ignore multiple attributes, e.g. `--ignore lastModified --ignore firstCreated`.
   * `--scan-limit`: a number, used to (optionally) limit the number of items returned by
     each call to `scan`. Use this if you need to slow down the scan to stay under your
     provisioned read capacity.
   * `--batch-read-limit`: a number, by default 50, that is used as the maximum number of
     items to read from the slave tables in a batch read operation. When a table
     (generally the master) is being scanned, we use `BatchGetItem` to get the
     corresponding items out of the other tables to make sure they exist and compare them.
     At times you may want to lower the number of items we read from those tables to keep
     the script running within your provisioned capacity. Additionally, on a batch read
     operation, if the response would be too large, DynamoDB will return "unprocessed
     keys" - that is, keys that you requested but are not included in the response. This
     requires recursive querying from the table, which we have not implemented at this
     time. Thus, if you get an error about `UnprocessedKeys`, you may need to lower this
     number to keep the responses within the size that DynamoDB can return.
   * `--parallel`: a number of parallel scanners that should run concurrently. By default
     we do a serial scan using a single "thread" (so to speak). However, if you have a
     larger table and enough provisioned read capacity on the master and all slaves, we
     can do the scan in parallel. You just specify how many parallel segments you want
     scanned simultaneously, e.g. `--parallel 8`.
      * Note that due to how DynamoDB partitions data, if you specify more parallel
        scanners than you have partitions in your table, some segments may end much sooner
        than others. I believe that DynamoDB is basically just guessing at some random
        keys in the partition, and then reading forward from that key until the end of the
        partition or until it reaches the starting point of another segment. Thus, you may
        not be "fully parallel" throughout your entire script run. The script will
        indicate when each segment finishes. For very small tables, some segments may not
        get any data at all - even from the first call to `scan`.
      * See
        https://aws.amazon.com/blogs/aws/amazon-dynamodb-parallel-scans-and-other-good-news/
   * `--write-missing`: a boolean flag, that when present will tell the synchronizer to
     write to the slave table(s) any items that they are missing.
   * `--write-differing`: a boolean flag, that when present will tell the synchronizer to
     write to the slave table(s) any items where their item is different from that of the
     master table.
   * `--scan-for-extra`: a boolean flag, that when present will tell the synchronizer to
     also scan the slave tables to find any items in them that are not present in the
     master table.
      * Note that whereas all other operations can be done by only scanning the master
        table, supplying this option will result in an additional scan of each slave
        table. While the slave is being scanned, additional reads will occur on the master
        table because for each item scanned from the slave table, we must do a read on the
        master table to see if the item exists in the master. The only way to avoid these
        additional reads back to the (already-scanned) master table would be to keep a
        list of all items that we'd seen in the master table during its own scan. This
        would create multiple problems:
         * Keeping that list of "items the master table has" for very large tables would
           require a lot of memory, or some other temporary storage mechanism.
         * Because the list would be quite old, the period for a "race condition" would
           become quite long - essentially the length of time of all scans combined.
   * `--delete-extra`: a boolean flag, that when present will tell the synchronizer to
     also scan the slave tables and delete any items in them that are not present in the
     master table.
     * Note that if supplying `--delete-extra` there is no need to also provide
       `--scan-for-extra`. Essentially `--scan-for-extra` is the way of invoking a "dry
       run" scan of the slave tables to see if they contain extras.
     * Supplying `--delete-extra` implies that we will also scan the slave tables and all
       of the same warnings and notes from `--scan-for-extra` thus apply here.
   * `--profile` the name of a profile in your AWS credentials file if the script should
     use a specific named profile for its credentials.
   * `--role-arn` the ARN of a role to assume if you need the script to assume a role
     before it can access DynamoDB.
   * `--mfa-serial` the serial number or ARN of an MFA device if assuming a role requires
     an MFA token (can only be used with `--role-arn` **and** `--mfa-token`).
   * `--mfa-token` the one-time password generated by your MFA device if assuming a role
     requires an MFA token (can only be used with `--role-arn` **and** `--mfa-serial`).
   * `--slave-profile`, `--slave-role-arn`, `--slave-mfa-serial`, and `--slave-mfa-token`
     - see the subheading "Syncing Tables in Two Accounts" for more information.
  * `--verbose` (or `-v`) enables additional verbose info & warnings to console logger on
     specific item discrepancies and actions being performed.



### Syncing Tables in Two Accounts

It is possible to synchronize tables in two accounts. To do so, you must provide
credentials arguments that configure the credentials providers to be used for the slave
tables. This is done by providing one of the following combinations of arguments:

   * `--slave-profile` can be used on its own to simply use a profile from your AWS
     credentials (INI) file for the slave tables.
   * `--slave-role-arn` can be used on its own to assume a role. When used on its own, it
     will default to SDK-default credentials to use as its "master credentials" that it
     uses for permission to assume the role.
      * It can also be combined with `--slave-profile`, in which case the slave profile
        will provide the master credentials that are used to assume the role.
      * It can also be used in conjunction with the `--slave-mfa-serial` and
        `--slave-mfa-token` arguments if assuming the role requires an MFA token.

By configuring credentials for the slaves using these arguments, the script will use the
master credentials (provided by default, or by the `--profile`, etc args) to describe and
read from the master table, and the slave credentials to describe, read from, and write to
the slave table(s).

See the heading below entitled "Authentication and Authorization to AWS DynamoDB API" for
more information related to credentials.


### "Dry Run" Mode

If you run the synchronizer without any of the modification flags (`--write-missing`,
`--write-differing`, and `--delete-extra`), then the script will run in a dry run /
report-only mode. It will log each item that is different or missing, and will report
stats at the end of the run.

As noted above, the dry run will (by default) only scan the master table - finding items
that are missing from the slaves or where the slave item differs from the master. If you
want to also scan the slave tables to find items in them that do not exist in the master
("extra" items), supply the `--scan-for-extra` flag.


## Note About Race Conditions

There is no way to make the multi-region/multi-table operation atomic. Thus, due to the
time between where we read and write from various tables, there are race conditions that
will exist.

For example, if you are replicating data from the master table to the slave table(s), it
may be that we read an item that has not yet replicated to the slave. Or, it's possible
that we read a new version of the item from the master, and an old version of the item
from the slave(s). In either of these scenarios, you are "safe" with the `--write-missing`
and `--write-differing` flags because the synchronizer will write what it read from the
master, which in both of these scenarios is the newer data.

Of course, there are scenarios that are not safe as well. Consider, for example, the
following scenario - portrayed as a serial list of events:

   * Item X is written to the master table, and replicated to the slave tables.
   * Another update to item X is written to the master table, bumping it to version 2.
   * Our scan reads item X (version 2) from the master table.
   * Another update to item X is written to the master table (from a separate process -
     not our synchronizer), bumping it to **version 3**.
      * This change is replicated to the slave tables.
   * Our synchronizer reads item X from a slave table and receives version 3 of the item.
      * It now detects that there is a difference between the master and slave table
        because it read version 2 from the master and now reads version 3 from the slave.
   * Because of the difference, our synchronizer writes version 2 to the slave table, thus
     **un-**synchronizing a change that had previously been in sync.

What can be done to avoid that scenario?

   * You could re-run the script after it completes, and on the subsequent run, item X
     would be "fixed" because we would see version 3 in the master table and version 2
     (that we wrote on the last run) in the slave table(s).
      * Of course, running the script again introduces the potential for the race
        condition to happen again - on item X or other items.
   * Better: if you have a version number of "last updated" field on your items, you could
     subclass or modify the `Synchronizer` class, overriding or modifying the
     `isItemDifferent` method. You could compare the version or last update of the items,
     and if the slave is newer than the master, you could not write it.
   * Only run the synchronizer when there are no writes happening on the table
     (understandably, this is not possible for most uses of DynamoDB since most use cases
     involve constant 24/7 writes).
   * Pause your normal replication process while the synchronizer is running, and resume
     it after the synchronizer runs. This assumes that the replication process is written
     in a way that it is safe to pause it for the length of time necessary for the
     synchronizer to run.


## Authentication and Authorization to AWS DynamoDB API

The script can run without any specific AWS credentials configuration (for example,
without `--profile`, `--role-arn` or the MFA-related arguments). In those cases the script
will simply use the built-in authentication mechanism from the SDK. Thus, you will need to
ensure that one of the methods that the SDK uses to auto-discover credentials will work in
your environment. For example, you could:

   * Supply the credentials via [environment variables][envvars]
   * Use the default credentials in your [shared credentials file][credsfile]
   * Run the script on an [EC2 instance that has permissions][ec2]

Note that if you assume a role that requires MFA, the temporary credentials the script
receives will only last for one hour, and cannot be refreshed without a new MFA token
(which the script does not attempt to implement). Thus, the provisioned capacity,
parallelism, and related limiting arguments must be configured to allow your entire table
to be scanned during a single hour if you are using MFA.


### What Permissions Are Needed?

On the **master** table you will need:

   * DynamoDB:DescribeTable
   * DynamoDB:Scan
   * If using the `--delete-extra` flag:
      * DynamoDB:BatchGetItem

On the **slave** table(s) you will need:

   * DynamoDB:DescribeTable
   * DynamoDB:BatchGetItem
   * If using the `--write-missing` or `--write-differing` flags:
      * DynamoDB:PutItem
   * If using the `--delete-extra` or `--scan-for-extra` flags:
      * DynamoDB:Scan
   * If using the `--delete-extra` flag:
      * DynamoDB:DeleteItem


## How do I contribute?

We genuinely appreciate external contributions. See [our extensive
documentation][contributing] on how to contribute.


## License

This software is released under the MIT license. See [the license file](LICENSE) for more
details.

[contributing]: https://github.com/silvermine/silvermine-info#contributing
[envvars]: http://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/loading-node-credentials-environment.html
[credsfile]: http://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/loading-node-credentials-shared.html
