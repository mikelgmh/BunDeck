/**
 * launcher-server.ts — mini API solo-localhost para la ventanita GPUI
 * (panel de control). El host Electrobun es el dueño canónico del Updater;
 * el launcher gobierna a distancia: abrir ventana, buscar/aplicar updates.
 *
 * Rutas:
 * - POST /__launcher/open-window  -> abre la BrowserWindow del dashboard
 * - GET  /__launcher/update-check -> { updateAvailable, version? }
 * - POST /__launcher/update-apply -> { ok } (descarga y aplica, reinicia)
 */

export interface OpenWindowResult {
  opened: boolean;
  url?: string;
  reason?: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  updateReady?: boolean;
  version?: string;
}

export interface LauncherServerDeps {
  openWindow: () => OpenWindowResult | Promise<OpenWindowResult>;
  checkUpdate: () => UpdateCheckResult | Promise<UpdateCheckResult>;
  applyUpdate: () => { ok: boolean } | Promise<{ ok: boolean }>;
  /** Controles de la ventana frameless (opcionales: el launcher GPUI no los usa). */
  windowMinimize?: () => void | Promise<void>;
  windowToggleMaximize?: () => { maximized: boolean } | Promise<{ maximized: boolean }>;
  windowClose?: () => void | Promise<void>;
  windowIsMaximized?: () => boolean | Promise<boolean>;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export async function handleLauncherRequest(req: Request, deps: LauncherServerDeps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }
  try {
    if (url.pathname === '/__launcher/open-window' && req.method === 'POST') {
      const res = await deps.openWindow();
      return json({ ok: true, ...res });
    }
    if (url.pathname === '/__launcher/update-check' && req.method === 'GET') {
      const res = await deps.checkUpdate();
      return json({ ok: true, ...res });
    }
    if (url.pathname === '/__launcher/update-apply' && req.method === 'POST') {
      const res = await deps.applyUpdate();
      return json({ ok: true, ...res });
    }
    if (url.pathname === '/__launcher/window-minimize' && req.method === 'POST') {
      await deps.windowMinimize?.();
      return json({ ok: true });
    }
    if (url.pathname === '/__launcher/window-toggle-maximize' && req.method === 'POST') {
      const res = (await deps.windowToggleMaximize?.()) ?? { maximized: false };
      return json({ ok: true, ...res });
    }
    if (url.pathname === '/__launcher/window-close' && req.method === 'POST') {
      await deps.windowClose?.();
      return json({ ok: true });
    }
    if (url.pathname === '/__launcher/window-state' && req.method === 'GET') {
      const maximized = (await deps.windowIsMaximized?.()) ?? false;
      return json({ ok: true, maximized });
    }
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
  return json({ ok: false, error: 'not-found' }, 404);
}

/** Sirve la API en 127.0.0.1 (nunca LAN). Lanza si el puerto está ocupado. */
export function startLauncherServer(deps: LauncherServerDeps, port: number, hostname = '127.0.0.1') {
  return Bun.serve({
    port,
    hostname,
    fetch: (req: Request) => handleLauncherRequest(req, deps),
    error: () => new Response('Launcher API error', { status: 500 }),
  });
}
