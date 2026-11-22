/**
 * useTunnel — helpers puros para detectar el modo túnel del relay.
 *
 * Cuando el móvil abre `/t/<sessionToken>/`, el frontend corre bajo el
 * proxy del relay y NO puede usar `host:3001/api` ni `host:3003/ws`
 * (puertos de LAN inalcanzables desde fuera). En ese modo la API y el WS
 * van por el mismo origen bajo `/t/<token>/…`.
 */

/** Token de sesión del túnel si el pathname es `/t/<token>/…`. */
export function getTunnelToken(pathname?: string): string | null {
  const path =
    pathname ??
    (typeof window !== 'undefined' ? window.location.pathname : '/')
  const m = /^\/t\/([^/]+)(?:\/|$)/.exec(path)
  const token = m?.[1] ?? ''
  return token ? decodeURIComponent(token) : null
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
