/**
 * device-bindings.ts — Vincula un `deviceId` estable (WS `hello`) con la
 * sesión de acceso que lo autorizó (UI remota o invitación LAN).
 *
 * Motivación: los dispositivos ya NO se crean a mano; son HW detectado o
 * navegadores aceptados. Cuando se revoca una sesión (`RemotePane`), el
 * dispositivo debe desaparecer de la lista Y tener prohibida la entrada.
 * Como el token y el `deviceId` viven en capas distintas (relay vs WS), el
 * `hello` registra aquí el enlace `deviceId → prefijo de token`.
 *
 * Persistencia: settings (sin tablas nuevas).
 * - `remote.ui.device.<deviceId>` = prefijo (8 chars) del token UI.
 * - `remote.lan.device.<deviceId>` = prefijo (8 chars) del token LAN.
 * Solo se guarda el prefijo: basta para revocar y nunca expone el secreto.
 */

import type { DatabaseService } from '../db';

const UI_DEVICE_PREFIX = 'remote.ui.device.';
const LAN_DEVICE_PREFIX = 'remote.lan.device.';

export type BindingKind = 'ui' | 'lan';

function keyFor(kind: BindingKind, deviceId: string): string {
  return `${kind === 'ui' ? UI_DEVICE_PREFIX : LAN_DEVICE_PREFIX}${deviceId}`;
}

/** Prefijo de 8 chars que listan las APIs (el token completo jamás sale). */
export function tokenPrefix(token: string): string {
  return String(token ?? '').slice(0, 8);
}

/**
 * Registra que `deviceId` entró con `token` (guarda solo el prefijo).
 * No valida: el llamante ya validó el token.
 */
export function bindDeviceToToken(
  db: DatabaseService,
  kind: BindingKind,
  deviceId: string,
  token: string,
): void {
  const id = String(deviceId ?? '').trim();
  const prefix = tokenPrefix(token);
  if (!id || !prefix) return;
  try {
    db.setSetting(keyFor(kind, id), prefix);
  } catch { /* mejor esfuerzo */ }
}

/** Prefijo enlazado a un dispositivo (o null si nunca se registró). */
export function boundPrefixForDevice(
  db: DatabaseService,
  kind: BindingKind,
  deviceId: string,
): string | null {
  try {
    const v = db.getSetting(keyFor(kind, String(deviceId ?? '')));
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Todos los deviceId enlazados a un prefijo de token (normalmente uno). */
export function devicesForTokenPrefix(
  db: DatabaseService,
  kind: BindingKind,
  prefix: string,
): string[] {
  const want = String(prefix ?? '').slice(0, 8);
  if (!want) return [];
  let all: Record<string, string> = {};
  try {
    all = db.getAllSettings();
  } catch {
    return [];
  }
  const ns = kind === 'ui' ? UI_DEVICE_PREFIX : LAN_DEVICE_PREFIX;
  const out: string[] = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(ns)) continue;
    if (String(v ?? '').slice(0, 8) !== want) continue;
    const deviceId = k.slice(ns.length);
    if (deviceId) out.push(deviceId);
  }
  return out;
}

/** Olvida los enlaces de un dispositivo (al borrarlo o al re-vincularlo). */
export function unbindDevice(db: DatabaseService, deviceId: string): void {
  for (const kind of ['ui', 'lan'] as const) {
    try {
      db.deleteSetting(keyFor(kind, String(deviceId ?? '')));
    } catch { /* noop */ }
  }
}
