import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { SpotifyPlugin } from '../plugins/spotify.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new SpotifyPlugin({
        log: (level: string, message: string, meta?: any) => {
            logs.push({ level, message, meta })
        }
    })
    return { plugin, logs }
}

type RecordedCall = { url: string; method: string; headers: any; body: any }

function jsonResponse(status: number, body: any = null): Response {
    if (status === 204) return new Response(null, { status: 204 })
    return new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    })
}

const realFetch = globalThis.fetch

function stubFetch(handler: (call: RecordedCall) => Response | Promise<Response>) {
    const calls: RecordedCall[] = []
    globalThis.fetch = (async (url: any, init: any = {}) => {
        const call: RecordedCall = {
            url: String(url),
            method: init?.method ?? 'GET',
            headers: init?.headers ?? {},
            body: init?.body
        }
        calls.push(call)
        return handler(call)
    }) as typeof fetch
    return calls
}

afterEach(() => {
    globalThis.fetch = realFetch
})

describe('SpotifyPlugin', () => {
    it('expone un manifest válido con 4 acciones', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()

        expect(manifest.id).toBe('spotify')
        expect(manifest.name).toBe('Spotify')
        expect(manifest.version).toBe('1.2.1')
        expect(manifest.author).toBe('BunDeck')
        expect(manifest.permissions).toContain('http')
        expect(manifest.permissions).toContain('network')
        expect(manifest.actions).toHaveLength(5)
        expect(manifest.actions.map((a: any) => a.id).sort()).toEqual(
            ['like', 'now-playing', 'playback', 'playlist', 'shuffle'].sort()
        )

        // Todos los schemas son JSON válidos con hints ui. El token vive en
        // los ajustes del plugin (⋯) con fallback: las acciones no lo exigen.
        const byId = Object.fromEntries(manifest.actions.map((a: any) => [a.id, a]))
        expect(byId.playback.schema.required).toEqual(['action'])
        expect(byId.like.schema.required).toEqual([])
        expect(byId.shuffle.schema.required).toEqual(['state'])
        expect(byId.playlist.schema.required).toEqual([])
        for (const action of manifest.actions) {
            expect(action.schema.type).toBe('object')
            expect(Array.isArray(action.schema.required)).toBe(true)
            expect(action.schema.required).not.toContain('token')
            for (const prop of Object.values<any>(action.schema.properties)) {
                expect(prop.title).toBeString()
                expect(prop.ui).toBeDefined()
            }
            // JSON válido: serializa y parsea sin perder nada
            expect(JSON.parse(JSON.stringify(action.schema))).toEqual(action.schema)
        }

        // Ajustes generales: token requerido + instrucciones
        expect(manifest.settingsSchema.required).toEqual(['token'])
        expect(typeof manifest.instructions).toBe('string')
    })

    it('registra los 5 handlers', () => {
        const { plugin } = makePlugin()
        const handlers = plugin.getActionHandlers()
        expect(handlers.has('playback')).toBe(true)
        expect(handlers.has('like')).toBe(true)
        expect(handlers.has('shuffle')).toBe(true)
        expect(handlers.has('playlist')).toBe(true)
        expect(handlers.has('now-playing')).toBe(true)
    })

    it('playback play llama a PUT /me/player/play con el token', async () => {
        const { plugin } = makePlugin()
        const calls = stubFetch(() => jsonResponse(204))
        const handlers = plugin.getActionHandlers()

        const result = await handlers.get('playback')!({ token: 'tok123', action: 'play' }, {})

        expect(result).toMatchObject({ action: 'play', executed: true, status: 204 })
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/play')
        expect(calls[0].method).toBe('PUT')
        expect(calls[0].headers.Authorization).toBe('Bearer tok123')
    })

    it('playback next/previous usan POST y propagan deviceId', async () => {
        const { plugin } = makePlugin()
        const calls = stubFetch(() => jsonResponse(204))
        const handlers = plugin.getActionHandlers()

        await handlers.get('playback')!({ token: 't', action: 'next' }, {})
        expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/next')
        expect(calls[0].method).toBe('POST')

        calls.length = 0
        await handlers.get('playback')!({ token: 't', action: 'previous', deviceId: 'dev1' }, {})
        expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/previous?device_id=dev1')
        expect(calls[0].method).toBe('POST')

        calls.length = 0
        await handlers.get('playback')!({ token: 't', action: 'pause', deviceId: 'dev1' }, {})
        expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/pause?device_id=dev1')
        expect(calls[0].method).toBe('PUT')
    })

    it('like con trackId llama a PUT /me/library y devuelve el id', async () => {
        const { plugin } = makePlugin()
        const calls = stubFetch(() => jsonResponse(200, {}))
        const handlers = plugin.getActionHandlers()

        const result = await handlers.get('like')!({ token: 't', trackId: 'trackABC' }, {})

        expect(result).toMatchObject({ trackId: 'trackABC', saved: true })
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://api.spotify.com/v1/me/library?ids=trackABC')
        expect(calls[0].method).toBe('PUT')
    })

    it('like sin trackId usa la pista actual', async () => {
        const { plugin } = makePlugin()
        const calls = stubFetch((call) => {
            if (call.url.includes('currently-playing')) {
                return jsonResponse(200, { item: { id: 'nowPlaying1' } })
            }
            return jsonResponse(200, {})
        })
        const handlers = plugin.getActionHandlers()

        const result = await handlers.get('like')!({ token: 't' }, {})

        expect(result).toMatchObject({ trackId: 'nowPlaying1', saved: true })
        expect(calls).toHaveLength(2)
        expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/currently-playing')
        expect(calls[0].method).toBe('GET')
        expect(calls[1].url).toBe('https://api.spotify.com/v1/me/library?ids=nowPlaying1')
        expect(calls[1].method).toBe('PUT')
    })

    it('shuffle llama a PUT /me/player/shuffle?state=', async () => {
        const { plugin } = makePlugin()
        const calls = stubFetch(() => jsonResponse(204))
        const handlers = plugin.getActionHandlers()

        const result = await handlers.get('shuffle')!({ token: 't', state: true }, {})

        expect(result).toMatchObject({ state: true, executed: true })
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/shuffle?state=true')
        expect(calls[0].method).toBe('PUT')
    })

    it('playlist construye context_uri desde playlistId', async () => {
        const { plugin } = makePlugin()
        const calls = stubFetch(() => jsonResponse(204))
        const handlers = plugin.getActionHandlers()

        const result = await handlers.get('playlist')!({ token: 't', playlistId: '37i9dQZF1DX' }, {})

        expect(result).toMatchObject({ contextUri: 'spotify:playlist:37i9dQZF1DX', executed: true })
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/play')
        expect(calls[0].method).toBe('PUT')
        expect(JSON.parse(calls[0].body)).toEqual({ context_uri: 'spotify:playlist:37i9dQZF1DX' })
    })

    it('playlist acepta contextUri directo y deviceId', async () => {
        const { plugin } = makePlugin()
        const calls = stubFetch(() => jsonResponse(204))
        const handlers = plugin.getActionHandlers()

        await handlers
            .get('playlist')!({ token: 't', contextUri: 'spotify:album:abc', deviceId: 'd9' }, {})

        expect(calls[0].url).toBe('https://api.spotify.com/v1/me/player/play?device_id=d9')
        expect(JSON.parse(calls[0].body)).toEqual({ context_uri: 'spotify:album:abc' })
    })

    it('401/403 -> error de token inválido sin exponer el token en logs', async () => {
        const { plugin, logs } = makePlugin()
        stubFetch(() => jsonResponse(401, { error: { message: 'Bad token' } }))
        const handlers = plugin.getActionHandlers()

        const err = await handlers.get('playback')!({ token: 'secreto123', action: 'play' }, {}).catch((e: any) => e)

        expect(err.message).toContain('token inválido o sin permisos (revisa OAuth)')
        const dumped = JSON.stringify(logs)
        expect(dumped).not.toContain('secreto123')
    })

    it('404 -> indica que abra Spotify en algún dispositivo', async () => {
        const { plugin } = makePlugin()
        stubFetch(() => jsonResponse(404, { error: { reason: 'NO_ACTIVE_DEVICE' } }))
        const handlers = plugin.getActionHandlers()

        const err = await handlers.get('shuffle')!({ token: 't', state: false }, {}).catch((e: any) => e)

        expect(err.message).toContain('Spotify')
        expect(err.message).toContain('dispositivo')
    })

    it('204 se trata como éxito', async () => {
        const { plugin } = makePlugin()
        stubFetch(() => new Response(null, { status: 204 }))
        const handlers = plugin.getActionHandlers()

        const result = await handlers.get('playback')!({ token: 't', action: 'pause' }, {})
        expect(result.executed).toBe(true)
        expect(result.status).toBe(204)
    })

    it('valida parámetros requeridos', async () => {
        const { plugin } = makePlugin()
        stubFetch(() => jsonResponse(204))
        const handlers = plugin.getActionHandlers()

        await expect(handlers.get('playback')!({ action: 'play' }, {})).rejects.toThrow('token')
        await expect(handlers.get('playback')!({ token: 't', action: 'bogus' }, {})).rejects.toThrow('action')
        await expect(handlers.get('shuffle')!({ token: 't' }, {})).rejects.toThrow('state')
        await expect(handlers.get('playlist')!({ token: 't' }, {})).rejects.toThrow('playlistId')
    })

    it('dispose no falla', () => {
        const { plugin } = makePlugin()
        expect(() => plugin.dispose()).not.toThrow()
    })
})

describe('SpotifyPlugin fetch stub (sanidad)', () => {
    it('beforeEach no deja fetch stubbed entre tests', () => {
        expect(globalThis.fetch).toBe(realFetch)
    })
})
