import { describe, it, expect } from 'vitest'
import {
  connLogKey,
  connLogParams,
  readLanProbe,
  LAN_PROBE_KEY,
  type ConnEntry,
} from '../utils/kioskConnLog'

describe('connLogKey', () => {
  it('mapea cada kind a su clave i18n', () => {
    expect(connLogKey('lan-ok')).toBe('bd.kioskLogLanOk')
    expect(connLogKey('lan-miss')).toBe('bd.kioskLogLanMiss')
    expect(connLogKey('rtc-start')).toBe('bd.kioskLogRtcStart')
    expect(connLogKey('rtc-signaling')).toBe('bd.kioskLogRtcSignaling')
    expect(connLogKey('rtc-answer')).toBe('bd.kioskLogRtcAnswer')
    expect(connLogKey('rtc-dc')).toBe('bd.kioskLogRtcDc')
    expect(connLogKey('rtc-ok')).toBe('bd.kioskLogRtcOk')
    expect(connLogKey('rtc-timeout')).toBe('bd.kioskLogRtcTimeout')
    expect(connLogKey('rtc-fallback')).toBe('bd.kioskLogRtcFallback')
  })
})

describe('connLogParams', () => {
  it('detail JSON → objeto de interpolación', () => {
    const e: ConnEntry = { ts: 1, kind: 'lan-ok', detail: JSON.stringify({ ip: '192.168.1.2', ms: 12 }) }
    expect(connLogParams(e)).toEqual({ ip: '192.168.1.2', ms: 12 })
  })
  it('detail plano → { detail }', () => {
    const e: ConnEntry = { ts: 1, kind: 'rtc-fallback', detail: 'handshake failed' }
    expect(connLogParams(e)).toEqual({ detail: 'handshake failed' })
  })
  it('sin detail → {}', () => {
    expect(connLogParams({ ts: 1, kind: 'rtc-start' })).toEqual({})
    expect(connLogParams({ ts: 1, kind: 'rtc-start', detail: '' })).toEqual({})
  })
})

describe('readLanProbe', () => {
  // Storage en memoria (inyectable, como lanInvite).
  const mem = (init?: Record<string, string>) => {
    const m = new Map(Object.entries(init ?? {}))
    return { getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null) }
  }

  it('lan-ok con ip/ms', () => {
    const s = mem({
      [LAN_PROBE_KEY]: JSON.stringify({ urlCode: 'AbC123', tried: true, ips: ['192.168.1.2'], ok: true, ip: '192.168.1.2', ms: 12, ts: 1700000000000 }),
    })
    expect(readLanProbe(s)).toEqual([
      { ts: 1700000000000, kind: 'lan-ok', detail: JSON.stringify({ ip: '192.168.1.2', ms: 12 }) },
    ])
  })

  it('lan-miss con n/ms', () => {
    const s = mem({
      [LAN_PROBE_KEY]: JSON.stringify({ urlCode: 'AbC123', tried: true, ips: ['a', 'b', 'c'], ok: false, ms: 345, ts: 1700000000000 }),
    })
    expect(readLanProbe(s)).toEqual([
      { ts: 1700000000000, kind: 'lan-miss', detail: JSON.stringify({ n: 3, ms: 345 }) },
    ])
  })

  it('basura o sin tried → vacío', () => {
    expect(readLanProbe(mem({ [LAN_PROBE_KEY]: 'no-json{{{' }))).toEqual([])
    expect(readLanProbe(mem({ [LAN_PROBE_KEY]: JSON.stringify({ ok: true }) }))).toEqual([])
    expect(readLanProbe(mem({}))).toEqual([])
  })

  it('sin storage inyectado usa sessionStorage (vacío → [])', () => {
    try {
      sessionStorage.removeItem(LAN_PROBE_KEY)
    } catch {
      /* sin sessionStorage: readLanProbe ya devuelve [] */
    }
    expect(readLanProbe()).toEqual([])
  })
})
