/**
 * client.ts — Capa HTTP del CLI contra el daemon (DaemonClient funcional).
 *
 * Contratos del daemon (solo lectura, NO modificar el daemon):
 * - daemon/src/server.ts: GET /health -> { status, timestamp, version, websocket: <wsPort:number> }
 *                         GET /config -> { wsPort, apiPort, frontendPort }
 *                         Solo las rutas /api/* llegan a setupAPIRoutes; el resto cae
 *                         a respuestas estáticas. Por eso TODOS los endpoints de la API
 *                         usan el prefijo /api/v1 (ver ENDPOINTS).
 * - daemon/src/api/routes.ts:
 *     GET  /api/v1/plugins                      -> { installed, loaded, detailed }
 *     POST /api/v1/plugins/install { sourceType: 'git'|'marketplace'|'url'|'directory', url?, path?, ref?, checksum?, force?, origin? }
 *     POST /api/v1/plugins/upload  (multipart form-data: file .zip/.plectro, force?)
 *     GET/POST /api/v1/profiles   | GET/PUT/DELETE /api/v1/profiles/:id
 *     GET /api/v1/pages?profileId= | GET /api/v1/buttons?pageId=
 *     GET /api/v1/logs?limit=&level=
 *     POST /api/v1/admin/shutdown
 */

import {
  buildApiBase,
  buildWsUrl,
  normalizePort,
  parseHealth,
  DEFAULT_API_PORT,
  DEFAULT_WS_PORT,
} from './cli-utils';

/** Prefijo obligatorio de la API del daemon (server.ts solo enruta /api/*). */
export const API_PREFIX = '/api/v1';

export const ENDPOINTS = {
  health: '/health',
  config: '/config',
  plugins: `${API_PREFIX}/plugins`,
  pluginInstall: `${API_PREFIX}/plugins/install`,
  pluginUpload: `${API_PREFIX}/plugins/upload`,
  profiles: `${API_PREFIX}/profiles`,
  pages: `${API_PREFIX}/pages`,
  buttons: `${API_PREFIX}/buttons`,
  logs: `${API_PREFIX}/logs`,
  settings: `${API_PREFIX}/settings`,
  shutdown: `${API_PREFIX}/admin/shutdown`,
} as const;

export type LogFn = (message: string) => void;
const noop: LogFn = () => {};

export function resolveApiBase(port: unknown): string {
  return buildApiBase(port);
}

export function resolveWsUrl(port: unknown): string {
  return buildWsUrl(port);
}

/** GET /config tal cual lo devuelve el daemon ({ wsPort, apiPort, frontendPort }). */
export async function fetchDaemonConfig(
  apiBase: string,
): Promise<{ wsPort?: number; apiPort?: number; frontendPort?: number }> {
  const response = await fetch(`${apiBase}${ENDPOINTS.config}`);
  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as { wsPort?: number; apiPort?: number; frontendPort?: number };
}

/**
 * Descubre el puerto WS del daemon: primero GET /config (fuente oficial),
 * si falla cae a GET /health (campo `websocket`), y si el daemon no responde
 * devuelve el fallback (flag --ws-port o DEFAULT_WS_PORT).
 */
export async function discoverWsPort(apiBase: string, fallback: unknown): Promise<number> {
  try {
    const config = await fetchDaemonConfig(apiBase);
    if (Number.isFinite(Number(config?.wsPort))) {
      return Number(config.wsPort);
    }
  } catch {
    // Sin /config: intentar con /health
  }
  try {
    const response = await fetch(`${apiBase}${ENDPOINTS.health}`);
    if (response.ok) {
      const parsed = parseHealth(await response.json());
      if (parsed.wsPort) return parsed.wsPort;
    }
  } catch {
    // Daemon no disponible: usar fallback
  }
  return normalizePort(fallback, DEFAULT_WS_PORT);
}

/**
 * Petición JSON contra la API del daemon.
 * `port` se usa para construir la base http://localhost:<port>.
 * Los errores HTTP (4xx/5xx) se propagan como `API Error: ...`; solo los
 * fallos de conexión se envuelven en el mensaje "Is it running?".
 */
export async function apiRequest(
  endpoint: string,
  options: RequestInit = {},
  port?: unknown,
): Promise<any> {
  const base = buildApiBase(port ?? DEFAULT_API_PORT);
  let response: globalThis.Response;
  try {
    response = await fetch(`${base}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });
  } catch {
    throw new Error('Failed to connect to BunDeck daemon. Is it running?');
  }
  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

/** Health-check puntual: true si GET /health responde 2xx. */
export async function isDaemonRunning(port: number, opts?: { log?: LogFn }): Promise<boolean> {
  const log = opts?.log ?? noop;
  try {
    log(`Checking if daemon is running on port ${port}...`);
    const base = buildApiBase(port);
    const response = await fetch(`${base}${ENDPOINTS.health}`);
    log(`Health check response status: ${response.status}`);
    return response.ok;
  } catch (error) {
    log(`Health check failed: ${(error as Error).message}`);
    return false;
  }
}

/** Health-check con reintentos (sustituye los `sleep` fijos). */
export async function waitForHealthy(
  port: number,
  timeoutMs = 30000,
  intervalMs = 1000,
  opts?: { log?: LogFn },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isDaemonRunning(port, opts)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Espera a que el daemon DEJE de responder (útil tras shutdown). */
export async function waitForStopped(
  port: number,
  timeoutMs = 15000,
  intervalMs = 500,
  opts?: { log?: LogFn },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isDaemonRunning(port, opts))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export type PluginInstallPlan =
  | { kind: 'zip-url'; url: string; sourceType: 'marketplace' }
  | { kind: 'git-url'; url: string; sourceType: 'git' }
  | { kind: 'zip-file'; path: string }
  | { kind: 'dir'; path: string };

/**
 * Decide la estrategia de instalación SIN tocar la red (puro, testeable):
 * - URL http(s) a .zip -> POST /api/v1/plugins/install (sourceType marketplace)
 * - URL http(s) a otra cosa -> POST /api/v1/plugins/install (sourceType git)
 * - Fichero local .zip/.plectro -> POST /api/v1/plugins/upload (multipart)
 * - Carpeta local -> POST /api/v1/plugins/install (sourceType directory, path).
 */
export function selectPluginInstall(target: string): PluginInstallPlan {
  if (/^https?:\/\//i.test(target)) {
    return /\.zip(\?|#|$)/i.test(target)
      ? { kind: 'zip-url', url: target, sourceType: 'marketplace' }
      : { kind: 'git-url', url: target, sourceType: 'git' };
  }
  if (/\.(zip|plectro)(\?|#|$)/i.test(target)) {
    return { kind: 'zip-file', path: target };
  }
  return { kind: 'dir', path: target };
}

/** POST /api/v1/plugins/install — instala desde URL git o zip remota. */
export async function installPluginFromUrl(
  apiBase: string,
  url: string,
  opts?: { sourceType?: 'git' | 'marketplace' | 'url'; ref?: string; force?: boolean },
): Promise<any> {
  const response = await fetch(`${apiBase}${ENDPOINTS.pluginInstall}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceType: opts?.sourceType ?? 'git',
      url,
      ref: opts?.ref,
      force: !!opts?.force,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as any)?.error ?? `API Error: ${response.status} ${response.statusText}`);
  }
  return data;
}

/** POST /api/v1/plugins/install — instala desde carpeta local (sourceType directory). */
export async function installPluginFromDirectory(
  apiBase: string,
  dirPath: string,
  force = false,
): Promise<any> {
  const response = await fetch(`${apiBase}${ENDPOINTS.pluginInstall}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceType: 'directory', path: dirPath, force: !!force }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as any)?.error ?? `API Error: ${response.status} ${response.statusText}`);
  }
  return data;
}

/** POST /api/v1/plugins/upload — sube un .zip/.plectro local (multipart). */
export async function uploadPluginZip(
  apiBase: string,
  zipPath: string,
  force = false,
): Promise<any> {
  const { basename } = await import('path');
  const file = Bun.file(zipPath);
  if (!(await file.exists())) {
    throw new Error(`No se encontró el archivo: ${zipPath}`);
  }
  const form = new FormData();
  form.set('file', file as unknown as Blob, basename(zipPath));
  form.set('force', force ? 'true' : 'false');
  const response = await fetch(`${apiBase}${ENDPOINTS.pluginUpload}`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as any)?.error ?? `API Error: ${response.status} ${response.statusText}`);
  }
  return data;
}

/**
 * Sigue logs en tiempo real por WS (topic 'logs', evento 'log.created').
 * Resuelve con la función de cierre. Rechaza si el WS no abre en timeoutMs.
 */
export function followLogsLive(
  wsPort: number,
  onLog: (log: any) => void,
  timeoutMs = 5000,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws: any;
    try {
      ws = new WebSocket(`ws://localhost:${wsPort}`);
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws?.close(); } catch {}
        reject(new Error('WS timeout'));
      }
    }, timeoutMs);
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'subscribe', payload: { topics: ['logs'] } }));
      } catch {}
    };
    ws.onmessage = (ev: any) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (!settled && (msg.type === 'subscribed' || msg.type === 'connected')) {
          // Esperar al primer log o a confirmación: consideramos vivo al suscribir.
          // Resolvemos en 'subscribed' para cambiar a modo WS cuanto antes.
          if (msg.type === 'subscribed') {
            settled = true;
            clearTimeout(timer);
            resolve(() => { try { ws.close(); } catch {} });
          }
          return;
        }
        if (msg.type === 'log.created') {
          onLog(msg.payload);
        }
      } catch {}
    };
    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('WS error'));
      }
    };
    ws.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('WS closed'));
      }
    };
  });
}
