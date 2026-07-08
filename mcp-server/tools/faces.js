import { z } from 'zod';

export function registerFaceGalleryTools(server, client) {
  server.tool(
    'list_face_galleries',
    'List all face galleries (general / VIP / blocklist / missing) with enrolled face counts. ' +
    'Use this before search_person or query_face_trajectories to see what galleries exist, or to ' +
    'check how many faces are enrolled for GDPR/audit purposes.',
    {
      type: z.enum(['general', 'vip', 'blocklist', 'missing']).optional().describe('Filter by gallery type'),
    },
    async ({ type }) => {
      try {
        const { data: galleries = [] } = await client.get('/api/galleries');
        const filtered = type ? galleries.filter(g => g.type === type) : galleries;

        if (filtered.length === 0) {
          return { content: [{ type: 'text', text: type ? `No galleries of type "${type}".` : 'No face galleries configured.' }] };
        }

        const lines = filtered.map(g =>
          `${g.name} (${g.id}) — type=${g.type}, faces=${g.faceCount}${g.description ? ` — ${g.description}` : ''}`
        );

        return { content: [{ type: 'text', text: `${filtered.length} galleries:\n\n${lines.join('\n')}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
