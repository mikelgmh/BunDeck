/**
 * useTunnel — helpers puros para detectar el modo túnel del relay.
 *
 * Cuando el móvil abre `/t/<sessionToken>/` (legacy) o `/s/<sid>/`
 * (split-token: sid público en URL + secreto en cookie HttpOnly), el
 * frontend corre bajo el proxy del relay y NO puede usar `host:3001/api`
 * ni `host:3003/ws` (puertos de LAN inalcanzables desde fuera). En ese modo
 * la API y el WS van por el mismo origen bajo el prefijo correspondiente.
 */

/** Prefijo del túnel: `/t/<token>` (legacy, secreto en URL) o `/s/<sid>` (nuevo, cookie). */
export interface TunnelPrefix {
  kind: 't' | 's';
  id: string;
}

/** Detecta el prefijo del túnel desde el pathname. */
export function getTunnelPrefix(pathname?: string): TunnelPrefix | null {
  const path =
    pathname ??
    (typeof window !== 'undefined' ? window.location.pathname : '/')
  const mt = /^\/t\/([^/]+)(?:\/|$)/.exec(path)
  if (mt?.[1]) {
    try {
      return { kind: 't', id: decodeURIComponent(mt[1]) }
    } catch {
      return { kind: 't', id: mt[1] }
    }
  }
  const ms = /^\/s\/([^/]+)(?:\/|$)/.exec(path)
  if (ms?.[1]) {
    try {
      return { kind: 's', id: decodeURIComponent(ms[1]) }
    } catch {
      return { kind: 's', id: ms[1] }
    }
  }
  return null
}

/** Token de sesión del túnel.
 *
 * Cubre la ruta del daemon (`/t/<sessionToken>/…`, 64-hex) y el nuevo
 * (`/s/<sid>/…`), y, en modo best-effort, la URL real del relay:
 * - `/ui/<urlCode>` (página que sirve el relay antes/después de aprobar),
 * - query `?token=|?sessionToken=|?session=|?t=` (enlaces relay con token),
 * - hash `#token=…` (algunos relays lo propagan en el fragmento).
 *
 * Para `/ui/<code>` se devuelve el `urlCode`: el intento P2P/signaling lo
 * usará como token y, si el relay no lo mapea, cae a `fallback` (relay)
 * en vez de quedarse en `idle` para siempre sin mostrar nada.
 *
 * En `/s/<sid>/` devuelve el `sid` (público): el secreto viaja en cookie
 * HttpOnly y el JS nunca lo ve.
 */
export function getTunnelToken(pathname?: string, search?: string): string | null {
  const prefix = getTunnelPrefix(pathname)
  if (prefix) return prefix.id
  const path =
    pathname ??
    (typeof window !== 'undefined' ? window.location.pathname : '/')
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

/** Base de la API cuando estamos en el túnel (detecta `/t/` o `/s/` por el pathname actual). */
export function tunnelApiBase(token: string, origin?: string, pathname?: string): string {
  const o =
    origin ?? (typeof window !== 'undefined' ? window.location.origin : '')
  const prefix = getTunnelPrefix(pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/'))
  if (prefix?.kind === 's') return `${o}/s/${encodeURIComponent(token)}/api/v1`
  return `${o}/t/${encodeURIComponent(token)}/api/v1`
}

/** URL del WS tuneleado (detecta `/t/` o `/s/`; la cookie se envía sola en el handshake). */
export function tunnelWsUrl(token: string, location?: { protocol: string; host: string; pathname?: string }): string {
  const loc =
    location ??
    (typeof window !== 'undefined'
      ? { protocol: window.location.protocol, host: window.location.host, pathname: window.location.pathname }
      : { protocol: 'http:', host: 'localhost', pathname: '/' })
  const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  const prefix = getTunnelPrefix((loc as { pathname?: string }).pathname)
  if (prefix?.kind === 's') return `${wsProtocol}//${loc.host}/s/${encodeURIComponent(token)}/ws`
  return `${wsProtocol}//${loc.host}/t/${encodeURIComponent(token)}/ws`
}

/** URL de `/config` a través del túnel (detecta `/t/` o `/s/`). */
export function tunnelConfigUrl(token: string, origin?: string, pathname?: string): string {
  const o =
    origin ?? (typeof window !== 'undefined' ? window.location.origin : '')
  const prefix = getTunnelPrefix(pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/'))
  if (prefix?.kind === 's') return `${o}/s/${encodeURIComponent(token)}/config`
  return `${o}/t/${encodeURIComponent(token)}/config`
}
