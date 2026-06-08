'use strict';
/**
 * Validate that streaming mode never eager-loads local analysis models.
 *
 * Run: node test/api/streaming_mode_model_skip.test.js
 */

const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC_STREAMING_MODEL_SKIP — Unit Contract Test       ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  const originalMode = process.env.SERVER_MODE;
  process.env.SERVER_MODE = 'streaming';

  const modulePath = path.resolve(__dirname, '../../server/src/services/pipelineManager.js');
  delete require.cache[modulePath];

  const PipelineManager = require(modulePath);

  const io = { emit() {}, to() { return { emit() {} }; } };
  const db = {
    find() { return []; },
    findOne() { return null; },
    insert() {},
    update() {},
    all() { return []; },
  };

  const pm = new PipelineManager(io, db);
  await pm.loadFaceServiceEagerly();

  assert(pm._attrPipeline === null, 'streaming mode must not create AttributePipeline during eager load');

  process.env.SERVER_MODE = originalMode;
  console.log('  ✓ streaming mode eager model load is skipped');
}

main().catch((err) => {
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
});
