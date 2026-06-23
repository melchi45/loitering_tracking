'use strict';

/**
 * db.js — backward-compatibility shim.
 *
 * The actual implementation lives in server/src/db/:
 *   BaseDatabase.js   — abstract interface (extend to add SQLite, Oracle, etc.)
 *   JsonDatabase.js   — JSON file backend
 *   MongoDatabase.js  — MongoDB backend
 *   index.js          — factory + public API
 *
 * All existing callers of require('./db') or require('../db') continue to work
 * unchanged because Node.js resolves require('./db') to this file first.
 */
module.exports = require('./db/index');
