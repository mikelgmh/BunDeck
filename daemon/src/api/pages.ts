/** Rutas `/api/v1/pages*` — CRUD de páginas. */
import { v4 as uuidv4 } from 'uuid';
import { jsonResponse, dataTooLarge, MAX_PAGE_PROFILE_DATA_BYTES } from './http-helpers';
import type { ApiHandler } from './types';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';

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
      if (dataTooLarge(body.data)) {
        return jsonResponse(
          { error: `page data exceeds ${MAX_PAGE_PROFILE_DATA_BYTES} bytes (possible corrupted payload)` },
          413
        );
      }
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

  // Endpoint compuesto (Fase C+D): evita N llamadas serie en loadProfile.
  // GET /api/v1/pages/:id/context → { page, buttons, assignments, pageVersion }
  // Solo aditivo: no altera las rutas existentes. Debe evaluarse ANTES que
  // el genérico /api/v1/pages/:id.
  const contextMatch = path.match(/^\/api\/v1\/pages\/([^/]+)\/context$/);
  if (contextMatch && method === 'GET') {
    const pageId = contextMatch[1];
    const page = db.getPage(pageId);
    if (!page) {
      return jsonResponse({ error: 'Page not found' }, 404);
    }
    const buttons = db.getButtonsByPage(pageId);
    let assignments: Record<string, string> = {};
    try {
      assignments = db.getAssignments(page.profile_id);
    } catch { /* mejor esfuerzo */ }
    return jsonResponse({ page, buttons, assignments, pageVersion: Date.now() });
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
      if (dataTooLarge(body.data)) {
        return jsonResponse(
          { error: `page data exceeds ${MAX_PAGE_PROFILE_DATA_BYTES} bytes (possible corrupted payload)` },
          413
        );
      }
      const page = db.getPage(pageId);
      if (!page) {
        return jsonResponse({ error: 'Page not found' }, 404);
      }

      try {
        db.updatePage(pageId, body);
        const updatedPage = db.getPage(pageId);
        services.wsManager.broadcast('page.updated', { pageId, page: updatedPage }, 'pages');
        // Refrescar el HW solo si muestra esta página (editar otra página en
        // el editor no debe mover el deck físico).
        if (body.data !== undefined || body.grid_cols !== undefined || body.grid_rows !== undefined) {
          try {
            if (streamDeckDriver.isConnected()) streamDeckDriver.scheduleRefreshIfVisible(pageId);
          } catch { /* noop */ }
        }
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
