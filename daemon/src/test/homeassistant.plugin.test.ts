import { describe, test, expect } from 'bun:test'
import { HomeAssistantPlugin } from '../plugins/homeassistant.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new HomeAssistantPlugin({
        log: (level: string, message: string, meta?: any) => {
            logs.push({ level, message, meta })
        }
    })
    return { plugin, logs }
}

interface RecordedRequest {
    method: string
    path: string
    auth: string | null
    body: any
}

/** Levanta un HA falso en 127.0.0.1 con puerto efímero. */
function startFakeHA(handler: (req: Request) => Response | Promise<Response>) {
    const requests: RecordedRequest[] = []
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (req) => {
            const url = new URL(req.url)
            let body: any = null
            if (req.method !== 'GET') {
                try {
                    body = await req.json()
                } catch {
                    body = null
                }
            }
            requests.push({
                method: req.method,
                path: url.pathname,
                auth: req.headers.get('authorization'),
                body
            })
            return handler(req)
        }
    })
    return { server, requests, baseUrl: `http://127.0.0.1:${server.port}` }
}

describe('HomeAssistantPlugin manifest', () => {
    test('manifest válido con 3 acciones y schemas', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('homeassistant')
        expect(manifest.name).toBe('Home Assistant')
        expect(manifest.version).toBe('1.0.0')
        expect(manifest.author).toBe('LibreDeck')
        expect(manifest.permissions).toContain('http')
        expect(manifest.permissions).toContain('network')
        expect(manifest.actions).toHaveLength(3)

        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(['light', 'scene', 'switch'])

        for (const action of manifest.actions) {
            expect(action.schema).toBeDefined()
            expect(action.schema.type).toBe('object')
            expect(Array.isArray(action.schema.required)).toBe(true)
            // baseUrl/token viven en los ajustes del plugin (⋯) con fallback:
            // cada acción solo exige la entidad.
            expect(action.schema.required).toContain('entityId')
            expect(action.schema.required).not.toContain('baseUrl')
            expect(action.schema.required).not.toContain('token')
        }

        // Ajustes generales del plugin: baseUrl + token requeridos + instrucciones
        expect(manifest.settingsSchema).toBeDefined()
        expect(manifest.settingsSchema.required).toEqual(
            expect.arrayContaining(['baseUrl', 'token'])
        )
        expect(typeof manifest.instructions).toBe('string')

        const light = manifest.actions.find((a: any) => a.id === 'light')
        expect(light.schema.properties.action.enum).toEqual(['on', 'off', 'toggle'])
        expect(light.schema.properties.action.default).toBe('toggle')
        expect(light.schema.properties.brightness.maximum).toBe(255)
        expect(light.schema.properties.brightness.minimum).toBe(0)
        expect(light.schema.properties.colorTemp).toBeDefined()
    })

    test('handlers registrados para light, scene y switch', () => {
        const { plugin } = makePlugin()
        const handlers = plugin.getActionHandlers()
        expect(handlers.has('light')).toBe(true)
        expect(handlers.has('scene')).toBe(true)
        expect(handlers.has('switch')).toBe(true)
    })
})

describe('HomeAssistantPlugin handlers (servidor falso)', () => {
    test('light toggle llama al endpoint correcto con Authorization Bearer', async () => {
        const { server, requests, baseUrl } = startFakeHA(async (req) => {
            const url = new URL(req.url)
            if (url.pathname === '/api/states/light.salon') {
                return Response.json({ entity_id: 'light.salon', state: 'on' })
            }
            return Response.json([{ entity_id: 'light.salon' }])
        })
        try {
            const { plugin } = makePlugin()
            const result = await plugin.getActionHandlers().get('light')!(
                { baseUrl: `${baseUrl}/`, token: 'test-token-123', entityId: 'light.salon', action: 'toggle' },
                {}
            )
            const serviceCall = requests.find((r) => r.path === '/api/services/light/toggle')
            expect(serviceCall).toBeDefined()
            expect(serviceCall!.method).toBe('POST')
            expect(serviceCall!.auth).toBe('Bearer test-token-123')
            expect(serviceCall!.body).toMatchObject({ entity_id: 'light.salon' })
            expect(result.success).toBe(true)
            expect(result.state).toMatchObject({ entity_id: 'light.salon', state: 'on' })
        } finally {
            server.stop()
        }
    })

    test('scene llama a scene/turn_on', async () => {
        const { server, requests, baseUrl } = startFakeHA(async (req) => {
            const url = new URL(req.url)
            if (url.pathname === '/api/states/scene.pelicula') {
                return Response.json({ entity_id: 'scene.pelicula', state: 'on' })
            }
            return Response.json([])
        })
        try {
            const { plugin } = makePlugin()
            const result = await plugin.getActionHandlers().get('scene')!(
                { baseUrl, token: 'tok', entityId: 'scene.pelicula' },
                {}
            )
            const serviceCall = requests.find((r) => r.path === '/api/services/scene/turn_on')
            expect(serviceCall).toBeDefined()
            expect(serviceCall!.method).toBe('POST')
            expect(serviceCall!.body).toMatchObject({ entity_id: 'scene.pelicula' })
            expect(result.success).toBe(true)
            expect(result.service).toBe('scene.turn_on')
        } finally {
            server.stop()
        }
    })

    test('401 produce un error legible de token inválido', async () => {
        const { server, baseUrl } = startFakeHA(() => {
            return new Response('Unauthorized', { status: 401 })
        })
        try {
            const { plugin } = makePlugin()
            const err = await plugin
                .getActionHandlers()
                .get('light')!({ baseUrl, token: 'bad-token', entityId: 'light.salon' }, {})
                .then(() => null)
                .catch((e: Error) => e)
            expect(err).not.toBeNull()
            expect(err.message).toMatch(/401/)
            expect(err.message.toLowerCase()).toMatch(/token/)
        } finally {
            server.stop()
        }
    })

    test('switch off llama a switch/turn_off y 404 da error legible', async () => {
        const { server, requests, baseUrl } = startFakeHA(() => {
            return new Response('Not found', { status: 404 })
        })
        try {
            const { plugin } = makePlugin()
            const err = await plugin
                .getActionHandlers()
                .get('switch')!({ baseUrl, token: 'tok', entityId: 'switch.inexistente', action: 'off' }, {})
                .then(() => null)
                .catch((e: Error) => e)
            expect(err).not.toBeNull()
            expect(err.message).toMatch(/404/)
            const serviceCall = requests.find((r) => r.path === '/api/services/switch/turn_off')
            expect(serviceCall).toBeDefined()
        } finally {
            server.stop()
        }
    })

    test('nunca loguea el token completo', async () => {
        const { server, baseUrl } = startFakeHA(async (req) => {
            const url = new URL(req.url)
            if (url.pathname.startsWith('/api/states/')) {
                return Response.json({ entity_id: 'light.salon', state: 'off' })
            }
            return Response.json([])
        })
        try {
            const secret = 'supersecreto-token-abcdef123456'
            const { plugin, logs } = makePlugin()
            await plugin.getActionHandlers().get('light')!(
                { baseUrl, token: secret, entityId: 'light.salon', action: 'on' },
                {}
            )
            const dumped = JSON.stringify(logs)
            expect(dumped).not.toContain(secret)
        } finally {
            server.stop()
        }
    })
})
