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
const realSpawn = Bun.spawn

function stubFetchMetrics(metrics: any) {
    globalThis.fetch = (async () => new Response(JSON.stringify(metrics), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
}

function emptyStream() {
    return new ReadableStream({ start(c) { c.close() } })
}

afterEach(() => {
    globalThis.fetch = realFetch
    ;(Bun as any).spawn = realSpawn
})

// Los handlers nuevos (cpu-temp/fan-speed/sensors) prueban CLIs del SO
// (nvidia-smi, powershell WMI) antes de degradarse: en Windows el spawn
// real de powershell tarda segundos y hace flaky el test. Se stubbea para
// que las vías CLI fallen rápido y se ejercite el degradado honesto.
function stubSpawnFailFast() {
    ;(Bun as any).spawn = ((_opts: any) => ({
        exitCode: 1,
        exited: Promise.resolve(1),
        stdout: emptyStream(),
        stderr: emptyStream(),
    })) as typeof Bun.spawn
}

const FAKE = {
    cpu: { usage: 42.46, temperature: 55.5 },
    ram: { usage: 71.2 },
    gpu: { usage: 10.04, temperature: 48.0 },
}

describe('PCVitalsPlugin', () => {
    it('expone un manifest válido (picker consolidado en monitor)', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('pc-vitals')
        expect(manifest.version).toBe('1.4.0')
        expect(manifest.actions.length).toBeGreaterThanOrEqual(8)
        const byId = Object.fromEntries(manifest.actions.map((a: any) => [a.id, a]))
        expect(byId.monitor).toBeDefined()
        expect(byId.monitor.dynamic).toBe(true)
        expect(byId.monitor.schema.required).toEqual(['component', 'metric'])
        expect(byId.monitor.schema.properties.component.enum).toEqual(['cpu', 'ram', 'gpu'])
        expect(byId.monitor.schema.properties.metric.enum).toEqual(['usage', 'temperature'])
        expect(JSON.parse(JSON.stringify(byId.monitor.schema))).toEqual(byId.monitor.schema)
        // Picker: monitor + summary + no duplicados (fan-speed/sensors sí son propios)
        for (const id of ['monitor', 'summary', 'fan-speed', 'sensors', 'disk-usage', 'net-speed', 'uptime', 'process-top']) {
            expect(byId[id], `acción ${id} registrada`).toBeDefined()
            expect(byId[id].schema?.type).toBe('object')
            expect(Array.isArray(byId[id].schema?.required)).toBe(true)
        }
        // gpu-temp/cpu-temp/gpu-usage NO están en el picker: los cubre monitor
        for (const id of ['gpu-temp', 'cpu-temp', 'gpu-usage']) {
            expect(byId[id], `acción ${id} no debe estar en el picker`).toBeUndefined()
        }
    })

    it('registra el handler monitor (más los nuevos; aliases de compatibilidad siguen existiendo)', () => {
        const { plugin } = makePlugin()
        expect(plugin.getActionHandlers().has('monitor')).toBe(true)
        for (const id of ['fan-speed', 'sensors', 'disk-usage', 'net-speed', 'uptime', 'process-top']) {
            expect(plugin.getActionHandlers().has(id)).toBe(true)
        }
        // Aliases ocultos del picker pero funcionales para botones ya guardados
        for (const id of ['gpu-temp', 'cpu-temp', 'gpu-usage']) {
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

    it('cpu-temp usa el endpoint y devuelve state por umbrales', async () => {
        const { plugin } = makePlugin()
        stubSpawnFailFast()
        stubFetchMetrics({ cpu: { usage: 20, temperature: 95.2 }, ram: { usage: 10 }, gpu: {}, fans: [], voltages: [], sources: { cpuTemp: 'system-metrics' } })
        const res = await plugin.getActionHandlers().get('cpu-temp')!({}, {})
        expect(res).toMatchObject({ component: 'cpu', value: 95.2, unit: '°C', state: 'crit', monitored: true })
    })

    it('cpu-temp degradado honesto sin sensor (no inventa datos)', async () => {
        const { plugin } = makePlugin()
        stubSpawnFailFast()
        stubFetchMetrics({ cpu: { usage: 20, temperature: null }, ram: { usage: 10 }, gpu: {}, fans: [], voltages: [] })
        const res = await plugin.getActionHandlers().get('cpu-temp')!({}, {})
        // En Linux sin sysfs/sensors puede degradarse; en cualquier caso nunca lanza
        expect(typeof res.monitored).toBe('boolean')
        if (!res.monitored) {
            expect(res.degraded).toBe(true)
            expect(String(res.reason)).toMatch(/LibreHardwareMonitor|sensor/i)
        }
    })

    it('gpu-usage y fan-speed no lanzan sin sensor', async () => {
        const { plugin } = makePlugin()
        stubSpawnFailFast()
        stubFetchMetrics({ cpu: {}, ram: {}, gpu: { usage: null }, fans: [], voltages: [] })
        for (const id of ['gpu-usage', 'fan-speed']) {
            const res = await plugin.getActionHandlers().get(id)!({}, {})
            expect(typeof res.monitored).toBe('boolean')
            if (!res.monitored) expect(res.degraded).toBe(true)
        }
    })

    it('summary devuelve foto global: cpu/ram/gpu + disco + uptime', async () => {
        const { plugin } = makePlugin()
        stubSpawnFailFast()
        stubFetchMetrics({ cpu: { usage: 95.2 }, ram: { usage: 10 }, gpu: { usage: 20, temperature: 55 }, sources: {} })
        const res = await plugin.getActionHandlers().get('summary')!({}, {})
        // Compat: forma anterior intacta
        expect(res).toMatchObject({ action: 'summary', state: 'crit', cpu: 95.2, ram: 10, monitored: true })
        expect(res.widget).toMatchObject({ kind: 'gauge' })
        // Nuevo: GPU + disco + uptime en la misma llamada
        expect(res.gpu).toMatchObject({ usage: 20, temperature: 55 })
        expect(res.uptime?.monitored ?? res.uptime?.human).toBeDefined()
        expect(res.disk === null || typeof res.disk.value === 'number').toBe(true)
    })

    it('sensors devuelve catálogo con fuentes', async () => {
        const { plugin } = makePlugin()
        stubSpawnFailFast()
        stubFetchMetrics({ cpu: { usage: 10, temperature: null }, ram: { usage: 20, used: 3 }, gpu: { usage: null, temperature: null }, fans: [], voltages: [], sources: {} })
        const res = await plugin.getActionHandlers().get('sensors')!({}, {})
        expect(res.monitored).toBe(true)
        expect(Array.isArray(res.sensors)).toBe(true)
        const ids = res.sensors.map((s: any) => s.id)
        for (const id of ['cpu.usage', 'cpu.temp', 'gpu.usage', 'gpu.temp', 'ram.usage']) {
            expect(ids).toContain(id)
        }
    })
})
