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
 * Familia del navegador actual (Chrome, Edge, Firefox, Safari, Brave…)
 * para identificar cada contexto en las listas de dispositivos.
 * Recibe `navigator` como parámetro para poder probarla sin DOM.
 */
export function browserFamilyName(nav?: any | null): string {
  try {
    const n = nav ?? (typeof navigator !== 'undefined' ? navigator : null)
    const ua = String(n?.userAgent ?? '')
    const brands: Array<{ brand?: string }> = n?.userAgentData?.brands ?? []
    const b = brands.map((x) => String(x?.brand ?? '').toLowerCase()).join(' ')
    return browserFamilyFromUa(ua, b, !!(n as any)?.brave)
  } catch { /* sin navigator: nombre genérico */ }
  return 'Navegador'
}

/** Núcleo puro de detección de navegador sobre un UA ya extraído. */
function browserFamilyFromUa(ua: string, brandsLower: string, braveFlag: boolean): string {
  try {
    if (braveFlag || brandsLower.includes('brave')) return 'Brave'
    if (/edg/i.test(ua) || brandsLower.includes('edge') || /(^|\s)edg($|\s)/.test(brandsLower)) return 'Edge'
    if (/opr\/|opera|opt\//i.test(ua) || brandsLower.includes('opera')) return 'Opera'
    if (/firefox|fxios/i.test(ua)) return 'Firefox'
    if (/chrome|chromium|crios/i.test(ua) || brandsLower.includes('chromium') || brandsLower.includes('chrome')) return 'Chrome'
    if (/safari/i.test(ua)) return 'Safari'
  } catch { /* noop */ }
  return 'Navegador'
}

export interface ParsedDevice {
  /** Modelo legible: iPad | iPhone | Android | Windows | macOS | Linux | '' */
  model: string
  /** Familia de navegador (igual que browserFamilyName). */
  browser: string
}

/**
 * Modelo de dispositivo + navegador a partir de un UA crudo.
 * Sirve para sugerir el nombre al aprobar ("iPad Safari"): el diálogo del
 * anfitrión solo tiene el UA que vio el relay, sin objeto navigator.
 */
export function parseDeviceUserAgent(ua: unknown): ParsedDevice {
  const s = String(ua ?? '')
  let model = ''
  if (/ipad/i.test(s)) model = 'iPad'
  else if (/iphone/i.test(s)) model = 'iPhone'
  // iPadOS 13+: el UA finge ser de escritorio ("Macintosh") pero con Mobile.
  else if (/macintosh/i.test(s) && /mobile/i.test(s)) model = 'iPad'
  else if (/android/i.test(s)) model = 'Android'
  else if (/windows nt/i.test(s)) model = 'Windows'
  else if (/mac os x|macintosh/i.test(s)) model = 'macOS'
  else if (/linux/i.test(s)) model = 'Linux'
  return { model, browser: browserFamilyFromUa(s, '', false) }
}

/**
 * Nombre por defecto para un dispositivo ("iPad Safari", "Windows Edge").
 * Sin UA usa el navegador propio (con detección Brave incluida); con UA
 * ajeno (p. ej. el que vio el relay) solo se puede inferir del texto, así
 * que un Brave en iOS se leerá como Chrome.
 */
export function deviceDefaultName(ua?: string): string {
  const nav = typeof navigator !== 'undefined' ? navigator : null
  const raw = typeof ua === 'string' ? ua : String((nav as any)?.userAgent ?? '')
  if (!raw.trim()) return 'Navegador'
  const brands: Array<{ brand?: string }> = (nav as any)?.userAgentData?.brands ?? []
  const b = ua === undefined ? brands.map((x) => String(x?.brand ?? '').toLowerCase()).join(' ') : ''
  // Brave solo se detecta en el navegador propio (navigator.brave / brands);
  // con un UA ajeno no hay forma de distinguirlo de Chrome.
  const brave = ua === undefined && (!!(nav as any)?.brave || b.includes('brave'))
  const { model } = parseDeviceUserAgent(raw)
  const browser = browserFamilyFromUa(raw, b, brave)
  const name = [model, browser === 'Navegador' ? '' : browser].filter(Boolean).join(' ')
  return name || 'Navegador'
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

/**
 * ¿Es una navegación GLOBAL (broadcast) y no dirigida?
 * Solo el broadcast debe tocar los settings globales `current.*` que lee
 * el HW físico y usan los arranques sin asignación. El reparto de pantallas
 * (destino concreto) nunca mueve al anfitrión: el daemon ya lo garantiza en
 * su lado y el frontend no debe deshacerlo con un POST directo a /settings.
 */
export function isBroadcastNav(payload: any): boolean {
  const p = payload ?? {}
  if ((p as any).broadcast === true) return true
  const targets = Array.isArray((p as any).targets) ? (p as any).targets : null
  if (targets) {
    if (targets.length === 0) return true
    return targets.includes('all') || targets.includes('*')
  }
  const t = (p as any).targetDeviceId ?? (p as any).target ?? (p as any).deviceId ?? (p as any).device_id ?? null
  if (t === null || t === undefined || t === '') return true
  if (t === 'all' || t === '*') return true
  return false
}
