/**
 * creative-gaming-domotica.test.ts
 * Manifiests en español + degradación sin credenciales de los plugins
 * creativos (photoshop/premiere/davinci/blender), MIDI/OSC, gaming
 * (steam/minecraft), domótica extra (hue-extra/govee) y las extensiones
 * de pc-vitals y homeassistant.
 *
 * Sin hardware real: los fallos usan puertos cerrados de localhost con
 * timeouts cortos, y los hotkeys solo se validan en sus errores de
 * parámetros (sin pulsar teclas).
 */
import { describe, it, expect } from 'bun:test'
import { createServer } from 'node:net'
import { PhotoshopPlugin } from '../plugins/photoshop.plugin'
import { PremierePlugin } from '../plugins/premiere.plugin'
import { DavinciPlugin } from '../plugins/davinci.plugin'
import { BlenderPlugin } from '../plugins/blender.plugin'
import { MidiOscPlugin, encodeOscMessage } from '../plugins/midi-osc.plugin'
import { SteamPlugin } from '../plugins/steam.plugin'
import { MinecraftPlugin } from '../plugins/minecraft.plugin'
import { HueExtraPlugin } from '../plugins/hue-extra.plugin'
import { GoveePlugin } from '../plugins/govee.plugin'
import { PCVitalsPlugin } from '../plugins/pc-vitals.plugin'
import { HomeAssistantPlugin } from '../plugins/homeassistant.plugin'

const noop = { log: (_l: string, _m: string, _meta?: any) => {} }

/** Puerto localhost garantizado como cerrado (bindeado y liberado). */
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

/** Servidor HTTP falso para HA/Hue/Govee/Steam/Minecraft vía apiBase. */
function startFakeHttp(handler: (req: Request) => Response | Promise<Response>) {
    const requests: Array<{ method: string; path: string; body: any }> = []
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (req) => {
            const url = new URL(req.url)
            let body: any = null
            if (req.method !== 'GET') {
                try { body = await req.json() } catch { body = null }
            }
            requests.push({ method: req.method, path: url.pathname, body })
            return handler(req)
        },
    })
    return { server, requests, base: `http://127.0.0.1:${server.port}` }
}

function expectSpanishManifest(manifest: any, id: string, minActions: number) {
    expect(manifest.id).toBe(id)
    expect(manifest.name).toBeDefined()
    expect(manifest.description).toBeDefined()
    expect(manifest.author).toBe('BunDeck')
    expect(manifest.actions.length).toBeGreaterThanOrEqual(minActions)
    for (const action of manifest.actions) {
        expect(action.name, `${id}.${action.id} nombre`).toBeDefined()
        expect(action.description, `${id}.${action.id} descripción`).toBeDefined()
        expect(action.schema?.type, `${id}.${action.id} schema`).toBe('object')
        expect(Array.isArray(action.schema?.required), `${id}.${action.id} required`).toBe(true)
        for (const [key, prop] of Object.entries<any>(action.schema.properties ?? {})) {
            expect(prop.title, `${id}.${action.id}.${key} title en español`).toBeDefined()
            expect(prop.ui, `${id}.${action.id}.${key} hint ui`).toBeDefined()
        }
    }
}

describe('Manifiests creativos/gaming/domotica', () => {
    it('photoshop: 6 acciones con presets', () => {
        const m = new PhotoshopPlugin(noop).getManifest()
        expectSpanishManifest(m, 'photoshop', 6)
        expect(m.actions.map((a: any) => a.id).sort()).toEqual(
            ['brush-size', 'history', 'layer-ops', 'run-action', 'save-export', 'tool-select'],
        )
        expect(new PhotoshopPlugin(noop).getActionHandlers().size).toBe(6)
    })
    it('premiere: 7 acciones (transporte JKL, marcas, jog placeholder)', () => {
        const m = new PremierePlugin(noop).getManifest()
        expectSpanishManifest(m, 'premiere', 7)
        expect(m.actions.map((a: any) => a.id).sort()).toEqual(
            ['export', 'history', 'jog-shuttle', 'mark', 'marker', 'save', 'transport'],
        )
    })
    it('davinci: 6 acciones con páginas Media..Deliver', () => {
        const m = new DavinciPlugin(noop).getManifest()
        expectSpanishManifest(m, 'davinci', 6)
        expect(m.actions.map((a: any) => a.id).sort()).toEqual(
            ['edit', 'marker', 'render-start', 'save-project', 'switch-page', 'transport'],
        )
    })
    it('blender: 4 acciones', () => {
        const m = new BlenderPlugin(noop).getManifest()
        expectSpanishManifest(m, 'blender', 4)
        expect(m.actions.map((a: any) => a.id).sort()).toEqual(['custom', 'render', 'save', 'viewport'])
    })
    it('midi-osc: 3 acciones', () => {
        const m = new MidiOscPlugin(noop).getManifest()
        expectSpanishManifest(m, 'midi-osc', 3)
    })
    it('steam: 4 acciones', () => {
        const m = new SteamPlugin(noop).getManifest()
        expectSpanishManifest(m, 'steam', 4)
    })
    it('minecraft: 3 acciones', () => {
        const m = new MinecraftPlugin(noop).getManifest()
        expectSpanishManifest(m, 'minecraft', 3)
    })
    it('hue-extra: 5 acciones con ajustes bridgeIp+apiKey', () => {
        const m = new HueExtraPlugin(noop).getManifest()
        expectSpanishManifest(m, 'hue-extra', 5)
        expect(m.settingsSchema.required).toEqual(expect.arrayContaining(['bridgeIp', 'apiKey']))
    })
    it('govee: 4 acciones con ajustes apiKey', () => {
        const m = new GoveePlugin(noop).getManifest()
        expectSpanishManifest(m, 'govee', 4)
        expect(m.settingsSchema.required).toEqual(expect.arrayContaining(['apiKey']))
    })
})

describe('Validación de parámetros (sin pulsar nada)', () => {
    it('photoshop rechaza herramienta/operación inválida y run-action sin hotkey', async () => {
        const h = new PhotoshopPlugin(noop).getActionHandlers()
        await expect(h.get('tool-select')!({ tool: 'varita-magica' }, {})).rejects.toThrow(/no válida/)
        await expect(h.get('layer-ops')!({ op: 'fusionar-todo' }, {})).rejects.toThrow(/no válida/)
        await expect(h.get('brush-size')!({ direction: 'gigante' }, {})).rejects.toThrow(/increase.*decrease/)
        await expect(h.get('run-action')!({ actionName: 'X' }, {})).rejects.toThrow(/hotkey/)
        await expect(h.get('history')!({ operation: 'warp' }, {})).rejects.toThrow(/no válida/)
        await expect(h.get('save-export')!({ operation: 'fax' }, {})).rejects.toThrow(/no válida/)
    })
    it('premiere/davinci/blender rechazan operaciones inválidas', async () => {
        const p = new PremierePlugin(noop).getActionHandlers()
        await expect(p.get('transport')!({ operation: 'turbo' }, {})).rejects.toThrow(/no válida/)
        await expect(p.get('mark')!({ point: 'mitad' }, {})).rejects.toThrow(/mark-in|mark-out|no válido/)
        await expect(p.get('history')!({ operation: 'nada' }, {})).rejects.toThrow(/undo.*redo/)
        await expect(p.get('jog-shuttle')!({ mode: 'hyper' }, {})).rejects.toThrow(/jog\/shuttle|no válido/i)
        const d = new DavinciPlugin(noop).getActionHandlers()
        await expect(d.get('transport')!({ operation: 'warp' }, {})).rejects.toThrow(/no válida/)
        await expect(d.get('edit')!({ operation: 'magia' }, {})).rejects.toThrow(/no válida/)
        await expect(d.get('switch-page')!({ page: 'cine' }, {})).rejects.toThrow(/no válida/)
        await expect(d.get('render-start')!({}, {})).rejects.toThrow(/hotkey/)
        const b = new BlenderPlugin(noop).getActionHandlers()
        await expect(b.get('viewport')!({ view: 'esquina' }, {})).rejects.toThrow(/no válida/)
        await expect(b.get('render')!({ operation: 'hornear' }, {})).rejects.toThrow(/no válida/)
        await expect(b.get('custom')!({}, {})).rejects.toThrow(/hotkey/)
    })
    it('steam/minecraft exigen appId/host numérico o presente', async () => {
        const s = new SteamPlugin(noop).getActionHandlers()
        await expect(s.get('launch-game')!({ appId: 'no-numerico' }, {})).rejects.toThrow(/numérico/)
        await expect(s.get('server-status')!({}, {})).rejects.toThrow(/numérico|AppID/)
        const mc = new MinecraftPlugin(noop).getActionHandlers()
        await expect(mc.get('server-status')!({}, {})).rejects.toThrow(/obligatorio/)
        await expect(mc.get('server-status')!({ host: 'https://x.com' }, {})).rejects.toThrow(/sin protocolo/)
    })
    it('hue/govee exigen credenciales con mensaje legible', async () => {
        const hue = new HueExtraPlugin({ ...noop, getSetting: () => null }).getActionHandlers()
        await expect(hue.get('lights-list')!({}, {})).rejects.toThrow(/IP del puente|API key/)
        await expect(hue.get('toggle')!({ lightId: '1', bridgeIp: '127.0.0.1', apiKey: 'k', action: 'bogus' }, {})).rejects.toThrow(/no válida/)
        const gov = new GoveePlugin({ ...noop, getSetting: () => null }).getActionHandlers()
        await expect(gov.get('toggle')!({ device: 'x', model: 'H1', action: 'on' }, {})).rejects.toThrow(/API key/)
        await expect(gov.get('brightness')!({ apiKey: 'k', device: 'x', model: 'H1', brightness: 500 }, {})).rejects.toThrow(/0 y 100/)
        await expect(gov.get('color')!({ apiKey: 'k', device: 'x', model: 'H1', red: 300, green: 0, blue: 0 }, {})).rejects.toThrow(/color no válido/)
    })
    it('midi-osc valida dirección, args y nota', async () => {
        const m = new MidiOscPlugin(noop).getActionHandlers()
        await expect(m.get('send-osc')!({ port: 8000, address: '/x' }, {})).rejects.toThrow(/host/)
        await expect(m.get('send-osc')!({ host: '127.0.0.1', port: 99999, address: '/x' }, {})).rejects.toThrow(/Puerto/)
        await expect(m.get('send-osc')!({ host: '127.0.0.1', port: 8000, address: 'sin-barra' }, {})).rejects.toThrow(/Dirección OSC/)
        await expect(m.get('send-midi')!({ note: 999 }, {})).rejects.toThrow(/Nota MIDI/)
    })
})

describe('Degradación sin red/credenciales (puertos cerrados)', () => {
    it('encodeOscMessage codifica int/float/string y rechaza direcciones malas', () => {
        const pkt = encodeOscMessage('/fader/1', [1, 0.5, 'go'])
        expect(pkt.length % 4).toBe(0)
        const text = Buffer.from(pkt).toString('utf8')
        expect(text).toContain('/fader/1')
        expect(text).toContain(',ifs')
        expect(() => encodeOscMessage('sin-barra', [])).toThrow(/Dirección OSC/)
        expect(() => encodeOscMessage('/x', [true as any])).toThrow(/no soportado/)
    })
    it('send-osc a UDP cerrado no lanza (fire-and-forget)', async () => {
        const port = await closedPort()
        const res = await new MidiOscPlugin(noop).getActionHandlers().get('send-osc')!(
            { host: '127.0.0.1', port, address: '/test', args: [1] }, {},
        )
        expect(res.sent).toBe(true)
    })
    it('send-midi y list-ports son placeholders degradados', async () => {
        const h = new MidiOscPlugin(noop).getActionHandlers()
        const midi = await h.get('send-midi')!({ note: 60 }, {})
        expect(midi.supported).toBe(false)
        expect(midi.degraded).toBe(true)
        const ports = await h.get('list-ports')!({}, {})
        expect(ports.osc.supported).toBe(true)
        expect(ports.midi.supported).toBe(false)
    })
    it('steam server-status contra tienda cerrada falla legible y rápido', async () => {
        const port = await closedPort()
        const h = new SteamPlugin(noop).getActionHandlers()
        const t0 = Date.now()
        const err = await h.get('server-status')!({ appId: '730', apiBase: `http://127.0.0.1:${port}`, timeoutMs: 2000 }, {}).then(() => null, (e: Error) => e)
        expect(err).not.toBeNull()
        expect(err.message).toMatch(/Steam|tienda|conectar/i)
        expect(Date.now() - t0).toBeLessThan(10000)
    })
    it('steam presence es placeholder degradado', async () => {
        const res = await new SteamPlugin(noop).getActionHandlers().get('presence')!({}, {})
        expect(res.supported).toBe(false)
        expect(res.note).toMatch(/API key/)
    })
    it('minecraft contra API cerrada falla legible y rápido', async () => {
        const port = await closedPort()
        const h = new MinecraftPlugin(noop).getActionHandlers()
        const err = await h.get('server-status')!({ host: 'ejemplo.test', apiBase: `http://127.0.0.1:${port}`, timeoutMs: 2000 }, {}).then(() => null, (e: Error) => e)
        expect(err).not.toBeNull()
        expect(err.message).toMatch(/ejemplo\.test|API|espera/i)
    })
    it('hue contra puente cerrado falla legible y rápido', async () => {
        const port = await closedPort()
        const hue = new HueExtraPlugin(noop).getActionHandlers()
        const err = await hue.get('lights-list')!({ bridgeIp: `127.0.0.1:${port}`, apiKey: 'falsa', timeoutMs: 2000 }, {}).then(() => null, (e: Error) => e)
        expect(err).not.toBeNull()
        expect(err.message).toMatch(/puente Hue|espera|conectar/i)
    })
    it('govee sin red falla legible (GOVEE_API_BASE a puerto cerrado)', async () => {
        const port = await closedPort()
        process.env.GOVEE_API_BASE = `http://127.0.0.1:${port}/v1`
        try {
            const err = await new GoveePlugin(noop).getActionHandlers().get('toggle')!(
                { apiKey: 'falsa', device: 'AA:BB', model: 'H6159', action: 'on' }, {},
            ).then(() => null, (e: Error) => e)
            expect(err).not.toBeNull()
            expect(err.message).toMatch(/Govee/i)
        } finally {
            delete process.env.GOVEE_API_BASE
        }
    })
})

describe('Extensiones pc-vitals y homeassistant', () => {
    it('pc-vitals uptime siempre funciona; process-top valida límites', async () => {
        const h = new PCVitalsPlugin(noop).getActionHandlers()
        const up = await h.get('uptime')!({}, {})
        expect(up.monitored).toBe(true)
        expect(up.value).toBeGreaterThanOrEqual(0)
        expect(up.human).toBeDefined()
        await expect(h.get('process-top')!({ limit: 99 }, {})).rejects.toThrow(/entre 1 y 20/)
        await expect(h.get('process-top')!({ sortBy: 'ram' }, {})).rejects.toThrow(/cpu.*mem/)
        await expect(h.get('net-speed')!({ sampleMs: 50 }, {})).rejects.toThrow(/200 y 5000/)
    })
    it('pc-vitals gpu-temp/disk-usage se degradan sin sensor (no lanzan)', async () => {
        const h = new PCVitalsPlugin(noop).getActionHandlers()
        const gpu = await h.get('gpu-temp')!({}, {})
        expect(typeof gpu.monitored).toBe('boolean')
        if (!gpu.monitored) expect(gpu.degraded).toBe(true)
        const disk = await h.get('disk-usage')!({ path: '/ruta/inexistente/xyz' }, {})
        expect(typeof disk.monitored).toBe('boolean')
    })
    it('homeassistant nuevas acciones llaman al endpoint correcto (HA falso)', async () => {
        const { server, requests, base } = startFakeHttp(async (req) => {
            const url = new URL(req.url)
            if (url.pathname.startsWith('/api/states/')) return Response.json({ entity_id: url.pathname.split('/').pop(), state: 'on' })
            return Response.json([])
        })
        try {
            const plugin = new HomeAssistantPlugin(noop)
            const h = plugin.getActionHandlers()
            const creds = { baseUrl: base, token: 'tok' }
            await h.get('scene-activate')!({ ...creds, entityId: 'scene.noche' }, {})
            await h.get('automation-trigger')!({ ...creds, entityId: 'automation.x' }, {})
            await h.get('cover-control')!({ ...creds, entityId: 'cover.salon', action: 'open' }, {})
            await h.get('cover-control')!({ ...creds, entityId: 'cover.salon', action: 'set-position', position: 50 }, {})
            await h.get('climate-set')!({ ...creds, entityId: 'climate.salon', temperature: 21 }, {})
            const paths = requests.map((r) => r.path)
            expect(paths).toContain('/api/services/scene/turn_on')
            expect(paths).toContain('/api/services/automation/trigger')
            expect(paths).toContain('/api/services/cover/open_cover')
            expect(paths).toContain('/api/services/cover/set_cover_position')
            expect(paths).toContain('/api/services/climate/set_temperature')
            const sensor = await h.get('sensor-value')!({ ...creds, entityId: 'sensor.t' }, {})
            expect(sensor.state).toBe('on')
            await expect(h.get('cover-control')!({ ...creds, entityId: 'cover.s', action: 'volar' }, {})).rejects.toThrow(/no válida/)
            await expect(h.get('climate-set')!({ ...creds, entityId: 'climate.s' }, {})).rejects.toThrow(/hvacMode|temperature/)
        } finally {
            server.stop()
        }
    })
})
