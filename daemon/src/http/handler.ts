/**
 * Manejador HTTP compartido del daemon (API + estáticos + /config + /health).
 *
 * Extraído de `server.ts` sin cambiar comportamiento: el `Bun.serve` de la
 * API y el CLIENTE DEL TÚNEL (`remote/tunnel.ts`) usan la misma función para
 * que lo servido por el relay sea idéntico a lo local.
 */
import { setupAPIRoutes } from '../api/routes';
import { buildCorsHeaders, isPreflight, preflightResponse, withCors } from './cors';
import {
  evaluateLanAccess,
  lanDeniedResponse,
  markLanContext,
  withLanCookie,
  getPeerIp,
} from './lan-guard';
import { DatabaseService } from '../db';
import { findWebDistFile, findWebDistIndex, getContentType, serveDataAsset, webDistCacheHeaders } from './static';
import { getVersion } from '../version';
import { API_PORT as PORT, WS_PORT, FRONTEND_PORT } from '../config';
import type { APIServices } from '../api/types';

/** Puerto del Astro dev (UI viva). Coincide con `web/astro.config.mjs`. */
export function astroDevPort(): number {
  const n = Number(process.env.ASTRO_PORT ?? '4321');
  return Number.isFinite(n) && n > 0 ? n : 4321;
}

/**
 * En DEV_MODE el túnel (`/t/<token>/…`) y las visitas directas sirven la UI
 * VIVA de Astro (`npm run dev`) en vez de `web-dist` compilado (obsoleto en
 * dev: el iPad veía la app vieja). Lectura dinámica de env para poder
 * testearlo sin reimportar el módulo.
 */
export function shouldProxyToAstro(pathname: string): boolean {
  if (process.env.DEV_MODE !== 'true') return false;
  if (pathname.startsWith('/api/')) return false;
  if (pathname.startsWith('/assets/')) return false;
  if (pathname === '/config' || pathname === '/health') return false;
  return true;
}

/**
 * Reverse-proxy best-effort a Astro dev. Devuelve `null` si Astro no responde
 * (el llamador cae a web-dist). El HMR-WS de Vite no viaja por el túnel (el
 * puente solo lleva `/ws`): la página carga viva pero sin hot-reload.
 */
export async function tryProxyAstroDev(req: Request, url: URL): Promise<Response | null> {
  const upstream = `http://127.0.0.1:${astroDevPort()}${url.pathname}${url.search}`;
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'content-length') return;
    try {
      headers.append(k, v);
    } catch { /* noop */ }
  });
  const init: RequestInit = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(8000),
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const buf = await req.arrayBuffer().catch(() => null);
    if (buf && buf.byteLength > 0) init.body = buf;
  }
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, init);
  } catch {
    return null;
  }
  const outHeaders = new Headers();
  upstreamRes.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === 'content-encoding' || lk === 'content-length' || lk === 'connection' || lk === 'transfer-encoding') return;
    try {
      outHeaders.append(k, v);
    } catch { /* noop */ }
  });
  // El documento HTML siempre fresco (iOS cachea agresivo sin no-store).
  if ((outHeaders.get('content-type') ?? '').includes('text/html')) {
    outHeaders.set('Cache-Control', 'no-store');
  }
  const body = await upstreamRes.arrayBuffer().catch(() => null);
  return new Response(body, { status: upstreamRes.status, headers: outHeaders });
}

export interface DaemonHttpDeps {
  wsManager: APIServices['wsManager'];
  pluginLoader: APIServices['pluginLoader'];
  actionRunner: APIServices['actionRunner'];
  windowWatcher: APIServices['windowWatcher'];
  onShutdown?: () => void;
}

/** Construye el `fetch` que usa `Bun.serve` para la API. Reutilizable por el túnel. */
export function createDaemonFetch(deps: DaemonHttpDeps): (req: Request, server?: any) => Promise<Response> {
  return async (req: Request, server?: any): Promise<Response> => {
    const url = new URL(req.url);
    const origin = req.headers.get('origin');
    const corsHeaders = buildCorsHeaders(origin);

    // Manejar preflight OPTIONS
    if (isPreflight(req)) {
      return preflightResponse(req);
    }

    // Guardia LAN solo-por-invitación (ver http/lan-guard.ts). El túnel del
    // relay llama sin socket (server undefined → via 'tunnel', ya autenticado
    // por el relay) y localhost queda exento.
    const peerIp = getPeerIp(req, server);
    let verdict;
    try {
      // Sin socket (túnel del relay) la IP es null por diseño: el relay ya
      // autenticó. Con socket real, null se deniega (ver lan-guard).
      verdict = evaluateLanAccess(new DatabaseService(), req, peerIp, { allowNullPeer: server == null });
    } catch {
      // Sin BD (tests de handler puro): solo loopback/túnel/público.
      verdict = { ok: false as const, status: 401 as const, code: 'LAN_INVITE_REQUIRED', message: 'Sin permiso' };
      if (peerIp === null && server == null) verdict = { ok: true as const, via: 'tunnel' as const };
    }
    markLanContext(req, { via: verdict.ok ? verdict.via : 'denied', peerIp });
    if (!verdict.ok) {
      return withCors(lanDeniedResponse(req, verdict), origin);
    }
    const finish = (res: Response): Response => withCors(withLanCookie(res, verdict), origin);

    // Servir assets estáticos (subidos por el usuario en <data>/assets)
    if (url.pathname.startsWith('/assets/')) {
      const served = await serveDataAsset(url.pathname.replace('/assets/', ''), corsHeaders);
      if (served) return finish(served);

      return finish(new Response('Asset not found', {
        status: 404,
        headers: corsHeaders,
      }));
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

      return finish(response);
    }

    // Config para el frontend (puertos centralizados).
    // También servido por el frontend embebido en prod; aquí para DEV_MODE.
    if (url.pathname === '/config') {
      return finish(new Response(
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
      ));
    }

    // Health check
    if (url.pathname === '/health') {
      return finish(new Response(
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
      ));
    }

    // DEV_MODE: UI viva de Astro (npm run dev) en vez de web-dist compilado
    // (obsoleto en dev). Vale para el túnel y para visitas directas.
    if (shouldProxyToAstro(url.pathname)) {
      try {
        const proxied = await tryProxyAstroDev(req, url);
        if (proxied) return finish(proxied);
      } catch { /* cae a web-dist */ }
    }

    // Frontend embebido (web-dist): lo mismo que el servidor dedicado de
    // `server.ts`, para que el túnel (`/t/<token>/…`) sirva la UI real en el
    // móvil en vez del texto plano de la API.
    try {
      const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
      const found = await findWebDistFile(filePath);
      if (found) {
        return finish(new Response(Bun.file(found), {
          headers: {
            ...corsHeaders,
            'Content-Type': getContentType(filePath),
            ...webDistCacheHeaders(filePath),
          },
        }));
      }
    } catch {
      /* cae al fallback SPA */
    }

    // Fallback SPA a index.html (rutas del frontend sin fichero propio).
    try {
      const indexPath = await findWebDistIndex();
      if (indexPath) {
        return finish(new Response(Bun.file(indexPath), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/html',
            'Cache-Control': 'no-store',
          },
        }));
      }
    } catch {
      /* sin web-dist: mensaje de diagnóstico */
    }

    return finish(new Response('BunDeck API Server', {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/plain; charset=utf-8',
      },
    }));
  };
}
