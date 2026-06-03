import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LTSClient } from '../lts-client.js';

// ── fetch mock helpers ────────────────────────────────────────────────────────

function makeFetch(status, body) {
  return async (_url, _opts) => ({
    ok:     status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json:   async () => body,
    text:   async () => JSON.stringify(body),
  });
}

// ── LTSClient.get() ───────────────────────────────────────────────────────────

describe('LTSClient.get()', () => {
  it('returns parsed JSON on 200', async () => {
    globalThis.fetch = makeFetch(200, { success: true, data: [{ id: '1' }] });
    const client = new LTSClient('http://localhost:3080');
    const result = await client.get('/api/cameras');
    assert.deepEqual(result, { success: true, data: [{ id: '1' }] });
  });

  it('appends query params to URL', async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url.toString();
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    const client = new LTSClient('http://localhost:3080');
    await client.get('/api/events', { limit: 10, cameraId: 'abc' });
    assert.ok(capturedUrl.includes('limit=10'));
    assert.ok(capturedUrl.includes('cameraId=abc'));
  });

  it('skips undefined/null query params', async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url.toString();
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    const client = new LTSClient('http://localhost:3080');
    await client.get('/api/events', { limit: 5, cameraId: undefined, from: null });
    assert.ok(!capturedUrl.includes('cameraId'));
    assert.ok(!capturedUrl.includes('from'));
    assert.ok(capturedUrl.includes('limit=5'));
  });

  it('strips trailing slash from baseUrl', async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url.toString();
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const client = new LTSClient('http://localhost:3080/');
    await client.get('/api/cameras');
    assert.ok(!capturedUrl.includes('//api'));
  });

  it('throws on non-2xx response', async () => {
    globalThis.fetch = makeFetch(404, 'Not Found');
    const client = new LTSClient('http://localhost:3080');
    await assert.rejects(
      () => client.get('/api/cameras'),
      (err) => {
        assert.ok(err.message.includes('404'));
        return true;
      }
    );
  });

  it('throws on 500 response', async () => {
    globalThis.fetch = makeFetch(500, 'Internal Server Error');
    const client = new LTSClient('http://localhost:3080');
    await assert.rejects(
      () => client.get('/api/cameras'),
      (err) => {
        assert.ok(err.message.includes('500'));
        return true;
      }
    );
  });
});

// ── LTSClient.post() ──────────────────────────────────────────────────────────

describe('LTSClient.post()', () => {
  it('sends POST with JSON body and returns response', async () => {
    let capturedOptions;
    globalThis.fetch = async (_url, opts) => {
      capturedOptions = opts;
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    const client = new LTSClient('http://localhost:3080');
    const result = await client.post('/api/alerts/abc/acknowledge', {});
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
    assert.deepEqual(result, { success: true });
  });

  it('throws on non-2xx POST response', async () => {
    globalThis.fetch = makeFetch(400, 'Bad Request');
    const client = new LTSClient('http://localhost:3080');
    await assert.rejects(() => client.post('/api/alerts/bad/acknowledge'));
  });
});

// ── LTSClient.put() ───────────────────────────────────────────────────────────

describe('LTSClient.put()', () => {
  it('sends PUT with JSON body', async () => {
    let capturedOptions;
    globalThis.fetch = async (_url, opts) => {
      capturedOptions = opts;
      return { ok: true, status: 200, json: async () => ({ success: true, data: { dwellThreshold: 60 } }) };
    };
    const client = new LTSClient('http://localhost:3080');
    const body = { dwellThreshold: 60 };
    const result = await client.put('/api/cameras/cam1/zones/zone1', body);
    assert.equal(capturedOptions.method, 'PUT');
    assert.equal(JSON.parse(capturedOptions.body).dwellThreshold, 60);
    assert.deepEqual(result, { success: true, data: { dwellThreshold: 60 } });
  });

  it('throws on non-2xx PUT response', async () => {
    globalThis.fetch = makeFetch(422, 'Unprocessable Entity');
    const client = new LTSClient('http://localhost:3080');
    await assert.rejects(() => client.put('/api/cameras/c/zones/z', {}));
  });
});
