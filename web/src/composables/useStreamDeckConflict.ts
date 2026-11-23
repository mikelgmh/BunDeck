// Conflicto con la app oficial de Elgato Stream Deck.
//
// La app oficial se queda el HID en exclusiva y BunDeck no puede abrir el
// dispositivo. El daemon la detecta por nombre de proceso (allowlist) y lo
// expone en `GET /api/v1/devices/streamdeck/status` → `conflict`.
// Este composable sondea ese estado: muestra el diálogo bloqueante mientras
// haya proceso oficial vivo (lo cierre el botón o el usuario a mano) y lo
// oculta en cuanto desaparece.

export interface ConflictProcessInfo {
  name: string
  pid: number | null
}

export interface StreamDeckConflict {
  detected: boolean
  processes: ConflictProcessInfo[]
  hidBusyHint: boolean
  reason: string
}

export interface StreamDeckStatusWithConflict {
  isConnected?: boolean
  conflict?: Partial<StreamDeckConflict> | null
}

/** ¿Hay que mostrar el diálogo bloqueante? Solo cuando el daemon ve el
 *  proceso oficial vivo (no basta la pista HID: sin dispositivo también hay
 *  lista vacía). Versión pura y testeable. */
export function shouldShowConflictDialog(
  status: StreamDeckStatusWithConflict | null | undefined
): boolean {
  const c = status?.conflict
  if (!c) return false
  if (c.detected === true) return true
  return Array.isArray(c.processes) && c.processes.length > 0
}

async function resolveApiBase(): Promise<string> {
  if (typeof window === 'undefined') return 'http://localhost:3001/api/v1'
  try {
    const { getTunnelToken, tunnelApiBase } = await import('./useTunnel')
    const token = getTunnelToken()
    if (token) return tunnelApiBase(token)
  } catch {
    /* sin túnel: base directa */
  }
  const hostname = window.location.hostname || 'localhost'
  const protocol = window.location.protocol || 'http:'
  // Puerto del API: sale de /config (3001 por defecto).
  let apiPort = 3001
  try {
    const configUrl =
      window.location.port !== '3001'
        ? `${protocol}//${hostname}:3001/config`
        : '/config'
    const res = await fetch(configUrl)
    if (res.ok) {
      const data = await res.json().catch(() => ({}))
      const p = Number((data as any)?.apiPort)
      if (Number.isFinite(p) && p > 0) apiPort = p
    }
  } catch {
    /* puerto por defecto */
  }
  return `${protocol}//${hostname}:${apiPort}/api/v1`
}

let cachedApiBase: string | null = null

export async function fetchStreamDeckStatus(): Promise<StreamDeckStatusWithConflict> {
  if (!cachedApiBase) cachedApiBase = await resolveApiBase()
  const res = await fetch(`${cachedApiBase}/devices/streamdeck/status`, {
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`status ${res.status}`)
  return (await res.json()) as StreamDeckStatusWithConflict
}

export async function requestCloseOfficialApp(): Promise<{
  closed: ConflictProcessInfo[]
  remaining: ConflictProcessInfo[]
  detected: boolean
}> {
  if (!cachedApiBase) cachedApiBase = await resolveApiBase()
  const res = await fetch(`${cachedApiBase}/devices/streamdeck/close-official`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`close-official ${res.status}`)
  return (await res.json()) as {
    closed: ConflictProcessInfo[]
    remaining: ConflictProcessInfo[]
    detected: boolean
  }
}
