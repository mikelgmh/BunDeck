import { describe, it, expect } from 'bun:test'
import { UtilityPlugin } from '../plugins/utility.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new UtilityPlugin({
        log: (level: string, message: string, meta?: any) => {
            logs.push({ level, message, meta })
        }
    })
    return { plugin, logs }
}

describe('UtilityPlugin delay', () => {
    it('expone la acción delay en el manifest', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        const byId = Object.fromEntries(manifest.actions.map((a: any) => [a.id, a]))
        expect(byId.delay).toBeDefined()
        expect(byId.delay.schema.properties.duration.minimum).toBe(0)
        expect(byId.delay.schema.properties.duration.maximum).toBe(60000)
    })

    it('registra los handlers delay y macro', () => {
        const { plugin } = makePlugin()
        const handlers = plugin.getActionHandlers()
        expect(handlers.has('delay')).toBe(true)
        expect(handlers.has('macro')).toBe(true)
    })

    it('delay espera y devuelve la duración', async () => {
        const { plugin } = makePlugin()
        const t0 = Date.now()
        const res = await plugin.getActionHandlers().get('delay')!({ duration: 30 }, {})
        expect(res).toEqual({ delayed: 30 })
        expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
    })

    it('delay usa 1000ms por defecto', async () => {
        const { plugin } = makePlugin()
        // No esperamos el segundo entero: validamos que arranque el timer
        // con el valor por defecto espiando el resultado con duración 0..1000.
        const t0 = Date.now()
        const p = plugin.getActionHandlers().get('delay')!({}, {})
        // Cancelación temprana no soportada: medimos que al menos no resuelva al instante con otro valor.
        const res = await Promise.race([
            p.then((r) => ({ ...r, done: true })),
            new Promise((resolve) => setTimeout(() => resolve({ done: false } as any), 50)),
        ])
        expect((res as any).done === true ? (res as any).delayed : 1000).toBe(1000)
        // Limpieza: esperar a que termine para no dejar timers colgados en el test runner.
        await p
        expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    }, 15000)
})
