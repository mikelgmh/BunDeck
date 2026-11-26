/**
 * webcam.plugin.test.ts — tests del plugin nativo Webcam.
 * Solo lectura del sistema (listar cámaras); sin capturas reales.
 */
import { describe, it, expect } from 'bun:test'
import { WebcamPlugin } from '../plugins/webcam.plugin'

const noopCtx = { log: (_l: string, _m: string, _meta?: any) => {} }
const plugin = new WebcamPlugin(noopCtx as any)

describe('WebcamPlugin manifest', () => {
    it('expone un manifest válido en español', () => {
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('webcam')
        expect(manifest.version).toBe('1.0.1')
        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(['list-cameras', 'open-settings', 'snapshot'])
    })
})

describe('WebcamPlugin lectura del sistema', () => {
    it('list-cameras devuelve un array (vacío si no hay cámaras)', async () => {
        const handler = plugin.getActionHandlers().get('list-cameras')!
        const res = await handler({}, {})
        expect(res.action).toBe('list-cameras')
        expect(Array.isArray(res.cameras)).toBe(true)
        expect(typeof res.count).toBe('number')
    }, 30000)
})
