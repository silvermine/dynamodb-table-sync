'use strict';

var Class = require('class.extend');

module.exports = Class.extend({

   /**
    * Simple holder for a running count.
    *
    * @class Counter
    */
   init: function() {
      this._count = 0;
   },

   /**
    * Increment the count by 1 (no args) or a specific number (pass `howMany`).
    *
    * @param [howMany] {integer} how many to increment by (defaults to 1 if not supplied)
    * @returns {integer} the new count
    */
   increment: function(howMany) {
      this._count = this._count + (howMany || 1);
      return this.get();
   },

   /**
    * Get the current count.
    *
    * @returns {integer} the current count
    */
   get: function() {
      return this._count;
   },

});
