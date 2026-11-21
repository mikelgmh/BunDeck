/** Rutas `/api/v1/pages*` — CRUD de páginas. */
import { v4 as uuidv4 } from 'uuid';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';

export const handlePages: ApiHandler = async (_req, { url, method, path, db, services }) => {
  if (path === '/api/v1/pages') {
    if (method === 'GET') {
      const profileId = url.searchParams.get('profileId');
      if (!profileId) {
        return jsonResponse({ error: 'profileId parameter required' }, 400);
      }

      const pages = db.getPagesByProfile(profileId);
      return jsonResponse(pages);
    }

    if (method === 'POST') {
      const body = await _req.json();
      const page = {
        id: uuidv4(),
        profile_id: body.profile_id,
        name: body.name,
        order_idx: body.order_idx || 0,
        is_folder: body.is_folder || 0,
        data: body.data || {},
      };

      try {
        db.createPage(page);
        services.wsManager.broadcastPageCreated(page.id, page);

        return jsonResponse(page, 201);
      } catch (error) {
        if (error instanceof Error && error.message.includes('already exists')) {
          return jsonResponse({ error: error.message }, 409);
        }
        throw error;
      }
    }
  }

  if (path.startsWith('/api/v1/pages/')) {
    const pageId = path.split('/')[4];

    if (method === 'GET') {
      const page = db.getPage(pageId);
      if (!page) {
        return jsonResponse({ error: 'Page not found' }, 404);
      }
      return jsonResponse(page);
    }

    if (method === 'PUT') {
      const body = await _req.json();
      const page = db.getPage(pageId);
      if (!page) {
        return jsonResponse({ error: 'Page not found' }, 404);
      }

      try {
        db.updatePage(pageId, body);
        const updatedPage = db.getPage(pageId);
        services.wsManager.broadcast('page.updated', { pageId, page: updatedPage }, 'pages');
        return jsonResponse(updatedPage);
      } catch (error) {
        if (error instanceof Error && error.message.includes('already exists')) {
          return jsonResponse({ error: error.message }, 409);
        }
        throw error;
      }
    }

    if (method === 'DELETE') {
      const page = db.getPage(pageId);
      if (!page) {
        return jsonResponse({ error: 'Page not found' }, 404);
      }

      db.deletePage(pageId);
      services.wsManager.broadcastPageDeleted(pageId);
      return jsonResponse({ success: true });
    }
  }

  return null;
};
