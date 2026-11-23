/**
 * Rutas `/api/v1/buttons*` — CRUD + reordenado atómico.
 * OJO: `/api/v1/buttons/reorder` debe evaluarse ANTES que `/api/v1/buttons/:id`.
 */
import { v4 as uuidv4 } from 'uuid';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';
import { jsonResponse } from './http-helpers';
import { isUniqueConstraintError } from './http-helpers';
import type { ApiHandler } from './types';

export const handleButtons: ApiHandler = async (_req, { url, method, path, db, services }) => {
  if (path === '/api/v1/buttons') {
    if (method === 'GET') {
      const pageId = url.searchParams.get('pageId');
      if (!pageId) {
        return jsonResponse({ error: 'pageId parameter required' }, 400);
      }

      const buttons = db.getButtonsByPage(pageId);
      return jsonResponse(buttons);
    }

    if (method === 'POST') {
      const body = await _req.json();
      const hasGeometry =
        body.x !== undefined || body.y !== undefined ||
        body.w !== undefined || body.h !== undefined ||
        body.widget_type !== undefined || body.kind !== undefined;
      // Geometría GridStack: crear como widget (x/y/w/h) manteniendo position legacy.
      if (hasGeometry) {
        try {
          const created = db.createButtonWidget({
            id: uuidv4(),
            page_id: body.page_id,
            position: body.position,
            kind: body.widget_type ?? body.kind ?? 'action_button',
            x: body.x ?? null,
            y: body.y ?? null,
            w: body.w ?? 1,
            h: body.h ?? 1,
            parent_widget_id: body.parent_widget_id ?? null,
            data: body.data || {},
          });
          services.wsManager.broadcast('button.created', { buttonId: created.id, button: created, pageId: created.page_id, mutationId: (body as any)?.mutationId, timestamp: Date.now() }, 'buttons');
          // Reglas load/timer/var fuera del camino crítico (ver scheduleResyncButtonAutomations).
          try { (services.actionRunner as any)?.scheduleResyncButtonAutomations?.(); } catch { /* noop */ }
          if (streamDeckDriver.isConnected()) {
            streamDeckDriver.scheduleRefreshIfVisible(created.page_id);
          }
          return jsonResponse(created, 201);
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            return jsonResponse({ error: `La posición ${body.position} ya está ocupada en esta página` }, 409);
          }
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }
      const button = {
        id: uuidv4(),
        page_id: body.page_id,
        position: body.position,
        data: body.data || {},
      };

      try {
        db.createButton(button);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return jsonResponse({ error: `La posición ${body.position} ya está ocupada en esta página` }, 409);
        }
        throw error;
      }
      services.wsManager.broadcast('button.created', { buttonId: button.id, button, pageId: button.page_id, mutationId: (body as any)?.mutationId, timestamp: Date.now() }, 'buttons');

      // Las reglas load/timer/var de la tecla funcionan con la UI cerrada:
      // re-sincronizar automatizaciones fuera del camino crítico (best-effort, no bloquea).
      try { (services.actionRunner as any)?.scheduleResyncButtonAutomations?.(); } catch { /* noop */ }

      // Repintado diferido (no bloquea la respuesta): el vaciado/creación
      // respondía tras un repintado completo y parecía "pillado".
      if (streamDeckDriver.isConnected()) {
        streamDeckDriver.scheduleRefreshIfVisible(button.page_id);
      }

      return jsonResponse(button, 201);
    }
  }

  // Reordenado atómico de botones (drag & drop): una sola transacción en BD,
  // un solo broadcast y un solo repintado del StreamDeck. Evita posiciones
  // duplicadas por fallos parciales de N PUTs individuales.
  if (path === '/api/v1/buttons/reorder') {
    if (method === 'POST') {
      try {
        const raw = (await _req.json()) as any;
        const { page_id, order } = raw ?? {};
        if (!page_id || !Array.isArray(order)) {
          return jsonResponse({ error: 'page_id y order (array) requeridos' }, 400);
        }

        const updated = db.reorderButtons(page_id, order);
        // pageVersion monotónico emitido por el servidor para que el
        // frontend descarte respuestas stale sin timestamp de cliente:
        // solo acepta si pageVersion avanza. Campo aditivo; el contrato
        // {success, buttons} no cambia.
        const pageVersion = Date.now();
        services.wsManager.broadcastButtonsReordered(page_id, updated, (raw as any)?.mutationId, pageVersion);
        // Fuera del camino crítico (ver scheduleResyncButtonAutomations).
        try { (services.actionRunner as any)?.scheduleResyncButtonAutomations?.(); } catch { /* noop */ }

        // Repintado diferido y coalescado (no bloquea la respuesta).
        if (streamDeckDriver.isConnected()) {
          streamDeckDriver.scheduleRefreshIfVisible(page_id);
        }

        return jsonResponse({ success: true, buttons: updated, pageVersion, mutationId: (raw as any)?.mutationId ?? null });
      } catch (error) {
        if (error instanceof Error && /no encontrado|no pertenece|duplicada|inválido|vacío/.test(error.message)) {
          return jsonResponse({ error: error.message }, 400);
        }
        if (isUniqueConstraintError(error)) {
          return jsonResponse({ error: 'Conflicto de posiciones: recarga los botones e inténtalo de nuevo' }, 409);
        }
        throw error;
      }
    }
  }

  if (path.startsWith('/api/v1/buttons/')) {
    const buttonId = path.split('/')[4];

    if (method === 'GET') {
      const button = db.getButton(buttonId);
      if (!button) {
        return jsonResponse({ error: 'Button not found' }, 404);
      }
      return jsonResponse(button);
    }

    if (method === 'PUT') {
      const body = await _req.json();
      const hasGeometry =
        body.x !== undefined || body.y !== undefined ||
        body.w !== undefined || body.h !== undefined ||
        body.widget_type !== undefined || body.kind !== undefined ||
        body.parent_widget_id !== undefined;

      try {
        // Geometría GridStack: actualizar x/y/w/h/tipo sin tocar data si no viene.
        if (hasGeometry) {
          db.updateButtonWidget(buttonId, {
            kind: body.widget_type ?? body.kind,
            x: body.x ?? undefined,
            y: body.y ?? undefined,
            w: body.w ?? undefined,
            h: body.h ?? undefined,
            parent_widget_id: body.parent_widget_id,
            data: body.data,
            position: body.position,
            page_id: body.page_id,
          });
        } else if (body.position !== undefined) {
          db.updateButtonComplete(buttonId, {
            data: body.data,
            position: body.position,
          });
        } else {
          db.updateButton(buttonId, body.data);
        }
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return jsonResponse({ error: `La posición ${body.position} ya está ocupada en esta página` }, 409);
        }
        throw error;
      }

      const updatedButton = db.getButton(buttonId);
      services.wsManager.broadcastButtonUpdate(buttonId, updatedButton, (body as any)?.mutationId);

      // Fuera del camino crítico (ver scheduleResyncButtonAutomations).
      try { (services.actionRunner as any)?.scheduleResyncButtonAutomations?.(); } catch { /* noop */ }

      // Repintado diferido (no bloquea la respuesta).
      if (streamDeckDriver.isConnected() && updatedButton) {
        streamDeckDriver.scheduleRefreshIfVisible(updatedButton.page_id);
      }

      return jsonResponse(updatedButton);
    }

    if (method === 'DELETE') {
      const button = db.getButton(buttonId);
      if (!button) {
        return jsonResponse({ error: 'Button not found' }, 404);
      }

      const pageId = button.page_id;
      db.deleteButton(buttonId);
      const deleteBody = await _req.json().catch(() => ({}));
      services.wsManager.broadcastButtonDeleted(buttonId, (deleteBody as any)?.mutationId, pageId);

      // Fuera del camino crítico (ver scheduleResyncButtonAutomations).
      try { (services.actionRunner as any)?.scheduleResyncButtonAutomations?.(); } catch { /* noop */ }

      // Repintado diferido (no bloquea la respuesta): vaciar respondía
      // tras el repintado completo y la UI parecía congelada.
      if (streamDeckDriver.isConnected()) {
        streamDeckDriver.scheduleRefreshIfVisible(pageId);
      }

      return jsonResponse({ success: true });
    }
  }

  return null;
};
