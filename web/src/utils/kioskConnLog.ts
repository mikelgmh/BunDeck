/**
 * kioskConnLog — historial de intentos de conexión para el diálogo del kiosco.
 *
 * Helpers puros: el pilotito de la barra abre un diálogo de solo lectura con
 * estas entradas (LAN primero: ocurrió antes que el P2P). El `detail` guarda
 * los parámetros de interpolación como JSON (`{"ip","ms","n","phase"}`) o el
 * motivo en texto plano (fallback); `connLogParams` lo convierte a objeto
 * para `t(clave, params)`.
 */

/** Clave fija que escribe la waiting del relay en `sessionStorage`. */
export const LAN_PROBE_KEY = 'libredeck:lanProbe'

export type ConnKind =
  | 'lan-ok'
  | 'lan-miss'
  | 'rtc-start'
  | 'rtc-signaling'
  | 'rtc-answer'
  | 'rtc-dc'
  | 'rtc-ok'
  | 'rtc-timeout'
  | 'rtc-fallback'

export interface ConnEntry {
  ts: number
  kind: ConnKind
  detail?: string
}

/** Clave i18n del texto de cada entrada (el componente aplica `t()`). */
export function connLogKey(kind: string): string {
  switch (kind) {
    case 'lan-ok':
      return 'bd.kioskLogLanOk'
    case 'lan-miss':
      return 'bd.kioskLogLanMiss'
    case 'rtc-start':
      return 'bd.kioskLogRtcStart'
    case 'rtc-signaling':
      return 'bd.kioskLogRtcSignaling'
    case 'rtc-answer':
      return 'bd.kioskLogRtcAnswer'
    case 'rtc-dc':
      return 'bd.kioskLogRtcDc'
    case 'rtc-ok':
      return 'bd.kioskLogRtcOk'
    case 'rtc-timeout':
      return 'bd.kioskLogRtcTimeout'
    case 'rtc-fallback':
    default:
      return 'bd.kioskLogRtcFallback'
  }
}

/** Parámetros de interpolación desde el `detail` (JSON o texto plano). */
export function connLogParams(e: ConnEntry): Record<string, string | number> {
  const d = e.detail
  if (d === undefined || d === '') return {}
  try {
    const o = JSON.parse(d) as unknown
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      return o as Record<string, string | number>
    }
  } catch {
    /* no es JSON: cae al detail plano */
  }
  return { detail: d }
}

interface LanProbe {
  tried?: boolean
  ok?: boolean
  ip?: string
  ips?: string[]
  ms?: number
  ts?: number
}

/**
 * Lee la sonda LAN (`libredeck:lanProbe`) y la convierte en 0-1 entradas:
 * `lan-ok` (ip/ms) o `lan-miss` (n/ms). Nunca lanza; sin storage o con
 * JSON roto devuelve lista vacía.
 */
export function readLanProbe(
  storage?: Pick<Storage, 'getItem'> | null,
): ConnEntry[] {
  try {
    const s = storage ?? (typeof sessionStorage !== 'undefined' ? sessionStorage : null)
    const raw = s?.getItem(LAN_PROBE_KEY)
    if (!raw) return []
    const p = JSON.parse(raw) as LanProbe
    if (!p || typeof p !== 'object' || p.tried !== true) return []
    const ms = Number(p.ms)
    const msSafe = Number.isFinite(ms) ? ms : 0
    const ts = Number.isFinite(Number(p.ts)) ? Number(p.ts) : Date.now()
    if (p.ok === true && typeof p.ip === 'string' && p.ip) {
      return [{ ts, kind: 'lan-ok', detail: JSON.stringify({ ip: p.ip, ms: msSafe }) }]
    }
    const n = Array.isArray(p.ips) ? p.ips.length : 0
    return [{ ts, kind: 'lan-miss', detail: JSON.stringify({ n, ms: msSafe }) }]
  } catch {
    return []
  }
}
