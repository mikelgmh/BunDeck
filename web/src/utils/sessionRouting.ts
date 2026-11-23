/**
 * sessionRouting — helpers puros para sesiones por dispositivo/cliente.
 *
 * Cada browser/hardware/relay tiene un `deviceId` estable con vista propia
 * (profileId/pageId). Las navegaciones (`page.navigate`/`profile.navigate`)
 * pueden ser dirigidas (`targetDeviceId`/`target`/`deviceId`) o broadcast
 * globales (sin destino, compat con el daemon anterior).
 */

/** Genera un deviceId estable (persistente en localStorage). */
export function getOrCreateDeviceId(storage?: Pick<Storage, 'getItem' | 'setItem'> | null): string {
  const KEY = 'libredeck_device_id'
  try {
    const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    const existing = s?.getItem(KEY)
    if (existing && existing.length > 0) return existing
    const fresh =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    try { s?.setItem(KEY, fresh) } catch { /* almacenamiento no disponible */ }
    return fresh
  } catch {
    return `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/**
 * ¿Debe este dispositivo aplicar una navegación recibida por WS?
 * - Sin destino (o 'all') → broadcast antiguo: aplica a todos (compat).
 * - Con destino → solo si coincide con el deviceId (o clientId) propio.
 */
export function isNavigationForMe(
  payload: any,
  ownDeviceId: string,
  ownClientId?: string | null,
): boolean {
  const p = payload ?? {}
  const t = p.targetDeviceId ?? p.target ?? p.deviceId ?? p.device_id ?? null
  const targets = Array.isArray(p.targets) ? p.targets : null
  if (targets) {
    if (targets.length === 0) return true // sin destinos: broadcast (compat)
    return (
      targets.includes('all') ||
      targets.includes('*') ||
      targets.includes(ownDeviceId) ||
      (ownClientId ? targets.includes(ownClientId) : false)
    )
  }
  if (t === null || t === undefined || t === '') return true // compat: broadcast antiguo
  if (t === 'all' || t === '*') return true
  if (t === ownDeviceId) return true
  if (ownClientId && (t === ownClientId || t === `client:${ownClientId}`)) return true
  return false
}

/** Extrae el destino de navegación de un payload (para tests y depuración). */
export function describeNavTarget(payload: any): string {
  const p = payload ?? {}
  const t = p.targetDeviceId ?? p.target ?? p.deviceId ?? p.device_id ?? null
  if (t) return String(t)
  if (Array.isArray(p.targets) && p.targets.length > 0) return p.targets.join(',')
  if (p.broadcast === true) return 'all'
  return 'all' // sin destino: broadcast (compat)
}
