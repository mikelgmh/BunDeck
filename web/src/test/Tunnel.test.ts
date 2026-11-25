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
    expect(isTunnelMode('/t/abc123/')).toBe(true)
    expect(isTunnelMode('/')).toBe(false)
  })

  it('cubre la URL real del relay: /ui/<code>, query y hash', () => {
    expect(getTunnelToken('/ui/CODE-abc_123/')).toBe('CODE-abc_123')
    expect(getTunnelToken('/', '?token=tok12345')).toBe('tok12345')
    expect(getTunnelToken('/', '?session=tok12345')).toBe('tok12345')
    expect(getTunnelToken('/', '?sessionToken=tok12345')).toBe('tok12345')
    expect(isTunnelMode('/ui/CODE-abc/')).toBe(true)
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
