import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nacl from 'tweetnacl';

/**
 * Auth por dispositivo (tokens auto-aprovisionados).
 *
 * - El daemon pide un token con POST /api/device-claim (auth con
 *   RELAY_PROVISION_TOKEN) enviando {deviceId, pubKey} donde pubKey es la
 *   CLAVE PÚBLICA ed25519 de firma (dedicada, vía tweetnacl sign — NO la
 *   identidad X25519 de box; esa no puede firmar) en base64 de 32 B crudos.
 * - El token es 32 bytes aleatorios en hex (64 chars). En disco solo se
 *   guarda sha256(token) -> {deviceId, pubKeyB64, createdAt, lastSeen,
 *   revoked, replacedAt?}. El token plano NUNCA se persiste ni se loguea.
 * - Varios tokens por deviceId permitidos (cada claim emite uno nuevo).
 * - Rotación: el viejo sigue válido `rotateGraceMs` y luego muere.
 * - `tunnel-register` firmado: el socket ligado a un device token debe
 *   enviar {deviceId, ts, sig} con sig = hex minúsculas de
 *   nacl.sign.detached(UTF-8 `${deviceId}|${ts}`, secretKey), verificado
 *   con nacl.sign.detached.verify y |now-ts| <= 5 min.
 */

export interface DeviceTokenEntry {
  deviceId: string;
  pubKeyB64: string;
  createdAt: number;
  lastSeen: number;
  revoked: boolean;
  replacedAt?: number;
  /**
   * Solo `rotate()` concede gracia: el token viejo sigue válido
   * `rotateGraceMs`. Una revocación (`revokeToken`/`revokeDevice`) mata de
   * inmediato aunque la entrada conserve `replacedAt` como apunte.
   */
  grace?: boolean;
}

export const DEVICE_TOKEN_BYTES = 32;
export const DEVICE_TOKEN_RE = /^[0-9a-fA-F]{64}$/;
export const DEVICE_REGISTER_SKEW_MS = 5 * 60_000;
const SIG_HEX_RE = /^[0-9a-fA-F]{128}$/;

/** sha256 hex de un token (clave del mapa; el token plano jamás se guarda). */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Comparación timing-safe de hashes hex. */
export function sameTokenHash(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function isValidDeviceTokenFormat(t: unknown): t is string {
  return typeof t === 'string' && DEVICE_TOKEN_RE.test(t);
}

/**
 * Verifica la firma de `tunnel-register` con ed25519 (tweetnacl sign).
 * - `sigHex`: hex (minúsculas o mayúsculas) de la firma cruda de 64 B sobre
 *   UTF-8 `${deviceId}|${ts}`.
 * - `pubKeyB64`: base64 de la verify-key cruda de 32 B (la guardada en claim).
 * - `ts` debe estar a ±5 min de `now`.
 */
export function verifyDeviceRegisterSignature(args: {
  deviceId: string;
  ts: unknown;
  sigHex: unknown;
  pubKeyB64: string;
  now?: number;
}): boolean {
  const { deviceId, ts, sigHex, pubKeyB64 } = args;
  const now = args.now ?? Date.now();
  if (typeof deviceId !== 'string' || deviceId === '') return false;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > DEVICE_REGISTER_SKEW_MS) return false;
  if (typeof sigHex !== 'string' || !SIG_HEX_RE.test(sigHex)) return false;
  let pub: Uint8Array;
  try {
    pub = new Uint8Array(Buffer.from(pubKeyB64, 'base64'));
  } catch {
    return false;
  }
  if (pub.length !== 32) return false;
  let sig: Uint8Array;
  try {
    sig = new Uint8Array(Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  const msg = new Uint8Array(Buffer.from(`${deviceId}|${ts}`, 'utf8'));
  try {
    return nacl.sign.detached.verify(msg, sig, pub);
  } catch {
    return false;
  }
}

export interface DeviceAuthStoreOptions {
  now?: () => number;
  rotateGraceMs?: number;
}

export class DeviceAuthStore {
  private entries = new Map<string, DeviceTokenEntry>();
  private readonly now: () => number;
  readonly rotateGraceMs: number;
  private readonly file: string | null;

  constructor(dataDir: string | null | undefined, opts: DeviceAuthStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.rotateGraceMs = opts.rotateGraceMs ?? 5 * 60_000;
    this.file = typeof dataDir === 'string' && dataDir !== '' ? join(dataDir, 'device-tokens.json') : null;
    if (this.file) this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
    } catch {
      /* best-effort */
    }
    try {
      const raw = readFileSync(this.file, 'utf8');
      const doc = JSON.parse(raw) as { tokens?: Record<string, DeviceTokenEntry> };
      if (doc && typeof doc.tokens === 'object') {
        for (const [h, e] of Object.entries(doc.tokens)) {
          if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) continue;
          if (!e || typeof e.deviceId !== 'string' || typeof e.pubKeyB64 !== 'string') continue;
          this.entries.set(h, {
            deviceId: e.deviceId,
            pubKeyB64: e.pubKeyB64,
            createdAt: typeof e.createdAt === 'number' ? e.createdAt : this.now(),
            lastSeen: typeof e.lastSeen === 'number' ? e.lastSeen : this.now(),
            revoked: e.revoked === true,
            ...(typeof e.replacedAt === 'number' ? { replacedAt: e.replacedAt } : {}),
            ...(e.grace === true ? { grace: true as const } : {}),
          });
        }
      }
    } catch {
      /* sin fichero o corrupto: arranca vacío (no tumba el relay) */
    }
  }

  /** ¿La entrada revocada sigue en gracia de rotación? */
  private inGrace(e: DeviceTokenEntry, now: number): boolean {
    return (
      e.revoked === true &&
      e.grace === true &&
      typeof e.replacedAt === 'number' &&
      now - e.replacedAt <= this.rotateGraceMs
    );
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      const doc = { version: 1, tokens: Object.fromEntries(this.entries) };
      const tmp = `${this.file}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(doc), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      /* persistencia best-effort: la memoria sigue mandando */
    }
  }

  /** Emite un token nuevo para {deviceId, pubKeyB64}. Devuelve el token plano (una sola vez). */
  issue(deviceId: string, pubKeyB64: string): string {
    const token = randomBytes(DEVICE_TOKEN_BYTES).toString('hex');
    const now = this.now();
    this.entries.set(hashDeviceToken(token.toLowerCase()), {
      deviceId,
      pubKeyB64,
      createdAt: now,
      lastSeen: now,
      revoked: false,
    });
    this.save();
    return token;
  }

  /**
   * Valida un token (incluye gracia de rotación) y refresca lastSeen.
   * Devuelve {deviceId, pubKeyB64, hash} o null. Nunca expone el token.
   */
  verify(token: string): { deviceId: string; pubKeyB64: string; hash: string } | null {
    if (!isValidDeviceTokenFormat(token)) return null;
    const hash = hashDeviceToken(token.toLowerCase());
    const e = this.entries.get(hash);
    if (!e) return null;
    const now = this.now();
    if (e.revoked) {
      if (this.inGrace(e, now)) {
        e.lastSeen = now;
        this.save();
        return { deviceId: e.deviceId, pubKeyB64: e.pubKeyB64, hash };
      }
      return null;
    }
    e.lastSeen = now;
    this.save();
    return { deviceId: e.deviceId, pubKeyB64: e.pubKeyB64, hash };
  }

  /** Entrada por hash (para firmar tunnel-register sin refrescar lastSeen). Null si muerta. */
  getByHash(hash: string): DeviceTokenEntry | null {
    const e = this.entries.get(hash);
    if (!e) return null;
    if (e.revoked && !this.inGrace(e, this.now())) return null;
    return e;
  }

  /**
   * Revoca un token de inmediato (sin gracia: la gracia es solo de `rotate`).
   * Si la entrada estaba en gracia de rotación, la gracia se cancela.
   */
  revokeToken(token: string): boolean {
    if (!isValidDeviceTokenFormat(token)) return false;
    const e = this.entries.get(hashDeviceToken(token.toLowerCase()));
    if (!e) return false;
    e.revoked = true;
    e.grace = false;
    e.replacedAt = this.now();
    this.save();
    return true;
  }

  /** Revoca TODOS los tokens de un deviceId, de inmediato y sin gracia. Devuelve nº afectado. */
  revokeDevice(deviceId: string): number {
    let n = 0;
    const now = this.now();
    for (const e of this.entries.values()) {
      if (e.deviceId === deviceId && (!e.revoked || this.inGrace(e, now))) {
        e.revoked = true;
        e.grace = false;
        e.replacedAt = now;
        n++;
      }
    }
    if (n > 0) this.save();
    return n;
  }

  /**
   * Rota un token válido: revoca el viejo (con gracia `rotateGraceMs`) y emite
   * uno nuevo para el mismo {deviceId, pubKey}. Rotar un token ya en gracia
   * no extiende su gracia (conserva el `replacedAt` original).
   */
  rotate(oldToken: string): string | null {
    if (!isValidDeviceTokenFormat(oldToken)) return null;
    const hash = hashDeviceToken(oldToken.toLowerCase());
    const e = this.entries.get(hash);
    if (!e) return null;
    const now = this.now();
    if (e.revoked) {
      if (!this.inGrace(e, now)) return null;
    } else {
      e.revoked = true;
      e.replacedAt = now;
    }
    e.grace = true;
    const token = randomBytes(DEVICE_TOKEN_BYTES).toString('hex');
    this.entries.set(hashDeviceToken(token.toLowerCase()), {
      deviceId: e.deviceId,
      pubKeyB64: e.pubKeyB64,
      createdAt: now,
      lastSeen: now,
      revoked: false,
    });
    this.save();
    return token;
  }

  /** Limpieza: borra revocados fuera de gracia (acota el fichero). */
  prune(now = this.now()): number {
    let n = 0;
    for (const [h, e] of [...this.entries]) {
      if (e.revoked && !this.inGrace(e, now)) {
        this.entries.delete(h);
        n++;
      }
    }
    if (n > 0) this.save();
    return n;
  }

  size(): number {
    return this.entries.size;
  }
}
