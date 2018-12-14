'use strict';

var _ = require('underscore'),
    Q = require('q'),
    AWS = require('aws-sdk'),
    Class = require('class.extend'),
    Counter = require('./lib/Counter'),
    REPLICATION_FIELDS = [ 'aws:rep:updateregion', 'aws:rep:updatetime', 'aws:rep:deleting' ];

module.exports = Class.extend({

   /**
    * The possible options supplied in `opts` are:
    *
    * ```
    * {
    *    writeMissing: false,
    *    writeDiffering: false,
    *    scanForExtra: false,
    *    deleteExtra: false,
    *    ignoreAtts: [ 'attributes', 'to', 'ignore' ],
    *    startingKey: { hashKey: 'abc', rangeKey: 'xyz' },
    *    scanLimit: 100,
    *    batchReadLimit: 50,
    *    parallel: 4,
    *    slaveCredentials: AWSCredentialsProvider(...),
    * }
    * ```
    *
    * @class Synchronizer
    * @param master {object} table definition { region: 'region', name: 'table-name' }
    * @param slave {object[]} array of table definitions
    * @param opts {object} options to determine how this class operates
    */
   init: function(master, slaves, opts) {
      this._master = _.extend({}, master, { id: (master.region + ':' + master.name), docs: this._makeDocClient(master) });

      this._slaves = _.map(slaves, function(def) {
         return _.extend({}, def, { id: (def.region + ':' + def.name), docs: this._makeDocClient(def, opts.slaveCredentials) });
      }.bind(this));

      this._abortScanning = false;
      this._opts = _.extend({ batchReadLimit: 50 }, opts);

      this._stats = _.reduce(this._slaves, function(stats, slave) {
         stats[slave.id] = { extra: 0, sameAs: 0, differing: 0, missing: 0 };
         return stats;
      }, {});
   },

   /**
    * Main entry function that runs a complete synchronization (regardless of whether that
    * is a "dry run" or an actual sync job that will write/delete items).
    *
    * The statistics that are returned contain stats for each slave table, comparing it to
    * the master, and are in the format:
    *
    * ```
    * {
    *    'region-1:table': {
    *       extra: 0, // number of items only in the slave, not in the master
    *       sameAs: 0, // number of items that matched
    *       differing: 0, // number of items the slave had, but that differed
    *       missing: 0, // number of items the slave was missing
    *    },
    *    'region-2:table': {
    *       extra: 0,
    *       sameAs: 0,
    *       differing: 0,
    *       missing: 0,
    *    },
    * }
    * ```
    *
    * @return {object} statistics on what the operation completed
    */
   run: function() {
      var self = this;

      return this._compareTableDescriptions()
         .then(this.compareSlavesToMasterScan.bind(this))
         .then(function() {
            if (self._opts.scanForExtra || self._opts.deleteExtra) {
               return _.reduce(self._slaves, function(prev, slaveDef) {
                  return prev.then(self.scanSlaveForExtraItems.bind(self, slaveDef));
               }, Q.when());
            }
         })
         .catch(function(err) {
            self._abortScanning = true;
            console.log('ERROR: encountered an error while comparing tables', err, err.stack);
         })
         .then(this._outputStats.bind(this));
   },

   /**
    * Scans the master table, and for each batch of items that the master table has in it,
    * queries the slaves to see if they contain the exact same items. If an item is
    * missing from a slave table, or an item in a slave table differs, this will call the
    * appropriate function to handle that event.
    *
    * @see Synchronizer#slaveMissingItem
    * @see Synchronizer#slaveItemDiffers
    * @see Synchronizer#slaveItemMatchesMaster
    */
   compareSlavesToMasterScan: function() {
      var self = this;

      // TODO: BatchGetItem will allow up to 100 items per request, but you may have to
      // iterate on UnprocessedKeys if the response would be too large.
      // See http://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchGetItem.html
      return this.scanTable(this._master, this._opts.batchReadLimit, function(batch, counter) {
         var keys = _.map(batch, self._makeKeyFromItem.bind(self));

         return Q.all(_.map(self._slaves, self._batchGetItems.bind(self, keys, false)))
            .then(function(slaveBatches) {
               return Q.all(_.map(slaveBatches, function(slaveBatch, i) {
                  return self._compareBatch(batch, self._slaves[i], slaveBatch);
               }));
            })
            .then(function() {
               console.log(
                  'Status: have compared %d of approximately %d items from the master table to its slaves',
                  counter.get() + batch.length,
                  self._master.approxItems
               );
            });
      });
   },

   /**
    * Scans the provided slave table comparing every item that it contains to the master
    * table. If items are found in the slave that do not exist in the master table,
    * `slaveExtraItem` will be called to handle the extra item (possibly deleting it from
    * the slave).
    *
    * @see Synchronizer#slaveExtraItem
    */
   scanSlaveForExtraItems: function(slaveDef) {
      var self = this;

      console.log('\nStarting to scan slave %s for extra items', slaveDef.id);

      // Remember that in this function we are only comparing keys (we pass `true` to both
      // `scanTable` and `_batchGetItems`) because we are simply looking for items on the
      // slave that do not exist in the master.

      return this.scanTable(slaveDef, this._opts.batchReadLimit, function(slaveBatch, counter) {
         return self._batchGetItems(slaveBatch, true, self._master)
            .then(self._compareForExtraItems.bind(self, slaveDef, slaveBatch))
            .then(function() {
               console.log(
                  'Status: have compared %d of approximately %d items from the slave table to the master',
                  counter.get() + slaveBatch.length,
                  slaveDef.approxItems
               );
            });
      }, true);
   },

   _compareForExtraItems: function(slaveDef, slaveBatch, masterBatch) {
      var self = this;

      return Q.all(_.map(slaveBatch, function(slaveKey) {
         var masterKey = _.findWhere(masterBatch, slaveKey);

         if (!masterKey) {
            self._stats[slaveDef.id].extra = self._stats[slaveDef.id].extra + 1;
            return self.slaveExtraItem(slaveKey, slaveDef);
         }
      }));
   },

   /**
    * Comparator that determines if a master item and a slave item match or differ.
    * Default implementation takes into account the attributes that are to be ignored
    * during comparison, leaving them out of the compared objects.
    *
    * In some cases you may want to override this to provide custom comparison. See the
    * README for one example of where you might do this.
    *
    * @param masterItem {object} the item from the master table
    * @param slaveItem {object} the item from the slave table that will be compared to the
    * master item
    * @returns {boolean} **true** if the items are **different**, false if they are the
    * same
    */
   isItemDifferent: function(masterItem, slaveItem) {
      var atts = _.union(this._opts.ignoreAtts, REPLICATION_FIELDS);

      return !_.isEqual(_.omit(masterItem, atts), _.omit(slaveItem, atts));
   },

   /**
    * This method is called each time the comparison operation finds an item that exists
    * on the master and does not exist on the slave. In its default implementation it will
    * write the item to the slave if the `writeMissing` option is enabled.
    *
    * @param masterItem {object} the item from the master table
    * @param slaveDef {object} the table definition for the slave table
    * @param key {object} the item's DynamoDB key (hash and range if applicable)
    * @returns {Promise} that is fulfilled when it is done processing the missing item (it
    * is not necessary to return a promise if you are not doing any processing)
    */
   slaveMissingItem: function(masterItem, slaveDef, key) {
      console.log('ERROR: %s is missing item present in master table: %j', slaveDef.id, key);
      if (this._opts.writeMissing) {
         return this.writeItem(masterItem, slaveDef);
      }
   },

   /**
    * This method is called each time the comparison operation finds an item that exists
    * on the master and slave, but the slave's version of the item is different from the
    * master's. In its default implementation it will write the item to the slave if the
    * `writeDiffering` option is enabled.
    *
    * @param masterItem {object} the item from the master table
    * @param slaveItem {object} the item from the slave table
    * @param slaveDef {object} the table definition for the slave table
    * @param key {object} the item's DynamoDB key (hash and range if applicable)
    * @returns {Promise} that is fulfilled when it is done processing the differing item
    * (it is not necessary to return a promise if you are not doing any processing)
    */
   slaveItemDiffers: function(masterItem, slaveItem, slaveDef, key) {
      console.log('ERROR: item in %s differs from same item in master table: %j', slaveDef.id, key);
      // TODO: output the differences
      // console.log('master', masterItem);
      // console.log('slave', slaveItem);
      if (this._opts.writeDiffering) {
         return this.writeItem(masterItem, slaveDef);
      }
   },

   /**
    * This method is called each time the comparison operation finds an item that exists
    * on the master and slave, and both items match each other. In its default
    * implementation it does nothing.
    *
    * @param masterItem {object} the item from the master table
    * @param slaveItem {object} the item from the slave table
    * @param slaveDef {object} the table definition for the slave table
    * @param key {object} the item's DynamoDB key (hash and range if applicable)
    * @returns {Promise} that is fulfilled when it is done processing the items (it is not
    * necessary to return a promise if you are not doing any processing)
    */
   slaveItemMatchesMaster: function() {
      // defaults to no-op, can be overridden
   },

   /**
    * This method is called each time the comparison operation finds an item that exists
    * on the slave that does not exist on the master. If the `deleteExtra` option is set
    * to true, this will delete the item from the slave.
    *
    * @param key {object} the DynamoDB key (hash and range if applicable) of the item that
    * exists in the slave table but not in the master table
    * @param slaveDef {object} the table definition for the slave table
    * @returns {Promise} that is fulfilled when it is done processing the items (it is not
    * necessary to return a promise if you are not doing any processing)
    */
   slaveExtraItem: function(key, slaveDef) {
      console.log('ERROR: slave %s had an item that was not in the master table: %j', slaveDef.id, key);

      if (this._opts.deleteExtra) {
         return this.deleteItem(key, slaveDef);
      }
   },

   /**
    * Writes an item to a table.
    *
    * @param item {object} the item to write
    * @param tableDef {object} the table definition for the table to write to
    */
   writeItem: function(item, tableDef) {
      console.log('Writing item to %s: %j', tableDef.id, this._makeKeyFromItem(item));
      return Q.ninvoke(tableDef.docs, 'put', { TableName: tableDef.name, Item: _.omit(item, REPLICATION_FIELDS) });
   },

   /**
    * Deletes an item from a table.
    *
    * @param key {object} the key of the item to delete - should contain hash and sort
    * keys if the table uses both, otherwise just the hash key
    * @param tableDef {object} the table definition for the table to delete from
    */
   deleteItem: function(key, tableDef) {
      console.log('Deleting item from %s: %j', tableDef.id, key);

      return Q.ninvoke(tableDef.docs, 'delete', { TableName: tableDef.name, Key: key });
   },

   /**
    * Scans a table, iterating over every item in the table. The number of items returned
    * by each call to DynamoDB's scan operation can be controlled by the `scanLimit`
    * option. Otherwise, will allow DynamoDB to dictate the number of items returned in
    * each call to `scan`.
    *
    * Each time scan is called, the items that are returned are "chunked" into batches
    * matching `callbackBatchSize`. Then the `callback` is invoked, being passed the
    * current batch (an array of items less than or equal to the `callbackBatchSize`) and
    * a counter that is tracking the number of items that have been processed prior to
    * this invocation of the callback.
    *
    * @param tableDef {object} table definition for the table to scan
    * @param callbackBatchSize {integer} how many items to pass the callback in each batch
    * @param callback {function} the callback to invoke for each batch of items (see
    * above for details on the args passed to the callback)
    * @param [keysOnly] {boolean} if true, returns only the keys of the items
    * @see Counter
    */
   scanTable: function(tableDef, callbackBatchSize, callback, keysOnly) {
      var self = this,
          counter = new Counter();

      if (this._opts.parallel) {
         return Q.all(_.times(this._opts.parallel, function(i) {
            return self._doScan(tableDef, keysOnly, callbackBatchSize, callback, i, counter)
               .catch(function(err) {
                  self._abortScanning = true;
                  throw err;
               });
         }));
      }

      return this._doScan(tableDef, keysOnly, callbackBatchSize, callback);
   },

   _doScan: function(tableDef, keysOnly, callbackBatchSize, callback, segment, counter) { // eslint-disable-line max-params
      var self = this,
          lastKey = this._opts.startingKey,
          deferred = Q.defer();

      counter = counter || new Counter();
      console.log('Scanning %s', tableDef.id);

      function loopOnce() {
         var params = { TableName: tableDef.name, ExclusiveStartKey: lastKey };

         if (keysOnly) {
            params.AttributesToGet = _.values(tableDef.schema);
         }

         if (self._abortScanning) {
            console.log('Segment %d is stopping because of an error in another segment scanner', segment);
            return deferred.resolve(counter.get());
         }

         if (segment !== undefined) {
            params.Segment = segment;
            params.TotalSegments = self._opts.parallel;
         }

         if (self._opts.scanLimit !== undefined) {
            params.Limit = self._opts.scanLimit;
         }

         // trace-level logging: console.log('scan', params);
         return Q.ninvoke(tableDef.docs, 'scan', params)
            .then(function(resp) {
               // trace-level logging: console.log('resp', _.omit(resp, 'Items'));
               return _.chain(resp.Items)
                  .groupBy(function(item, i) {
                     return Math.floor(i / callbackBatchSize);
                  })
                  .values()
                  .reduce(function(prev, batch) {
                     return prev
                        .then(function() {
                           return callback(batch, counter);
                        })
                        .then(function() {
                           counter.increment(batch.length);
                        });
                  }, Q.when())
                  .value()
                  .then(function() {
                     if (resp.LastEvaluatedKey) {
                        lastKey = resp.LastEvaluatedKey;
                        Q.nextTick(loopOnce);
                     } else {
                        if (segment !== undefined) {
                           console.log('Segment %d of %d has completed', segment, self._opts.parallel);
                        }
                        deferred.resolve(counter.get());
                     }
                  });
            })
            .catch(deferred.reject);
      }

      Q.nextTick(function() {
         loopOnce().catch(deferred.reject);
      });

      return deferred.promise;
   },

   _makeKeyFromItem: function(item) {
      return _.pick(item, _.values(this._master.schema));
   },

   /**
    * Describes the master and all slave tables, comparing their descriptions to make sure
    * that they have the same key schema. The comparison will not work on tables that have
    * different key schemas.
    *
    * Also updates the table definition that we hold in memory to have an object
    * containing information about the key schema. The object will look like this:
    *
    * ```
    * {
    *    hash: 'NameOfHashKeyField',
    *    range: 'NameOfRangeKeyFieldIfThereIsOne', // undefined if there is not one
    * }
    * ```
    *
    * Additionally updates the table definition in memory to have an `approxItems` field
    * that has the approximate number of items that DynamoDB reports for the table.
    */
   _compareTableDescriptions: function() {
      var def = Q.defer(),
          describeMaster = this._describeTable(this._master),
          describeSlaves = Q.all(_.map(this._slaves, _.partial(this._describeTable.bind(this), _, this._opts.slaveCredentials)));

      function logDescription(title, tableDef, tableDesc) {
         console.log('%s table %s', title, tableDef.id);
         console.log('Approx. item count:', tableDesc.ItemCount);
         console.log('Key schema:', tableDef.schema);
         console.log();
      }

      function addTableInfoToDefinition(tableDef, desc) {
         var hash = _.findWhere(desc.KeySchema, { KeyType: 'HASH' }),
             range = _.findWhere(desc.KeySchema, { KeyType: 'RANGE' });

         tableDef.schema = { hash: hash.AttributeName };
         if (range) {
            tableDef.schema.range = range.AttributeName;
         }

         tableDef.approxItems = desc.ItemCount;
      }

      Q.all([ describeMaster, describeSlaves ])
         .spread(function(master, slaves) {
            var unlikeTables = [];

            addTableInfoToDefinition(this._master, master);
            logDescription('Master', this._master, master);

            _.each(slaves, function(slaveDesc, i) {
               addTableInfoToDefinition(this._slaves[i], slaveDesc);
               logDescription('Slave[' + (i + 1) + ']', this._slaves[i], slaveDesc);

               if (!_.isEqual(master.KeySchema, slaveDesc.KeySchema)) {
                  unlikeTables.push(this._slaves[i].id);
               }
            }.bind(this));

            return unlikeTables;
         }.bind(this))
         .then(function(unlikeTables) {
            if (!_.isEmpty(unlikeTables)) {
               console.log('ERROR: the following slave tables have key schemas that do not match the master table:', unlikeTables);
               return def.reject(unlikeTables);
            }

            def.resolve();
         })
         .catch(def.reject)
         .done();

      return def.promise;
   },

   _describeTable: function(tableDef, creds) {
      var dyn = new AWS.DynamoDB({ region: tableDef.region, credentials: creds || AWS.config.credentials });

      return Q.ninvoke(dyn, 'describeTable', { TableName: tableDef.name })
         .then(function(resp) {
            return resp.Table;
         });
   },

   _makeDocClient: function(def, creds) {
      return new AWS.DynamoDB.DocumentClient({ region: def.region, credentials: creds || AWS.config.credentials });
   },

   _outputStats: function() {
      console.log('\nSynchronization completed. Stats:');

      _.each(this._slaves, function(slave) {
         var stats = this._stats[slave.id];

         console.log('\n%s', slave.id);
         console.log('Had %d items that were the same as the master', stats.sameAs);
         if (this._opts.deleteExtra || this._opts.scanForExtra) {
            console.log('Had %d items more than master', stats.extra);
         } else {
            console.log('(we did not scan the slave to find if it had "extra" items that the master does not have)');
         }
         console.log('Had %d items that were different from the master', stats.differing);
         console.log('Was missing %d items that the master had', stats.missing);
      }.bind(this));

      return this._stats;
   },

   _batchGetItems: function(keys, keysOnly, tableDef) {
      var params = { RequestItems: {} };

      params.RequestItems[tableDef.name] = { Keys: keys };

      if (keysOnly) {
         params.RequestItems[tableDef.name].AttributesToGet = _.values(tableDef.schema);
      }

      return Q.ninvoke(tableDef.docs, 'batchGet', params)
         .then(function(resp) {
            if (!_.isEmpty(resp.UnprocessedKeys)) {
               throw new Error('ERROR: unprocessed keys in batchGet'); // TODO: recursive querying as needed
            }

            return resp.Responses[tableDef.name];
         });
   },

   _compareBatch: function(masterBatch, slaveDef, slaveBatch) {
      var self = this;

      console.log('Comparing batch of %d from master to %d from slave %s', masterBatch.length, slaveBatch.length, slaveDef.id);

      return Q.all(_.map(masterBatch, function(masterItem) {
         var key = self._makeKeyFromItem(masterItem),
             slaveItem = _.findWhere(slaveBatch, key);

         if (!slaveItem) {
            self._stats[slaveDef.id].missing = self._stats[slaveDef.id].missing + 1;
            return self.slaveMissingItem(masterItem, slaveDef, key);
         } else if (self.isItemDifferent(masterItem, slaveItem)) {
            self._stats[slaveDef.id].differing = self._stats[slaveDef.id].differing + 1;
            return self.slaveItemDiffers(masterItem, slaveItem, slaveDef, key);
         }

         self._stats[slaveDef.id].sameAs = self._stats[slaveDef.id].sameAs + 1;
         return self.slaveItemMatchesMaster(masterItem, slaveItem, slaveDef, key);
      }));
   },

});
