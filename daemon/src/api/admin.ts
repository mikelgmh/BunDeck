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

export const handleAdmin: ApiHandler = async (_req, { method, path, services }) => {
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
