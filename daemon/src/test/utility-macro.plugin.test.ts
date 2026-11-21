import { describe, test, expect } from 'bun:test'
import { UtilityPlugin } from '../plugins/utility.plugin'

function makePlugin(executor?: (action: any, context: any) => Promise<any>) {
    const logs: Array<{ level: string; message: string }> = []
    const plugin = new UtilityPlugin({
        log: (level: string, message: string) => {
            logs.push({ level, message })
        }
    })
    if (executor) {
        plugin.setActionExecutor(executor)
    }
    return { plugin, logs }
}

describe('UtilityPlugin macro', () => {
    test('manifest expone delay y macro', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        const ids = manifest.actions.map((a: any) => a.id)
        expect(ids).toContain('delay')
        expect(ids).toContain('macro')

        const macro = manifest.actions.find((a: any) => a.id === 'macro')
        expect(macro.schema.type).toBe('object')
        expect(macro.schema.required).toContain('steps')
        expect(macro.schema.properties.steps.type).toBe('array')
        expect(macro.schema.properties.steps.minItems).toBe(1)
        expect(macro.schema.properties.steps.maxItems).toBe(50)

        const handlers = plugin.getActionHandlers()
        expect(handlers.has('delay')).toBe(true)
        expect(handlers.has('macro')).toBe(true)
    })

    test('ejecuta pasos en secuencia con parámetros y contexto derivado', async () => {
        const calls: Array<{ action: any; context: any }> = []
        const { plugin } = makePlugin(async (action, context) => {
            calls.push({ action, context })
            return { success: true, result: { ok: action.type }, duration: 1 }
        })

        const handlers = plugin.getActionHandlers()
        const macro = handlers.get('macro')!
        const ctx = { buttonId: 'b1', pageId: 'p1', profileId: 'pr1', timestamp: 1000 }
        const out = await macro(
            {
                steps: [
                    { type: 'utility.delay', parameters: { duration: 5 } },
                    { type: 'multimedia.multimedia', parameters: { action: 'play' } }
                ]
            },
            ctx
        )

        expect(out.total).toBe(2)
        expect(out.completed).toBe(2)
        expect(out.failedStep).toBeNull()
        expect(out.results).toHaveLength(2)
        expect(calls).toHaveLength(2)
        expect(calls[0].action).toMatchObject({ type: 'utility.delay', parameters: { duration: 5 } })
        expect(calls[1].action).toMatchObject({ type: 'multimedia.multimedia', parameters: { action: 'play' } })
        // Contexto derivado: mismos ids, timestamp nuevo
        for (const c of calls) {
            expect(c.context.buttonId).toBe('b1')
            expect(c.context.pageId).toBe('p1')
            expect(c.context.profileId).toBe('pr1')
            expect(typeof c.context.timestamp).toBe('number')
            expect(c.context.timestamp).toBeGreaterThanOrEqual(ctx.timestamp)
        }
    })

    test('stopOnError=true aborta al primer fallo', async () => {
        const calls: string[] = []
        const { plugin } = makePlugin(async (action) => {
            calls.push(action.type)
            if (action.type === 'b.fail') {
                return { success: false, error: 'boom', duration: 1 }
            }
            return { success: true, result: {}, duration: 1 }
        })

        const macro = plugin.getActionHandlers().get('macro')!
        const out = await macro(
            {
                steps: [{ type: 'a.ok' }, { type: 'b.fail' }, { type: 'c.ok' }],
                stopOnError: true
            },
            { timestamp: Date.now() }
        )

        expect(calls).toEqual(['a.ok', 'b.fail'])
        expect(out.completed).toBe(1)
        expect(out.total).toBe(3)
        expect(out.failedStep).toBe(1)
        expect(out.results).toHaveLength(2)
        expect(out.results[1].success).toBe(false)
    })

    test('stopOnError=false continúa y reporta todos', async () => {
        const calls: string[] = []
        const { plugin } = makePlugin(async (action) => {
            calls.push(action.type)
            if (action.type === 'b.fail') {
                throw new Error('boom')
            }
            return { success: true, result: {}, duration: 1 }
        })

        const macro = plugin.getActionHandlers().get('macro')!
        const out = await macro(
            {
                steps: [{ type: 'a.ok' }, { type: 'b.fail' }, { type: 'c.ok' }],
                stopOnError: false
            },
            { timestamp: Date.now() }
        )

        expect(calls).toEqual(['a.ok', 'b.fail', 'c.ok'])
        expect(out.completed).toBe(2)
        expect(out.total).toBe(3)
        expect(out.failedStep).toBe(1)
        expect(out.results).toHaveLength(3)
        expect(out.results[1]).toMatchObject({ success: false, error: 'boom' })
    })

    test('macro anidada rechazada sin llamar al executor', async () => {
        let called = 0
        const { plugin } = makePlugin(async () => {
            called++
            return { success: true, result: {}, duration: 1 }
        })

        const macro = plugin.getActionHandlers().get('macro')!
        const out = await macro(
            { steps: [{ type: 'utility.macro', parameters: { steps: [] } }] },
            { timestamp: Date.now() }
        )

        expect(called).toBe(0)
        expect(out.completed).toBe(0)
        expect(out.failedStep).toBe(0)
        expect(out.results[0].success).toBe(false)
        expect(out.results[0].error).toMatch(/anidad/i)
    })

    test('sin executor falla con error claro', async () => {
        const { plugin } = makePlugin()
        const macro = plugin.getActionHandlers().get('macro')!
        await expect(
            macro({ steps: [{ type: 'utility.delay' }] }, { timestamp: Date.now() })
        ).rejects.toThrow(/macro requiere executor/)
    })

    test('delay sigue funcionando', async () => {
        const { plugin } = makePlugin()
        const delay = plugin.getActionHandlers().get('delay')!
        const out = await delay({ duration: 5 }, {})
        expect(out).toEqual({ delayed: 5 })
    })
})
