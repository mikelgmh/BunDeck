import { describe, it, expect, afterEach } from 'bun:test'
import { PCVitalsPlugin } from '../plugins/pc-vitals.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new PCVitalsPlugin({
        log: (level: string, message: string, meta?: any) => {
            logs.push({ level, message, meta })
        }
    })
    return { plugin, logs }
}

const realFetch = globalThis.fetch

function stubFetchMetrics(metrics: any) {
    globalThis.fetch = (async () => new Response(JSON.stringify(metrics), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
}

afterEach(() => {
    globalThis.fetch = realFetch
})

const FAKE = {
    cpu: { usage: 42.46, temperature: 55.5 },
    ram: { usage: 71.2 },
    gpu: { usage: 10.04, temperature: 48.0 },
}

describe('PCVitalsPlugin', () => {
    it('expone un manifest válido con la acción monitor (más 5 nuevas)', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('pc-vitals')
        expect(manifest.version).toBe('1.1.0')
        expect(manifest.actions.length).toBeGreaterThanOrEqual(6)
        const byId = Object.fromEntries(manifest.actions.map((a: any) => [a.id, a]))
        expect(byId.monitor).toBeDefined()
        expect(byId.monitor.dynamic).toBe(true)
        expect(byId.monitor.schema.required).toEqual(['component', 'metric'])
        expect(byId.monitor.schema.properties.component.enum).toEqual(['cpu', 'ram', 'gpu'])
        expect(byId.monitor.schema.properties.metric.enum).toEqual(['usage', 'temperature'])
        expect(JSON.parse(JSON.stringify(byId.monitor.schema))).toEqual(byId.monitor.schema)
        for (const id of ['gpu-temp', 'disk-usage', 'net-speed', 'uptime', 'process-top']) {
            expect(byId[id], `acción ${id} registrada`).toBeDefined()
            expect(byId[id].schema?.type).toBe('object')
            expect(Array.isArray(byId[id].schema?.required)).toBe(true)
        }
    })

    it('registra el handler monitor (más los nuevos)', () => {
        const { plugin } = makePlugin()
        expect(plugin.getActionHandlers().has('monitor')).toBe(true)
        for (const id of ['gpu-temp', 'disk-usage', 'net-speed', 'uptime', 'process-top']) {
            expect(plugin.getActionHandlers().has(id)).toBe(true)
        }
    })

    it('exige component y metric', async () => {
        const { plugin } = makePlugin()
        await expect(plugin.getActionHandlers().get('monitor')!({}, {})).rejects.toThrow(/Component and metric are required/)
    })

    it('cpu usage devuelve valor redondeado a 1 decimal', async () => {
        const { plugin } = makePlugin()
        stubFetchMetrics(FAKE)
        const res = await plugin.getActionHandlers().get('monitor')!({ component: 'cpu', metric: 'usage' }, {})
        expect(res).toMatchObject({ component: 'cpu', metric: 'usage', value: 42.5, unit: '%', monitored: true })
    })

    it('cpu temperature usa °C', async () => {
        const { plugin } = makePlugin()
        stubFetchMetrics(FAKE)
        const res = await plugin.getActionHandlers().get('monitor')!({ component: 'cpu', metric: 'temperature' }, {})
        expect(res).toMatchObject({ value: 55.5, unit: '°C', monitored: true })
    })

    it('ram sin temperature disponible devuelve N/A monitorizado', async () => {
        const { plugin } = makePlugin()
        stubFetchMetrics(FAKE)
        const res = await plugin.getActionHandlers().get('monitor')!({ component: 'ram', metric: 'temperature' }, {})
        expect(res.value).toBe('N/A')
        expect(res.monitored).toBe(true)
    })

    it('si el endpoint falla devuelve monitored:false sin lanzar', async () => {
        const { plugin } = makePlugin()
        globalThis.fetch = (async () => { throw new Error('conn refused') }) as typeof fetch
        const res = await plugin.getActionHandlers().get('monitor')!({ component: 'cpu', metric: 'usage' }, {})
        expect(res.monitored).toBe(false)
        expect(res.value).toBe('Error')
    })

    it('dispose no falla', () => {
        const { plugin } = makePlugin()
        expect(() => plugin.dispose()).not.toThrow()
    })
})
