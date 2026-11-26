/**
 * youtube.plugin.test.ts — tests del plugin nativo YouTube.
 * Sin claves reales: errores amigables + un camino feliz con fetch simulado.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { YoutubePlugin } from '../plugins/youtube.plugin'

const noopCtx = { log: (_l: string, _m: string, _meta?: any) => {} }
const plugin = new YoutubePlugin(noopCtx as any)

const realFetch = globalThis.fetch
afterEach(() => {
    globalThis.fetch = realFetch
})

describe('YoutubePlugin manifest', () => {
    it('expone un manifest válido en español', () => {
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('youtube')
        expect(manifest.version).toBe('1.1.1')
        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(['open-dashboard', 'post-chat', 'start-broadcast', 'stop-broadcast', 'viewer-count'])
    })
})

describe('YoutubePlugin sin credenciales', () => {
    it('viewer-count sin api key pide crear una', async () => {
        const handler = plugin.getActionHandlers().get('viewer-count')!
        await expect(handler({ videoId: 'abc' }, {})).rejects.toThrow(/API key/)
    })

    it('viewer-count sin videoId lo pide', async () => {
        const handler = plugin.getActionHandlers().get('viewer-count')!
        await expect(handler({ apiKey: 'k' }, {})).rejects.toThrow(/ID del vídeo|videoId/)
    })

    it('post-chat sin message lo exige', async () => {
        const handler = plugin.getActionHandlers().get('post-chat')!
        await expect(handler({}, {})).rejects.toThrow(/message/)
    })

    it('post-chat sin token OAuth explica cómo conseguirlo', async () => {
        const handler = plugin.getActionHandlers().get('post-chat')!
        await expect(handler({ message: 'hola' }, {})).rejects.toThrow(/OAuth/)
    })
})

describe('YoutubePlugin con fetch simulado', () => {
    it('viewer-count devuelve espectadores y live', async () => {
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    items: [{
                        snippet: { title: 'Mi directo' },
                        liveStreamingDetails: { concurrentViewers: '42', activeLiveChatId: 'chat1' },
                        statistics: { likeCount: '5' },
                    }],
                }),
                { status: 200 }
            )) as typeof fetch
        const handler = plugin.getActionHandlers().get('viewer-count')!
        const res = await handler({ apiKey: 'k', videoId: 'vid123' }, {})
        expect(res.live).toBe(true)
        expect(res.viewerCount).toBe(42)
        expect(res.title).toBe('Mi directo')
    })

    it('viewer-count con vídeo inexistente lo dice claro', async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as typeof fetch
        const handler = plugin.getActionHandlers().get('viewer-count')!
        await expect(handler({ apiKey: 'k', videoId: 'noexiste' }, {})).rejects.toThrow(/No se encontró/)
    })
})
