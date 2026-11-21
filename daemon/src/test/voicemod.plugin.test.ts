/**
 * voicemod.plugin.test.ts — tests del plugin nativo Voicemod.
 * Sin Voicemod real: manifest, validación y error amigable contra puerto cerrado.
 */
import { describe, it, expect } from 'bun:test'
import { createServer } from 'node:net'
import { VoicemodPlugin } from '../plugins/voicemod.plugin'

const noopCtx = { log: (_l: string, _m: string, _meta?: any) => {} }
const plugin = new VoicemodPlugin(noopCtx as any)

async function closedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address()
            const port = typeof addr === 'object' && addr !== null ? addr.port : 0
            server.close((err?: Error) => (err ? reject(err) : resolve(port)))
        })
    })
}

describe('VoicemodPlugin manifest', () => {
    it('expone un manifest válido en español', () => {
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('voicemod')
        expect(manifest.version).toBe('1.0.0')
        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(['get-status', 'mute', 'set-voice', 'toggle-effect'])
    })
})

describe('VoicemodPlugin sin Voicemod', () => {
    it('set-voice exige voiceId', async () => {
        const handler = plugin.getActionHandlers().get('set-voice')!
        await expect(handler({}, {})).rejects.toThrow(/voiceId/)
    })

    it('get-status contra puerto cerrado da error amigable', async () => {
        const port = await closedPort()
        const handler = plugin.getActionHandlers().get('get-status')!
        await expect(handler({ host: '127.0.0.1', port }, {})).rejects.toThrow(/Voicemod/)
    }, 15000)
})
