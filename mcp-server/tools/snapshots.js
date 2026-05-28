import { z } from 'zod';

export function registerSnapshotTools(server, client) {
  /**
   * get_object_snapshots
   * Returns recent detection snapshots (with base64 crop images) for a specific
   * tracked object — useful for "missing person search" and visual verification.
   */
  server.tool(
    'get_object_snapshots',
    'Retrieve detection snapshots with cropped images for a tracked object. ' +
    'Use this to visually identify a person or object across cameras. ' +
    'Returns base64 JPEG crops plus appearance metadata.',
    {
      objectId: z.string().describe('Tracked object ID to retrieve images for'),
      limit:    z.number().int().min(1).max(10).optional().describe('Max snapshots (default 5)'),
    },
    async ({ objectId, limit = 5 }) => {
      try {
        // Fetch snapshots list filtered by objectId (no cropData in list)
        const { snapshots = [], total } = await client.get('/api/snapshots', {
          objectId,
          limit,
          offset: 0,
        });

        if (snapshots.length === 0) {
          return {
            content: [{ type: 'text', text: `No snapshots found for object: ${objectId}` }],
          };
        }

        // Fetch each snapshot individually to get cropData
        const content = [];

        content.push({
          type: 'text',
          text: `Object ${objectId} — ${total} total snapshots (showing ${snapshots.length}):`,
        });

        for (const snap of snapshots) {
          // GET /api/snapshots/:id returns full record including cropData
          let cropData = snap.cropData;
          if (!cropData) {
            try {
              const full = await client.get(`/api/snapshots/${snap.id}`);
              cropData = full?.cropData ?? full?.data?.cropData;
            } catch {
              // skip if individual fetch fails
            }
          }

          const meta = [
            `📷 Camera: ${snap.cameraName || snap.cameraId}`,
            `🕐 Time:   ${new Date(snap.timestamp).toLocaleString('ko-KR')}`,
            `🏷  Class:  ${snap.className}  (conf ${(snap.confidence * 100).toFixed(1)}%)`,
            snap.isLoitering ? `⚠️  Loitering: ${snap.dwellTime ? snap.dwellTime.toFixed(1) + 's' : 'yes'}` : null,
            snap.zoneName    ? `📍 Zone:    ${snap.zoneName}` : null,
            snap.attributes?.color
              ? `👕 Color:   upper=${snap.attributes.color.upper}, lower=${snap.attributes.color.lower}`
              : null,
          ].filter(Boolean).join('\n');

          content.push({ type: 'text', text: meta });

          if (cropData) {
            // Strip data-URI prefix if present
            const base64 = cropData.replace(/^data:image\/[^;]+;base64,/, '');
            content.push({
              type:     'image',
              data:     base64,
              mimeType: 'image/jpeg',
            });
          } else {
            content.push({ type: 'text', text: '(이미지 없음)' });
          }
        }

        return { content };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  /**
   * search_person
   * Unified missing-person search: finds loitering events, tracking history,
   * and returns snapshot images for the top matching objects.
   */
  server.tool(
    'search_person',
    'Search for a missing person or suspicious individual across all cameras. ' +
    'Queries loitering events, retrieves cross-camera tracking history, and returns ' +
    'snapshot images. Useful for: "show me everyone who stayed near the entrance for >10 min".',
    {
      minDwellSec: z.number().optional().describe('Minimum dwell time in seconds (default 300)'),
      cameraId:    z.string().optional().describe('Restrict search to a specific camera'),
      from:        z.string().optional().describe('Start time (ISO 8601)'),
      to:          z.string().optional().describe('End time (ISO 8601)'),
      topN:        z.number().int().min(1).max(5).optional().describe('Return top N suspects by dwell time (default 3)'),
    },
    async ({ minDwellSec = 300, cameraId, from, to, topN = 3 }) => {
      try {
        // 1. Query loitering events
        const params = { limit: 200 };
        if (cameraId) params.cameraId = cameraId;
        if (from)     params.from = from;
        if (to)       params.to   = to;

        const { data: events = [] } = await client.get('/api/events', params);
        const filtered = events.filter(e => (e.dwellTime || 0) >= minDwellSec);

        if (filtered.length === 0) {
          return {
            content: [{ type: 'text', text: `No objects found with dwell ≥ ${minDwellSec}s in the given filters.` }],
          };
        }

        // 2. Aggregate by objectId — pick longest dwell per object
        const byObject = {};
        for (const e of filtered) {
          if (!byObject[e.objectId] || e.dwellTime > byObject[e.objectId].dwellTime) {
            byObject[e.objectId] = e;
          }
        }
        const topObjects = Object.values(byObject)
          .sort((a, b) => b.dwellTime - a.dwellTime)
          .slice(0, topN);

        const content = [];
        content.push({
          type: 'text',
          text: `🔍 실종자 탐색 결과 — 체류시간 ≥ ${minDwellSec}s 조건 (상위 ${topObjects.length}명)`,
        });

        // 3. For each object: tracking history + snapshot image
        for (let i = 0; i < topObjects.length; i++) {
          const ev = topObjects[i];

          content.push({
            type: 'text',
            text: `\n${'─'.repeat(50)}\n` +
                  `👤 #${i + 1} Object ID: ${ev.objectId}\n` +
                  `📷 Camera:    ${ev.cameraId}\n` +
                  `📍 Zone:      ${ev.zoneName || ev.zoneId || 'Global'}\n` +
                  `⏱  Dwell:     ${ev.dwellTime.toFixed(1)}s\n` +
                  `🕐 Detected:  ${new Date(ev.startTime).toLocaleString('ko-KR')}`,
          });

          // Tracking history
          try {
            const hist = await client.get('/api/tracker', {});
            const track = (hist?.data || []).find(t => t.objectId === ev.objectId);
            if (track) {
              content.push({
                type: 'text',
                text: `🗺  이동경로: ${(track.cameras || [ev.cameraId]).join(' → ')}\n` +
                      `   첫 발견: ${new Date(track.firstSeen || ev.startTime).toLocaleString('ko-KR')}\n` +
                      `   마지막:  ${new Date(track.lastSeen  || ev.startTime).toLocaleString('ko-KR')}`,
              });
            }
          } catch { /* tracking optional */ }

          // Snapshot image
          try {
            const { snapshots = [] } = await client.get('/api/snapshots', {
              objectId: ev.objectId,
              limit:    1,
            });

            if (snapshots.length > 0) {
              const snap = snapshots[0];
              let cropData = snap.cropData;
              if (!cropData) {
                const full = await client.get(`/api/snapshots/${snap.id}`);
                cropData = full?.cropData ?? full?.data?.cropData;
              }
              if (cropData) {
                const base64 = cropData.replace(/^data:image\/[^;]+;base64,/, '');
                content.push({ type: 'text', text: '📸 스냅샷:' });
                content.push({ type: 'image', data: base64, mimeType: 'image/jpeg' });
              }
              if (snap.attributes?.color) {
                const c = snap.attributes.color;
                content.push({
                  type: 'text',
                  text: `👕 의상: 상의=${c.upper}, 하의=${c.lower}`,
                });
              }
            }
          } catch { /* image optional */ }
        }

        return { content };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
