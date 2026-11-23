import { describe, it, expect } from 'vitest'
import { ensureDefaultIcon, DEFAULT_KEY_ICON } from '../composables/useStreamDeck'

// Icono por defecto al CREAR teclas: si no hay visual (icon/iconImage/emoji)
// se pone DEFAULT_KEY_ICON. Solo creación: los updates conservan icon:''.
describe('ensureDefaultIcon (icono por defecto al crear)', () => {
  it('expone un icono Lucide válido', () => {
    expect(typeof DEFAULT_KEY_ICON).toBe('string')
    expect(DEFAULT_KEY_ICON.length).toBeGreaterThan(0)
    expect(DEFAULT_KEY_ICON).toMatch(/^[A-Za-z][A-Za-z0-9]*$/)
  })

  it('pone el icono cuando no hay visual', () => {
    expect(ensureDefaultIcon({})).toEqual({ icon: DEFAULT_KEY_ICON })
    expect(ensureDefaultIcon({ label: 'X', actions: [] })).toEqual({
      label: 'X',
      actions: [],
      icon: DEFAULT_KEY_ICON,
    })
  })

  it('respeta el visual elegido por el usuario', () => {
    expect(ensureDefaultIcon({ icon: 'Play' })).toEqual({ icon: 'Play' })
    expect(ensureDefaultIcon({ iconImage: '/assets/a.png' })).toEqual({ iconImage: '/assets/a.png' })
    expect(ensureDefaultIcon({ emoji: '🔥' })).toEqual({ emoji: '🔥' })
    // icon vacío + emoji válido: manda el emoji.
    expect(ensureDefaultIcon({ icon: '', emoji: '🔥' })).toEqual({ icon: '', emoji: '🔥' })
  })

  it('trata el icon en blanco como ausente', () => {
    expect(ensureDefaultIcon({ icon: '   ' })).toEqual({ icon: DEFAULT_KEY_ICON })
  })

  it('no muta el objeto de entrada', () => {
    const src = { label: 'X' }
    const out = ensureDefaultIcon(src)
    expect(src).toEqual({ label: 'X' })
    expect(out).not.toBe(src)
    expect(out.icon).toBe(DEFAULT_KEY_ICON)
  })

  it('tolera entradas no-objeto', () => {
    expect(ensureDefaultIcon(null as any)).toEqual({ icon: DEFAULT_KEY_ICON })
    expect(ensureDefaultIcon(undefined as any)).toEqual({ icon: DEFAULT_KEY_ICON })
  })
})
