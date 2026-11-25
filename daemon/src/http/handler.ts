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
import chokidar from 'chokidar';
import {
  findWebDistFile,
  findWebDistIndex,
  getContentType,
  resolveWebSrcCandidates,
  serveDataAsset,
  webDistCacheHeaders,
  webDistStale,
} from './static';
import { getVersion } from '../version';
import { API_PORT as PORT, WS_PORT, FRONTEND_PORT } from '../config';
import type { APIServices } from '../api/types';
import fs from 'node:fs';
import path from 'node:path';

/** Intervalo mínimo entre auto-rebuilds del frontend en DEV. */
export const WEB_BUILD_MIN_INTERVAL_MS = 60_000;

let webBuildRunning = false;
let webBuildLastTrigger = 0;

/** Solo tests: resetea el estado del auto-rebuild. */
export function __resetWebDistRebuildForTests(): void {
  webBuildRunning = false;
  webBuildLastTrigger = 0;
}

let webDistWatcher: chokidar.FSWatcher | null = null;
let webDistDebounce: ReturnType<typeof setTimeout> | null = null;

/** Debounce del watcher: reconstruye X ms después del último cambio. */
export const WEBDIST_WATCH_DEBOUNCE_MS = 8000;

/** Solo tests: cierra el watcher y limpia el debounce. */
export function __resetWebDistWatcherForTests(): void {
  if (webDistDebounce) clearTimeout(webDistDebounce);
  webDistDebounce = null;
  if (webDistWatcher) {
    try {
      void webDistWatcher.close();
    } catch { /* noop */ }
    webDistWatcher = null;
  }
}

/**
 * DEV: vigila `web/src` y reconstruye `web/dist` en segundo plano al guardar.
 *
 * El rebuild perezoso (al pedir un .html) llegaba tarde — en pleno test del
 * kiosco por relay — y quemaba CPU en el peor momento. El watcher reconstruye
 * justo después de editar (con debounce) y respeta el guard de "ya hay un
 * build en curso" de `maybeRebuildWebDist`. Solo arranca si existe `web/src`
 * (en prod/instalado no hay fuentes: no hace nada).
 */
export function startWebDistWatcher(opts?: {
  debounceMs?: number;
  spawnFn?: (webDir: string) => void;
  /** Solo tests: directorio src a vigilar (sin esto usa los candidatos reales). */
  srcDir?: string;
}): void {
  if (webDistWatcher) return;
  if (process.env.DEV_MODE !== 'true') return;
  const srcDir =
    opts?.srcDir ??
    (resolveWebSrcCandidates().find((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    }) ?? null);
  if (!srcDir) return;
  // En tests, el dist va junto al srcDir inyectado; en real se resuelve
  // con los candidatos (web/dist primero en DEV).
  const testing = opts?.srcDir !== undefined;
  const sibling = path.join(path.dirname(srcDir), 'dist', 'index.html');
  const distIndex = testing ? (fs.existsSync(sibling) ? sibling : null) : undefined;
  const base = {
    ...(opts?.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    ...(testing ? { srcDir, distIndex } : {}),
  };
  // Si ya está obsoleto al arrancar, una reconstrucción inicial en segundo plano.
  void maybeRebuildWebDist(base).catch(() => {});
  const debounceMs = opts?.debounceMs ?? WEBDIST_WATCH_DEBOUNCE_MS;
  webDistWatcher = chokidar.watch(srcDir, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
    depth: 12,
  });
  webDistWatcher.on('all', () => {
    if (webDistDebounce) clearTimeout(webDistDebounce);
    webDistDebounce = setTimeout(() => {
      webDistDebounce = null;
      void maybeRebuildWebDist(base).catch(() => {});
    }, debounceMs);
  });
  console.log(`👀 Vigilando ${srcDir} → rebuild de web-dist al guardar (debounce ${debounceMs / 1000}s)`);
}

function defaultSpawnWebBuild(webDir: string): void {
  try {
    console.log(`🔨 web-dist obsoleto: reconstruyendo en segundo plano (npm run build en ${webDir})…`);
    const t0 = Date.now();
    const cmd =
      process.platform === 'win32' ? ['cmd', '/c', 'npm', 'run', 'build'] : ['npm', 'run', 'build'];
    const proc = Bun.spawn(cmd, { cwd: webDir, stdio: ['ignore', 'ignore', 'ignore'] });
    void proc.exited
      .then(() => {
        webBuildRunning = false;
        console.log(`✅ web-dist reconstruido en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      })
      .catch((e) => {
        webBuildRunning = false;
        console.warn(`⚠️ web-dist: falló la reconstrucción en segundo plano: ${e instanceof Error ? e.message : e}`);
      });
  } catch {
    webBuildRunning = false;
  }
}

/**
 * DEV_MODE: si `web/src` es más nuevo que `web/dist`, dispara `npm run build`
 * en segundo plano (máx. 1 vez por minuto, sin solapar). Así el túnel sirve UI
 * fresca sin intervención. No bloquea: se sirve el build actual mientras se
 * reconstruye (Vite vacía `dist` al empezar: puede haber un hueco breve de
 * 404 que se cura recargando).
 */
export async function maybeRebuildWebDist(opts?: {
  nowMs?: number;
  spawnFn?: (webDir: string) => void;
  /** Solo tests: override de src/dist (por defecto, candidatos reales). */
  srcDir?: string | null;
  distIndex?: string | null;
}): Promise<boolean> {
  if (process.env.DEV_MODE !== 'true') return false;
  if (webBuildRunning) return false;
  const now = opts?.nowMs ?? Date.now();
  if (now - webBuildLastTrigger < WEB_BUILD_MIN_INTERVAL_MS) return false;
  const srcDir =
    opts?.srcDir !== undefined
      ? opts.srcDir
      : (resolveWebSrcCandidates().find((d) => {
          try {
            return fs.statSync(d).isDirectory();
          } catch {
            return false;
          }
        }) ?? null);
  if (!srcDir) return false;
  const webDir = path.dirname(srcDir);
  const distIndex =
    opts?.distIndex !== undefined ? opts.distIndex : await findWebDistIndex().catch(() => null);
  if (!webDistStale(srcDir, distIndex)) return false;
  webBuildRunning = true;
  webBuildLastTrigger = now;
  try {
    (opts?.spawnFn ?? defaultSpawnWebBuild)(webDir);
  } catch {
    webBuildRunning = false;
  }
  return true;
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

    // Frontend embebido (web-dist): lo mismo que el servidor dedicado de
    // `server.ts`, para que el túnel (`/t/<token>/…`) sirva la UI real en el
    // móvil en vez del texto plano de la API. OJO: en DEV el túnel NO proxya
    // a Astro dev aunque sea más fresco: los bundles dev (`/@id/`, HMR…)
    // no sobreviven al reescritor de URLs del relay y la app quedaría sin
    // JS; se sirve el build y se reconstruye solo si está obsoleto (abajo).
    try {
      const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
      const found = await findWebDistFile(filePath);
      if (found) {
        if (filePath.endsWith('.html')) {
          // Solo en documentos (no en cada asset): si el build está viejo,
          // reconstruir en segundo plano para la próxima carga.
          void maybeRebuildWebDist().catch(() => {});
        }
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
        void maybeRebuildWebDist().catch(() => {});
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
