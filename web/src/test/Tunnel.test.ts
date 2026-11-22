import { describe, expect, it } from 'vitest'
import {
  getTunnelToken,
  isTunnelMode,
  tunnelApiBase,
  tunnelConfigUrl,
  tunnelWsUrl,
} from '../composables/useTunnel'

describe('useTunnel', () => {
  it('detecta el token en /t/<token>/…', () => {
    expect(getTunnelToken('/t/abc123/')).toBe('abc123')
    expect(getTunnelToken('/t/abc123/_astro/index.css')).toBe('abc123')
    expect(getTunnelToken('/')).toBeNull()
    expect(getTunnelToken('/ui/abc123')).toBeNull()
    expect(isTunnelMode('/t/abc123/')).toBe(true)
    expect(isTunnelMode('/')).toBe(false)
  })

  it('construye API/WS/config por el mismo origen del túnel', () => {
    expect(tunnelApiBase('tok1', 'https://relay.example')).toBe(
      'https://relay.example/t/tok1/api/v1',
    )
    expect(tunnelConfigUrl('tok1', 'https://relay.example')).toBe(
      'https://relay.example/t/tok1/config',
    )
    expect(
      tunnelWsUrl('tok1', { protocol: 'https:', host: 'relay.example' }),
    ).toBe('wss://relay.example/t/tok1/ws')
    expect(
      tunnelWsUrl('tok1', { protocol: 'http:', host: 'relay.example' }),
    ).toBe('ws://relay.example/t/tok1/ws')
  })
})
