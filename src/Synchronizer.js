'use strict';

var Q = require('q'),
    Class = require('class.extend');

module.exports = Class.extend({

   run: function() {
      return Q.delay(1000);
   },

});
