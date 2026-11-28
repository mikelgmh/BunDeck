/**
 * tunnelRetry — decisión pura del auto-reintento de la tarjeta `tunnel-gone`.
 *
 * El relay distingue (ver relay/src/relay.ts):
 * - `502 daemon-offline` → REINTENTABLE: sesión conocida pero daemon
 *   reconectando, o token desconocido en ventana de gracia post-redespliegue
 *   (el daemon aún no re-anunció con `ui-rebind`). Poll con backoff a
 *   `/config` por el túnel y recarga sola al volver 200.
 * - `401 expired` / `401 invalid-token` → DEFINITIVO: pedir QR nuevo, no
 *   reintentar (la sesión no va a resucitar).
 */

/** Backoff del poll (ms): 2s, 3s, 5s, 8s, 13s, 20s (techo). */
export const TUNNEL_RETRY_DELAYS = [2000, 3000, 5000, 8000, 13000, 20000] as const

/** Nº máximo de intentos (~4 min de ventana: cubre backoff del daemon 1s→30s). */
export const TUNNEL_RETRY_MAX = 20

/** Retardo antes del intento `attempt` (1-based; techo en el último tramo). */
export function tunnelRetryDelayMs(attempt: number): number {
  const i = Math.max(0, Math.min(attempt - 1, TUNNEL_RETRY_DELAYS.length - 1))
  return TUNNEL_RETRY_DELAYS[i]
}

export type TunnelGoneReason = 'invalid-token' | 'expired' | 'daemon-offline'

/** Qué hacer ante un error del túnel: reintentar, pedir QR nuevo o ignorar. */
export type TunnelErrorAction = 'retry' | 'qr-new' | 'ignore'

/**
 * Clasifica un error HTTP del túnel por status + `error` del cuerpo.
 * Solo `502 daemon-offline` reintenta; `401 expired/invalid-token` piden QR.
 */
export function classifyTunnelError(status: number, error: string): TunnelErrorAction {
  if (status === 502 && error === 'daemon-offline') return 'retry'
  if (status === 401 && (error === 'expired' || error === 'invalid-token')) return 'qr-new'
  return 'ignore'
}

/** ¿La tarjeta de sesión muerta debe auto-reintentar? Solo daemon-offline. */
export function shouldAutoRetryTunnelGone(reason: TunnelGoneReason | null): boolean {
  return reason === 'daemon-offline'
}
