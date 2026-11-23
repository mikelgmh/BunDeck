/**
 * middleware.ts — Veto LAN en el servidor de desarrollo (`:4321`).
 *
 * El veto real vive en el daemon (lan-guard: cada llamada API/WS valida la
 * sesión), pero el dev-server de Astro serviría la cáscara estática sin
 * pedir nada. Este middleware la veta igual que el frontend embebido de
 * producción (`:3002`):
 * - Loopback (desarrollo en el propio equipo) → siempre pasa.
 * - Petición con cookie de sesión (`ld_lan`) o con código de invitación
 *   (`?invite=` del QR/enlace) → pasa (la VALIDEZ la sigue comprobando el
 *   daemon en cada llamada; aquí solo se exige presencia).
 * - Resto desde LAN → 403 con la misma pantalla "Sin permiso" del daemon.
 *
 * Sin esto, una tablet en la red cargaba la UI de desarrollo sin invitación.
 * En producción este fichero no se usa (la UI la sirve el daemon).
 */
import type { MiddlewareHandler } from 'astro';

const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
const INVITE_KEYS = ['invite', 'lanInvite', 'lan_invite', 'token'];

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().split(':')[0].replace(/^\[|\]$/g, '');
  return LOOPBACKS.has(h);
}

function hasLanCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return /(?:^|;\s*)ld_lan=/.test(cookieHeader);
}

function lockPage(): string {
  const title = 'Sin permiso — No permission';
  const msg =
    'Sin permiso: entra con el QR del anfitrión. Pide al anfitrión que te lo enseñe desde Ajustes → Acceso remoto o con el botón de QR de la barra superior (Abrir en el móvil), o que te pase el enlace de invitación, y vuelve a intentarlo.';
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title>` +
    `<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#111827;color:#f9fafb}` +
    `.card{max-width:26rem;padding:2rem;border:1px solid #374151;border-radius:1rem;background:#1f2937;text-align:center}` +
    `h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#d1bebe;line-height:1.5}</style></head>` +
    `<body data-cy="lan-denied"><div class="card"><h1>🔒 Sin permiso</h1>` +
    `<p>${msg}</p>` +
    `<p lang="en">No permission: ask the host to show you the QR from Settings → Remote access or via the QR button in the top bar, or to send you the invite link, and try again.</p>` +
    `</div></body></html>`
  );
}

export const onRequest: MiddlewareHandler = async (context, next) => {
  try {
    const clientIp = String((context as any).clientAddress ?? '').trim().toLowerCase();
    const host = context.request.headers.get('host');
    if (isLoopbackHost(host) || LOOPBACKS.has(clientIp)) return next();
    const url = new URL(context.request.url);
    if (hasLanCookie(context.request.headers.get('cookie'))) return next();
    for (const k of INVITE_KEYS) {
      if ((url.searchParams.get(k) ?? '').trim() !== '') return next();
    }
    return new Response(lockPage(), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch {
    return next();
  }
};
