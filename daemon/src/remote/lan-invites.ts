/**
 * Invitaciones LAN por QR/enlace (acceso solo-por-invitación en red local).
 *
 * Modelo (reutiliza los patrones de `remote/ui-policy.ts`, sin segundo
 * sistema para el relay: son claves distintas con el mismo diseño):
 * - `remote.lan.invite` = JSON `{code, createdAt, expiresAt, label}`. Solo
 *   existe UNA invitación vigente (como `ui.code`): generarla sustituye a la
 *   anterior. El QR y el enlace copiable llevan la MISMA URL con el MISMO
 *   `?invite=<code>`; no hay dos sistemas.
 * - El código es de UN SOLO USO y caducidad corta (15 min): al canjearse
 *   (`redeemLanInvite`) se consume (tombstone `remote.lan.consumed.<code>`)
 *   y se crea una sesión.
 * - `remote.lan.session.<token>` = JSON `{createdAt, exp, ua, ip, label,
 *   revoked}`. Sesión portadora (bearer) de 24 h, revocable, listable por
 *   prefijo (el token completo NUNCA sale del servidor salvo al canjear).
 *
 * Seguridad:
 * - Código: 16 bytes aleatorios (128 bits) en base64url; sesión: 32 bytes
 *   (256 bits) en hex. `node:crypto` (disponible en Bun).
 * - Comparación con `timingSafeEqual` (como `relay/src/relay.ts`).
 * - Auditoría con prefijos (8 chars), NUNCA el secreto completo.
 * - Sin tablas nuevas: `settings` (las migrations ya existen).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../db';

export const LAN_INVITE_KEY = 'remote.lan.invite';
const LAN_CONSUMED_PREFIX = 'remote.lan.consumed.';
const LAN_SESSION_PREFIX = 'remote.lan.session.';

export const LAN_INVITE_TTL_MS = 15 * 60 * 1000; // 15 min, como pairing/urlCode
export const LAN_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 h, como ui sessions

export interface LanInvite {
  code: string;
  createdAt: number;
  expiresAt: number;
  label: string;
}

export interface LanInviteMeta {
  present: boolean;
  createdAt: number | null;
  expiresAt: number | null;
  redeemed: boolean;
  label: string;
}

export interface LanSession {
  createdAt: number;
  exp: number;
  ua: string;
  ip: string;
  label: string;
  revoked: boolean;
}

export interface LanSessionView {
  tokenPrefix: string; // 8 chars, NUNCA el token completo
  createdAt: number;
  exp: number;
  ua: string;
  ip: string;
  label: string;
  revoked: boolean;
}

function consumedKey(code: string): string {
  return `${LAN_CONSUMED_PREFIX}${code}`;
}

function sessionKey(token: string): string {
  return `${LAN_SESSION_PREFIX}${token}`;
}

function audit(db: DatabaseService, message: string, meta?: Record<string, unknown>): void {
  try {
    db.addLog({ level: 'info', message, meta: { ...(meta ?? {}), lan: true }, ts: Date.now() });
  } catch { /* noop */ }
  try {
    (globalThis as any).__libredeckWs?.broadcast?.('remote.lan-audit', { message, ts: Date.now() }, 'remote');
  } catch { /* noop */ }
}

/** Comparación constante-tiempo (evita oráculos de timing). */
export function safeEqual(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function readInvite(db: DatabaseService): LanInvite | null {
  let raw: string | null = null;
  try { raw = db.getSetting(LAN_INVITE_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as LanInvite;
    if (typeof v.code !== 'string' || !v.code) return null;
    return v;
  } catch { return null; }
}

function isConsumed(db: DatabaseService, code: string): boolean {
  let raw: string | null = null;
  try { raw = db.getSetting(consumedKey(code)); } catch { return false; }
  if (!raw) return false;
  const until = Number(raw);
  if (Number.isFinite(until) && until > Date.now()) return true;
  try { db.deleteSetting(consumedKey(code)); } catch { /* noop */ }
  return false;
}

function markConsumed(db: DatabaseService, code: string): void {
  try { db.setSetting(consumedKey(code), String(Date.now() + LAN_INVITE_TTL_MS)); } catch { /* noop */ }
}

/**
 * Crea (o regenera) la invitación LAN vigente. Sustituye a la anterior
 * (un solo QR/enlace válido a la vez). Solo la llama el anfitrión local.
 */
export function createLanInvite(db: DatabaseService, label = ''): LanInvite {
  const cur = readInvite(db);
  if (cur) {
    try { db.deleteSetting(LAN_INVITE_KEY); } catch { /* noop */ }
    markConsumed(db, cur.code);
  }
  const now = Date.now();
  const invite: LanInvite = {
    code: randomBytes(16).toString('base64url'), // 128 bits
    createdAt: now,
    expiresAt: now + LAN_INVITE_TTL_MS,
    label: String(label ?? ''),
  };
  db.setSetting(LAN_INVITE_KEY, JSON.stringify(invite));
  audit(db, '[lan] invitación creada (expira ' + new Date(invite.expiresAt).toISOString() + ')');
  return invite;
}

/** Metadatos de la invitación vigente (SIN el código: el secreto solo sale al crear). */
export function getLanInviteMeta(db: DatabaseService): LanInviteMeta {
  const cur = readInvite(db);
  if (!cur) return { present: false, createdAt: null, expiresAt: null, redeemed: false, label: '' };
  if (cur.expiresAt < Date.now()) {
    try { db.deleteSetting(LAN_INVITE_KEY); } catch { /* noop */ }
    markConsumed(db, cur.code);
    return { present: false, createdAt: null, expiresAt: null, redeemed: false, label: '' };
  }
  return { present: true, createdAt: cur.createdAt, expiresAt: cur.expiresAt, redeemed: false, label: cur.label };
}

/** Revoca la invitación vigente. Devuelve true si había alguna. */
export function revokeLanInvite(db: DatabaseService): boolean {
  const cur = readInvite(db);
  try { db.deleteSetting(LAN_INVITE_KEY); } catch { /* noop */ }
  if (!cur) return false;
  markConsumed(db, cur.code);
  audit(db, '[lan] invitación revocada por el anfitrión');
  return true;
}

/**
 * Canjea un código de invitación por una sesión portadora. Un solo uso:
 * éxito o caducidad consumen el código. Devuelve el token COMPLETO (mostrar
 * UNA vez / fijar como cookie UNA vez); el listado solo expone prefijos.
 */
export function redeemLanInvite(
  db: DatabaseService,
  code: string,
  input?: { ua?: string; ip?: string; label?: string },
): { ok: boolean; token?: string; exp?: number; error?: string } {
  const c = String(code ?? '');
  if (!c) return { ok: false, error: 'Código requerido' };
  if (isConsumed(db, c)) {
    audit(db, '[lan] canje rechazado: código ya utilizado');
    return { ok: false, error: 'Código ya utilizado o caducado: pide un QR nuevo al anfitrión' };
  }
  const cur = readInvite(db);
  if (!cur || !safeEqual(cur.code, c)) {
    return { ok: false, error: 'Código denegado o expirado: pide el QR al anfitrión' };
  }
  if (cur.expiresAt < Date.now()) {
    try { db.deleteSetting(LAN_INVITE_KEY); } catch { /* noop */ }
    markConsumed(db, c);
    audit(db, '[lan] canje rechazado: código caducado');
    return { ok: false, error: 'Código caducado: pide un QR nuevo al anfitrión' };
  }
  // Un solo uso: consumir ANTES de crear la sesión.
  try { db.deleteSetting(LAN_INVITE_KEY); } catch { /* noop */ }
  markConsumed(db, c);
  const token = randomBytes(32).toString('hex'); // 256 bits
  const now = Date.now();
  const session: LanSession = {
    createdAt: now,
    exp: now + LAN_SESSION_TTL_MS,
    ua: String(input?.ua ?? ''),
    ip: String(input?.ip ?? ''),
    label: String(input?.label ?? cur.label ?? ''),
    revoked: false,
  };
  db.setSetting(sessionKey(token), JSON.stringify(session));
  audit(db, `[lan] invitado aceptado (sesión ${token.slice(0, 8)}…)`);
  return { ok: true, token, exp: session.exp };
}

function readSession(db: DatabaseService, token: string): { key: string; session: LanSession } | null {
  const t = String(token ?? '');
  if (!t) return null;
  // Comparación constante-tiempo contra cada candidata (pocas sesiones).
  let all: Record<string, string> = {};
  try { all = db.getAllSettings(); } catch { return null; }
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(LAN_SESSION_PREFIX)) continue;
    const candidate = k.slice(LAN_SESSION_PREFIX.length);
    if (!safeEqual(candidate, t)) continue;
    try {
      return { key: k, session: JSON.parse(v) as LanSession };
    } catch { return null; }
  }
  return null;
}

/** Valida una sesión portadora. Caducada → inválida + auditoría; resto → silenciosa. */
export function validateLanSession(db: DatabaseService, token: string): { ok: boolean; reason?: string } {
  const hit = readSession(db, String(token ?? ''));
  if (!hit) return { ok: false, reason: 'desconocida' };
  if (hit.session.revoked) return { ok: false, reason: 'revocada' };
  if (hit.session.exp < Date.now()) {
    audit(db, '[lan] sesión expirada usada (denegada)');
    return { ok: false, reason: 'expirada' };
  }
  return { ok: true };
}

/** Lista sesiones SIN el token completo (solo prefijo de 8 chars). */
export function listLanSessions(db: DatabaseService): LanSessionView[] {
  const out: LanSessionView[] = [];
  let all: Record<string, string> = {};
  try { all = db.getAllSettings(); } catch { return out; }
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(LAN_SESSION_PREFIX)) continue;
    const token = k.slice(LAN_SESSION_PREFIX.length);
    try {
      const s = JSON.parse(v) as LanSession;
      out.push({
        tokenPrefix: token.slice(0, 8),
        createdAt: s.createdAt,
        exp: s.exp,
        ua: s.ua,
        ip: s.ip,
        label: s.label,
        revoked: s.revoked,
      });
    } catch { /* corrupta: ignorar */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Revoca por prefijo (8 chars). */
export function revokeLanSessionByPrefix(db: DatabaseService, prefix: string): boolean {
  let all: Record<string, string> = {};
  try { all = db.getAllSettings(); } catch { return false; }
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(LAN_SESSION_PREFIX)) continue;
    const token = k.slice(LAN_SESSION_PREFIX.length);
    if (token.slice(0, 8) !== prefix) continue;
    try {
      const s = JSON.parse(v) as LanSession;
      db.setSetting(k, JSON.stringify({ ...s, revoked: true } satisfies LanSession));
      audit(db, `[lan] sesión revocada (prefijo ${prefix})`);
      return true;
    } catch { return false; }
  }
  return false;
}

/** Solo tests: purga invitaciones/sesiones LAN. */
export function clearLanForTests(db: DatabaseService): void {
  try {
    for (const k of Object.keys(db.getAllSettings())) {
      if (k === LAN_INVITE_KEY || k.startsWith(LAN_CONSUMED_PREFIX) || k.startsWith(LAN_SESSION_PREFIX)) {
        db.deleteSetting(k);
      }
    }
  } catch { /* noop */ }
}
