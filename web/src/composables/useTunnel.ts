/**
 * useTunnel — helpers puros para detectar el modo túnel del relay.
 *
 * Cuando el móvil abre `/t/<sessionToken>/`, el frontend corre bajo el
 * proxy del relay y NO puede usar `host:3001/api` ni `host:3003/ws`
 * (puertos de LAN inalcanzables desde fuera). En ese modo la API y el WS
 * van por el mismo origen bajo `/t/<token>/…`.
 */

/** Token de sesión del túnel.
 *
 * Cubre la ruta del daemon (`/t/<sessionToken>/…`, 64-hex) y, en modo
 * best-effort, la URL real del relay que abre el usuario:
 * - `/ui/<urlCode>` (página que sirve el relay antes/después de aprobar),
 * - query `?token=|?sessionToken=|?session=|?t=` (enlaces relay con token),
 * - hash `#token=…` (algunos relays lo propagan en el fragmento).
 *
 * Para `/ui/<code>` se devuelve el `urlCode`: el intento P2P/signaling lo
 * usará como token y, si el relay no lo mapea, cae a `fallback` (relay)
 * en vez de quedarse en `idle` para siempre sin mostrar nada.
 */
export function getTunnelToken(pathname?: string, search?: string): string | null {
  const path =
    pathname ??
    (typeof window !== 'undefined' ? window.location.pathname : '/')
  const m = /^\/t\/([^/]+)(?:\/|$)/.exec(path)
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return m[1]
    }
  }
  const ui = /^\/ui\/([^/]+)(?:\/|$)/.exec(path)
  if (ui?.[1]) {
    try {
      return decodeURIComponent(ui[1])
    } catch {
      return ui[1]
    }
  }
  try {
    const qs = search ?? (typeof window !== 'undefined' ? window.location.search : '')
    if (qs) {
      const q = new URLSearchParams(qs)
      for (const k of ['token', 'sessionToken', 'session', 't']) {
        const v = q.get(k)
        if (v) return v
      }
    }
  } catch {
    /* sin URLSearchParams: no hay token en query */
  }
  try {
    const h = typeof window !== 'undefined' ? window.location.hash : ''
    const hm = /[#&?](?:token|sessionToken|session|t)=([^&#]+)/.exec(h)
    if (hm?.[1]) return decodeURIComponent(hm[1])
  } catch {
    /* sin hash válido */
  }
  return null
}

/** ¿Corre el frontend dentro del túnel del relay? */
export function isTunnelMode(pathname?: string): boolean {
  return getTunnelToken(pathname) !== null
}

/** Base de la API cuando estamos en el túnel: mismo origen + `/t/<token>/api/v1`. */
export function tunnelApiBase(token: string, origin?: string): string {
  const o =
    origin ?? (typeof window !== 'undefined' ? window.location.origin : '')
  return `${o}/t/${encodeURIComponent(token)}/api/v1`
}

/** URL del WS tuneleado: mismo host + `/t/<token>/ws`. */
export function tunnelWsUrl(token: string, location?: { protocol: string; host: string }): string {
  const loc =
    location ??
    (typeof window !== 'undefined'
      ? { protocol: window.location.protocol, host: window.location.host }
      : { protocol: 'http:', host: 'localhost' })
  const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${loc.host}/t/${encodeURIComponent(token)}/ws`
}

/** URL de `/config` a través del túnel. */
export function tunnelConfigUrl(token: string, origin?: string): string {
  const o =
    origin ?? (typeof window !== 'undefined' ? window.location.origin : '')
  return `${o}/t/${encodeURIComponent(token)}/config`
}
