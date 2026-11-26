/**
 * shadowplay.plugin.test.ts — tests del plugin nativo ShadowPlay.
 * Sin NVIDIA real: manifest y comportamiento por plataforma.
 */
import { describe, it, expect } from 'bun:test'
import { ShadowplayPlugin } from '../plugins/shadowplay.plugin'

const noopCtx = { log: (_l: string, _m: string, _meta?: any) => {} }
const plugin = new ShadowplayPlugin(noopCtx as any)

describe('ShadowplayPlugin manifest', () => {
    it('expone un manifest válido en español', () => {
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('shadowplay')
        expect(manifest.version).toBe('1.0.1')
        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(['check-status', 'instant-replay-save', 'toggle-overlay', 'toggle-record'])
    })
})

describe('ShadowplayPlugin por plataforma', () => {
    it('check-status responde según plataforma', async () => {
        const handler = plugin.getActionHandlers().get('check-status')!
        if (process.platform === 'win32') {
            const res = await handler({}, {})
            expect(res.action).toBe('check-status')
            expect(typeof res.running).toBe('boolean')
            expect(typeof res.note).toBe('string')
        } else {
            await expect(handler({}, {})).rejects.toThrow(/solo existe en Windows/)
        }
    })

    it('instant-replay-save fuera de Windows lo dice claro', async () => {
        if (process.platform !== 'win32') {
            const handler = plugin.getActionHandlers().get('instant-replay-save')!
            await expect(handler({}, {})).rejects.toThrow(/solo existe en Windows/)
        }
    })
})
