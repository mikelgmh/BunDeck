/**
 * Manejador HTTP compartido del daemon (API + estáticos + /config + /health).
 *
 * Extraído de `server.ts` sin cambiar comportamiento: el `Bun.serve` de la
 * API y el CLIENTE DEL TÚNEL (`remote/tunnel.ts`) usan la misma función para
 * que lo servido por el relay sea idéntico a lo local.
 */
import { setupAPIRoutes } from '../api/routes';
import { buildCorsHeaders, isPreflight, preflightResponse, withCors } from './cors';
import { findWebDistFile, findWebDistIndex, getContentType, serveDataAsset } from './static';
import { getVersion } from '../version';
import { API_PORT as PORT, WS_PORT, FRONTEND_PORT } from '../config';
import type { APIServices } from '../api/types';

export interface DaemonHttpDeps {
  wsManager: APIServices['wsManager'];
  pluginLoader: APIServices['pluginLoader'];
  actionRunner: APIServices['actionRunner'];
  windowWatcher: APIServices['windowWatcher'];
  onShutdown?: () => void;
}

/** Construye el `fetch` que usa `Bun.serve` para la API. Reutilizable por el túnel. */
export function createDaemonFetch(deps: DaemonHttpDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const origin = req.headers.get('origin');
    const corsHeaders = buildCorsHeaders(origin);

    // Manejar preflight OPTIONS
    if (isPreflight(req)) {
      return preflightResponse(req);
    }

    // Servir assets estáticos (subidos por el usuario en <data>/assets)
    if (url.pathname.startsWith('/assets/')) {
      const served = await serveDataAsset(url.pathname.replace('/assets/', ''), corsHeaders);
      if (served) return served;

      return new Response('Asset not found', {
        status: 404,
        headers: corsHeaders,
      });
    }

    // Manejar rutas API
    if (url.pathname.startsWith('/api/')) {
      const response = await setupAPIRoutes(req, {
        wsManager: deps.wsManager!,
        pluginLoader: deps.pluginLoader!,
        actionRunner: deps.actionRunner!,
        windowWatcher: deps.windowWatcher,
        onShutdown: deps.onShutdown,
      });

      return withCors(response, origin);
    }

    // Config para el frontend (puertos centralizados).
    // También servido por el frontend embebido en prod; aquí para DEV_MODE.
    if (url.pathname === '/config') {
      return new Response(
        JSON.stringify({
          wsPort: WS_PORT,
          apiPort: PORT,
          frontendPort: FRONTEND_PORT,
        }),
        {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          timestamp: Date.now(),
          version: getVersion(),
          websocket: WS_PORT,
        }),
        {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // Frontend embebido (web-dist): lo mismo que el servidor dedicado de
    // `server.ts`, para que el túnel (`/t/<token>/…`) sirva la UI real en el
    // móvil en vez del texto plano de la API.
    try {
      const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
      const found = await findWebDistFile(filePath);
      if (found) {
        return new Response(Bun.file(found), {
          headers: {
            ...corsHeaders,
            'Content-Type': getContentType(filePath),
          },
        });
      }
    } catch {
      /* cae al fallback SPA */
    }

    // Fallback SPA a index.html (rutas del frontend sin fichero propio).
    try {
      const indexPath = await findWebDistIndex();
      if (indexPath) {
        return new Response(Bun.file(indexPath), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/html',
          },
        });
      }
    } catch {
      /* sin web-dist: mensaje de diagnóstico */
    }

    return new Response('BunDeck API Server', {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  };
}
