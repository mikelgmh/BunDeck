import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createKeyEngine } from '../composables/useKeyEngine'
import { TAP_WINDOW_MS } from '../composables/usePressActions'

const act = (type: string) => ({ id: `a-${type}`, type, parameters: {} })

function makeEngine(dataByPos: Record<number, any>) {
  const remote: any[] = []
  const toasts: string[] = []
  const engine = createKeyEngine({
    getButton: (pos: number) => (dataByPos[pos] ? { id: `b${pos}` } : undefined) as any,
    getExecData: (pos: number) => dataByPos[pos] ?? null,
    execRemote: async (action: any) => {
      remote.push(action.type)
    },
    toast: (msg: string) => {
      toasts.push(msg)
    },
    noActionsToast: () => {
      toasts.push('__empty__')
    },
    profileName: () => 'P',
    pageName: () => 'Pg',
    pageId: () => 'pg',
    executing: { value: [] },
  })
  return { engine, remote, toasts }
}

describe('useKeyEngine multi-tap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sin double/triple: el click se ejecuta al instante (sin latencia)', async () => {
    const { engine, remote } = makeEngine({
      0: { actions: [act('shell')], mode: 'seq', rules: [] },
    })
    engine.tapKey(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(remote).toEqual(['shell'])
  })

  it('click → double: el simple espera la ventana y solo se ejecuta el double', async () => {
    const { engine, remote } = makeEngine({
      0: {
        actions: [act('shell')],
        pressActions: { double: [act('web')] },
        mode: 'seq',
        rules: [],
      },
    })
    engine.tapKey(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(remote).toEqual([]) // debounce: aún no se ejecuta
    engine.tapKey(0)
    await vi.advanceTimersByTimeAsync(TAP_WINDOW_MS + 50)
    expect(remote).toEqual(['web'])
  })

  it('triple toque ejecuta la lista triple', async () => {
    const { engine, remote } = makeEngine({
      0: {
        actions: [act('shell')],
        pressActions: { double: [act('web')], triple: [act('key')] },
        mode: 'seq',
        rules: [],
      },
    })
    engine.tapKey(0)
    engine.tapKey(0)
    engine.tapKey(0)
    await vi.advanceTimersByTimeAsync(TAP_WINDOW_MS + 50)
    expect(remote).toEqual(['key'])
  })

  it('sin lista double pero con regla double: también hay debounce', async () => {
    const { engine, remote } = makeEngine({
      0: {
        actions: [act('shell')],
        rules: [{ id: 'r1', on: true, when: 'double', cond: '', then: [act('web')], else: [] }],
      },
    })
    engine.tapKey(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(remote).toEqual([])
    engine.tapKey(0)
    await vi.advanceTimersByTimeAsync(TAP_WINDOW_MS + 50)
    expect(remote).toEqual(['web'])
  })

  it('el long consume el tap pendiente (no cae un click después)', async () => {
    const { engine, remote } = makeEngine({
      0: {
        actions: [act('shell')],
        pressActions: { double: [act('web')], long: [act('key')] },
        mode: 'seq',
        rules: [],
      },
    })
    engine.tapKey(0)
    expect(engine.pendingTaps(0)).toBe(1)
    await engine.execKey(0, 'long')
    await vi.advanceTimersByTimeAsync(TAP_WINDOW_MS + 100)
    expect(remote).toEqual(['key'])
  })

  it('doble sin acciones double cae a clicks normales (sin penalizar)', async () => {
    const { engine, remote } = makeEngine({
      0: { actions: [act('shell')], mode: 'seq', rules: [] },
    })
    engine.tapKey(0)
    await vi.advanceTimersByTimeAsync(0)
    engine.tapKey(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(remote).toEqual(['shell', 'shell'])
  })

  it('long ejecuta su lista + reglas long y no toca el click', async () => {
    const { engine, remote } = makeEngine({
      0: {
        actions: [act('shell')],
        pressActions: { long: [act('key')] },
        mode: 'seq',
        rules: [{ id: 'r1', on: true, when: 'long', cond: '', then: [act('web')], else: [] }],
      },
    })
    await engine.execKey(0, 'long')
    expect(remote).toEqual(['key', 'web'])
  })

  it('reglas double se ejecutan tras la lista double', async () => {
    const { engine, remote } = makeEngine({
      0: {
        actions: [],
        pressActions: { double: [act('shell')] },
        mode: 'seq',
        rules: [{ id: 'r1', on: true, when: 'double', cond: '', then: [act('web')], else: [] }],
      },
    })
    await engine.execKey(0, 'double')
    expect(remote).toEqual(['shell', 'web'])
  })
})
