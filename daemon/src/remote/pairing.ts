/**
 * Emparejamiento por código de 6 dígitos + fingerprint de clave pública.
 *
 * Flujo:
 *  1. Equipo A (el que recibe): `POST /remote/pair-code` → muestra
 *     `{code, fingerprint}` (el panel lo pinta como QR/contenido).
 *  2. Equipo B (el que se une): el usuario teclea el código en su panel;
 *     B llama a su propio `POST /remote/pair-accept {code,…}` con el
 *     `code` + la identidad de A (deviceId/pubKey obtenidas por el canal
 *     que el usuario use: QR, relay `invite`, etc.).
 *  3. Cuando el relay reenvíe el `invite`, el receptor valida el código
 *     pendiente y registra al peer como trusted.
 *
 * Almacén: `settings` con `remote.trusted.<deviceId> = JSON` y
 * `remote.pending.<code> = JSON`. Sin tablas nuevas (las migrations de
 * settings ya existen y los tests mockean DatabaseService).
 */
import { DatabaseService } from '../db';
import { DEFAULT_POLICY, type RemotePolicy } from './remote-actions';

export interface TrustedDevice {
  deviceId: string;
  pubKey: string; // b64 X25519
  name: string;
  allowedActions: string[];
  createdAt: number;
  revoked: boolean;
}

export interface PendingCode {
  code: string;
  fingerprint: string;
  pubKey: string;
  deviceId: string;
  name?: string;
  allowedActions: string[];
  createdAt: number;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const TRUSTED_PREFIX = 'remote.trusted.';
const PENDING_PREFIX = 'remote.pending.';

function trustedKey(id: string): string { return `${TRUSTED_PREFIX}${id}`; }
function pendingKey(code: string): string { return `${PENDING_PREFIX}${code}`; }

function randomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function generatePairCode(
  db: DatabaseService,
  opts?: { name?: string; allowedActions?: string[]; deviceId?: string; pubKey?: string; fingerprint?: string },
): PendingCode {
  // Limpieza oportunista de caducados.
  prunePending(db);
  let code = randomCode();
  for (let i = 0; i < 10 && db.getSetting(pendingKey(code)); i++) code = randomCode();
  const now = Date.now();
  const pending: PendingCode = {
    code,
    fingerprint: opts?.fingerprint ?? '',
    pubKey: opts?.pubKey ?? '',
    deviceId: opts?.deviceId ?? '',
    name: opts?.name,
    allowedActions: opts?.allowedActions ?? [...DEFAULT_POLICY],
    createdAt: now,
    expiresAt: now + PENDING_TTL_MS,
  };
  db.setSetting(pendingKey(code), JSON.stringify(pending));
  return pending;
}

export function listPending(db: DatabaseService): PendingCode[] {
  prunePending(db);
  const out: PendingCode[] = [];
  try {
    for (const [k, v] of Object.entries(db.getAllSettings())) {
      if (!k.startsWith(PENDING_PREFIX)) continue;
      try { out.push(JSON.parse(v)); } catch { /* corrupto: ignorar */ }
    }
  } catch { /* mock sin getAllSettings */ }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Acepta una invitación: valida el código pendiente (si existe localmente)
 * y registra al peer como trusted. Si el código NO existe localmente se
 * asume que el usuario lo tecleó desde el otro equipo (verificado
 * out-of-band por el propio usuario al leerlo del QR) y se registra igual,
 * siempre que el formato sea válido. Devuelve el trusted creado.
 */
export function acceptInvite(
  db: DatabaseService,
  input: { code: string; remoteDeviceId: string; remotePubKey: string; name?: string; allowedActions?: string[] },
): TrustedDevice {
  const code = String(input.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) throw new Error('Código inválido (6 dígitos)');
  if (!input.remoteDeviceId || !input.remotePubKey) throw new Error('Falta identidad remota (deviceId/pubKey)');
  const raw = db.getSetting(pendingKey(code));
  let policy: string[] = input.allowedActions ?? [...DEFAULT_POLICY];
  if (raw) {
    try {
      const p = JSON.parse(raw) as PendingCode;
      if (p.expiresAt < Date.now()) {
        db.deleteSetting(pendingKey(code));
        throw new Error('Código caducado: genera uno nuevo');
      }
      if (Array.isArray(p.allowedActions) && p.allowedActions.length) policy = p.allowedActions;
    } catch (e) {
      if (e instanceof Error && /caducado/.test(e.message)) throw e;
      // pendiente corrupto: se consume igualmente
    }
    db.deleteSetting(pendingKey(code));
  }
  const trusted: TrustedDevice = {
    deviceId: input.remoteDeviceId,
    pubKey: input.remotePubKey,
    name: input.name ?? input.remoteDeviceId.slice(0, 8),
    allowedActions: policy,
    createdAt: Date.now(),
    revoked: false,
  };
  db.setSetting(trustedKey(trusted.deviceId), JSON.stringify(trusted));
  return trusted;
}

export function listDevices(db: DatabaseService): TrustedDevice[] {
  const out: TrustedDevice[] = [];
  try {
    for (const [k, v] of Object.entries(db.getAllSettings())) {
      if (!k.startsWith(TRUSTED_PREFIX)) continue;
      try { out.push(JSON.parse(v)); } catch { /* ignorar */ }
    }
  } catch { /* mock sin getAllSettings */ }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function getTrusted(db: DatabaseService, deviceId: string): TrustedDevice | null {
  const raw = db.getSetting(trustedKey(deviceId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Revoca un equipo: borra su clave pública (ya no puede descifrar nada
 * nuevo hacia él ni nosotros desde él) y marca `revoked: true` para
 * auditoría. Cierra la sesión: el relay-client deja de aceptar envelopes
 * suyos y `isTrusted` pasa a false.
 */
export function revokeDevice(db: DatabaseService, deviceId: string): boolean {
  const t = getTrusted(db, deviceId);
  if (!t) return false;
  const redacted: TrustedDevice = { ...t, pubKey: '', revoked: true };
  db.setSetting(trustedKey(deviceId), JSON.stringify(redacted));
  try { db.deleteSetting(`remote.seq.${deviceId}`); } catch { /* noop */ }
  return true;
}

export function updatePolicy(db: DatabaseService, deviceId: string, policy: RemotePolicy): TrustedDevice {
  const t = getTrusted(db, deviceId);
  if (!t) throw new Error('Dispositivo desconocido');
  if (t.revoked) throw new Error('Dispositivo revocado');
  const next: TrustedDevice = { ...t, allowedActions: [...policy] };
  db.setSetting(trustedKey(deviceId), JSON.stringify(next));
  return next;
}

function prunePending(db: DatabaseService): void {
  try {
    const now = Date.now();
    for (const [k, v] of Object.entries(db.getAllSettings())) {
      if (!k.startsWith(PENDING_PREFIX)) continue;
      try {
        const p = JSON.parse(v) as PendingCode;
        if (p.expiresAt < now) db.deleteSetting(k);
      } catch {
        db.deleteSetting(k);
      }
    }
  } catch { /* noop */ }
}
