/**
 * PC Vitals Plugin
 * Monitor system metrics like CPU, GPU, RAM usage and temperatures
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

async function runCommand(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({ cmd, stdio: ['ignore', 'pipe', 'pipe'] })
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ])
    await proc.exited
    return { exitCode: proc.exitCode, stdout, stderr }
}

function degraded(action: string, reason: string, extra: Record<string, any> = {}): any {
    return { action, monitored: false, degraded: true, value: 'N/A', unit: '', reason, ...extra }
}

export class PCVitalsPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'pc-vitals',
            name: 'PC Vitals',
            version: '1.1.0',
            description: 'Muestra el estado del equipo: CPU, RAM, GPU, temperatura, disco, red, uptime y procesos',
            author: 'BunDeck',
            permissions: ['system', 'monitoring'],
            actions: [
                {
                    id: 'monitor',
                    name: 'Monitor PC Metric',
                    description: 'Display real-time system metrics on button',
                    icon: 'Activity',
                    dynamic: true,
                    schema: {
                        type: 'object',
                        properties: {
                            component: {
                                type: 'string',
                                title: 'Component',
                                description: 'System component to monitor',
                                enum: ['cpu', 'ram', 'gpu'],
                                default: 'cpu',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'cpu', label: 'CPU' },
                                        { value: 'ram', label: 'RAM' },
                                        { value: 'gpu', label: 'GPU' }
                                    ]
                                }
                            },
                            metric: {
                                type: 'string',
                                title: 'Metric',
                                description: 'What to measure',
                                enum: ['usage', 'temperature'],
                                default: 'usage',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'usage', label: 'Usage %' },
                                        { value: 'temperature', label: 'Temperature °C' }
                                    ]
                                }
                            },
                            updateInterval: {
                                type: 'number',
                                title: 'Update Interval (ms)',
                                description: 'How often to update the metric',
                                default: 1000,
                                minimum: 500,
                                maximum: 10000,
                                ui: {
                                    component: 'input',
                                    type: 'number',
                                    min: 500,
                                    max: 10000,
                                    placeholder: '1000'
                                }
                            }
                        },
                        required: ['component', 'metric']
                    }
                },
                {
                    id: 'gpu-temp',
                    name: 'Temperatura GPU',
                    description: 'Temperatura de la GPU (nvidia-smi o endpoint del sistema; degradado si no hay sensor)',
                    icon: 'Thermometer',
                    schema: {
                        type: 'object',
                        properties: {
                            updateInterval: {
                                type: 'number', title: 'Intervalo (ms)',
                                description: 'Reservado para botones dinámicos',
                                default: 1000, minimum: 500, maximum: 10000,
                                ui: { component: 'hidden' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'disk-usage',
                    name: 'Uso de disco',
                    description: 'Espacio usado/libre del disco (df en Linux/macOS, wmic en Windows)',
                    icon: 'HardDrive',
                    schema: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string', title: 'Ruta o unidad',
                                description: 'Ruta a medir (ej. / o C:). Vacío = raíz del sistema',
                                ui: { component: 'input', type: 'text', placeholder: 'Vacío = raíz' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'net-speed',
                    name: 'Velocidad de red',
                    description: 'KB/s enviados+recibidos (dos muestras de contadores del SO separadas 500 ms)',
                    icon: 'Wifi',
                    schema: {
                        type: 'object',
                        properties: {
                            sampleMs: {
                                type: 'number', title: 'Muestreo (ms)',
                                description: 'Tiempo entre las dos lecturas de contadores',
                                default: 500, minimum: 200, maximum: 5000,
                                ui: { component: 'hidden' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'uptime',
                    name: 'Tiempo encendido',
                    description: 'Segundos desde el arranque (siempre disponible, vía node:os)',
                    icon: 'Clock',
                    schema: { type: 'object', properties: {}, required: [] }
                },
                {
                    id: 'process-top',
                    name: 'Procesos top',
                    description: 'Procesos con más CPU/memoria (ps en Linux/macOS, tasklist en Windows)',
                    icon: 'ListOrdered',
                    schema: {
                        type: 'object',
                        properties: {
                            limit: {
                                type: 'number', title: 'Nº de procesos',
                                description: 'Cuántos procesos devolver',
                                default: 5, minimum: 1, maximum: 20,
                                ui: { component: 'input', type: 'number', placeholder: '5' }
                            },
                            sortBy: {
                                type: 'string', title: 'Ordenar por',
                                description: 'Criterio de orden',
                                enum: ['cpu', 'mem'], default: 'cpu',
                                ui: { component: 'select', options: [{ value: 'cpu', label: 'CPU' }, { value: 'mem', label: 'Memoria' }] }
                            }
                        },
                        required: []
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('monitor', this.monitorVitals.bind(this))
        handlers.set('gpu-temp', this.gpuTemp.bind(this))
        handlers.set('disk-usage', this.diskUsage.bind(this))
        handlers.set('net-speed', this.netSpeed.bind(this))
        handlers.set('uptime', this.uptime.bind(this))
        handlers.set('process-top', this.processTop.bind(this))
        return handlers
    }

    private async monitorVitals(params: any, context: any): Promise<any> {
        const { component, metric, updateInterval = 1000 } = params

        if (!component || !metric) {
            throw new Error('Component and metric are required for PC vitals monitoring')
        }

        this.context.log('info', `Monitoring ${component} ${metric}`, { component, metric, updateInterval })

        try {
            // Fetch current system metrics — puerto dinámico
            const { API_PORT } = await import('../config');
            const response = await fetch(`http://localhost:${API_PORT}/api/v1/system/metrics`)
            if (!response.ok) {
                throw new Error(`Failed to fetch system metrics: ${response.status}`)
            }

            const metrics = await response.json()

            // Extract the requested metric
            let value: number | null = null
            let unit = ''

            switch (component) {
                case 'cpu':
                    if (metric === 'usage') {
                        value = metrics.cpu.usage
                        unit = '%'
                    } else if (metric === 'temperature') {
                        value = metrics.cpu.temperature
                        unit = '°C'
                    }
                    break
                case 'ram':
                    if (metric === 'usage') {
                        value = metrics.ram.usage
                        unit = '%'
                    }
                    break
                case 'gpu':
                    if (metric === 'usage') {
                        value = metrics.gpu.usage
                        unit = '%'
                    } else if (metric === 'temperature') {
                        value = metrics.gpu.temperature
                        unit = '°C'
                    }
                    break
            }

            if (value === null) {
                return {
                    component,
                    metric,
                    value: 'N/A',
                    unit,
                    updateInterval,
                    monitored: true,
                    description: `${component.toUpperCase()} ${metric} not available`
                }
            }

            return {
                component,
                metric,
                value: Math.round(value * 10) / 10, // Round to 1 decimal place
                unit,
                updateInterval,
                monitored: true,
                description: `${component.toUpperCase()} ${metric}: ${value}${unit}`
            }
        } catch (error) {
            this.context.log('error', `Failed to monitor PC vitals: ${error}`, { component, metric })
            return {
                component,
                metric,
                value: 'Error',
                unit: '',
                updateInterval,
                monitored: false,
                description: `Error monitoring ${component} ${metric}`
            }
        }
    }

    /**
     * Temperatura de la GPU: intenta nvidia-smi, si no existe usa el
     * endpoint de métricas del daemon, y si tampoco hay sensor devuelve
     * degradado (sin lanzar) para paneles sin GPU dedicada.
     */
    private async gpuTemp(params: any, _context: any): Promise<any> {
        try {
            const smi = await runCommand(['nvidia-smi', '--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'])
            const value = parseFloat(smi.stdout.trim().split('\n')[0] ?? '')
            if (smi.exitCode === 0 && Number.isFinite(value)) {
                return { action: 'gpu-temp', component: 'gpu', metric: 'temperature', value, unit: '°C', monitored: true, source: 'nvidia-smi' }
            }
        } catch { /* sin nvidia-smi: prueba el endpoint */ }
        try {
            const { API_PORT } = await import('../config')
            const response = await fetch(`http://localhost:${API_PORT}/api/v1/system/metrics`)
            if (response.ok) {
                const metrics = await response.json()
                const value = metrics?.gpu?.temperature
                if (typeof value === 'number') {
                    return { action: 'gpu-temp', component: 'gpu', metric: 'temperature', value: Math.round(value * 10) / 10, unit: '°C', monitored: true, source: 'system-metrics' }
                }
            }
        } catch { /* sin endpoint: degradado */ }
        this.context.log('warn', 'gpu-temp: sin sensor de GPU disponible (ni nvidia-smi ni endpoint)')
        return degraded('gpu-temp', 'Sin sensor de GPU: instala drivers NVIDIA (nvidia-smi) o revisa el endpoint /api/v1/system/metrics')
    }

    /**
     * Uso de disco: df -k en Linux/macOS, wmic en Windows.
     * Sin comando disponible devuelve degradado.
     */
    private async diskUsage(params: any, _context: any): Promise<any> {
        const target = typeof params?.path === 'string' && params.path.trim() ? params.path.trim() : (process.platform === 'win32' ? 'C:' : '/')
        try {
            if (process.platform === 'win32') {
                const drive = /^[a-zA-Z]:/.test(target) ? target.slice(0, 2).toUpperCase() : 'C:'
                const out = await runCommand(['wmic', 'logicaldisk', 'where', `DeviceID='${drive}'`, 'get', 'Size,FreeSpace', '/format:csv'])
                const line = out.stdout.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => /^\S+,\d*,\d*$/.test(l) || /^[^,]+,\d+,\d+/.test(l))
                if (out.exitCode === 0 && line) {
                    const parts = line.split(',')
                    const free = Number(parts[parts.length - 2] || parts[1])
                    const size = Number(parts[parts.length - 1] || parts[2])
                    if (Number.isFinite(size) && size > 0 && Number.isFinite(free)) {
                        const used = size - free
                        const pct = Math.round((used / size) * 1000) / 10
                        return { action: 'disk-usage', path: drive, usedGB: Math.round(used / 1e9 * 10) / 10, totalGB: Math.round(size / 1e9 * 10) / 10, value: pct, unit: '%', monitored: true, source: 'wmic' }
                    }
                }
            } else {
                const out = await runCommand(['df', '-k', '-P', target])
                const row = out.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean)[0]
                if (out.exitCode === 0 && row) {
                    const cols = row.split(/\s+/)
                    // df -P: filesystem 1024-blocks Used Available Capacity Mounted
                    const sizeKb = Number(cols[1])
                    const usedKb = Number(cols[2])
                    const pct = parseFloat((cols[4] ?? '').replace('%', ''))
                    if (Number.isFinite(sizeKb) && Number.isFinite(usedKb) && Number.isFinite(pct)) {
                        return { action: 'disk-usage', path: target, usedGB: Math.round(usedKb / 1024 / 1024 * 10) / 10, totalGB: Math.round(sizeKb / 1024 / 1024 * 10) / 10, value: pct, unit: '%', monitored: true, source: 'df' }
                    }
                }
            }
        } catch { /* degradado abajo */ }
        this.context.log('warn', `disk-usage: no se pudo medir ${target}`)
        return degraded('disk-usage', `No se pudo medir el disco de "${target}" en ${process.platform}`, { path: target })
    }

    private async readNetCounters(): Promise<{ rx: number; tx: number } | null> {
        try {
            if (process.platform === 'linux') {
                const { readFile } = await import('node:fs/promises')
                const text = await readFile('/proc/net/dev', 'utf8')
                let rx = 0
                let tx = 0
                for (const line of text.split('\n')) {
                    const m = line.match(/^\s*([^:]+):\s*(.+)$/)
                    if (!m || m[1].trim() === 'lo') continue
                    const nums = m[2].trim().split(/\s+/).map(Number)
                    if (nums.length >= 9 && nums.every(Number.isFinite)) {
                        rx += nums[0]
                        tx += nums[8]
                    }
                }
                return { rx, tx }
            }
            if (process.platform === 'darwin') {
                const out = await runCommand(['netstat', '-ib'])
                let rx = 0
                let tx = 0
                for (const line of out.stdout.split('\n').slice(1)) {
                    const cols = line.trim().split(/\s+/)
                    if (cols.length >= 10 && !/^lo\d?/.test(cols[0])) {
                        const r = Number(cols[6])
                        const t = Number(cols[9])
                        if (Number.isFinite(r)) rx += r
                        if (Number.isFinite(t)) tx += t
                    }
                }
                return out.exitCode === 0 ? { rx, tx } : null
            }
            // Windows: netstat -e (bytes recibidos/enviados)
            const out = await runCommand(['netstat', '-e'])
            const m = out.stdout.match(/Bytes\s+(\d+)\s+(\d+)/i)
            if (out.exitCode === 0 && m) return { rx: Number(m[1]), tx: Number(m[2]) }
            return null
        } catch {
            return null
        }
    }

    /**
     * Velocidad de red: dos lecturas de contadores separadas sampleMs.
     * Sin contadores devuelve degradado (sin lanzar).
     */
    private async netSpeed(params: any, _context: any): Promise<any> {
        const sampleMsRaw = params?.sampleMs
        const sampleMs = sampleMsRaw === undefined ? 500 : Number(sampleMsRaw)
        if (!Number.isFinite(sampleMs) || sampleMs < 200 || sampleMs > 5000) {
            throw new Error('El muestreo (sampleMs) debe estar entre 200 y 5000 ms')
        }
        const first = await this.readNetCounters()
        if (!first) {
            this.context.log('warn', 'net-speed: sin contadores de red en esta plataforma')
            return degraded('net-speed', `Sin contadores de red disponibles en ${process.platform}`)
        }
        await new Promise((r) => setTimeout(r, sampleMs))
        const second = await this.readNetCounters()
        if (!second) {
            return degraded('net-speed', 'La segunda lectura de contadores falló')
        }
        const deltaBytes = Math.max(0, second.rx - first.rx) + Math.max(0, second.tx - first.tx)
        const kbps = Math.round((deltaBytes / 1024 / (sampleMs / 1000)) * 10) / 10
        return { action: 'net-speed', value: kbps, unit: 'KB/s', downKBs: Math.round(Math.max(0, second.rx - first.rx) / 1024 / (sampleMs / 1000) * 10) / 10, upKBs: Math.round(Math.max(0, second.tx - first.tx) / 1024 / (sampleMs / 1000) * 10) / 10, monitored: true, source: process.platform }
    }

    /** Tiempo encendido: siempre disponible vía node:os. */
    private async uptime(_params: any, _context: any): Promise<any> {
        const { uptime } = await import('node:os')
        const seconds = Math.floor(uptime())
        const days = Math.floor(seconds / 86400)
        const hours = Math.floor((seconds % 86400) / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)
        const human = days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
        return { action: 'uptime', value: seconds, unit: 's', human, monitored: true, source: 'node:os' }
    }

    /**
     * Top de procesos: ps en Linux/macOS, tasklist en Windows.
     * Sin comando disponible devuelve degradado.
     */
    private async processTop(params: any, _context: any): Promise<any> {
        const limitRaw = params?.limit
        const limit = limitRaw === undefined ? 5 : Number(limitRaw)
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
            throw new Error('El límite (limit) debe ser un entero entre 1 y 20')
        }
        const sortBy = params?.sortBy ?? 'cpu'
        if (sortBy !== 'cpu' && sortBy !== 'mem') {
            throw new Error('Orden (sortBy) no válido: usa "cpu" o "mem"')
        }
        try {
            if (process.platform === 'win32') {
                const out = await runCommand(['tasklist', '/FO', 'CSV', '/NH'])
                if (out.exitCode !== 0) throw new Error('tasklist falló')
                const rows = out.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('"'))
                const procs = rows.slice(0, limit).map((r) => {
                    const cols = r.split('","').map((c) => c.replace(/^"|"$/g, ''))
                    return { name: cols[0] ?? '?', pid: Number(cols[1]) || null, memory: cols[4] ?? null }
                })
                if (procs.length === 0) throw new Error('sin filas')
                return { action: 'process-top', sortBy, limit, processes: procs, monitored: true, source: 'tasklist', note: 'tasklist no da %CPU: orden no garantizado en Windows' }
            }
            const sortFlag = sortBy === 'cpu' ? '-pcpu' : '-rss'
            const out = await runCommand(['ps', '-eo', 'pid,pcpu,rss,comm', '--sort', sortFlag])
            if (out.exitCode !== 0) throw new Error('ps falló')
            const rows = out.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).slice(-limit).reverse()
            const procs = rows.map((r) => {
                const m = r.match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
                return m ? { pid: Number(m[1]), cpu: Number(m[2]), rssKb: Number(m[3]), name: m[4] } : { raw: r }
            })
            if (procs.length === 0) throw new Error('sin filas')
            return { action: 'process-top', sortBy, limit, processes: procs, monitored: true, source: 'ps' }
        } catch {
            this.context.log('warn', 'process-top: sin listado de procesos disponible')
            return degraded('process-top', `No se pudo listar procesos en ${process.platform}`, { sortBy, limit, processes: [] })
        }
    }

    public dispose(): void {
        // Cleanup if needed
    }
}