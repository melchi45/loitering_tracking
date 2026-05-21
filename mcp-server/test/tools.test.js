/**
 * Tool handler unit tests.
 *
 * Uses a MockMcpServer that captures registered tool handlers so they can be
 * called directly without a real MCP transport.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { registerCameraTools }    from '../tools/cameras.js';
import { registerAlertTools }     from '../tools/alerts.js';
import { registerLoiteringTools } from '../tools/loitering.js';
import { registerAnalyticsTools } from '../tools/analytics.js';
import { createServer, TOOL_CATALOG, RESOURCE_CATALOG } from '../create-server.js';

// ── Test infrastructure ───────────────────────────────────────────────────────

/** Minimal McpServer stub that captures tool + resource registrations. */
class MockMcpServer {
  constructor() {
    this.tools     = {};
    this.resources = {};
  }
  tool(name, _desc, _schema, handler) {
    this.tools[name] = handler;
  }
  resource(name, _uriOrTemplate, _meta, handler) {
    this.resources[name] = handler;
  }
}

function mockClient(overrides = {}) {
  return {
    async get(path)  { return overrides.get  ? overrides.get(path)  : { data: [] }; },
    async post(path) { return overrides.post ? overrides.post(path) : { success: true }; },
    async put(path, body) { return overrides.put ? overrides.put(path, body) : { data: body }; },
  };
}

// ── Camera tools ──────────────────────────────────────────────────────────────

describe('get_camera_status', () => {
  const cameras = [
    {
      id: 'cam1', name: 'Front Door', type: 'rtsp', url: 'rtsp://x/0',
      aiEnabled: true,
      pipelineStatus: { running: true },
    },
    {
      id: 'cam2', name: 'Parking', type: 'rtsp', url: 'rtsp://y/0',
      aiEnabled: false,
      pipelineStatus: { running: false, error: 'Connection refused' },
    },
  ];

  function setup() {
    const srv = new MockMcpServer();
    registerCameraTools(srv, mockClient({ get: async () => ({ data: cameras }) }));
    return srv.tools.get_camera_status;
  }

  it('returns summary for all cameras', async () => {
    const handler = setup();
    const result  = await handler({});
    const text    = result.content[0].text;
    assert.ok(text.includes('2'));
    assert.ok(text.includes('Front Door'));
    assert.ok(text.includes('Parking'));
  });

  it('filters to a single camera by ID', async () => {
    const handler = setup();
    const result  = await handler({ cameraId: 'cam1' });
    const text    = result.content[0].text;
    assert.ok(text.includes('Front Door'));
    assert.ok(!text.includes('Parking'));
  });

  it('reports "Camera not found" for unknown ID', async () => {
    const handler = setup();
    const result  = await handler({ cameraId: 'unknown' });
    assert.ok(result.content[0].text.includes('not found'));
  });

  it('reports no cameras when list is empty', async () => {
    const srv = new MockMcpServer();
    registerCameraTools(srv, mockClient({ get: async () => ({ data: [] }) }));
    const result = await srv.tools.get_camera_status({});
    assert.ok(result.content[0].text.includes('No cameras'));
  });

  it('includes error message for failed pipelines', async () => {
    const handler = setup();
    const result  = await handler({ cameraId: 'cam2' });
    assert.ok(result.content[0].text.includes('Connection refused'));
  });
});

describe('get_zone_config', () => {
  const zones = [
    {
      id: 'z1', name: 'Zone 1', type: 'MONITOR',
      dwellThreshold: 30, polygon: [{x:0,y:0},{x:1,y:0},{x:1,y:1}],
      targetClasses: ['human'],
    },
  ];

  it('returns zone details', async () => {
    const srv = new MockMcpServer();
    registerCameraTools(srv, mockClient({ get: async () => ({ data: zones }) }));
    const result = await srv.tools.get_zone_config({ cameraId: 'cam1' });
    const text   = result.content[0].text;
    assert.ok(text.includes('Zone 1'));
    assert.ok(text.includes('30'));
    assert.ok(text.includes('human'));
  });

  it('returns message when no zones configured', async () => {
    const srv = new MockMcpServer();
    registerCameraTools(srv, mockClient({ get: async () => ({ data: [] }) }));
    const result = await srv.tools.get_zone_config({ cameraId: 'cam1' });
    assert.ok(result.content[0].text.includes('No zones'));
  });
});

describe('update_zone_threshold', () => {
  it('returns confirmation on success', async () => {
    const srv = new MockMcpServer();
    registerCameraTools(srv, mockClient({
      put: async (_path, body) => ({ data: { name: 'Zone 1', dwellThreshold: body.dwellThreshold } }),
    }));
    const result = await srv.tools.update_zone_threshold({ cameraId: 'c1', zoneId: 'z1', dwellThreshold: 60 });
    assert.ok(result.content[0].text.includes('60'));
  });

  it('returns isError on API failure', async () => {
    const srv = new MockMcpServer();
    registerCameraTools(srv, mockClient({
      put: async () => { throw new Error('Not found'); },
    }));
    const result = await srv.tools.update_zone_threshold({ cameraId: 'c1', zoneId: 'z1', dwellThreshold: 30 });
    assert.equal(result.isError, true);
  });
});

// ── Alert tools ───────────────────────────────────────────────────────────────

describe('get_active_alerts', () => {
  const alerts = [
    {
      id: 'a1', type: 'LOITERING', cameraId: 'cam1', zoneName: 'Zone 1',
      dwellTime: 95, timestamp: Date.now(), acknowledged: false,
    },
    {
      id: 'a2', type: 'LOITERING', cameraId: 'cam1', zoneName: 'Zone 1',
      dwellTime: 45, timestamp: Date.now() - 60000, acknowledged: false,
    },
  ];

  it('returns active alerts list', async () => {
    const srv = new MockMcpServer();
    registerAlertTools(srv, mockClient({ get: async () => ({ data: alerts }) }));
    const result = await srv.tools.get_active_alerts({});
    const text   = result.content[0].text;
    assert.ok(text.includes('2 active'));
    assert.ok(text.includes('a1'));
  });

  it('respects limit parameter', async () => {
    const srv = new MockMcpServer();
    registerAlertTools(srv, mockClient({ get: async () => ({ data: alerts }) }));
    const result = await srv.tools.get_active_alerts({ limit: 1 });
    const text   = result.content[0].text;
    assert.ok(text.includes('1 active'));
    assert.ok(!text.includes('a2'));
  });

  it('returns all-clear when no active alerts', async () => {
    const srv = new MockMcpServer();
    registerAlertTools(srv, mockClient({ get: async () => ({ data: [] }) }));
    const result = await srv.tools.get_active_alerts({});
    assert.ok(result.content[0].text.includes('All clear'));
  });
});

describe('acknowledge_alert', () => {
  it('returns confirmation message', async () => {
    const srv = new MockMcpServer();
    registerAlertTools(srv, mockClient({ post: async () => ({ success: true }) }));
    const result = await srv.tools.acknowledge_alert({ alertId: 'a1' });
    assert.ok(result.content[0].text.includes('a1'));
    assert.ok(result.content[0].text.includes('acknowledged'));
  });

  it('returns isError on API failure', async () => {
    const srv = new MockMcpServer();
    registerAlertTools(srv, mockClient({
      post: async () => { throw new Error('Alert not found'); },
    }));
    const result = await srv.tools.acknowledge_alert({ alertId: 'bad' });
    assert.equal(result.isError, true);
  });
});

// ── Loitering tools ───────────────────────────────────────────────────────────

describe('query_loitering_events', () => {
  const events = [
    { id: 'e1', cameraId: 'cam1', zoneId: 'z1', zoneName: 'Zone 1', objectId: 'obj1', dwellTime: 90,  startTime: '2026-05-21T07:00:00Z' },
    { id: 'e2', cameraId: 'cam1', zoneId: 'z1', zoneName: 'Zone 1', objectId: 'obj2', dwellTime: 25,  startTime: '2026-05-21T07:01:00Z' },
    { id: 'e3', cameraId: 'cam1', zoneId: 'z1', zoneName: 'Zone 1', objectId: 'obj1', dwellTime: 120, startTime: '2026-05-21T07:02:00Z' },
  ];

  it('returns all events when no filters', async () => {
    const srv = new MockMcpServer();
    registerLoiteringTools(srv, mockClient({ get: async () => ({ data: events }) }));
    const result = await srv.tools.query_loitering_events({});
    assert.ok(result.content[0].text.includes('3 loitering'));
  });

  it('filters by minDwellSec', async () => {
    const srv = new MockMcpServer();
    registerLoiteringTools(srv, mockClient({ get: async () => ({ data: events }) }));
    const result = await srv.tools.query_loitering_events({ minDwellSec: 80 });
    const text   = result.content[0].text;
    assert.ok(text.includes('2 loitering'));
    assert.ok(!text.includes('e2'));
  });

  it('returns message when no events', async () => {
    const srv = new MockMcpServer();
    registerLoiteringTools(srv, mockClient({ get: async () => ({ data: [] }) }));
    const result = await srv.tools.query_loitering_events({});
    assert.ok(result.content[0].text.includes('No loitering'));
  });
});

describe('get_tracking_history', () => {
  const events = [
    { id: 'e1', cameraId: 'cam1', objectId: 'obj1', dwellTime: 90,  zoneName: 'Zone 1', startTime: '2026-05-21T06:00:00Z' },
    { id: 'e2', cameraId: 'cam2', objectId: 'obj1', dwellTime: 45,  zoneName: 'Zone 2', startTime: '2026-05-21T07:00:00Z' },
    { id: 'e3', cameraId: 'cam1', objectId: 'obj2', dwellTime: 120, zoneName: 'Zone 1', startTime: '2026-05-21T08:00:00Z' },
  ];

  it('returns history for known objectId', async () => {
    const srv = new MockMcpServer();
    registerLoiteringTools(srv, mockClient({ get: async () => ({ data: events }) }));
    const result = await srv.tools.get_tracking_history({ objectId: 'obj1' });
    const text   = result.content[0].text;
    assert.ok(text.includes('obj1'));
    assert.ok(text.includes('2'));       // 2 appearances
    assert.ok(text.includes('135'));     // total dwell 90+45
  });

  it('returns not found for unknown objectId', async () => {
    const srv = new MockMcpServer();
    registerLoiteringTools(srv, mockClient({ get: async () => ({ data: events }) }));
    const result = await srv.tools.get_tracking_history({ objectId: 'unknown' });
    assert.ok(result.content[0].text.includes('No tracking history'));
  });
});

// ── Analytics tools ───────────────────────────────────────────────────────────

describe('get_analytics_summary', () => {
  const events = [
    { cameraId: 'cam1', objectId: 'obj1', dwellTime: 90,  startTime: '2026-05-21T07:00:00Z' },
    { cameraId: 'cam1', objectId: 'obj2', dwellTime: 30,  startTime: '2026-05-21T08:00:00Z' },
  ];
  const alerts = [
    { id: 'a1', cameraId: 'cam1', zoneName: 'Zone 1', dwellTime: 90, timestamp: Date.now(), acknowledged: true  },
    { id: 'a2', cameraId: 'cam1', zoneName: 'Zone 1', dwellTime: 30, timestamp: Date.now(), acknowledged: false },
  ];

  it('returns summary with counts and averages', async () => {
    const srv = new MockMcpServer();
    registerAnalyticsTools(srv, mockClient({
      get: async (path) => path.includes('events') ? { data: events } : { data: alerts },
    }));
    const result = await srv.tools.get_analytics_summary({});
    const text   = result.content[0].text;
    assert.ok(text.includes('2'));         // 2 events
    assert.ok(text.includes('Analytics')); // section header
  });

  it('returns no-data message when both lists empty', async () => {
    const srv = new MockMcpServer();
    registerAnalyticsTools(srv, mockClient({ get: async () => ({ data: [] }) }));
    const result = await srv.tools.get_analytics_summary({});
    assert.ok(result.content[0].text.includes('No data'));
  });
});

// ── Catalog integrity ─────────────────────────────────────────────────────────

describe('TOOL_CATALOG', () => {
  it('exports exactly 10 tools', () => {
    assert.equal(TOOL_CATALOG.length, 10);
  });

  it('every tool has name, access, and description', () => {
    for (const t of TOOL_CATALOG) {
      assert.ok(t.name,        `${t.name}: missing name`);
      assert.ok(t.access,      `${t.name}: missing access`);
      assert.ok(t.description, `${t.name}: missing description`);
      assert.ok(['read', 'write'].includes(t.access), `${t.name}: invalid access`);
    }
  });
});

describe('RESOURCE_CATALOG', () => {
  it('exports exactly 4 resources', () => {
    assert.equal(RESOURCE_CATALOG.length, 4);
  });
});
