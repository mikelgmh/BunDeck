import { describe, expect, it } from 'vitest'
import {
  TUNNEL_RETRY_DELAYS,
  TUNNEL_RETRY_MAX,
  tunnelRetryDelayMs,
  classifyTunnelError,
  shouldAutoRetryTunnelGone,
} from '../utils/tunnelRetry'

describe('tunnelRetry', () => {
  it('backoff creciente con techo', () => {
    expect(tunnelRetryDelayMs(1)).toBe(TUNNEL_RETRY_DELAYS[0])
    expect(tunnelRetryDelayMs(2)).toBe(TUNNEL_RETRY_DELAYS[1])
    const last = TUNNEL_RETRY_DELAYS[TUNNEL_RETRY_DELAYS.length - 1]
    expect(tunnelRetryDelayMs(99)).toBe(last)
    // Monótono no-decreciente en la ventana útil.
    for (let i = 1; i < TUNNEL_RETRY_MAX; i++) {
      expect(tunnelRetryDelayMs(i + 1)).toBeGreaterThanOrEqual(tunnelRetryDelayMs(i))
    }
  })

  it('solo 502 daemon-offline reintenta; 401 expired/invalid-token piden QR nuevo', () => {
    // Caso del fix: recarga en ventana de reconexión (relay recién
    // redesplegado, daemon aún no re-anunció) → reintentar, no QR nuevo.
    expect(classifyTunnelError(502, 'daemon-offline')).toBe('retry')
    expect(classifyTunnelError(401, 'expired')).toBe('qr-new')
    expect(classifyTunnelError(401, 'invalid-token')).toBe('qr-new')
    // Ruido: no dispara ni reintento ni QR.
    expect(classifyTunnelError(502, 'daemon-timeout')).toBe('ignore')
    expect(classifyTunnelError(401, 'auth-required')).toBe('ignore')
    expect(classifyTunnelError(200, '')).toBe('ignore')
    expect(classifyTunnelError(429, 'rate-limited')).toBe('ignore')
  })

  it('auto-reintento de la tarjeta solo con daemon-offline', () => {
    expect(shouldAutoRetryTunnelGone('daemon-offline')).toBe(true)
    expect(shouldAutoRetryTunnelGone('expired')).toBe(false)
    expect(shouldAutoRetryTunnelGone('invalid-token')).toBe(false)
    expect(shouldAutoRetryTunnelGone(null)).toBe(false)
  })
})
