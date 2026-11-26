import { describe, it, expect } from 'vitest'
import { kioskTransportLabelKey } from '../utils/kioskTransport'

describe('kioskTransportLabelKey', () => {
  it('mapea cada estado a su texto (el rojo nunca dice P2P)', () => {
    expect(kioskTransportLabelKey('p2p')).toBe('bd.remoteUiTransportP2p')
    expect(kioskTransportLabelKey('relay')).toBe('bd.remoteUiTransportRelay')
    expect(kioskTransportLabelKey('disconnected')).toBe('bd.tunnelTransportDisconnected')
    expect(kioskTransportLabelKey('probing')).toBe('bd.tunnelTransportProbing')
    expect(kioskTransportLabelKey('connecting')).toBe('bd.tunnelTransportConnecting')
  })
})
