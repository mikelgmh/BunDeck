/**
 * Política de acceso a la UI remota (aprobación en host).
 *
 * Diseño (settings, sin tablas nuevas):
 * - `remote.ui.enabled` ("0"/"1", default "0"): interruptor maestro.
 * - `remote.ui.code`: JSON `{code, urlCode, createdAt, expiresAt}` (un solo
 *   navegador: al aprobarse se consume).
 * - `remote.ui.consumed.<urlCode>`: tombstone con expiración (un solo uso).
 * - `remote.ui.session.<token>`: JSON `{createdAt, exp, ua, ip, revoked}`.
 *   Convención: `exp = 0` significa SIN caducidad (sesiones perennes: solo
 *   mueren por revocación explícita del dueño). Las aprobadas nacen con
 *   `exp = 0`; las antiguas con exp numérico futuro siguen valiendo hasta
 *   su exp (sin migración).
 *
 * Cola de pendientes (navegadores esperando aprobación): la cola VIVA la
 * lleva el TunnelClient (`remote/tunnel.ts`: `getPending()` /
 * `decideUiRequest()`, máx 20, TTL 120 s, broadcast
 * `ui-approval-requested`). La capa REST (`api/remote.ts`) delega en él vía
 * `listUiPendingCombined` / `approveUiPending` / `denyUiPending` de ESTE
 * módulo. Aquí queda además un store local en memoria (misma forma) como
 * respaldo para tests y daemon sin túnel (`enqueueUiRequest`,
 * `listUiPending`, `resolveUiPending`); las sesiones SÍ se persisten
 * siempre en settings para que sobrevivan a reinicios (`GET /ui-sessions`,
 * `validateUiSession`). Cada request UI posterior presenta su token; el
 * tunnel-client lo valida con `validateUiSession(db, token)`.
 *
 * Seguridad: se guarda ua+ip tal cual para que el dueño decida. El tráfico
 * de la UI lo ve el operador del relay (TLS+token, opt-in explícito,
 * default OFF). Los tokens completos solo se muestran UNA vez (al aprobar);
 * el listado solo expone el prefijo (8 chars).
 */
import { randomBytes } from 'node:crypto';
import { DatabaseService } from '../db';
import { API_PORT, FRONTEND_PORT, DEV_MODE } from '../config';
import { createLanInvite, getLanInviteMeta, LAN_INVITE_KEY } from './lan-invites';
import { publicIdentity } from './identity';

export const UI_ENABLED_KEY = 'remote.ui.enabled';
export const UI_CODE_KEY = 'remote.ui.code';
const UI_CONSUMED_PREFIX = 'remote.ui.consumed.';
/** Prefijo de las sesiones UI persistidas (lo reutiliza el TunnelClient para re-anunciarlas al reconectar). */
export const UI_SESSION_PREFIX = 'remote.ui.session.';
/**
 * Tombstones de revocación (`remote.ui.unbind-pending.<token>` = exp epochMs).
 * Cubren revocar con el relay caído: el `ui-unbind` best-effort se pierde,
 * pero `resyncUiState` lo re-emite en cada (re)conexión hasta que caduque
 * (idempotente: el relay ignora tokens desconocidos). Sin esto, borrar la
 * fila de sesión hacía que el relay conservara la sesión 24 h y la tablet
 * siguiera operando en modo Relay tras revocar.
 */
export const UI_UNBIND_PENDING_PREFIX = 'remote.ui.unbind-pending.';

export const UI_CODE_TTL_MS = 10 * 60 * 1000; // 10 min, como pairing
export const UI_PENDING_TTL_MS = 2 * 60 * 1000; // igual que la ventana de aprobación del relay
export const UI_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export interface UiCode {
  code: string; // 6 dígitos (móvil teclea o QR)
  urlCode: string; // 12 chars url-safe (navegador abre /ui/<urlCode>)
  createdAt: number;
  expiresAt: number;
}

export interface UiPendingRequest {
  reqId: string;
  urlCode: string;
  ua: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
}

export interface UiSession {
  createdAt: number;
  exp: number;
  ua: string;
  ip: string;
  revoked: boolean;
  /** Nombre propuesto por el dueño al aprobar (se usa como nombre del dispositivo). */
  deviceName?: string;
  /** Split-token: secreto plano (solo DB local del daemon) + su hash. */
  secret?: string;
  secretHash?: string;
}

export interface UiSessionView {
  tokenPrefix: string; // 8 chars, NUNCA el token completo
  createdAt: number;
  exp: number;
  ua: string;
  ip: string;
  revoked: boolean;
  /** Nombre de dispositivo propuesto al aprobar (null si no se fijó). */
  deviceName: string | null;
}

/** Interruptor maestro. Default OFF ("0") si no existe. */
export function isUiEnabled(db: DatabaseService): boolean {
  try {
    return db.getSetting(UI_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Fija el interruptor maestro (`remote.ui.enabled` = "1"/"0"). Devuelve el
 * estado resultante. Lo usa `POST/PUT /api/v1/remote/ui-enabled`.
 */
export function setUiEnabled(db: DatabaseService, enabled: boolean): boolean {
  const on = enabled === true;
  db.setSetting(UI_ENABLED_KEY, on ? '1' : '0');
  audit(db, on
    ? '[remote-ui] UI remota HABILITADA por el dueño (opt-in: el operador del relay ve el tráfico UI; TLS+token)'
    : '[remote-ui] UI remota deshabilitada por el dueño');
  return on;
}

/** TunnelClient vivo (lo registra server.ts en `__libredeckRemote.tunnel`). */
export function getTunnelClient(): any {
  try {
    return (globalThis as any).__libredeckRemote?.tunnel
      ?? (globalThis as any).__libredeckRemote?.tunnelClient
      ?? null;
  } catch {
    return null;
  }
}

import { resolveRelayUrl } from '../remote/public-relay';

/**
 * HTTPS pública del relay (URL efectiva: env, settings o relay público):
 * wss→https, ws→http. `""` si el relay está desactivado explícitamente.
 */
export function relayHttpsUrl(db: { getSetting: (key: string) => string | null }): string {
  let raw = '';
  try {
    raw = resolveRelayUrl(db).trim();
  } catch {
    return '';
  }
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol === 'wss:') u.protocol = 'https:';
    else if (u.protocol === 'ws:') u.protocol = 'http:';
    else if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function random6(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function randomUrlCode(): string {
  // 9 bytes → 12 chars base64url (A–Z a–z 0–9 - _).
  return randomBytes(9).toString('base64url');
}

function consumedKey(urlCode: string): string {
  return `${UI_CONSUMED_PREFIX}${urlCode}`;
}

function sessionKey(token: string): string {
  return `${UI_SESSION_PREFIX}${token}`;
}

function audit(db: DatabaseService, message: string, meta?: Record<string, unknown>): void {  try {
    db.addLog({ level: 'info', message, meta: { ...(meta ?? {}), remote: true }, ts: Date.now() });
  } catch {
    /* noop */
  }
  // Best-effort para el path del tunnel-client (sin acceso al wsManager):
  // el API layer además difunde vía services.wsManager con topic `remote`.
  try {
    (globalThis as any).__libredeckWs?.broadcast?.('remote.ui-audit', { message, ts: Date.now() }, 'remote');
  } catch {
    /* noop */
  }
}

function readCode(db: DatabaseService): UiCode | null {
  let raw: string | null = null;
  try {
    raw = db.getSetting(UI_CODE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UiCode;
  } catch {
    return null;
  }
}

function isConsumed(db: DatabaseService, urlCode: string): boolean {
  let raw: string | null = null;
  try {
    raw = db.getSetting(consumedKey(urlCode));
  } catch {
    return false;
  }
  if (!raw) return false;
  const until = Number(raw);
  if (Number.isFinite(until) && until > Date.now()) return true;
  try {
    db.deleteSetting(consumedKey(urlCode));
  } catch {
    /* noop */
  }
  return false;
}

function markConsumed(db: DatabaseService, urlCode: string): void {
  try {
    db.setSetting(consumedKey(urlCode), String(Date.now() + UI_CODE_TTL_MS));
  } catch {
    /* noop */
  }
}

// ---------- Fast-path LAN (credenciales pareadas ui+lan) ----------

/** Objeto `lan` del `ui-publish` extendido (contrato fijo con el relay). */
export interface UiFastPathLan {
  code: string; // invite LAN 128 bits (canjeable una vez en LAN)
  ips: string[]; // máx 4 IPv4 RFC1918 del host, rankeadas
  port: number; // UI LAN (lanUiPort: embebido en prod, Astro en dev)
  apiPort: number; // API (verificacion de identidad via /config)
  fp: string; // fingerprint público (ya público en QR/status)
  dev: string; // deviceId público (ya público en QR/status)
}

/** Puerto de la UI LAN al que redirige el fast-path (donde abre el kiosco). */
export const DEV_FRONTEND_PORT = 4321; // Astro dev fijo (ver web/astro.config.mjs)

/**
 * Puerto UI del `lan`: en prod el embebido (`FRONTEND_PORT`, sirve web-dist
 * + `/config`); en DEV el embebido está desactivado y la UI vive en Astro
 * (`DEV_FRONTEND_PORT`). Publicar 3002 en dev apuntaba a un puerto muerto.
 */
export function lanUiPort(devMode = DEV_MODE): number {
  return devMode ? DEV_FRONTEND_PORT : FRONTEND_PORT;
}

/** Margen para reutilizar el lan-invite vigente en vez de rotarlo. */
export const UI_FASTPATH_LAN_REUSE_MS = 60_000;

/** Rank de IP LAN (misma lógica que `QrDialog.getDaemonLanIp` en web). */
export function rankLanIp(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

function isRfc1918Ip(ip: string): boolean {
  if (typeof ip !== 'string' || !ip) return false;
  if (ip.startsWith('192.168.')) {
    return /^192\.168\.\d{1,3}\.\d{1,3}$/.test(ip);
  }
  if (ip.startsWith('10.')) {
    return /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
  }
  const m = /^(172)\.(1[6-9]|2\d|3[01])\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m !== null;
}

/**
 * Filtra (solo RFC1918, sin loopback/IPv6) + rankea + top 4.
 * Pura (testeable sin red): `getHostLanIps` le pasa las del host.
 */
export function filterAndRankLanIps(ips: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ip of ips ?? []) {
    if (typeof ip !== 'string' || !ip) continue;
    const clean = ip.trim();
    if (!clean || seen.has(clean)) continue;
    if (clean === '127.0.0.1' || clean.includes(':')) continue; // loopback/IPv6 fuera
    if (!isRfc1918Ip(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  out.sort((a, b) => rankLanIp(a) - rankLanIp(b));
  return out.slice(0, 4);
}

/** IPv4 LAN del host ya filtradas/rankeadas (máx 4). `[]` si no hay. */
export function getHostLanIps(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { networkInterfaces } = require('node:os') as typeof import('node:os');
    const nets = networkInterfaces();
    const raw: string[] = [];
    for (const addrs of Object.values(nets)) {
      for (const a of addrs ?? []) {
        try {
          if ((a as { family?: unknown }).family === 'IPv4' && !(a as { internal?: unknown }).internal) {
            raw.push((a as { address?: unknown }).address as string);
          }
        } catch { /* entrada rara: ignorar */ }
      }
    }
    return filterAndRankLanIps(raw);
  } catch {
    return [];
  }
}

/** Lee el lan-invite vigente SIN crearlo (null si ausente/caducado). */
export function readExistingLanInvite(db: DatabaseService): { code: string; expiresAt: number } | null {
  let meta: { present: boolean; expiresAt: number | null };
  try {
    meta = getLanInviteMeta(db);
  } catch {
    return null;
  }
  if (!meta.present || typeof meta.expiresAt !== 'number') return null;
  let raw: string | null = null;
  try {
    raw = db.getSetting(LAN_INVITE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { code?: unknown; expiresAt?: unknown };
    if (typeof v.code !== 'string' || !v.code) return null;
    const exp = typeof v.expiresAt === 'number' ? v.expiresAt : meta.expiresAt;
    if (!Number.isFinite(exp) || (exp as number) <= Date.now()) return null;
    return { code: v.code, expiresAt: exp as number };
  } catch {
    return null;
  }
}

/**
 * Snapshot del `lan` fast-path SIN crear invites (para `resyncUiState`:
 * re-anunciar tras reconectar no debe rotar el QR LAN).
 * `undefined` si no hay invite vigente o no hay IPs (sanitiza en origen).
 */
export function readUiFastPathLan(
  db: DatabaseService,
  opts?: { ips?: string[] },
): UiFastPathLan | undefined {
  const ips = filterAndRankLanIps(opts?.ips ?? getHostLanIps());
  if (ips.length === 0) return undefined;
  const existing = readExistingLanInvite(db);
  if (!existing) return undefined;
  let pub: { deviceId: string; fingerprint: string };
  try {
    pub = publicIdentity(db);
  } catch {
    return undefined;
  }
  if (!pub?.deviceId || !pub?.fingerprint) return undefined;
  return {
    code: existing.code,
    ips,
    port: lanUiPort(),
    apiPort: API_PORT,
    fp: pub.fingerprint,
    dev: pub.deviceId,
  };
}

/**
 * Construye el `lan` fast-path ASEGURANDO invite: reutiliza el vigente con
 * >60 s de vida; si no, crea uno fresco (`ui-fastpath`).
 * `undefined` si no hay IPs (sanitiza en origen: el campo se omite y el
 * relay viejo lo ignoraría igualmente) o sin identidad pública.
 */
export function buildUiFastPathLan(
  db: DatabaseService,
  opts?: { ips?: string[]; now?: number },
): UiFastPathLan | undefined {
  const ips = filterAndRankLanIps(opts?.ips ?? getHostLanIps());
  if (ips.length === 0) return undefined;
  let pub: { deviceId: string; fingerprint: string };
  try {
    pub = publicIdentity(db);
  } catch {
    return undefined;
  }
  if (!pub?.deviceId || !pub?.fingerprint) return undefined;
  const now = typeof opts?.now === 'number' ? opts.now : Date.now();
  try {
    const existing = readExistingLanInvite(db);
    if (existing && existing.expiresAt - now > UI_FASTPATH_LAN_REUSE_MS) {
      return {
        code: existing.code,
        ips,
        port: lanUiPort(),
        apiPort: API_PORT,
        fp: pub.fingerprint,
        dev: pub.deviceId,
      };
    }
  } catch { /* sin reutilizable: crear fresco */ }
  let fresh: { code: string };
  try {
    fresh = createLanInvite(db, 'ui-fastpath');
  } catch {
    return undefined;
  }
  if (!fresh?.code) return undefined;
  return {
    code: fresh.code,
    ips,
    port: lanUiPort(),
    apiPort: API_PORT,
    fp: pub.fingerprint,
    dev: pub.deviceId,
  };
}

/**
 * Crea (o regenera) el código de acceso móvil. Sobrescribe el anterior.
 * No valida `enabled`: lo hace el API layer (403 maestro).
 *
 * Fast-path LAN (credenciales pareadas ui+lan para el relay): además del
 * ui-code se asegura un lan-invite vigente (`remote.lan.invite`). Si queda
 * uno con >60 s de vida se REUTILIZA (no se rota el QR/enlace LAN en cada
 * regeneración del QR de internet); si no, se crea uno fresco con label
 * `ui-fastpath`. NOTA single-use: `POST /ui-code` (requestUiCode) rota el
 * QR de internet vigente igual que hoy regenera — el anterior deja de
 * valer; el lan-invite compartido solo se consume al canjearse en LAN.
 */
export function createUiCode(db: DatabaseService): UiCode & { lan?: UiFastPathLan } {
  // Solo debe existir un código QR pendiente de uso. Si el anterior ya se
  // consumió al aprobar, UI_CODE_KEY está vacío y su publicación se conserva
  // en el relay únicamente para que el móvil termine el handshake.
  if (readCode(db)) revokeUiCode(db);
  const now = Date.now();
  const code: UiCode = {
    code: random6(),
    urlCode: randomUrlCode(),
    createdAt: now,
    expiresAt: now + UI_CODE_TTL_MS,
  };
  db.setSetting(UI_CODE_KEY, JSON.stringify(code));
  audit(db, `[remote-ui] código UI creado (expira ${new Date(code.expiresAt).toISOString()})`);
  // Fast-path LAN pareado (best-effort: sin IPs no hay `lan` y el relay
  // viejo ignora el campo igualmente). Se publica junto al ui-code para que
  // el móvil pre-aprobado pruebe LAN directa sin esperar al relay.
  let lan: UiFastPathLan | undefined;
  try {
    lan = buildUiFastPathLan(db);
  } catch {
    lan = undefined;
  }
  // Best-effort: que el relay conozca el código (el túnel lo republica al reconectar).
  try { getTunnelClient()?.publishUiCode?.(code.urlCode, code.expiresAt, lan); } catch { /* noop */ }
  return lan ? { ...code, lan } : code;
}

/** Revoca el código vigente. Devuelve true si había código. */
export function revokeUiCode(db: DatabaseService): boolean {
  const cur = readCode(db);
  try {
    db.deleteSetting(UI_CODE_KEY);
  } catch {
    /* noop */
  }
  if (!cur) return false;
  markConsumed(db, cur.urlCode);
  try { getTunnelClient()?.unpublishUiCode?.(cur.urlCode); } catch { /* noop */ }
  audit(db, '[remote-ui] código UI revocado por el dueño');
  return true;
}

/** Consume el urlCode (un solo navegador). Idempotente. */
export function consumeUrlCode(db: DatabaseService, urlCode: string, unpublish = true): void {
  const cur = readCode(db);
  if (cur && cur.urlCode === urlCode) {
    try {
      db.deleteSetting(UI_CODE_KEY);
    } catch {
      /* noop */
    }
  }
  markConsumed(db, urlCode);
  // No retirar del relay al aprobar: el navegador todavía necesita consultar
  // /status para recibir el token y ser redirigido a la sesión. El relay lo
  // invalida al caducar o revocar la sesión.
  if (unpublish) {
    try { getTunnelClient()?.unpublishUiCode?.(urlCode); } catch { /* noop */ }
  } else {
    try { getTunnelClient()?.consumeUiCode?.(urlCode); } catch { /* noop */ }
  }
}

// ---------- Cola de pendientes (memoria con TTL) ----------

const pending = new Map<string, UiPendingRequest>();

function prunePendingMem(): void {
  const now = Date.now();
  for (const [id, p] of pending) {
    if (p.expiresAt < now) pending.delete(id);
  }
}

/** Solo para tests: vacía la cola en memoria. */
export function clearUiPendingForTests(): void {
  pending.clear();
}

/**
 * Encola la petición de un navegador (lo llama el tunnel-client).
 * Lanza si la UI está deshabilitada o el urlCode es desconocido, ya
 * consumido (un solo uso) o caducado: el tunnel debe responder deny.
 * NOTA: guarda ua+ip tal cual para que el dueño decida; el tráfico UI
 * lo ve el operador del relay (TLS+token, opt-in explícito, OFF por defecto).
 */
export function enqueueUiRequest(
  db: DatabaseService,
  input: { urlCode: string; ua?: string; ip?: string },
): UiPendingRequest {
  prunePendingMem();
  const urlCode = String(input.urlCode ?? '');
  if (!isUiEnabled(db)) throw new Error('UI remota deshabilitada (remote.ui.enabled=0)');
  if (isConsumed(db, urlCode)) {
    audit(db, '[remote-ui] navegador rechazado: código de un solo uso ya consumido');
    throw new Error('Código denegado o expirado (un solo uso)');
  }
  const cur = readCode(db);
  if (!cur || cur.urlCode !== urlCode) {
    throw new Error('Código denegado o expirado');
  }
  if (cur.expiresAt < Date.now()) {
    try {
      db.deleteSetting(UI_CODE_KEY);
    } catch {
      /* noop */
    }
    markConsumed(db, urlCode);
    audit(db, '[remote-ui] navegador rechazado: código caducado');
    throw new Error('Código denegado o expirado');
  }
  const now = Date.now();
  const entry: UiPendingRequest = {
    reqId: randomBytes(8).toString('hex'),
    urlCode,
    ua: String(input.ua ?? ''),
    ip: String(input.ip ?? ''),
    createdAt: now,
    expiresAt: Math.min(cur.expiresAt, now + UI_PENDING_TTL_MS),
  };
  pending.set(entry.reqId, entry);
  return entry;
}

/** Lista pendientes vigentes (prune oportunista). Para el panel y tests. */
export function listUiPending(): UiPendingRequest[] {
  prunePendingMem();
  return [...pending.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Toma y elimina un pendiente (allow/deny). null si desconocido/caducado. */
export function resolveUiPending(reqId: string): UiPendingRequest | null {
  const p = pending.get(reqId) ?? null;
  if (p) pending.delete(reqId);
  else prunePendingMem();
  if (!p) return null;
  if (p.expiresAt < Date.now()) return null;
  return p;
}

// ---------- Sesiones ----------

/** Crea una sesión PERENNE (`exp = 0`: sin caducidad, solo revocación
 *  explícita) y devuelve el token COMPLETO (mostrar una sola vez). */
export function createUiSession(
  db: DatabaseService,
  input: { ua?: string; ip?: string },
): { token: string; session: UiSession } {
  const token = randomBytes(32).toString('hex'); // 32 B → 64 hex
  const now = Date.now();
  const session: UiSession = {
    createdAt: now,
    exp: 0,
    ua: String(input.ua ?? ''),
    ip: String(input.ip ?? ''),
    revoked: false,
  };
  db.setSetting(sessionKey(token), JSON.stringify(session));
  return { token, session };
}

function readSession(db: DatabaseService, token: string): UiSession | null {
  let raw: string | null = null;
  try {
    raw = db.getSetting(sessionKey(token));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UiSession;
  } catch {
    return null;
  }
}

/**
 * Valida un token presentado por un navegador (lo usa el tunnel-client).
 * `exp = 0`/falsy = perenne: nunca caduca. Exp numérico futuro caducado →
 * inválida + auditoría `uso expirado`. Revocada/inexistente → inválida
 * silenciosa (sin log para no amplificar escaneos).
 */
export function validateUiSession(
  db: DatabaseService,
  token: string,
): { ok: boolean; reason?: string } {
  const s = readSession(db, String(token ?? ''));
  if (!s) return { ok: false, reason: 'desconocida' };
  if (s.revoked) return { ok: false, reason: 'revocada' };
  const exp = Number(s.exp);
  if (Number.isFinite(exp) && exp !== 0 && exp < Date.now()) {
    audit(db, '[remote-ui] sesión expirada usada (denegada)');
    return { ok: false, reason: 'expirada' };
  }
  return { ok: true };
}

/** Lista sesiones vigentes SIN el token completo (solo prefijo de 8 chars).
 * Las revocadas y caducadas no se listan (desaparecen del panel); al
 * revocar se borra la fila para que no vuelva a aparecer. `exp = 0` es
 * perenne: se lista siempre (no se poda). */
export function listUiSessions(db: DatabaseService): UiSessionView[] {
  const out: UiSessionView[] = [];
  let all: Record<string, string> = {};
  try {
    all = db.getAllSettings();
  } catch {
    return out;
  }
  const now = Date.now();
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(UI_SESSION_PREFIX)) continue;
    const token = k.slice(UI_SESSION_PREFIX.length);
    try {
      const s = JSON.parse(v) as UiSession;
      const exp = (s as { exp?: unknown })?.exp;
      const expired = typeof exp === 'number' && Number.isFinite(exp) && exp !== 0 && exp <= now;
      if (s.revoked || expired || typeof exp !== 'number' || !Number.isFinite(exp)) {
        // Higiene oportunista: las filas muertas no se listan ni se conservan.
        // (exp = 0 es perenne: no entra aquí.)
        try { db.deleteSetting(k); } catch { /* noop */ }
        continue;
      }
      out.push({
        tokenPrefix: token.slice(0, 8),
        createdAt: s.createdAt,
        exp: s.exp,
        ua: s.ua,
        ip: s.ip,
        revoked: false,
        deviceName: typeof s.deviceName === 'string' && s.deviceName ? s.deviceName : null,
      });
    } catch {
      /* corrupta: ignorar */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Revoca por prefijo (8 chars). Borra la fila para que desaparezca de la
 * lista (el token ya no valida igualmente). Devuelve el token completo
 * para unbind. */
export function revokeUiSessionByPrefix(
  db: DatabaseService,
  prefix: string,
): { token: string; session: UiSession } | null {
  let all: Record<string, string> = {};
  try {
    all = db.getAllSettings();
  } catch {
    return null;
  }
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(UI_SESSION_PREFIX)) continue;
    const token = k.slice(UI_SESSION_PREFIX.length);
    if (token.slice(0, 8) !== prefix) continue;
    try {
      const s = JSON.parse(v) as UiSession;
      try { db.deleteSetting(k); } catch { /* noop */ }
      audit(db, `[remote-ui] sesión revocada (prefijo ${prefix})`);
      return { token, session: s };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Localiza una sesión por prefijo (8 chars) SIN modificarla.
 * null si no existe o está corrupta.
 */
export function findUiSessionByPrefix(
  db: DatabaseService,
  prefix: string,
): { token: string; session: UiSession } | null {
  const want = String(prefix ?? '').slice(0, 8);
  if (!want) return null;
  let all: Record<string, string> = {};
  try {
    all = db.getAllSettings();
  } catch {
    return null;
  }
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(UI_SESSION_PREFIX)) continue;
    const token = k.slice(UI_SESSION_PREFIX.length);
    if (token.slice(0, 8) !== want) continue;
    try {
      return { token, session: JSON.parse(v) as UiSession };
    } catch {
      return null;
    }
  }
  return null;
}

/** Lee una sesión por token COMPLETO (solo quien lo posee la conoce). */
export function readUiSessionByToken(db: DatabaseService, token: string): UiSession | null {
  return readSession(db, String(token ?? ''));
}

/**
 * Guarda el nombre de dispositivo propuesto por el dueño al aprobar.
 * Lo persiste en la sesión (el móvil lo adopta al arrancar con su token)
 * y devuelve el token completo para renombrar de inmediato si el
 * dispositivo ya conectó. Solo valida longitud; el API layer decide
 * quién puede llamar (igual que allow/deny).
 */
export function setUiSessionDeviceName(
  db: DatabaseService,
  prefix: string,
  name: string,
): { ok: boolean; token?: string; error?: string } {
  const clean = String(name ?? '').trim();
  if (!clean) return { ok: false, error: 'Nombre vacío' };
  if (clean.length > 80) return { ok: false, error: 'Nombre demasiado largo (máx 80)' };
  const hit = findUiSessionByPrefix(db, prefix);
  if (!hit) return { ok: false, error: 'Sesión desconocida' };
  try {
    const next: UiSession = { ...hit.session, deviceName: clean };
    db.setSetting(`${UI_SESSION_PREFIX}${hit.token}`, JSON.stringify(next));
  } catch {
    return { ok: false, error: 'No se pudo guardar' };
  }
  audit(db, `[remote-ui] nombre de dispositivo propuesto (prefijo ${hit.token.slice(0, 8)}): ${clean}`);
  return { ok: true, token: hit.token };
}

/** Persiste en settings una sesión cuyo token generó el túnel (ui-bind). */
export function persistUiSession(db: DatabaseService, token: string, session: UiSession): void {
  db.setSetting(sessionKey(token), JSON.stringify(session));
}

export interface UiPendingView {
  reqId: string;
  urlCode: string;
  ua: string;
  ip: string;
  createdAt: number;
}

/**
 * Pendientes combinados para el panel: primero la cola VIVA del
 * TunnelClient (la que alimenta el relay; `receivedAt` → `createdAt`) y
 * después el store local de respaldo (tests / daemon sin túnel).
 * Sin duplicados por reqId.
 */
export function listUiPendingCombined(db: DatabaseService): UiPendingView[] {
  void db;
  const seen = new Set<string>();
  const out: UiPendingView[] = [];
  try {
    const arr = getTunnelClient()?.getPending?.();
    if (Array.isArray(arr)) {
      for (const p of arr) {
        const reqId = String(p?.reqId ?? '');
        if (!reqId || seen.has(reqId)) continue;
        seen.add(reqId);
        out.push({
          reqId,
          urlCode: String(p?.urlCode ?? ''),
          ua: String(p?.ua ?? ''),
          ip: String(p?.ip ?? ''),
          createdAt: Number(p?.receivedAt ?? p?.createdAt ?? Date.now()),
        });
      }
    }
  } catch { /* sin túnel: solo store local */ }
  for (const p of listUiPending()) {
    if (seen.has(p.reqId)) continue;
    seen.add(p.reqId);
    out.push({ reqId: p.reqId, urlCode: p.urlCode, ua: p.ua, ip: p.ip, createdAt: p.createdAt });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function findTunnelPending(reqId: string): any | null {
  try {
    const arr = getTunnelClient()?.getPending?.();
    if (Array.isArray(arr)) {
      const hit = arr.find((p: any) => String(p?.reqId ?? '') === reqId);
      return hit ?? null;
    }
  } catch { /* noop */ }
  return null;
}

/**
 * Aprueba un pendiente. Si el reqId vive en el TunnelClient, decide por él
 * (emite `ui-decision` + `ui-bind` al relay) y persiste la sesión en
 * settings para que `GET /ui-sessions` y `validateUiSession` la vean;
 * si no, usa el store local. En ambos casos el urlCode se consume para
 * impedir otra solicitud, pero la publicación del relay se conserva para
 * completar el poll de aprobación del navegador.
 */
export function approveUiPending(
  db: DatabaseService,
  reqId: string,
): { ok: boolean; sessionToken?: string; sid?: string; error?: string } {
  const hit = findTunnelPending(reqId);
  if (hit) {
    const exp = 0; // Sesiones perennes: sin caducidad (el QR y la ventana de aprobación sí caducan, la sesión aprobada no).
    let d: any = null;
    try {
      d = getTunnelClient()?.decideUiRequest?.(reqId, true, exp);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!d?.ok) return { ok: false, error: String(d?.error ?? 'Solicitud desconocida o caducada') };
    if (!d?.allowed || !d?.sessionToken) return { ok: false, error: 'Túnel no disponible: la aprobación no se pudo entregar al relay' };
    const token = String(d.sessionToken);
    const sid = typeof d.sid === 'string' ? d.sid : null;
    const secret = typeof d.secret === 'string' ? d.secret : null;
    if (sid && secret) {
      // Split-token: la clave es el sid público; el secreto va dentro del JSON
      // (DB local del daemon, nunca sale salvo al rebind autenticado).
      // Se conserva además la entrada legacy por compat con relays viejos.
      const { createHash } = require('node:crypto') as typeof import('node:crypto');
      persistUiSession(db, sid, {
        createdAt: Date.now(),
        exp,
        ua: String(hit?.ua ?? ''),
        ip: String(hit?.ip ?? ''),
        revoked: false,
        secret,
        secretHash: createHash('sha256').update(secret, 'utf8').digest('hex'),
      } as UiSession);
      persistUiSession(db, token, {
        createdAt: Date.now(),
        exp,
        ua: String(hit?.ua ?? ''),
        ip: String(hit?.ip ?? ''),
        revoked: false,
      });
      consumeUrlCode(db, String(hit?.urlCode ?? ''), false);
      audit(db, `[remote-ui] navegador aprobado (req ${reqId}, vía túnel, prefijo ${sid.slice(0, 8)})`);
      return { ok: true, sessionToken: token, sid };
    }
    persistUiSession(db, token, {
      createdAt: Date.now(),
      exp,
      ua: String(hit?.ua ?? ''),
      ip: String(hit?.ip ?? ''),
      revoked: false,
    });
    consumeUrlCode(db, String(hit?.urlCode ?? ''), false);
    audit(db, `[remote-ui] navegador aprobado (req ${reqId}, vía túnel, prefijo ${token.slice(0, 8)})`);
    return { ok: true, sessionToken: token };
  }
  const p = resolveUiPending(reqId);
  if (!p) return { ok: false, error: 'Solicitud desconocida o caducada' };
  // Un solo navegador por código: al aprobar se consume el urlCode.
  consumeUrlCode(db, p.urlCode);
  const { token } = createUiSession(db, { ua: p.ua, ip: p.ip });
  audit(db, `[remote-ui] navegador aprobado (req ${reqId}, prefijo ${token.slice(0, 8)})`);
  return { ok: true, sessionToken: token };
}

/** Deniega un pendiente (túnel si lo tiene; si no, store local). */
export function denyUiPending(db: DatabaseService, reqId: string): { ok: boolean; error?: string } {
  if (findTunnelPending(reqId)) {
    try {
      getTunnelClient()?.decideUiRequest?.(reqId, false);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    audit(db, `[remote-ui] navegador denegado (req ${reqId}, vía túnel)`);
    return { ok: true };
  }
  const p = resolveUiPending(reqId);
  if (!p) return { ok: false, error: 'Solicitud desconocida o caducada' };
  audit(db, `[remote-ui] navegador denegado (req ${reqId})`);
  return { ok: true };
}
/** Hooks best-effort hacia el tunnel-client (si existe). Nunca lanzan. */
export function notifyTunnelUiAllow(reqId: string, sessionToken: string): void {
  try {
    getTunnelClient()?.approveUiRequest?.(reqId, sessionToken);
  } catch {
    /* noop: la vía principal ya decidió vía decideUiRequest */
  }
}

export function notifyTunnelUiDeny(reqId: string): void {
  try {
    getTunnelClient()?.denyUiRequest?.(reqId);
  } catch {
    /* noop */
  }
}

export function notifyTunnelUiUnbind(sessionToken: string): void {
  try {
    const t = getTunnelClient();
    if (!t) return;
    // Nombre futuro (`unbindUiSession`) o actual del TunnelClient (`revokeUiSession`, emite ui-unbind).
    if (typeof t.unbindUiSession === 'function') t.unbindUiSession(sessionToken);
    else if (typeof t.revokeUiSession === 'function') t.revokeUiSession(sessionToken);
  } catch {
    /* noop */
  }
}

/**
 * Encola un `ui-unbind` durable (tombstone con expiración de la sesión).
 * Llamar SIEMPRE al revocar, además de `notifyTunnelUiUnbind`: si el túnel
 * está caído el envío best-effort se pierde y `resyncUiState` lo reintenta
 * en cada reconexión hasta que caduque. `exp = 0` (perenne) se guarda
 * como `"0"`: nunca caduca y se re-emite en cada reconexión (un ui-unbind
 * extra por reconexión, despreciable frente a garantizar la revocación).
 */
export function queueUiUnbind(db: DatabaseService, sessionToken: string, exp: number): void {
  const token = String(sessionToken ?? '');
  if (!/^[0-9a-fA-F]{32,}$/.test(token)) return;
  if (Number(exp) === 0) {
    try {
      db.setSetting(`${UI_UNBIND_PENDING_PREFIX}${token}`, '0');
    } catch { /* noop */ }
    return;
  }
  const ttl = Number.isFinite(exp) ? exp : Date.now() + UI_SESSION_TTL_MS;
  if (ttl <= Date.now()) return;
  try {
    db.setSetting(`${UI_UNBIND_PENDING_PREFIX}${token}`, String(ttl));
  } catch { /* noop */ }
}

/** Tombstones vigentes (poda oportunista de caducados; `0` = perenne, nunca caduca). Para `resyncUiState`. */
export function listUiUnbindPending(db: { getAllSettings?: () => Record<string, string>; deleteSetting?: (k: string) => void }): Array<{ token: string; exp: number }> {
  const out: Array<{ token: string; exp: number }> = [];
  let all: Record<string, string> = {};
  try {
    all = typeof db.getAllSettings === 'function' ? db.getAllSettings() : {};
  } catch {
    return out;
  }
  const now = Date.now();
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(UI_UNBIND_PENDING_PREFIX)) continue;
    const token = k.slice(UI_UNBIND_PENDING_PREFIX.length);
    const exp = Number(v);
    if (exp === 0) {
      if (!/^[0-9a-fA-F]{32,}$/.test(token)) {
        try { db.deleteSetting?.(k); } catch { /* noop */ }
        continue;
      }
      out.push({ token, exp: 0 });
      continue;
    }
    if (!/^[0-9a-fA-F]{32,}$/.test(token) || !Number.isFinite(exp) || exp <= now) {
      try { db.deleteSetting?.(k); } catch { /* noop */ }
      continue;
    }
    out.push({ token, exp });
  }
  return out;
}
