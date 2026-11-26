import { describe, it, expect, vi } from 'vitest'
import {
  parseLanInviteFromUrl,
  parseRelayFallbackFromUrl,
  buildLanInviteUrl,
  stripLanInviteFromUrl,
  getStoredLanSession,
  setStoredLanSession,
  clearStoredLanSession,
  isLanDeniedError,
  LAN_INVITE_PARAM,
} from '../utils/lanInvite'

function memStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      m.set(k, v)
    },
    removeItem: (k: string) => {
      m.delete(k)
    },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

describe('lanInvite: parse/build/strip del enlace', () => {
  it('parsea ?invite= (y alias lanInvite)', () => {
    expect(parseLanInviteFromUrl('?invite=ABC123')).toBe('ABC123')
    expect(parseLanInviteFromUrl('?lanInvite=XYZ')).toBe('XYZ')
    expect(parseLanInviteFromUrl('?kiosk=1')).toBeNull()
    expect(parseLanInviteFromUrl('')).toBeNull()
  })

  it('el enlace lleva la misma invitación que el QR (un único sistema)', () => {
    const url = buildLanInviteUrl('http://192.168.1.10:3002/', 'CODE-1')
    expect(url).toContain(`${LAN_INVITE_PARAM}=CODE-1`)
    expect(url).toContain('kiosk=1')
    // Regenerar cambia el código del enlace (misma base).
    const url2 = buildLanInviteUrl('http://192.168.1.10:3002/', 'CODE-2')
    expect(url2).toContain('CODE-2')
    expect(url2).not.toContain('CODE-1')
  })

  it('strip quita el código (un solo uso: no reenviarlo al recargar)', () => {
    const clean = stripLanInviteFromUrl('http://h:3002/?invite=ABC&kiosk=1')
    expect(clean).not.toContain('invite=')
    expect(clean).toContain('kiosk=1')
  })

  it('strip conserva relayFallback (el escape sobrevive a la limpieza)', () => {
    const clean = stripLanInviteFromUrl('http://h:3002/?invite=ABC&relayFallback=AbC123xYz&kiosk=1')
    expect(clean).not.toContain('invite=ABC')
    expect(clean).toContain('relayFallback=AbC123xYz')
    expect(clean).toContain('kiosk=1')
  })

  it('sesión en storage: guardar/leer/limpiar', () => {
    const s = memStorage()
    expect(getStoredLanSession(s)).toBeNull()
    setStoredLanSession('tok-123', s)
    expect(getStoredLanSession(s)).toBe('tok-123')
    clearStoredLanSession(s)
    expect(getStoredLanSession(s)).toBeNull()
  })

  it('detecta el error de denegación LAN', () => {
    expect(isLanDeniedError({ code: 'LAN_INVITE_REQUIRED' }, 401)).toBe(true)
    expect(isLanDeniedError(new Error('Sin permiso: entra con el QR'), 403)).toBe(true)
    expect(isLanDeniedError(new Error('API Error: 500'), 500)).toBe(false)
    expect(isLanDeniedError(null)).toBe(false)
  })
})

describe('lanInvite: escape al relay (?relayFallback=<urlCode>)', () => {
  it('acepta solo urlCode válido (nunca URL ni dominio: no se inventan)', () => {
    expect(parseRelayFallbackFromUrl('?relayFallback=AbC123xYz')).toBe('AbC123xYz')
    expect(parseRelayFallbackFromUrl('?invite=X&relayFallback=AbC123xYz')).toBe('AbC123xYz')
    // URL completa o dominio: se rechaza (la LAN no conoce el dominio relay).
    expect(parseRelayFallbackFromUrl('?relayFallback=https://relay.example/ui/AbC123xYz')).toBeNull()
    expect(parseRelayFallbackFromUrl('?relayFallback=relay.example')).toBeNull()
    // Vacío, ausente o con caracteres raros: null.
    expect(parseRelayFallbackFromUrl('?relayFallback=')).toBeNull()
    expect(parseRelayFallbackFromUrl('?kiosk=1')).toBeNull()
    expect(parseRelayFallbackFromUrl('')).toBeNull()
    expect(parseRelayFallbackFromUrl('?relayFallback=<script>alert(1)</script>')).toBeNull()
    expect(parseRelayFallbackFromUrl('?relayFallback=ab')).toBeNull()
  })
})

describe('lanInvite: copiado del enlace (clipboard)', () => {
  it('usa navigator.clipboard.writeText con el enlace completo', async () => {
    const writeText = vi.fn(async (_s: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const url = buildLanInviteUrl('http://192.168.1.10:3002/', 'CODE-9')
    await navigator.clipboard.writeText(url)
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('invite=CODE-9'))
    vi.unstubAllGlobals()
  })
})
