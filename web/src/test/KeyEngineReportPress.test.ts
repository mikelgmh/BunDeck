import { describe, it, expect, vi } from 'vitest'
import { createKeyEngine } from '../composables/useKeyEngine'

function makeEngine(dataByPos: Record<number, any>) {
  const remote: any[] = []
  const toasts: string[] = []
  const reported: any[] = []
  const engine = createKeyEngine({
    getButton: (pos: number) => (dataByPos[pos] ? { id: `b${pos}`, page_id: 'pg' } : undefined) as any,
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
    reportPress: (info: any) => {
      reported.push(info)
    },
  })
  return { engine, remote, toasts, reported }
}

describe('useKeyEngine reportPress (baliza local.*)', () => {
  it('local.toast se reporta con éxito y ctx canónico', async () => {
    const { engine, remote, reported } = makeEngine({
      0: { actions: [{ type: 'local.toast', parameters: { text: 'hola' } }], mode: 'seq', rules: [] },
    })
    await engine.execKey(0, 'press')
    expect(remote).toEqual([])
    expect(reported).toHaveLength(1)
    expect(reported[0].actionType).toBe('local.toast')
    expect(reported[0].success).toBe(true)
    // pressType canónico para el daemon (nunca 'press' legado).
    expect(reported[0].ctx.pressType).toBe('short')
    expect(reported[0].ctx.buttonId).toBe('b0')
  })

  it('la acción remota NO se reporta (la registra el daemon)', async () => {
    const { engine, remote, reported } = makeEngine({
      0: { actions: [{ type: 'flow.log', parameters: { message: 'x' } }], mode: 'seq', rules: [] },
    })
    await engine.execKey(0, 'press')
    expect(remote).toEqual(['flow.log'])
    expect(reported).toEqual([])
  })

  it('local con error se reporta con success:false', async () => {
    const { engine, reported, toasts } = makeEngine({
      0: { actions: [{ type: 'local.set-var', parameters: { name: '', expr: '1' } }], mode: 'seq', rules: [] },
    })
    await engine.execKey(0, 'press')
    expect(reported).toHaveLength(1)
    expect(reported[0].actionType).toBe('local.set-var')
    expect(reported[0].success).toBe(false)
    expect(typeof reported[0].error).toBe('string')
    expect(toasts.some((m) => m.startsWith('Error:'))).toBe(true)
  })

  it('sin reportPress no rompe (dep opcional)', async () => {
    const engine = createKeyEngine({
      getButton: () => ({ id: 'b0' }) as any,
      getExecData: () => ({ actions: [{ type: 'local.toast', parameters: { text: 'h' } }], mode: 'seq', rules: [] }),
      execRemote: async () => {},
      toast: () => {},
      noActionsToast: () => {},
      profileName: () => 'P',
      pageName: () => 'Pg',
      pageId: () => 'pg',
      executing: { value: [] },
    })
    await expect(engine.execKey(0, 'press')).resolves.toBeUndefined()
  })
})
