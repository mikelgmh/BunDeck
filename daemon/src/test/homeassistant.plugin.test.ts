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
    test('manifest válido con 1 acción visible + 10 ocultas (alias y entity-list)', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('homeassistant')
        expect(manifest.name).toBe('Home Assistant')
        expect(manifest.version).toBe('2.2.0')
        expect(manifest.author).toBe('BunDeck')
        expect(manifest.permissions).toContain('http')
        expect(manifest.permissions).toContain('network')
        expect(manifest.actions).toHaveLength(11)

        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(['automation-trigger', 'climate-set', 'cover-control', 'entity', 'entity-list', 'get-state', 'light', 'scene', 'scene-activate', 'sensor-value', 'switch'])

        // Solo «entity» es visible en la biblioteca; el resto son alias heredados ocultos
        // más entity-list (fuente de opciones, la llama la UI).
        const visible = manifest.actions.filter((a: any) => a.hidden !== true)
        expect(visible.map((a: any) => a.id)).toEqual(['entity'])
        for (const legacy of ['light', 'scene', 'switch', 'scene-activate', 'automation-trigger', 'cover-control', 'climate-set', 'sensor-value', 'get-state', 'entity-list']) {
            expect(manifest.actions.find((a: any) => a.id === legacy).hidden).toBe(true)
        }

        for (const action of manifest.actions) {
            expect(action.schema).toBeDefined()
            expect(action.schema.type).toBe('object')
            expect(Array.isArray(action.schema.required)).toBe(true)
            // baseUrl/token viven en los ajustes del plugin (⋯) con fallback:
            // ninguna acción los exige.
            expect(action.schema.required).not.toContain('baseUrl')
            expect(action.schema.required).not.toContain('token')
        }
        for (const id of ['entity', 'light', 'scene', 'switch', 'scene-activate', 'automation-trigger', 'cover-control', 'climate-set', 'sensor-value', 'get-state']) {
            expect(manifest.actions.find((a: any) => a.id === id).schema.required).toContain('entityId')
        }

        // Ajustes generales del plugin: baseUrl + token requeridos + instrucciones
        expect(manifest.settingsSchema).toBeDefined()
        expect(manifest.settingsSchema.required).toEqual(
            expect.arrayContaining(['baseUrl', 'token'])
        )
        expect(typeof manifest.instructions).toBe('string')

        const entity = manifest.actions.find((a: any) => a.id === 'entity')
        expect(entity.schema.properties.action.enum).toEqual(['toggle', 'on', 'off', 'open', 'close', 'stop', 'set-position', 'activate', 'trigger', 'set-climate', 'read'])
        expect(entity.schema.properties.action.default).toBe('toggle')
        expect(entity.schema.properties.brightness.maximum).toBe(255)
        expect(entity.schema.properties.brightness.minimum).toBe(0)
        expect(entity.schema.properties.colorTemp).toBeDefined()
        expect(entity.schema.properties.position.maximum).toBe(100)
        expect(entity.schema.properties.hvacMode).toBeDefined()
        expect(entity.dynamic).toBe(true)

        // Descubrimiento de entidades: optionsFrom válido hacia entity-list.
        expect(entity.optionsFrom).toMatchObject({ field: 'entityId', sourceAction: 'entity-list' })
        expect(entity.schema.properties[entity.optionsFrom.field]).toBeDefined()
        expect(manifest.actions.some((a: any) => a.id === entity.optionsFrom.sourceAction)).toBe(true)
        expect(HomeAssistantPlugin.supportedActionsFor('light')).toEqual(['toggle', 'on', 'off', 'read'])
        expect(HomeAssistantPlugin.supportedActionsFor('cover')).toContain('set-position')
        expect(HomeAssistantPlugin.supportedActionsFor('scene')).toEqual(['activate', 'read'])
        expect(HomeAssistantPlugin.supportedActionsFor('automation')).toEqual(['trigger', 'read'])
        expect(HomeAssistantPlugin.supportedActionsFor('climate')).toEqual(['set-climate', 'read'])
        expect(HomeAssistantPlugin.supportedActionsFor('sensor')).toEqual(['read'])
    })

    test('handlers registrados para entity + entity-list + 9 alias', () => {
        const { plugin } = makePlugin()
        const handlers = plugin.getActionHandlers()
        for (const id of ['entity', 'entity-list', 'light', 'switch', 'cover-control', 'scene', 'scene-activate', 'automation-trigger', 'climate-set', 'sensor-value', 'get-state']) {
            expect(handlers.has(id)).toBe(true)
        }
    })

    test('el manifiesto pasa el validador del contrato', async () => {
        const { validateManifest } = await import('../plugin-system/validator')
        const { plugin } = makePlugin()
        const result = validateManifest(plugin.getManifest())
        expect(result.valid).toBe(true)
        expect(result.errors).toEqual([])
    })

    test('ninguna accion expone baseUrl/token: la conexion es SOLO del plugin', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        for (const action of manifest.actions) {
            expect(Object.keys(action.schema.properties)).not.toContain('baseUrl')
            expect(Object.keys(action.schema.properties)).not.toContain('token')
        }
        // Los ajustes del plugin conservan ambos como obligatorios.
        expect(manifest.settingsSchema.required).toEqual(
            expect.arrayContaining(['baseUrl', 'token'])
        )
        // entity-list se alimenta de los ajustes del servidor: nada que reenviar.
        const entity = manifest.actions.find((a: any) => a.id === 'entity')
        expect(entity.optionsFrom.forwardParams ?? []).toEqual([])
    })

    test('tabla dominio→campos y visibleWhen del schema (fallback: desconocido = todo)', async () => {
        const { HA_DOMAIN_FIELDS, visibleFieldsForDomain } = await import('../plugins/homeassistant.plugin')
        expect(HA_DOMAIN_FIELDS).toMatchObject({
            light: ['brightness', 'colorTemp'],
            cover: ['position'],
            climate: ['hvacMode', 'temperature']
        })
        expect(HA_DOMAIN_FIELDS.sensor).toEqual([])
        expect(visibleFieldsForDomain('light.salon')).toEqual(['brightness', 'colorTemp'])
        expect(visibleFieldsForDomain('cover')).toEqual(['position'])
        expect(visibleFieldsForDomain('climate.salon')).toEqual(['hvacMode', 'temperature'])
        expect(visibleFieldsForDomain('sensor.t')).toEqual([])
        // Fallback sensato: dominios desconocidos o sin entidad muestran todo.
        expect(visibleFieldsForDomain('fan.techo')).toBeNull()
        expect(visibleFieldsForDomain('')).toBeNull()
        const { plugin } = makePlugin()
        const props = plugin.getManifest().actions.find((a: any) => a.id === 'entity').schema.properties
        expect(props.brightness.visibleWhen).toEqual({ field: 'entityId', domains: ['light'] })
        expect(props.colorTemp.visibleWhen).toEqual({ field: 'entityId', domains: ['light'] })
        expect(props.position.visibleWhen).toEqual({ field: 'entityId', domains: ['cover'] })
        expect(props.hvacMode.visibleWhen).toEqual({ field: 'entityId', domains: ['climate'] })
        expect(props.temperature.visibleWhen).toEqual({ field: 'entityId', domains: ['climate'] })
        expect(props.entityId.visibleWhen).toBeUndefined()
        expect(props.action.visibleWhen).toBeUndefined()
    })

    test('la accion usa la configuracion del plugin cuando no trae credenciales', async () => {
        const { server, requests, baseUrl } = startFakeHA(async (req) => {
            const url = new URL(req.url)
            if (url.pathname === '/api/states/light.salon') {
                return Response.json({ entity_id: 'light.salon', state: 'on' })
            }
            return Response.json([])
        })
        try {
            const plugin = new HomeAssistantPlugin({
                log: () => {},
                getSetting: (k: string) => (k === 'baseUrl' ? baseUrl : k === 'token' ? 'tok-settings' : null)
            })
            const result = await plugin.getActionHandlers().get('entity')!(
                { entityId: 'light.salon', action: 'toggle' },
                {}
            )
            expect(result.success).toBe(true)
            const call = requests.find((r) => r.path === '/api/services/light/toggle')
            expect(call?.auth).toBe('Bearer tok-settings')
            // Sin credenciales en ningun sitio: error que lleva a ajustes del plugin.
            const bare = makePlugin().plugin
            await expect(
                bare.getActionHandlers().get('entity')!({ entityId: 'light.salon' }, {})
            ).rejects.toThrow(/ajustes del plugin/)
        } finally {
            server.stop()
        }
    })
})

describe('HomeAssistantPlugin handlers (servidor falso)', () => {
    test('entity toggle en light llama a light/toggle con Authorization Bearer', async () => {
        const { server, requests, baseUrl } = startFakeHA(async (req) => {
            const url = new URL(req.url)
            if (url.pathname === '/api/states/light.salon') {
                return Response.json({ entity_id: 'light.salon', state: 'on' })
            }
            return Response.json([{ entity_id: 'light.salon' }])
        })
        try {
            const { plugin } = makePlugin()
            const result = await plugin.getActionHandlers().get('entity')!(
                { baseUrl: `${baseUrl}/`, token: 'test-token-123', entityId: 'light.salon', action: 'toggle' },
                {}
            )
            const serviceCall = requests.find((r) => r.path === '/api/services/light/toggle')
            expect(serviceCall).toBeDefined()
            expect(serviceCall!.method).toBe('POST')
            expect(serviceCall!.auth).toBe('Bearer test-token-123')
            expect(serviceCall!.body).toMatchObject({ entity_id: 'light.salon' })
            expect(result.success).toBe(true)
            expect(result.domain).toBe('light')
            expect(result.state).toMatchObject({ entity_id: 'light.salon', state: 'on' })
        } finally {
            server.stop()
        }
    })

    test('entity deduce cover/climate/scene/automation/sensor por el prefijo', async () => {
        const { server, requests, baseUrl } = startFakeHA(async (req) => {
            const url = new URL(req.url)
            if (url.pathname.startsWith('/api/states/')) {
                return Response.json({ entity_id: url.pathname.split('/').pop(), state: 'on' })
            }
            return Response.json([])
        })
        try {
            const { plugin } = makePlugin()
            const h = plugin.getActionHandlers().get('entity')!
            const creds = { baseUrl, token: 'tok' }
            await h({ ...creds, entityId: 'cover.salon', action: 'open' }, {})
            await h({ ...creds, entityId: 'cover.salon', action: 'set-position', position: 50 }, {})
            await h({ ...creds, entityId: 'climate.salon', action: 'set-climate', temperature: 21 }, {})
            await h({ ...creds, entityId: 'scene.noche', action: 'activate' }, {})
            await h({ ...creds, entityId: 'automation.x', action: 'trigger' }, {})
            await h({ ...creds, entityId: 'switch.cafetera', action: 'off' }, {})
            const paths = requests.map((r) => r.path)
            expect(paths).toContain('/api/services/cover/open_cover')
            expect(paths).toContain('/api/services/cover/set_cover_position')
            expect(paths).toContain('/api/services/climate/set_temperature')
            expect(paths).toContain('/api/services/scene/turn_on')
            expect(paths).toContain('/api/services/automation/trigger')
            expect(paths).toContain('/api/services/switch/turn_off')
            const sensor = await h({ ...creds, entityId: 'sensor.t', action: 'read' }, {})
            expect(sensor.state).toBe('on')
            // sensor-value solo lee: no POSTea a services con sensor
            expect(paths.filter((p) => p.startsWith('/api/services') && p.includes('sensor'))).toEqual([])
        } finally {
            server.stop()
        }
    })

    test('entity rechaza acciones cruzadas con error legible', async () => {
        const { server, baseUrl } = startFakeHA(() => Response.json([]))
        try {
            const { plugin } = makePlugin()
            const h = plugin.getActionHandlers().get('entity')!
            const creds = { baseUrl, token: 'tok' }
            await expect(h({ ...creds, entityId: 'sensor.t', action: 'on' }, {})).rejects.toThrow(/solo lectura/)
            await expect(h({ ...creds, entityId: 'light.salon', action: 'open' }, {})).rejects.toThrow(/cover/)
            await expect(h({ ...creds, entityId: 'light.salon', action: 'volar' }, {})).rejects.toThrow(/no válida/)
            await expect(h({ ...creds, entityId: 'climate.salon', action: 'toggle' }, {})).rejects.toThrow(/Ajustar clima/)
            await expect(h({ ...creds, entityId: 'climate.salon', action: 'set-climate' }, {})).rejects.toThrow(/hvacMode|temperature/)
            await expect(h({ ...creds, entityId: 'sin-dominio', action: 'toggle' }, {})).rejects.toThrow(/no válida/)
        } finally {
            server.stop()
        }
    })

    test('alias heredados delegan en entity (compatibilidad)', async () => {
        const { server, requests, baseUrl } = startFakeHA(async (req) => {
            const url = new URL(req.url)
            if (url.pathname.startsWith('/api/states/')) {
                return Response.json({ entity_id: url.pathname.split('/').pop(), state: 'off' })
            }
            return Response.json([])
        })
        try {
            const { plugin } = makePlugin()
            const h = plugin.getActionHandlers()
            const creds = { baseUrl, token: 'tok' }
            await h.get('scene')!({ ...creds, entityId: 'scene.pelicula' }, {})
            await h.get('cover-control')!({ ...creds, entityId: 'cover.salon', action: 'open' }, {})
            await h.get('climate-set')!({ ...creds, entityId: 'climate.s', temperature: 21 }, {})
            await h.get('automation-trigger')!({ ...creds, entityId: 'automation.x' }, {})
            await h.get('sensor-value')!({ ...creds, entityId: 'sensor.t' }, {})
            const paths = requests.map((r) => r.path)
            expect(paths).toContain('/api/services/scene/turn_on')
            expect(paths).toContain('/api/services/cover/open_cover')
            expect(paths).toContain('/api/services/climate/set_temperature')
            expect(paths).toContain('/api/services/automation/trigger')
            // cover-control con acción inválida sigue dando error legible
            await expect(h.get('cover-control')!({ ...creds, entityId: 'cover.s', action: 'volar' }, {})).rejects.toThrow(/no válida/)
        } finally {
            server.stop()
        }
    })

    test('entity-list devuelve entidades con acciones compatibles por dominio', async () => {
        const states: any[] = [
            { entity_id: 'light.comedor', state: 'on', attributes: { friendly_name: 'Comedor' } },
            { entity_id: 'cover.salon', state: 'open', attributes: { friendly_name: 'Persiana salón' } },
            { entity_id: 'climate.salon', state: 'heat', attributes: {} },
            { entity_id: 'scene.noche', state: 'unknown', attributes: { friendly_name: 'Noche' } },
            { entity_id: 'automation.x', state: 'on', attributes: {} },
            { entity_id: 'sensor.t', state: '21.5', attributes: { friendly_name: 'Temperatura', unit_of_measurement: '°C' } }
        ]
        const { server, requests, baseUrl } = startFakeHA(async (req) => {
            const url = new URL(req.url)
            if (url.pathname === '/api/states') return Response.json(states)
            return Response.json([])
        })
        try {
            const { plugin, logs } = makePlugin()
            const result = await plugin.getActionHandlers().get('entity-list')!(
                { baseUrl, token: 'tok-abc' },
                {}
            )
            expect(result.success).toBe(true)
            expect(result.count).toBe(6)
            expect(result.options).toHaveLength(6)
            const byId = Object.fromEntries(result.options.map((o: any) => [o.value, o]))
            expect(byId['light.comedor'].label).toBe('Comedor (light.comedor)')
            expect(byId['light.comedor'].actions).toEqual(['toggle', 'on', 'off', 'read'])
            expect(byId['cover.salon'].actions).toContain('set-position')
            expect(byId['climate.salon'].actions).toEqual(['set-climate', 'read'])
            expect(byId['scene.noche'].actions).toEqual(['activate', 'read'])
            expect(byId['automation.x'].actions).toEqual(['trigger', 'read'])
            expect(byId['sensor.t'].state).toBe('21.5')
            expect(byId['sensor.t'].actions).toEqual(['read'])
            // Ordenadas por entity_id y sin token en logs.
            expect(result.options.map((o: any) => o.value)).toEqual([...result.options.map((o: any) => o.value)].sort())
            expect(JSON.stringify(logs)).not.toContain('tok-abc')
            const listCall = requests.find((r) => r.path === '/api/states')
            expect(listCall?.method).toBe('GET')
            expect(listCall?.auth).toBe('Bearer tok-abc')
        } finally {
            server.stop()
        }
    })

    test('entity-list sin credenciales o con 401 da error legible', async () => {
        const { server, baseUrl } = startFakeHA(() => new Response('Unauthorized', { status: 401 }))
        try {
            const { plugin } = makePlugin()
            const h = plugin.getActionHandlers().get('entity-list')!
            await expect(h({ baseUrl, token: 'mal' }, {})).rejects.toThrow(/401/)
            await expect(h({ baseUrl }, {})).rejects.toThrow(/token/i)
            await expect(h({ token: 'tok' }, {})).rejects.toThrow(/URL base/)
        } finally {
            server.stop()
        }
    })

    test('scene (alias) llama a scene/turn_on', async () => {
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
