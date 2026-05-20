'use strict';

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // passWithNoTests와 runInBand는 package.json scripts에서 CLI 플래그로 전달
  testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js'],
};
