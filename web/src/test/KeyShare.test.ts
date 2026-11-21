import { describe, it, expect } from 'vitest'
import { cleanKey, parseSharedDoc } from '../composables/useKeyShare'

describe('useKeyShare', () => {
  it('cleanKey recorta longitudes y fija valores', () => {
    const cleaned = cleanKey({
      label: 'x'.repeat(100),
      icon: 'y'.repeat(100),
      textColor: '#e8b04e',
      backgroundColor: '#123456',
      mode: 'nonsense',
      longPress: 'folder',
      confirm: true,
      actions: Array.from({ length: 50 }, (_, i) => ({
        id: `${i}`,
        type: 'shell',
        parameters: { command: 'z'.repeat(600) },
        waitMs: 999999
      }))
    })
    expect(cleaned.label.length).toBeLessThanOrEqual(40)
    expect(cleaned.icon.length).toBeLessThanOrEqual(48)
    expect(cleaned.mode).toBe('seq')
    expect(cleaned.actions).toHaveLength(32)
    expect(cleaned.actions[0].waitMs).toBeLessThanOrEqual(10000)
    expect(String(cleaned.actions[0].parameters?.command).length).toBeLessThanOrEqual(500)
  })

  it('parseSharedDoc rechaza lo que no es una tecla', () => {
    expect(parseSharedDoc('no json').error).toBe('notValidJson')
    expect(parseSharedDoc(JSON.stringify({ foo: 1 })).error).toBe('invalidKeyCode')
    const ok = parseSharedDoc(JSON.stringify({ libredeck: 1, type: 'key', key: { actions: [] } }))
    expect(ok.doc?.key.actions).toEqual([])
  })

  it('conserva reglas, looks y variables', () => {
    const doc = {
      libredeck: 1,
      type: 'key',
      key: {
        label: 'Micro',
        actions: [{ id: 'a', type: 'local.toggle-var', parameters: { name: 'micSilenciado' }, waitMs: 0 }],
        rules: [{ id: 'r', on: true, when: 'long', every: 5, vn: '', cond: 'contador > 3', then: [], else: [] }],
        looks: [{ cond: 'micSilenciado', t: 'Off', i: 'mic-off', c: 4, bg: 1 }]
      },
      pages: [],
      plugins: [],
      vars: [{ n: 'contador', t: 'num', v: 2 }, { n: 'mala variable', t: 'num', v: 1 }]
    }
    const r = parseSharedDoc(JSON.stringify(doc))
    expect(r.doc?.key.rules).toHaveLength(1)
    expect(r.doc?.key.rules?.[0].when).toBe('long')
    expect(r.doc?.key.looks).toHaveLength(1)
    expect(r.doc?.vars).toEqual([{ n: 'contador', t: 'num', v: 2 }])
  })

  it('recorta reglas y condiciones largas', () => {
    const long = 'x'.repeat(500)
    const doc = {
      libredeck: 1,
      type: 'key',
      key: { actions: [], rules: [{ when: 'press', cond: long, then: [], else: [] }], looks: [] },
      pages: [],
      plugins: [],
      vars: []
    }
    const r = parseSharedDoc(JSON.stringify(doc))
    expect(String(r.doc?.key.rules?.[0].cond).length).toBeLessThanOrEqual(300)
  })
})
