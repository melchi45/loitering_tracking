'use strict';

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // passWithNoTests and runInBand are passed as CLI flags from package.json scripts
  testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js'],
};
