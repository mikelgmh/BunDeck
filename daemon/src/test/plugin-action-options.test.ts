/**
 * plugin-action-options.test.ts — POST /api/v1/plugins/action-options
 * Resuelve el `optionsFrom` de una acción ejecutando su sourceAction.
 */
import { describe, it, expect } from 'bun:test'
import { handlePlugins } from '../api/plugins'
import { HomeAssistantPlugin } from '../plugins/homeassistant.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string }> = []
    return new HomeAssistantPlugin({ log: (level, message) => { logs.push({ level, message }) } })
}

async function postOptions(services: any, body: any) {
    const path = '/api/v1/plugins/action-options'
    const req = new Request(`http://localhost:3001${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    })
    const res = await handlePlugins(req, {
        url: new URL(`http://localhost:3001${path}`),
        method: 'POST',
        path,
        db: {} as any,
        services
    } as any)
    if (!res) throw new Error('sin handler para POST /api/v1/plugins/action-options')
    return { status: res.status, body: await res.json() }
}

function stubServices(manifest: any, opts: { enabled?: boolean; execute?: (a: any) => Promise<any> } = {}) {
    const calls: any[] = []
    return {
        calls,
        services: {
            pluginLoader: {
                getPlugin: (id: string) =>
                    id === manifest.id && opts.enabled !== false
                        ? { manifest, enabled: true }
                        : undefined
            },
            actionRunner: {
                executeAction: async (a: any) => {
                    calls.push(a)
                    if (opts.execute) return opts.execute(a)
                    return { success: true, result: { options: [{ value: 'x', label: 'X' }] } }
                }
            }
        }
    }
}

describe('POST /api/v1/plugins/action-options', () => {
    it('homeassistant.entity :: ejecuta entity-list y devuelve opciones con dominio/acciones', async () => {
        // HA falso con 3 entidades.
        const server = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: async (req) => {
                const url = new URL(req.url)
                if (url.pathname === '/api/states') {
                    return Response.json([
                        { entity_id: 'light.comedor', state: 'on', attributes: { friendly_name: 'Comedor' } },
                        { entity_id: 'cover.salon', state: 'closed', attributes: {} },
                        { entity_id: 'sensor.t', state: '20', attributes: {} }
                    ])
                }
                return Response.json([])
            }
        })
        try {
            const plugin = makePlugin()
            const handlers = plugin.getActionHandlers()
            const baseUrl = `http://127.0.0.1:${server.port}`
            const { calls, services } = stubServices(plugin.getManifest(), {
                execute: async (a: any) => {
                    const [pid, aid] = String(a.type).split('.')
                    const out = await handlers.get(aid)!({ ...(a.parameters ?? {}), baseUrl, token: 'tok-e2e' }, {})
                    void pid
                    return { success: true, result: out }
                }
            })
            const r = await postOptions(services, {
                pluginId: 'homeassistant',
                actionId: 'entity',
                field: 'entityId',
                params: { entityId: '', baseUrl, token: 'tok-e2e', junk: 'no-debe-viajar' }
            })
            expect(r.status).toBe(200)
            expect(r.body.success).toBe(true)
            expect(r.body.field).toBe('entityId')
            expect(r.body.count).toBe(3)
            const byId = Object.fromEntries(r.body.options.map((o: any) => [o.value, o]))
            expect(byId['light.comedor'].actions).toEqual(['toggle', 'on', 'off', 'read'])
            expect(byId['cover.salon'].domain).toBe('cover')
            expect(byId['sensor.t'].actions).toEqual(['read'])
            // forwardParams: [] — la conexion vive en los ajustes del plugin
            // (servidor); nada de params viaja a entity-list (ni credenciales ni junk).
            expect(calls).toHaveLength(1)
            expect(calls[0].type).toBe('homeassistant.entity-list')
            expect(Object.keys(calls[0].parameters).sort()).toEqual([])
        } finally {
            server.stop()
        }
    })

    it('si la sourceAction falla, responde 200 success:false con el mensaje (la UI deja escribir a mano)', async () => {
        const plugin = makePlugin()
        const { services } = stubServices(plugin.getManifest(), {
            execute: async () => ({ success: false, error: 'Token inválido o sin autorización (401): revisa el token' })
        })
        const r = await postOptions(services, { pluginId: 'homeassistant', actionId: 'entity', params: {} })
        expect(r.status).toBe(200)
        expect(r.body.success).toBe(false)
        expect(r.body.error).toMatch(/401/)
    })

    it('rechaza acción sin optionsFrom, campo erróneo y plugin ausente/deshabilitado', async () => {
        const plugin = makePlugin()
        const manifest = plugin.getManifest()
        const { services } = stubServices(manifest)
        // Acción sin optionsFrom.
        const bad1 = await postOptions(services, { pluginId: 'homeassistant', actionId: 'light', params: {} })
        expect(bad1.status).toBe(400)
        // Campo erróneo.
        const bad2 = await postOptions(services, { pluginId: 'homeassistant', actionId: 'entity', field: 'action', params: {} })
        expect(bad2.status).toBe(400)
        // Plugin inexistente.
        const bad3 = await postOptions(services, { pluginId: 'nope', actionId: 'entity', params: {} })
        expect(bad3.status).toBe(404)
        // Sin ids.
        const bad4 = await postOptions(services, { params: {} })
        expect(bad4.status).toBe(400)
        // Deshabilitado.
        const disabled = stubServices(manifest, { enabled: false })
        const bad5 = await postOptions(disabled.services, { pluginId: 'homeassistant', actionId: 'entity', params: {} })
        expect(bad5.status).toBe(404)
    })

    it('nunca ejecuta acciones arbitrarias: solo la sourceAction declarada', async () => {
        const plugin = makePlugin()
        const { calls, services } = stubServices(plugin.getManifest())
        await postOptions(services, {
            pluginId: 'homeassistant',
            actionId: 'entity',
            params: {}
        })
        expect(calls).toHaveLength(1)
        expect(calls[0].type).toBe('homeassistant.entity-list')
    })
})
