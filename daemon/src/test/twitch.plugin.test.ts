/**
 * twitch.plugin.test.ts — tests del plugin nativo Twitch.
 * Sin credenciales reales: errores amigables + un camino feliz con fetch simulado.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { TwitchPlugin } from '../plugins/twitch.plugin'

const noopCtx = { log: (_l: string, _m: string, _meta?: any) => {} }
const plugin = new TwitchPlugin(noopCtx as any)

const realFetch = globalThis.fetch
afterEach(() => {
    globalThis.fetch = realFetch
})

describe('TwitchPlugin manifest', () => {
    it('expone un manifest válido en español', () => {
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('twitch')
        expect(manifest.version).toBe('1.1.0')
        expect(manifest.settingsSchema).toBeDefined()
        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(['ad-break', 'chat-message', 'create-clip', 'create-marker', 'set-category', 'set-title', 'viewer-count'])
    })
})

describe('TwitchPlugin sin credenciales', () => {
    it('set-title exige title', async () => {
        const handler = plugin.getActionHandlers().get('set-title')!
        await expect(handler({}, {})).rejects.toThrow(/title/)
    })

    it('set-title con título pero sin credenciales pide configuración', async () => {
        const handler = plugin.getActionHandlers().get('set-title')!
        await expect(handler({ title: 'Hola' }, {})).rejects.toThrow(/Client ID|configuración/)
    })

    it('viewer-count sin credenciales pide configuración', async () => {
        const handler = plugin.getActionHandlers().get('viewer-count')!
        await expect(handler({}, {})).rejects.toThrow(/Client ID|configuración/)
    })

    it('chat-message exige message', async () => {
        const handler = plugin.getActionHandlers().get('chat-message')!
        await expect(handler({}, {})).rejects.toThrow(/message/)
    })

    it('set-category exige gameName o gameId', async () => {
        const handler = plugin.getActionHandlers().get('set-category')!
        await expect(handler({ clientId: 'c', token: 't', broadcaster: '123' }, {})).rejects.toThrow(/gameName|gameId/)
    })
})

describe('TwitchPlugin con fetch simulado', () => {
    it('viewer-count devuelve espectadores y live', async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ data: [{ viewer_count: 7, title: 'Directo', game_name: 'Juego' }] }), { status: 200 })) as typeof fetch
        const handler = plugin.getActionHandlers().get('viewer-count')!
        const res = await handler({ clientId: 'c', token: 't', broadcaster: '12345' }, {})
        expect(res.live).toBe(true)
        expect(res.viewerCount).toBe(7)
        expect(res.broadcasterId).toBe('12345')
    })

    it('401 produce error amigable de token', async () => {
        globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
        const handler = plugin.getActionHandlers().get('viewer-count')!
        await expect(handler({ clientId: 'c', token: 'malo', broadcaster: '12345' }, {})).rejects.toThrow(/token|scopes/)
    })
})
