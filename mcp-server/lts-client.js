/**
 * HTTP client for the LTS-2026 REST API.
 * All methods throw on non-2xx responses with the status and body included.
 */
export class LTSClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async get(path, params = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LTS API ${res.status} ${res.statusText}: ${body}`);
    }
    return res.json();
  }

  async post(path, body = {}) {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LTS API ${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
  }

  async put(path, body = {}) {
    const res = await fetch(this.baseUrl + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LTS API ${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
  }
}
