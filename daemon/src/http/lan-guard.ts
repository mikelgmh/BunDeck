/**
 * Guardia de acceso LAN solo-por-invitación.
 *
 * Punto único de decisión para HTTP (API + UI embebida + frontend :3002) y
 * WS. Reglas:
 * - Loopback (127.0.0.1/::1) o túnel del relay (petición sintética sin
 *   socket): acceso total, sin invitación (el anfitrión y el relay ya
 *   autentican por su cuenta).
 * - Solo-lectura pública sin secretos (salud/config/IPs + canje + preflight):
 *   abierta para que el invitado pueda arrancar y canjear.
 * - Resto (`/api/*` de control, UI, assets, WS): solo con sesión LAN válida
 *   (header `Authorization: Bearer`, `x-lan-invite`, cookie `ld_lan` o query
 *   `?invite=`) o canjeando al vuelo un código de invitación vigente vía
 *   `?invite=<code>` (un solo uso: crea sesión + fija cookie).
 * - Gestión de invitaciones/sesiones (`/lan-invite*`, `/lan-sessions*`):
 *   SOLO loopback (el anfitrión). Un invitado válido recibe 403, no 401.
 *
 * Lo que queda abierto sin invitación (documentado): GET /health, GET
 * /config (puertos, sin secretos), GET /api/v1/network/ips (IPs LAN, sin
 * secretos; el invitado ya conoce una) y POST /api/v1/remote/lan-redeem
 * (canje rate-limitado: sin código válido no concede nada).
 */
import type { DatabaseService } from '../db';
import {
  redeemLanInvite,
  validateLanSession,
} from '../remote/lan-invites';
import { RateLimiter } from './rate-limit';

export const LAN_TOKEN_QUERY_KEYS = ['invite', 'lanInvite', 'lan_invite', 'token'] as const;
export const LAN_TOKEN_HEADER = 'x-lan-invite';
export const LAN_COOKIE = 'ld_lan';
export const LAN_DENIED_CODE = 'LAN_INVITE_REQUIRED';
export const LAN_HOST_ONLY_CODE = 'LAN_HOST_ONLY';

/** Canjes por minuto y por IP (código de 128 bits: el límite es anti-escaneo). */
export const lanRedeemLimiter = new RateLimiter(10, 60_000);
/** Para tests: resetea el limiter de canje. */
export function resetLanRedeemLimiter(): void {
  lanRedeemLimiter.clear();
}

/** Solo tests / API layer: permite fijar el limiter. */
export function allowLanRedeem(ip: string): boolean {
  return lanRedeemLimiter.allow(`redeem:${ip || 'unknown'}`);
}

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  return LOOPBACK_IPS.has(String(ip).trim().toLowerCase());
}

/** IP remota del socket; null = petición sintética (túnel relay / tests). */
export function getPeerIp(_req: Request, server: any): string | null {
  try {
    const addr = server?.requestIP?.(_req)?.address;
    if (typeof addr === 'string' && addr) return addr;
  } catch { /* noop */ }
  return null;
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = req.headers.get('cookie') ?? '';
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  } catch { /* noop */ }
  return out;
}

/** Sesión portadora presentada (header > cookie > query). NUNCA se loguea. */
export function extractLanSessionToken(req: Request, url?: URL): string | null {
  try {
    const auth = req.headers.get('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  } catch { /* noop */ }
  try {
    const h = req.headers.get(LAN_TOKEN_HEADER)?.trim();
    if (h) return h;
  } catch { /* noop */ }
  try {
    const c = parseCookies(req)[LAN_COOKIE];
    if (c) return c;
  } catch { /* noop */ }
  try {
    const u = url ?? new URL(req.url);
    for (const k of LAN_TOKEN_QUERY_KEYS) {
      const v = u.searchParams.get(k)?.trim();
      if (v) return v;
    }
  } catch { /* noop */ }
  return null;
}

/** ¿Ruta pública sin invitación? (solo-lectura sin secretos + canje). */
export function isLanPublicPath(path: string, method: string): boolean {
  const m = method.toUpperCase();
  if (m === 'OPTIONS') return true;
  if (m === 'GET' && (path === '/health' || path === '/config')) return true;
  if (m === 'GET' && path === '/api/v1/network/ips') return true;
  if (m === 'POST' && path === '/api/v1/remote/lan-redeem') return true;
  return false;
}

/** ¿Gestión de invitaciones? Solo el anfitrión (loopback). */
export function isLanManagementPath(path: string, method: string): boolean {
  const m = method.toUpperCase();
  if (path === '/api/v1/remote/lan-invite') return m === 'POST' || m === 'GET' || m === 'DELETE';
  if (path === '/api/v1/remote/lan-sessions' && m === 'GET') return true;
  if (path.startsWith('/api/v1/remote/lan-sessions/') && m === 'DELETE') return true;
  return false;
}

export type LanVerdict =
  | { ok: true; via: 'tunnel' | 'loopback' | 'public' | 'invite'; setCookie?: { token: string; exp: number } }
  | { ok: false; status: 401 | 403 | 429; code: string; message: string };

const DENIED_MSG =
  'Sin permiso: entra con el QR del anfitrión. Pide al anfitrión que te lo enseñe desde Ajustes → Acceso remoto o con el botón de QR de la barra superior (Abrir en el móvil), o que te pase el enlace de invitación, y vuelve a intentarlo.';
const HOST_ONLY_MSG =
  'Solo el anfitrión (localhost) puede gestionar invitaciones.';

export function evaluateLanAccess(
  db: DatabaseService,
  req: Request,
  peerIp: string | null,
  opts?: { ua?: string; allowNullPeer?: boolean },
): LanVerdict {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Túnel del relay (petición sintética sin socket: allowNullPeer): el relay
  // ya validó la sesión UI; no aplicar la policy LAN aquí.
  // OJO: en un socket real la IP siempre se conoce. Si falta (requestIP
  // falló), se DENIEGA por defecto: permitir sería un agujero (antes todo
  // peerIp null entraba como 'tunnel').
  if (peerIp === null) {
    if (opts?.allowNullPeer) return { ok: true, via: 'tunnel' };
    return { ok: false, status: 401, code: LAN_DENIED_CODE, message: DENIED_MSG };
  }
  // Anfitrión local: exento siempre.
  if (isLoopbackIp(peerIp)) return { ok: true, via: 'loopback' };
  // Solo-lectura pública + canje explícito.
  if (isLanPublicPath(path, method)) return { ok: true, via: 'public' };

  // 1) ¿Sesión portadora válida? (header/cookie/query; NUNCA se loguea)
  const presented = extractLanSessionToken(req, url);
  if (presented && validateLanSession(db, presented).ok) {
    if (isLanManagementPath(path, method)) {
      return { ok: false, status: 403, code: LAN_HOST_ONLY_CODE, message: HOST_ONLY_MSG };
    }
    return { ok: true, via: 'invite' };
  }

  // 2) ¿Código de invitación de un solo uso? Se canjea al vuelo (sirve la
  // UI + fija cookie de sesión). Se prueban el valor presentado y el resto
  // de params (un token de sesión ajeno falla sin efectos: redeem solo
  // muta ante el código vigente exacto).
  if (!isLanManagementPath(path, method)) {
    const candidates: string[] = [];
    if (presented) candidates.push(presented);
    try {
      for (const k of LAN_TOKEN_QUERY_KEYS) {
        const v = url.searchParams.get(k)?.trim();
        if (v && !candidates.includes(v)) candidates.push(v);
      }
    } catch { /* noop */ }
    for (const code of candidates) {
      const r = redeemLanInvite(db, code, { ua: opts?.ua ?? req.headers.get('user-agent') ?? '', ip: peerIp });
      if (r.ok && r.token && r.exp) {
        return { ok: true, via: 'invite', setCookie: { token: r.token, exp: r.exp } };
      }
    }
  }

  if (isLanManagementPath(path, method)) {
    return { ok: false, status: 403, code: LAN_HOST_ONLY_CODE, message: HOST_ONLY_MSG };
  }
  // API → 401 (el cliente reintenta con credencial); UI/estáticos → 403.
  const status = path.startsWith('/api/') ? 401 : 403;
  return { ok: false, status, code: LAN_DENIED_CODE, message: DENIED_MSG };
}

/** `Set-Cookie` de sesión LAN (HttpOnly; el puerto no forma parte de la cookie). */
export function buildLanSessionCookie(token: string, exp: number): string {
  const maxAge = Math.max(60, Math.floor((exp - Date.now()) / 1000));
  return `${LAN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly`;
}

/** Adjunta la cookie de sesión a una respuesta (si el veredicto la trae). */
export function withLanCookie(res: Response, verdict: LanVerdict): Response {
  if (verdict.ok !== true || !verdict.setCookie) return res;
  const headers = new Headers(res.headers);
  headers.append('Set-Cookie', buildLanSessionCookie(verdict.setCookie.token, verdict.setCookie.exp));
  return new Response(res.body, { status: res.status, headers });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Respuesta de denegación: JSON para `/api/*`, página HTML "Sin permiso"
 * (bilingüe, sin secretos) para la UI y estáticos.
 */
export function lanDeniedResponse(req: Request, verdict: Extract<LanVerdict, { ok: false }>): Response {
  const url = new URL(req.url);
  const msg = verdict.message;
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: msg, code: verdict.code }, null, 2), {
      status: verdict.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const title = 'Sin permiso — No permission';
  const body = `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#111827;color:#f9fafb}` +
    `.card{max-width:26rem;padding:2rem;border:1px solid #374151;border-radius:1rem;background:#1f2937;text-align:center}` +
    `h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#d1d5db;line-height:1.5}code{color:#fbbf24}</style></head>` +
    `<body data-cy="lan-denied"><div class="card"><h1>🔒 Sin permiso</h1>` +
    `<p>${escapeHtml(msg)}</p>` +
    `<p lang="en">No permission: ask the host to show you the QR from Settings → Remote access or via the QR button in the top bar, or to send you the invite link, and try again.</p>` +
    `</div></body></html>`;
  return new Response(body, {
    status: 403,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** ¿Presenta la petición una sesión LAN válida? Sin efectos (no canjea códigos). */
export function hasValidLanSession(db: DatabaseService, req: Request): boolean {
  try {
    const token = extractLanSessionToken(req);
    return !!token && validateLanSession(db, token).ok;
  } catch {
    return false;
  }
}

// ---- Contexto por petición (el API layer no recibe el socket) ----

export interface LanContext {
  via: 'tunnel' | 'loopback' | 'public' | 'invite' | 'denied';
  peerIp: string | null;
}

const lanContext = new WeakMap<object, LanContext>();

/** Lo llama el handler HTTP antes de rutear (misma identidad de `req`). */
export function markLanContext(req: Request, ctx: LanContext): void {
  try { lanContext.set(req, ctx); } catch { /* noop */ }
}

export function getLanContext(req: Request): LanContext | null {
  try { return lanContext.get(req) ?? null; } catch { return null; }
}
