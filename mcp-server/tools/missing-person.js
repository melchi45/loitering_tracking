import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerMissingPersonTools(server, client) {
  server.tool(
    'register_missing_person',
    'Register a missing person with profile data and facial embedding.',
    {
      name:        z.string().min(1).describe('Missing person name'),
      age:         z.number().int().min(0).max(150).describe('Age'),
      gender:      z.enum(['M', 'F', 'OTHER']).describe('Gender'),
      description: z.string().min(1).describe('Physical traits / clothing details'),
      photoUrl:    z.string().min(1).describe('Photo URL or base64 image payload'),
      priority:    z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().describe('Priority level (default: MEDIUM)'),
      contactName: z.string().optional().describe('Emergency contact name'),
      contactPhone:z.string().min(1).describe('Emergency contact phone number'),
      contactRelation: z.string().optional().describe('Relationship to missing person'),
      faceEmbedding: z.array(z.number()).length(512).optional().describe('Optional 512-d face embedding')
    },
    async ({ name, age, gender, description, photoUrl, priority = 'MEDIUM', contactName, contactPhone, contactRelation, faceEmbedding }) => {
      try {
        const created = await client.post('/api/missing-persons', {
          name,
          age,
          gender,
          description,
          photoUrl,
          priority,
          faceEmbedding,
          contacts: {
            name: contactName || 'N/A',
            phone: contactPhone,
            relation: contactRelation || 'N/A',
          },
        });

        return {
          content: [{
            type: 'text',
            text: `Registered missing person ${created.name} (${created.id}) with status ${created.status}.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'search_missing_person',
    'Search missing persons by name, age, gender, status, or free-text query.',
    {
      query:  z.string().optional().describe('Free text query (name/description)'),
      age:    z.number().int().optional().describe('Age (uses +-5 tolerance)'),
      gender: z.enum(['M', 'F', 'OTHER']).optional().describe('Gender filter'),
      status: z.enum(['MISSING', 'FOUND', 'UNCONFIRMED']).optional().describe('Status filter (default: MISSING)'),
      limit:  z.number().int().min(1).max(50).optional().describe('Result limit (default: 10)'),
    },
    async ({ query, age, gender, status = 'MISSING', limit = 10 }) => {
      try {
        const params = { status, limit };
        if (query) params.q = query;
        if (typeof age === 'number') params.age = age;
        if (gender) params.gender = gender;

        const data = await client.get('/api/missing-persons', params);
        const results = data.results || [];

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No matching missing persons found.' }] };
        }

        const lines = results.map(p => [
          `${p.name} (${p.age}, ${p.gender})`,
          `  id: ${p.id}`,
          `  status: ${p.status}`,
          `  priority: ${p.priority}`,
          `  desc: ${p.description}`,
        ].join('\n'));

        return { content: [{ type: 'text', text: `${results.length} result(s):\n\n${lines.join('\n\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_missing_person_detections',
    'Get missing-person detection events for a date with optional filters.',
    {
      date: z.string().optional().describe('Date in YYYY-MM-DD (default: today)'),
      missingPersonId: z.string().optional().describe('Missing person ID filter'),
      status: z.enum(['PENDING', 'CONFIRMED', 'FALSE_POSITIVE']).optional().describe('Detection status filter'),
      limit: z.number().int().min(1).max(100).optional().describe('Result limit (default: 50)'),
    },
    async ({ date, missingPersonId, status, limit = 50 }) => {
      try {
        const targetDate = date || new Date().toISOString().slice(0, 10);
        const params = { date: targetDate, limit };
        if (missingPersonId) params.missingPersonId = missingPersonId;
        if (status) params.status = status;

        const data = await client.get('/api/missing-persons/detections', params);
        const detections = data.detections || [];
        const summary = data.summary || {};

        if (detections.length === 0) {
          return { content: [{ type: 'text', text: `No detections found for ${targetDate}.` }] };
        }

        const lines = detections.map(d => {
          const ts = new Date(d.timestamp).toISOString();
          const name = d.missingPerson?.name || d.missingPersonId;
          const sim = typeof d.similarity === 'number' ? `${(d.similarity * 100).toFixed(1)}%` : 'N/A';
          return `${name} @ ${d.cameraId} | ${ts} | similarity=${sim} | status=${d.status}`;
        });

        return {
          content: [{
            type: 'text',
            text: [
              `Detections for ${targetDate}`,
              `total=${summary.total || detections.length}, confirmed=${summary.confirmed || 0}, pending=${summary.pending || 0}, falsePositive=${summary.falsePositives || 0}`,
              '',
              ...lines,
            ].join('\n'),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'update_missing_person_status',
    'Update missing person status to FOUND / MISSING / UNCONFIRMED.',
    {
      missingPersonId: z.string().min(1).describe('Missing person ID'),
      status: z.enum(['FOUND', 'MISSING', 'UNCONFIRMED']).describe('New status'),
      notes: z.string().optional().describe('Optional audit note'),
    },
    async ({ missingPersonId, status, notes }) => {
      try {
        const updated = await client.put(`/api/missing-persons/${missingPersonId}/status`, { status, notes });
        return {
          content: [{
            type: 'text',
            text: `Updated ${updated.name} (${updated.id}) to status ${updated.status}.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_missing_person_statistics',
    'Get missing-person registry and detection statistics.',
    {},
    async () => {
      try {
        const stats = await client.get('/api/missing-persons/stats');
        return {
          content: [{
            type: 'text',
            text: [
              'Missing person stats',
              `registered=${stats.totalRegistered}, missing=${stats.totalMissing}, found=${stats.totalFound}`,
              `detectionsToday=${stats.totalDetectionsToday}, confirmedToday=${stats.confirmedToday}, pendingToday=${stats.pendingToday}`,
              `priority(H/M/L)=${stats.byPriority?.HIGH || 0}/${stats.byPriority?.MEDIUM || 0}/${stats.byPriority?.LOW || 0}`,
            ].join('\n'),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}

export function registerMissingPersonResources(server, client) {
  server.resource(
    'missing-persons-registry',
    'missing-persons://registry',
    { mimeType: 'application/json', description: 'Missing person registry list' },
    async () => {
      const data = await client.get('/api/missing-persons', { limit: 100, status: 'MISSING' });
      return {
        contents: [{
          uri: 'missing-persons://registry',
          mimeType: 'application/json',
          text: JSON.stringify(data.results || [], null, 2),
        }],
      };
    }
  );

  server.resource(
    'missing-persons-detections',
    new ResourceTemplate('missing-persons://detections/{date}', { list: undefined }),
    { mimeType: 'application/json', description: 'Missing-person detection events by date (YYYY-MM-DD)' },
    async (uri, { date }) => {
      const data = await client.get('/api/missing-persons/detections', { date, limit: 100 });
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );
}
