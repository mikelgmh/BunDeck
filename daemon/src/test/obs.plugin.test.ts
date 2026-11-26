/**
 * obs.plugin.test.ts — tests for the native OBS Studio plugin.
 * No real OBS connection is attempted: failure paths target a closed
 * localhost port with a short timeoutMs, so they fail fast and legibly.
 */
import { describe, it, expect } from 'bun:test'
import { createServer } from 'node:net'
import { ObsPlugin } from '../plugins/obs.plugin'

const context = { log: (_level: string, _message: string, _meta?: any) => {} }
const plugin = new ObsPlugin(context)

const EXPECTED_ACTIONS = ['filter-toggle', 'mute', 'record', 'replay', 'scene', 'scene-list', 'screenshot', 'source', 'status', 'stream', 'studio-mode', 'transition']

/** Returns a localhost port that is guaranteed closed (bound then released). */
async function closedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address()
            const port = typeof addr === 'object' && addr !== null ? addr.port : 0
            server.close((err?: Error) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(port)
                }
            })
        })
    })
}

describe('ObsPlugin manifest', () => {
    it('expone un manifest válido con las 12 acciones', () => {
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('obs')
        expect(manifest.name).toBe('OBS Studio')
        expect(manifest.version).toBe('1.2.1')
        expect(manifest.author).toBe('BunDeck')
        expect(manifest.permissions).toContain('network')
        expect(manifest.actions).toHaveLength(12)

        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(EXPECTED_ACTIONS)

        for (const action of manifest.actions) {
            expect(action.schema?.type).toBe('object')
            expect(action.schema?.properties).toBeDefined()
            expect(Array.isArray(action.schema?.required)).toBe(true)
            for (const [key, prop] of Object.entries<any>(action.schema.properties)) {
                expect(prop.title, `${action.id}.${key} debe tener title en español`).toBeDefined()
                expect(prop.ui, `${action.id}.${key} debe tener hint ui`).toBeDefined()
            }
        }
    })

    it('declara los required documentados', () => {
        const byId = Object.fromEntries(plugin.getManifest().actions.map((a: any) => [a.id, a]))
        expect(byId.scene.schema.required).toEqual(['scene'])
        expect(byId.source.schema.required).toEqual(['source'])
        expect(byId.mute.schema.required).toEqual(['source'])
        expect(byId.stream.schema.required).toEqual(['action'])
        expect(byId.record.schema.required).toEqual(['action'])
        expect(byId['filter-toggle'].schema.required).toEqual(['source', 'filter'])
        expect(Array.isArray(byId.replay.schema.required)).toBe(true)
        expect(Array.isArray(byId['studio-mode'].schema.required)).toBe(true)
        expect(Array.isArray(byId.transition.schema.required)).toBe(true)
        expect(Array.isArray(byId.screenshot.schema.required)).toBe(true)
        expect(Array.isArray(byId['scene-list'].schema.required)).toBe(true)
    })

    it('getActionHandlers devuelve las 12 claves', () => {
        const handlers = plugin.getActionHandlers()
        expect([...handlers.keys()].sort()).toEqual(EXPECTED_ACTIONS)
        for (const key of EXPECTED_ACTIONS) {
            expect(typeof handlers.get(key)).toBe('function')
        }
    })
})

describe('ObsPlugin validación de parámetros (sin conexión)', () => {
    it('scene exige "scene"', async () => {
        const handler = plugin.getActionHandlers().get('scene')!
        await expect(handler({}, {})).rejects.toThrow(/scene/)
    })

    it('source exige "source"', async () => {
        const handler = plugin.getActionHandlers().get('source')!
        await expect(handler({}, {})).rejects.toThrow(/source/)
    })

    it('mute exige "source"', async () => {
        const handler = plugin.getActionHandlers().get('mute')!
        await expect(handler({}, {})).rejects.toThrow(/source/)
    })

    it('stream rechaza action inválida', async () => {
        const handler = plugin.getActionHandlers().get('stream')!
        await expect(handler({ action: 'bogus' }, {})).rejects.toThrow(/start.*stop.*toggle|action/)
    })

    it('record rechaza action inválida', async () => {
        const handler = plugin.getActionHandlers().get('record')!
        await expect(handler({ action: 'bogus' }, {})).rejects.toThrow(/start.*stop.*toggle|action/)
    })

    it('studio-mode rechaza enabled no booleano', async () => {
        const handler = plugin.getActionHandlers().get('studio-mode')!
        await expect(handler({ enabled: 'yes' }, {})).rejects.toThrow(/enabled/)
    })

    it('filter-toggle exige source y filter', async () => {
        const handler = plugin.getActionHandlers().get('filter-toggle')!
        await expect(handler({}, {})).rejects.toThrow(/source/)
        await expect(handler({ source: 'Mic' }, {})).rejects.toThrow(/filter/)
    })

    it('transition exige al menos un parámetro', async () => {
        const handler = plugin.getActionHandlers().get('transition')!
        await expect(handler({}, {})).rejects.toThrow(/transitionName|durationMs/)
    })

    it('screenshot rechaza formato inválido', async () => {
        const handler = plugin.getActionHandlers().get('screenshot')!
        await expect(handler({ imageFormat: 'bmp' }, {})).rejects.toThrow(/png.*jpg|imageFormat/)
    })
})

describe('ObsPlugin sin OBS disponible', () => {
    it('los 11 handlers fallan con error legible en vez de colgarse', async () => {
        const port = await closedPort()
        const handlers = plugin.getActionHandlers()
        const base = { host: '127.0.0.1', port, timeoutMs: 1500 }
        const calls: Array<[string, any]> = [
            ['scene', { ...base, scene: 'Escena' }],
            ['source', { ...base, source: 'Fuente' }],
            ['stream', { ...base, action: 'toggle' }],
            ['record', { ...base, action: 'toggle' }],
            ['replay', { ...base }],
            ['mute', { ...base, source: 'Micrófono' }],
            ['studio-mode', { ...base, enabled: true }],
            ['filter-toggle', { ...base, source: 'Micrófono', filter: 'Ruido' }],
            ['transition', { ...base, durationMs: 300 }],
            ['screenshot', { ...base }],
            ['scene-list', { ...base }]
        ]

        const started = Date.now()
        for (const [key, params] of calls) {
            let error: unknown
            try {
                await handlers.get(key)!(params, {})
            } catch (err) {
                error = err
            }
            expect(error, `${key} debería fallar sin OBS disponible`).toBeDefined()
            expect(String((error as Error)?.message), `${key} debe mencionar OBS`).toMatch(/OBS/)
        }
        // 11 llamadas con timeoutMs=1500: muy por debajo del límite si no hay cuelgues.
        expect(Date.now() - started).toBeLessThan(30000)
    }, 40000)
})
