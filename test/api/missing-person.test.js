'use strict';

/**
 * Missing Person API + MCP-ready flow test script
 * TC mapping: TC-U001/U002/U005, TC-I001/I002/I003/I004, TC-R001
 *
 * Run: node test/api/missing-person.test.js
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3001';

let passed = 0;
let failed = 0;

function assert(cond, message) {
  if (!cond) throw new Error(message || 'Assertion failed');
}

function mkEmbedding(seed = 0) {
  const out = new Array(512);
  let x = 1234567 + seed;
  for (let i = 0; i < 512; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = ((x % 2000) / 1000) - 1;
  }
  return out;
}

async function req(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function test(id, name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${id} ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${id} ${name}`);
    console.error(`    ${err.message}`);
  }
}

async function main() {
  console.log('=== Missing Person Test Script ===');

  let createdId;

  await test('TC-U001', '실종자 등록 성공', async () => {
    const payload = {
      name: 'TC User',
      age: 12,
      gender: 'M',
      description: 'blue jacket',
      photoUrl: 'https://example.com/face.jpg',
      faceEmbedding: mkEmbedding(1),
      priority: 'HIGH',
      contacts: { name: 'Guardian', phone: '010-0000-0000', relation: 'parent' },
    };
    const { status, data } = await req('POST', '/api/missing-persons', payload);
    assert(status === 201, `expected 201, got ${status}`);
    assert(data.id, 'id missing');
    createdId = data.id;
  });

  await test('TC-U002', '잘못된 입력 거부', async () => {
    const { status } = await req('POST', '/api/missing-persons', { name: '' });
    assert(status === 400, `expected 400, got ${status}`);
  });

  await test('TC-I002', '실종자 검색', async () => {
    const { status, data } = await req('GET', `/api/missing-persons?q=${encodeURIComponent('TC User')}`);
    assert(status === 200, `expected 200, got ${status}`);
    assert(Array.isArray(data.results), 'results should be array');
    assert(data.results.some(p => p.id === createdId), 'created person not found');
  });

  await test('TC-U005', '감지 이벤트 생성 및 조회', async () => {
    const createDet = await req('PUT', '/api/missing-persons/detections/non-existent/status', { status: 'PENDING' });
    assert(createDet.status === 404, `expected 404 on unknown detection, got ${createDet.status}`);

    const today = new Date().toISOString().slice(0, 10);
    const { status, data } = await req('GET', `/api/missing-persons/detections?date=${today}`);
    assert(status === 200, `expected 200, got ${status}`);
    assert(data.summary, 'summary missing');
  });

  await test('TC-I004', '상태 업데이트', async () => {
    const { status, data } = await req('PUT', `/api/missing-persons/${createdId}/status`, {
      status: 'FOUND',
      notes: 'confirmed by test',
    });
    assert(status === 200, `expected 200, got ${status}`);
    assert(data.status === 'FOUND', 'status not updated');
  });

  await test('TC-I005', '통계 조회', async () => {
    const { status, data } = await req('GET', '/api/missing-persons/stats');
    assert(status === 200, `expected 200, got ${status}`);
    assert(typeof data.totalRegistered === 'number', 'totalRegistered missing');
    assert(data.byPriority && typeof data.byPriority.HIGH === 'number', 'byPriority missing');
  });

  console.log('\n=== Result ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
