import { describe, it, expect } from 'vitest'
import { SIMPLE_ICON_LIST, isSimpleIconName, simpleIcon } from '../composables/useSimpleIcons'
import { dynamicIcon, clearDynamicIconCache } from '../composables/useDynamicIcon'

// Marcas Simple Icons (pestaña «Marcas» del selector): `si:<slug>`.
describe('useSimpleIcons (marcas)', () => {
  it('el catálogo trae las marcas clave con su slug', () => {
    const names = SIMPLE_ICON_LIST.map((m) => m.name)
    for (const expected of ['si:youtube', 'si:twitch', 'si:github', 'si:spotify', 'si:discord']) {
      expect(names).toContain(expected)
    }
    expect(SIMPLE_ICON_LIST.length).toBeGreaterThan(20)
  })

  it('cada marca tiene título y ruta SVG válida', () => {
    for (const m of SIMPLE_ICON_LIST) {
      expect(m.name).toMatch(/^si:[a-z0-9]+$/)
      expect(m.title.length).toBeGreaterThan(0)
      expect(m.path).toMatch(/^[Mm]/)
      expect(m.path.length).toBeGreaterThan(20)
    }
  })

  it('isSimpleIconName valida el formato y el catálogo', () => {
    expect(isSimpleIconName('si:youtube')).toBe(true)
    expect(isSimpleIconName('si:noexiste')).toBe(false)
    expect(isSimpleIconName('Youtube')).toBe(false)
    expect(isSimpleIconName('')).toBe(false)
    expect(isSimpleIconName(null)).toBe(false)
  })

  it('simpleIcon devuelve componente para marcas y null para el resto', () => {
    expect(simpleIcon('si:twitch')).toBeTruthy()
    expect(simpleIcon('si:twitch')).toBe(simpleIcon('si:twitch'))
    expect(simpleIcon('Twitch')).toBe(null)
    expect(simpleIcon('si:noexiste')).toBe(null)
  })
})

describe('dynamicIcon con marcas', () => {
  it('resuelve `si:<slug>` además de Lucide', () => {
    clearDynamicIconCache()
    expect(dynamicIcon('si:youtube')).toBeTruthy()
    expect(dynamicIcon('Play')).toBeTruthy()
    expect(dynamicIcon('Youtube')).toBeTruthy()
    expect(dynamicIcon('no existe!')).toBe(null)
  })
})
