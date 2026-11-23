/**
 * Sesiones por dispositivo/cliente: lógica pura de enrutamiento.
 *
 * Cada WS client (browser/hardware/relay) tiene su propio `deviceId` estable,
 * con vista `profileId/pageId` independiente persistida en `device_sessions`.
 * Estas funciones no tocan sockets: las usa `ws.ts` (daemon) y se prueban
 * sin red en `src/test/device-sessions.test.ts`.
 */

/** Destino de una navegación (page.select/profile.select/acciones). */
export type NavTargets =
  | { kind: 'self' } // solo el dispositivo que ejecuta (defecto)
  | { kind: 'devices'; ids: string[] } // uno o varios deviceId concretos
  | { kind: 'all' }; // broadcast a todos

/**
 * Resuelve el destino de una navegación desde el payload del mensaje.
 * Acepta `target`, `deviceId`/`device_id`, `targets[]` o `broadcast:true`.
 * Sin destino explícito → solo el emisor (`self`).
 * `target:'all'` (o `broadcast:true`, `'*'`) → broadcast.
 */
export function resolveNavTargets(payload: any, senderDeviceId: string): NavTargets {
  const p = payload ?? {};
  const raw =
    p.target ?? p.deviceId ?? p.device_id ?? null;
  const broadcast =
    p.broadcast === true ||
    raw === 'all' ||
    raw === '*' ||
    (Array.isArray(p.targets) && (p.targets.includes('all') || p.targets.includes('*')));

  if (broadcast) return { kind: 'all' };

  if (typeof raw === 'string' && raw.length > 0) {
    if (raw === senderDeviceId || raw === 'self') return { kind: 'self' };
    return { kind: 'devices', ids: [raw] };
  }

  if (Array.isArray(p.targets)) {
    const ids = [...new Set(
      p.targets.filter((x: any) => typeof x === 'string' && x.length > 0 && x !== 'all' && x !== '*' && x !== 'self'),
    )] as string[];
    // 'self' explícito mezclado → se incluye el emisor
    const withSelf = p.targets.includes('self') || p.targets.includes(senderDeviceId);
    const others = ids.filter((id) => id !== senderDeviceId);
    if (others.length === 0) return { kind: 'self' };
    if (withSelf) return { kind: 'devices', ids: [senderDeviceId, ...others] };
    return { kind: 'devices', ids: others };
  }

  return { kind: 'self' };
}

/**
 * ¿Debe este dispositivo aplicar una navegación recibida?
 * Los mensajes dirigidos traen `targetDeviceId`/`target`/`deviceId`;
 * los antiguos (broadcast global) no traen destino → aplican a todos.
 */
export function isNavigationForDevice(payload: any, ownDeviceId: string, ownClientId?: string): boolean {
  const p = payload ?? {};
  const t = p.targetDeviceId ?? p.target ?? p.deviceId ?? p.device_id ?? null;
  const targets = Array.isArray(p.targets) ? p.targets : null;
  if (targets) {
    if (targets.length === 0) return true;
    return targets.includes('all') || targets.includes('*') ||
      targets.includes(ownDeviceId) ||
      (ownClientId ? targets.includes(ownClientId) : false);
  }
  if (t === null || t === undefined || t === '') return true; // compat: broadcast antiguo
  if (t === 'all' || t === '*') return true;
  if (t === ownDeviceId) return true;
  if (ownClientId && (t === ownClientId || t === `client:${ownClientId}`)) return true;
  return false;
}

/** Normaliza el kind de cliente a un vocabulario conocido. */
export function normalizeDeviceKind(kind: unknown): string {
  const k = typeof kind === 'string' ? kind.toLowerCase().trim() : '';
  if (k === 'browser' || k === 'web' || k === 'dashboard') return 'browser';
  if (k === 'hardware' || k === 'streamdeck' || k === 'elgato') return 'hardware';
  if (k === 'relay' || k === 'tunnel' || k === 'remote') return 'relay';
  if (k === 'cli' || k === 'api') return 'cli';
  return k || 'unknown';
}
