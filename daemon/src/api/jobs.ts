/** Rutas `/api/v1/jobs*` — operaciones largas (import/build/clone) anti-cuelgue. */
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';

export const handleJobs: ApiHandler = async (_req, { method, path }) => {
  if (path === '/api/v1/jobs') {
    if (method === 'GET') {
      const { getJobManager } = await import('../jobs/manager');
      return jsonResponse({ jobs: getJobManager().list() });
    }
  }
  if (path.startsWith('/api/v1/jobs/') && path.endsWith('/cancel')) {
    if (method === 'POST') {
      const id = decodeURIComponent(path.split('/')[4] ?? '');
      const { getJobManager } = await import('../jobs/manager');
      const ok = getJobManager().cancel(id);
      if (!ok) return jsonResponse({ error: 'Job not found o ya terminado' }, 404);
      return jsonResponse({ success: true, jobId: id });
    }
  }

  return null;
};
