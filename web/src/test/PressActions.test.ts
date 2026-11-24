import { describe, it, expect } from 'vitest'
import {
  normalizePressActions,
  getActionsForKind,
  setActionsForKind,
  ensurePressMirror,
  hasMultiTapContent,
  hasLongContent,
  hasKindContent,
} from '../composables/usePressActions'
import { cleanKey, parseSharedDoc } from '../composables/useKeyShare'

const a = (type: string) => ({ id: `x-${type}`, type, parameters: {}, waitMs: 0 })

describe('usePressActions', () => {
  it('migra actions[] legacy a click en lectura', () => {
    const n = normalizePressActions({ actions: [a('shell')] })
    expect(n.click.map((x: any) => x.type)).toEqual(['shell'])
    expect(n.double).toEqual([])
    expect(getActionsForKind({ actions: [a('shell')] }, 'click').length).toBe(1)
  })

  it('pressActions.click manda sobre actions[]', () => {
    const n = normalizePressActions({ actions: [a('shell')], pressActions: { click: [a('web')] } })
    expect(n.click.map((x: any) => x.type)).toEqual(['web'])
  })

  it('setActionsForKind escribe la lista y espeja click↔actions', () => {
    const next = setActionsForKind({ actions: [a('shell')] }, 'double', [a('web')])
    expect(next.pressActions.double.map((x: any) => x.type)).toEqual(['web'])
    // click intacto como espejo de actions
    expect(next.actions.map((x: any) => x.type)).toEqual(['shell'])
    const nextClick = setActionsForKind(next, 'click', [a('key')])
    expect(nextClick.actions.map((x: any) => x.type)).toEqual(['key'])
    expect(nextClick.pressActions.click.map((x: any) => x.type)).toEqual(['key'])
    expect(nextClick.pressActions.double.map((x: any) => x.type)).toEqual(['web'])
  })

  it('ensurePressMirror iguala actions y pressActions.click', () => {
    expect(ensurePressMirror({ actions: [a('shell')] }).pressActions.click.length).toBe(1)
    const m = ensurePressMirror({ actions: [], pressActions: { click: [a('web')] } })
    expect(m.actions.map((x: any) => x.type)).toEqual(['web'])
  })

  it('getActionsForKind click usa pressActions.click aunque falte el espejo actions[]', () => {
    // Teclas creadas fuera del editor (API/MCP/imports) pueden no traer el
    // espejo legacy: el click efectivo sigue siendo pressActions.click.
    const d = { actions: [], pressActions: { click: [a('web')], double: [], triple: [], long: [] } }
    expect(getActionsForKind(d, 'click').map((x: any) => x.type)).toEqual(['web'])
    expect(hasKindContent(d, 'click')).toBe(true)
    // Con espejo vacío en ambos, sigue sin contenido.
    expect(getActionsForKind({ actions: [] }, 'click')).toEqual([])
  })

  it('detecta contenido multi-tap y long (listas y reglas)', () => {
    expect(hasMultiTapContent({ actions: [] })).toBe(false)
    expect(hasMultiTapContent({ actions: [], pressActions: { double: [a('web')] } })).toBe(true)
    expect(
      hasMultiTapContent({ actions: [], rules: [{ on: true, when: 'triple', then: [], else: [] }] }),
    ).toBe(true)
    expect(hasLongContent({ actions: [], pressActions: { long: [a('web')] } })).toBe(true)
    expect(hasLongContent({ actions: [], rules: [{ on: true, when: 'long', then: [], else: [] }] })).toBe(true)
    expect(hasKindContent({ actions: [] }, 'double')).toBe(false)
  })
})

describe('KeyShare roundtrip con pressActions', () => {
  it('cleanKey conserva las 4 listas y parseSharedDoc las devuelve', () => {
    const key = cleanKey({
      label: 'T',
      actions: [a('shell')],
      pressActions: { click: [a('shell')], double: [a('web')], triple: [], long: [a('key')] },
      rules: [{ on: true, when: 'double', then: [a('web')], else: [] }],
    })
    expect(key.pressActions?.double?.map((x) => x.type)).toEqual(['web'])
    expect(key.pressActions?.long?.map((x) => x.type)).toEqual(['key'])
    // legacy espejo intacto
    expect(key.actions.map((x) => x.type)).toEqual(['shell'])

    const doc = {
      libredeck: 1,
      type: 'key',
      app: 'LibreDeck',
      key,
      pages: [],
      plugins: [],
      vars: [],
    }
    const { doc: parsed, error } = parseSharedDoc(JSON.stringify(doc))
    expect(error).toBeUndefined()
    expect(parsed?.key.pressActions?.double?.map((x) => x.type)).toEqual(['web'])
    expect(parsed?.key.pressActions?.long?.map((x) => x.type)).toEqual(['key'])
    expect(parsed?.key.actions.map((x) => x.type)).toEqual(['shell'])
    expect(parsed?.key.rules?.[0]?.when).toBe('double')
  })

  it('recarga legacy sin pressActions: click = actions', () => {
    const n = normalizePressActions({ actions: [a('shell')], rules: [] })
    expect(n.click.length).toBe(1)
    expect(n.long).toEqual([])
  })
})
