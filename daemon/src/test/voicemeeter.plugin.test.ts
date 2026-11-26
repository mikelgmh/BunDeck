/**
 * voicemeeter.plugin.test.ts — tests del plugin nativo VoiceMeeter.
 * Sin VoiceMeeter real: manifest y errores amigables (Windows / no instalado).
 */
import { describe, it, expect } from 'bun:test'
import { VoicemeeterPlugin } from '../plugins/voicemeeter.plugin'

const noopCtx = { log: (_l: string, _m: string, _meta?: any) => {} }
const plugin = new VoicemeeterPlugin(noopCtx as any)

describe('VoicemeeterPlugin manifest', () => {
    it('expone un manifest válido en español', () => {
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('voicemeeter')
        expect(manifest.version).toBe('1.0.1')
        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(['bus-mute', 'device-info', 'open-voicemeeter', 'strip-mute'])
    })
})

describe('VoicemeeterPlugin sin VoiceMeeter', () => {
    it('device-info falla con mensaje claro (solo Windows / no instalado)', async () => {
        const handler = plugin.getActionHandlers().get('device-info')!
        if (process.platform === 'win32') {
            // Sin VoiceMeeter instalado → error de instalación; con él → objeto.
            try {
                const res = await handler({}, {})
                expect(res.installed).toBe(true)
            } catch (err) {
                expect(String((err as Error).message)).toMatch(/no está instalado|vb-audio/i)
            }
        } else {
            await expect(handler({}, {})).rejects.toThrow(/solo existe en Windows/)
        }
    })

    it('strip-mute sin hotkey pide configurarlo o avisa de plataforma', async () => {
        const handler = plugin.getActionHandlers().get('strip-mute')!
        await expect(handler({}, {})).rejects.toThrow(/atajo|hotkey|Windows|instalado/)
    })

    it('bus-mute sin hotkey pide configurarlo o avisa de plataforma', async () => {
        const handler = plugin.getActionHandlers().get('bus-mute')!
        await expect(handler({}, {})).rejects.toThrow(/hotkey|atajo|Windows|instalado/)
    })
})
