/**
 * Rutas `/api/v1/admin/*` y `/api/v1/update`.
 *
 * Contrato de `POST /api/v1/admin/shutdown` (coordinado con el host):
 * responde `{success:true}` INMEDIATAMENTE y apaga de forma diferida
 * (vía `services.onShutdown`, que server.ts inyecta desde lifecycle.ts).
 * Sin `onShutdown` (tests) responde igual sin apagar.
 *
 * `POST /api/v1/update`: 501 canónico — las updates las gestiona el
 * launcher (ver UPDATE_SYSTEM.md), no la API del daemon.
 */
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';
import { resetDatabaseToDefaults } from '../db';

export const handleAdmin: ApiHandler = async (_req, { method, path, services }) => {
  // Restablecimiento total a valores de fábrica. Requiere confirmación
  // explícita ({ "confirm": true }): sin ella responde 400 sin tocar nada.
  // Borra TODO (perfiles, páginas, botones, variables, ajustes, sesiones…)
  // y restaura la semilla por defecto (perfil + plugins built-in).
  if (path === '/api/v1/admin/reset') {
    if (method === 'POST') {
      let body: any = {};
      try { body = await _req.json(); } catch { body = {}; }
      if (body?.confirm !== true) {
        return jsonResponse(
          { error: 'Confirmación requerida', hint: 'Repite la petición con { "confirm": true }.' },
          400
        );
      }
      try {
        const result = await resetDatabaseToDefaults();
        try {
          services.wsManager?.broadcast('profile.updated', { profileId: result.profileId, reset: true }, 'profiles');
        } catch { /* noop: el frontend recarga tras el reset */ }
        return jsonResponse({ success: true, reset: true, ...result });
      } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
  }

  if (path === '/api/v1/admin/shutdown') {
    if (method === 'POST') {
      console.log('Shutdown requested via API');

      // Apagado diferido vía lifecycle (2s) para que el CLI/web procesen
      // la respuesta antes de que el proceso muera.
      services.onShutdown?.();

      return jsonResponse({ success: true, message: 'Shutting down...' });
    }
  }

  // Deprecated: update flow moved to the launcher (ver UPDATE_SYSTEM.md).
  // Kept as 501 so old clients fail loudly instead of hanging.
  if (path === '/api/v1/update') {
    if (method === 'POST') {
      return jsonResponse(
        { error: 'Gone', message: 'Updates are managed by the launcher updater, not the daemon API.' },
        501
      );
    }
  }

  return null;
};
