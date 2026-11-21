import { describe, it, expect, afterEach } from 'bun:test'
import { HttpPlugin } from '../plugins/http.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new HttpPlugin({
        log: (level: string, message: string, meta?: any) => {
            logs.push({ level, message, meta })
        }
    })
    return { plugin, logs }
}

const realFetch = globalThis.fetch

type Seen = { url: string; method: string; headers: any; body: any }

function stubFetch(handler: (s: Seen) => Response | Promise<Response>) {
    const seen: Seen[] = []
    globalThis.fetch = (async (url: any, init: any = {}) => {
        const s: Seen = { url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body }
        seen.push(s)
        return handler(s)
    }) as typeof fetch
    return seen
}

afterEach(() => {
    globalThis.fetch = realFetch
})

describe('HttpPlugin', () => {
    it('expone un manifest válido con la acción http', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('http')
        expect(manifest.name).toBe('HTTP Requests')
        expect(manifest.version).toBe('1.0.0')
        expect(manifest.author).toBe('BunDeck')
        expect(manifest.permissions).toContain('http')
        expect(manifest.actions).toHaveLength(1)
        const action = manifest.actions[0]
        expect(action.id).toBe('http')
        expect(action.schema.type).toBe('object')
        expect(action.schema.required).toEqual(['url'])
        expect(action.schema.properties.url.title).toBeString()
        expect(action.schema.properties.method.enum).toContain('POST')
        expect(JSON.parse(JSON.stringify(action.schema))).toEqual(action.schema)
    })

    it('registra el handler http', () => {
        const { plugin } = makePlugin()
        expect(plugin.getActionHandlers().has('http')).toBe(true)
    })

    it('GET devuelve status/headers/body', async () => {
        const { plugin } = makePlugin()
        const seen = stubFetch(() => new Response(' mercury ', { status: 200, headers: { 'Content-Type': 'text/plain', 'X-A': 'b' } }))
        const res = await plugin.getActionHandlers().get('http')!({ url: 'https://api.example.com/x' }, {})
        expect(res.status).toBe(200)
        expect(res.body).toBe(' mercury ')
        expect(res.headers['x-a']).toBe('b')
        expect(seen[0].method).toBe('GET')
    })

    it('POST serializa el body a JSON y propaga headers', async () => {
        const { plugin } = makePlugin()
        const seen = stubFetch(() => new Response('{}', { status: 201 }))
        const res = await plugin.getActionHandlers().get('http')!({
            url: 'https://api.example.com/items',
            method: 'POST',
            headers: { Authorization: 'Bearer x' },
            body: { a: 1 },
        }, {})
        expect(res.status).toBe(201)
        expect(seen[0].method).toBe('POST')
        expect(JSON.parse(seen[0].body)).toEqual({ a: 1 })
        expect(seen[0].headers.Authorization).toBe('Bearer x')
    })

    it('usa GET por defecto', async () => {
        const { plugin } = makePlugin()
        const seen = stubFetch(() => new Response('ok', { status: 200 }))
        await plugin.getActionHandlers().get('http')!({ url: 'https://x.test' }, {})
        expect(seen[0].method).toBe('GET')
    })

    it('exige url', async () => {
        const { plugin } = makePlugin()
        stubFetch(() => new Response('ok'))
        await expect(plugin.getActionHandlers().get('http')!({}, {})).rejects.toThrow(/URL is required/)
    })

    it('propaga errores de red', async () => {
        const { plugin } = makePlugin()
        stubFetch(() => { throw new Error('dns fail') })
        await expect(plugin.getActionHandlers().get('http')!({ url: 'https://x.test' }, {})).rejects.toThrow(/dns fail/)
    })

    it('dispose no falla', () => {
        const { plugin } = makePlugin()
        expect(() => plugin.dispose()).not.toThrow()
    })
})
