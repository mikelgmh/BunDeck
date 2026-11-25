import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SHORTCUTS,
  comboFromEvent,
  findShortcutConflicts,
  formatShortcut,
  isValidShortcutCombo,
  loadShortcutsState,
  matchShortcutsEvent,
  matchesShortcutEvent,
  normalizeKey,
  parseDaemonShortcutsConfig,
  parseShortcut,
  saveShortcutsState,
  serializeDaemonShortcutsConfig,
  stepProfile,
  type MinimalStorage,
  type ShortcutMap,
} from './useShortcuts'

function mem(): MinimalStorage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
  }
}

describe('parseShortcut', () => {
  it('parsea modificadores + tecla', () => {
    expect(parseShortcut('Ctrl+Alt+P')).toEqual({ ctrl: true, alt: true, shift: false, meta: false, key: 'P' })
    expect(parseShortcut('ctrl+alt+arrowright')).toEqual({
      ctrl: true, alt: true, shift: false, meta: false, key: 'ArrowRight',
    })
  })

  it('rechaza combos sin modificador, vacíos o con varias teclas', () => {
    expect(parseShortcut('P')).toBeNull()
    expect(parseShortcut('')).toBeNull()
    expect(parseShortcut('Ctrl+P+M')).toBeNull()
    expect(parseShortcut('Ctrl+')).toBeNull()
  })

  it('acepta Meta/Cmd/Shift y F-keys', () => {
    expect(parseShortcut('Cmd+Shift+K')?.meta).toBe(true)
    expect(parseShortcut('Ctrl+F5')?.key).toBe('F5')
  })
})

describe('formatShortcut', () => {
  it('canoniza el orden de modificadores', () => {
    expect(formatShortcut({ ctrl: true, alt: true, shift: false, meta: false, key: 'P' })).toBe('Ctrl+Alt+P')
  })
})

describe('normalizeKey', () => {
  it('mayúsculas para letras y alias de especiales', () => {
    expect(normalizeKey('p')).toBe('P')
    expect(normalizeKey('arrowleft')).toBe('ArrowLeft')
    expect(normalizeKey('esc')).toBe('Escape')
  })
})

describe('matchesShortcutEvent', () => {
  it('exige modificadores exactos', () => {
    const ev = { key: 'p', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }
    expect(matchesShortcutEvent(ev, 'Ctrl+Alt+P')).toBe(true)
    expect(matchesShortcutEvent({ ...ev, shiftKey: true }, 'Ctrl+Alt+P')).toBe(false)
    expect(matchesShortcutEvent({ ...ev, ctrlKey: false }, 'Ctrl+Alt+P')).toBe(false)
  })

  it('matchShortcutsEvent respeta enabled', () => {
    const map: ShortcutMap = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS))
    const ev = { key: 'm', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }
    expect(matchShortcutsEvent(ev, map)).toBe('mute-all')
    map['mute-all'].enabled = false
    expect(matchShortcutsEvent(ev, map)).toBeNull()
  })
})

describe('findShortcutConflicts', () => {
  it('agrupa ids con el mismo combo normalizado', () => {
    const map: ShortcutMap = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS))
    map['mute-all'].combo = 'Ctrl+Alt+P'
    const conflicts = findShortcutConflicts(map)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].sort()).toEqual(['mute-all', 'toggle-panels'])
  })

  it('sin conflictos por defecto e ignora deshabilitados', () => {
    expect(findShortcutConflicts(DEFAULT_SHORTCUTS)).toEqual([])
    const map: ShortcutMap = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS))
    map['mute-all'].combo = map['toggle-panels'].combo
    map['mute-all'].enabled = false
    expect(findShortcutConflicts(map)).toEqual([])
  })
})

describe('comboFromEvent', () => {
  it('construye combo canónico y rechaza modificadores puros o sin modificador', () => {
    expect(comboFromEvent({ key: 'p', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBe('Ctrl+Alt+P')
    expect(comboFromEvent({ key: 'Control', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBeNull()
    expect(comboFromEvent({ key: 'p', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBeNull()
  })
})

describe('persistencia', () => {
  it('roundtrip localStorage + sanea combos inválidos', () => {
    const s = mem()
    const map = loadShortcutsState(s)
    expect(map['toggle-panels'].combo).toBe('Ctrl+Alt+P')
    map['mute-all'].combo = 'nope'
    map['next-profile'].enabled = false
    saveShortcutsState(map, s)
    const back = loadShortcutsState(s)
    // 'nope' no parsea: se conserva el valor por defecto saneado
    expect(back['mute-all'].combo).toBe(DEFAULT_SHORTCUTS['mute-all'].combo)
    expect(back['next-profile'].enabled).toBe(false)
  })

  it('serializa el formato del daemon (shortcuts.config)', () => {
    const s = serializeDaemonShortcutsConfig(DEFAULT_SHORTCUTS)
    const back = parseDaemonShortcutsConfig(s)
    expect(back?.['toggle-kiosk'].combo).toBe('Ctrl+Alt+K')
    expect(parseDaemonShortcutsConfig('{{{')).toBeNull()
  })
})

describe('stepProfile', () => {
  it('avanza/retrocede con wrap', () => {
    expect(stepProfile(['a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(stepProfile(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(stepProfile(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(stepProfile(['a'], 'a', 1)).toBe('a')
    expect(stepProfile([], null, 1)).toBeNull()
    expect(stepProfile(['a', 'b'], 'zzz', 1)).toBe('a')
  })
})

describe('isValidShortcutCombo', () => {
  it('valida formato', () => {
    expect(isValidShortcutCombo('Ctrl+Alt+M')).toBe(true)
    expect(isValidShortcutCombo('M')).toBe(false)
  })
})
