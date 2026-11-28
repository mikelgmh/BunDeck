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

import { CONTRACT_API_VERSION, CONTRACT_ENGINE } from './contract'

async function runCommand(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({ windowsHide: true,  cmd, stdio: ['ignore', 'pipe', 'pipe'] })
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
            version: '1.4.2',
            description: 'Muestra el estado del equipo: CPU, RAM, GPU, temperatura, ventiladores, voltajes, disco, red, uptime y procesos',
            author: 'BunDeck',
            apiVersion: CONTRACT_API_VERSION,
            engine: CONTRACT_ENGINE,
            category: 'system',
            permissions: ['system', 'monitoring'],
            widgets: [
                { id: 'cpu', kind: 'gauge', title: 'CPU', description: 'Uso de CPU en %', sourceAction: 'summary', refreshMs: 2000 },
                { id: 'ram', kind: 'gauge', title: 'RAM', description: 'Uso de RAM en %', sourceAction: 'summary', refreshMs: 2000 }
            ],
            actions: [
                {
                    id: 'summary',
                    name: 'Resumen del sistema',
                    description: 'CPU/RAM/GPU/disco/uptime en una sola llamada (widgets gauge + iconos por umbral)',
                    i18n: { es: { name: 'Resumen del sistema', description: 'CPU/RAM/GPU/disco/uptime en una sola llamada (widgets gauge + iconos por umbral)' }, en: { name: 'Resumen del sistema', description: 'CPU/RAM/GPU/disco/uptime en una sola llamada (widgets gauge + iconos por umbral)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Gauge',
                    dynamic: true,
                    surface: 'control',
                    component: 'status-cards',
                    pollMs: 5000,
                    timeoutMs: 15000,
                    states: [
                        { value: 'ok', label: 'Normal', icon: 'Activity' },
                        { value: 'warn', label: 'Carga alta', icon: 'TriangleAlert' },
                        { value: 'crit', label: 'Crítica', icon: 'Siren' }
                    ],
                    schema: {
                        type: 'object',
                        properties: {
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'monitor',
                    name: 'Monitor PC Metric',
                    description: 'Métrica CPU/RAM/GPU en botón (uso % o temperatura; cubre lo que antes eran acciones separadas de temperatura/uso)',
                    i18n: { es: { name: 'Monitor PC Metric', description: 'Métrica CPU/RAM/GPU en botón (uso % o temperatura; cubre lo que antes eran acciones separadas de temperatura/uso)' }, en: { name: 'Monitor PC Metric', description: 'Métrica CPU/RAM/GPU en botón (uso % o temperatura; cubre lo que antes eran acciones separadas de temperatura/uso)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Activity',
                    dynamic: true,
                    surface: 'control',
                    component: 'status-cards',
                    pollMs: 2000,
                    timeoutMs: 10000,
                    states: [
                        { value: 'ok', label: 'Normal', icon: 'Activity' },
                        { value: 'warn', label: 'Carga alta', icon: 'TriangleAlert' },
                        { value: 'crit', label: 'Crítica', icon: 'Siren' }
                    ],
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
                            },
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: ['component', 'metric']
                    }
                },
                {
                    id: 'fan-speed',
                    name: 'Ventiladores',
                    description: 'RPM de ventiladores (requiere LHM/OHM con driver+admin en Windows, hwmon/sensors en Linux; degradado si no hay sensor)',
                    i18n: { es: { name: 'Ventiladores', description: 'RPM de ventiladores (requiere LHM/OHM con driver+admin en Windows, hwmon/sensors en Linux; degradado si no hay sensor)' }, en: { name: 'Ventiladores', description: 'RPM de ventiladores (requiere LHM/OHM con driver+admin en Windows, hwmon/sensors en Linux; degradado si no hay sensor)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Fan',
                    surface: 'control',
                    component: 'status-cards',
                    schema: {
                        type: 'object',
                        properties: {
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'sensors',
                    name: 'Todos los sensores',
                    description: 'Catálogo de sensores disponibles (CPU/GPU/RAM/fans/voltajes + fuentes), como el catalog del plugin LHM de Macro-Deck',
                    i18n: { es: { name: 'Todos los sensores', description: 'Catálogo de sensores disponibles (CPU/GPU/RAM/fans/voltajes + fuentes), como el catalog del plugin LHM de Macro-Deck' }, en: { name: 'Todos los sensores', description: 'Catálogo de sensores disponibles (CPU/GPU/RAM/fans/voltajes + fuentes), como el catalog del plugin LHM de Macro-Deck' } }, // TODO i18n: EN temporal = ES
                    icon: 'ListOrdered',
                    schema: { type: 'object', properties: {}, required: [] }
                },
                {
                    id: 'disk-usage',
                    name: 'Uso de disco',
                    description: 'Espacio usado/libre del disco (df en Linux/macOS, CIM/wmic en Windows)',
                    i18n: { es: { name: 'Uso de disco', description: 'Espacio usado/libre del disco (df en Linux/macOS, CIM/wmic en Windows)' }, en: { name: 'Uso de disco', description: 'Espacio usado/libre del disco (df en Linux/macOS, CIM/wmic en Windows)' } }, // TODO i18n: EN temporal = ES
                    icon: 'HardDrive',
                    surface: 'control',
                    component: 'status-cards',
                    schema: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string', title: 'Ruta o unidad',
                                description: 'Ruta a medir (ej. / o C:). Vacío = raíz del sistema',
                                ui: { component: 'input', type: 'text', placeholder: 'Vacío = raíz' }
                            },
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'net-speed',
                    name: 'Velocidad de red',
                    description: 'KB/s enviados+recibidos (dos muestras de contadores del SO separadas 500 ms)',
                    i18n: { es: { name: 'Velocidad de red', description: 'KB/s enviados+recibidos (dos muestras de contadores del SO separadas 500 ms)' }, en: { name: 'Velocidad de red', description: 'KB/s enviados+recibidos (dos muestras de contadores del SO separadas 500 ms)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Wifi',
                    surface: 'control',
                    component: 'status-cards',
                    schema: {
                        type: 'object',
                        properties: {
                            sampleMs: {
                                type: 'number', title: 'Muestreo (ms)',
                                description: 'Tiempo entre las dos lecturas de contadores',
                                default: 500, minimum: 200, maximum: 5000,
                                ui: { component: 'hidden' }
                            },
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'uptime',
                    name: 'Tiempo encendido',
                    description: 'Segundos desde el arranque (siempre disponible, vía node:os)',
                    i18n: { es: { name: 'Tiempo encendido', description: 'Segundos desde el arranque (siempre disponible, vía node:os)' }, en: { name: 'Tiempo encendido', description: 'Segundos desde el arranque (siempre disponible, vía node:os)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Clock',
                    surface: 'control',
                    component: 'status-cards',
                    schema: {
                        type: 'object',
                        properties: {
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'process-top',
                    name: 'Procesos top',
                    description: 'Procesos con más CPU/memoria (ps en Linux/macOS, tasklist en Windows)',
                    i18n: { es: { name: 'Procesos top', description: 'Procesos con más CPU/memoria (ps en Linux/macOS, tasklist en Windows)' }, en: { name: 'Procesos top', description: 'Procesos con más CPU/memoria (ps en Linux/macOS, tasklist en Windows)' } }, // TODO i18n: EN temporal = ES
                    icon: 'ListOrdered',
                    surface: 'control',
                    component: 'status-cards',
                    timeoutMs: 15000,
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
                            },
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
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
        handlers.set('summary', this.systemSummary.bind(this))
        // Aliases de compatibilidad (no aparecen en el picker desde 1.4.0:
        // todo eso lo cubre `monitor` con component+metric). Se conservan para
        // no romper botones ya guardados con esos tipos.
        handlers.set('gpu-temp', this.gpuTemp.bind(this))
        handlers.set('cpu-temp', this.cpuTemp.bind(this))
        handlers.set('gpu-usage', this.gpuUsage.bind(this))
        handlers.set('fan-speed', this.fanSpeed.bind(this))
        handlers.set('sensors', this.allSensors.bind(this))
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

        // Sin log por sondeo: monitor se ejecuta cada updateInterval (p. ej.
        // 1 s) por cada botón dinámico; loguear cada vez llenaba la BD
        // (105k+ filas "Monitoring cpu/ram usage"). Solo se loguean errores.

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
     * Temperatura de la GPU: nvidia-smi → rocm-smi (AMD Linux) →
     * endpoint del daemon (GPU Engine / LHM-WMI / LHM-remote) →
     * degradado honesto (sin lanzar).
     */
    private async gpuTemp(params: any, _context: any): Promise<any> {
        try {
            const smi = await runCommand(['nvidia-smi', '--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'])
            const value = parseFloat(smi.stdout.trim().split('\n')[0] ?? '')
            if (smi.exitCode === 0 && Number.isFinite(value)) {
                return { action: 'gpu-temp', component: 'gpu', metric: 'temperature', value, unit: '°C', monitored: true, source: 'nvidia-smi' }
            }
        } catch { /* sin nvidia-smi: sigue */ }
        if (process.platform === 'linux') {
            try {
                const rocm = await runCommand(['rocm-smi', '--showtemp'])
                const m = rocm.stdout.match(/([\d.]+)\s*c/i)
                const value = m ? Number(m[1]) : NaN
                if (rocm.exitCode === 0 && Number.isFinite(value)) {
                    return { action: 'gpu-temp', component: 'gpu', metric: 'temperature', value, unit: '°C', monitored: true, source: 'rocm-smi' }
                }
            } catch { /* sin rocm-smi */ }
        }
        try {
            const metrics = await this.fetchEndpointMetrics()
            const value = metrics?.gpu?.temperature
            if (typeof value === 'number') {
                return { action: 'gpu-temp', component: 'gpu', metric: 'temperature', value: Math.round(value * 10) / 10, unit: '°C', monitored: true, source: metrics?.sources?.gpuTemp ?? 'system-metrics' }
            }
        } catch { /* sin endpoint: degradado */ }
        this.context.log('warn', 'gpu-temp: sin sensor de GPU disponible (ni nvidia-smi/rocm-smi ni endpoint)')
        return degraded('gpu-temp', 'Sin sensor de GPU: en NVIDIA instala drivers (nvidia-smi); en AMD usa LibreHardwareMonitor/HWiNFO o rocm-smi en Linux')
    }

    /** Lee métricas del endpoint local con timeout corto. Devuelve null si falla. */
    private async fetchEndpointMetrics(): Promise<any | null> {
        try {
            const { API_PORT } = await import('../config')
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 8000)
            try {
                const response = await fetch(`http://localhost:${API_PORT}/api/v1/system/metrics`, { signal: ctrl.signal })
                if (!response.ok) return null
                return await response.json()
            } finally {
                clearTimeout(timer)
            }
        } catch {
            return null
        }
    }

    /** Sensores LHM/OHM vía WMI (Windows). Requiere LHM corriendo + driver/admin para CPU/fans. */
    private async readLhmWmi(): Promise<{ temps: number[]; fans: any[]; voltages: any[]; source: string | null }> {
        const empty = { temps: [] as number[], fans: [] as any[], voltages: [] as any[], source: null as string | null };
        if (process.platform !== 'win32') return empty
        // Un solo spawn de PowerShell que prueba ambos namespaces (antes eran 2).
        try {
            const ps = `$s = $null; $nsUsed = $null; ` +
                `foreach ($ns in @('root/LibreHardwareMonitor','root/OpenHardwareMonitor')) { ` +
                `try { $s = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction Stop; $nsUsed = $ns; break } catch {} }; ` +
                `if (-not $s) { @{} | ConvertTo-Json -Compress }; ` +
                `$t = @($s | Where-Object { $_.SensorType -eq 'Temperature' } | ForEach-Object { try { [double]$_.Value } catch {} } | Where-Object { $_ -gt -50 -and $_ -lt 150 }); ` +
                `$f = @($s | Where-Object { $_.SensorType -eq 'Fan' } | Select-Object -First 4 Name, Value); ` +
                `$v = @($s | Where-Object { $_.SensorType -eq 'Voltage' } | Select-Object -First 4 Name, Value); ` +
                `@{ temps = $t; fans = @($f | ForEach-Object { @{ name = $_.Name; value = $_.Value } }); volts = @($v | ForEach-Object { @{ name = $_.Name; value = $_.Value } }); ns = $nsUsed } | ConvertTo-Json -Compress -Depth 4`
            const out = await runCommand(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps])
            if (out.exitCode !== 0 || !out.stdout.trim().startsWith('{')) return empty
            const data = JSON.parse(out.stdout.trim())
            const temps = (Array.isArray(data.temps) ? data.temps : []).map(Number).filter((n) => Number.isFinite(n))
            if (temps.length === 0 && (data.fans?.length ?? 0) === 0) return empty
            return {
                temps,
                fans: (data.fans ?? []).map((f: any) => ({ name: String(f.name ?? 'Fan'), value: Math.round(Number(f.value)), unit: 'RPM' })).filter((f: any) => Number.isFinite(f.value)).slice(0, 8),
                voltages: (data.volts ?? []).map((v: any) => ({ name: String(v.name ?? 'V'), value: Math.round(Number(v.value) * 1000) / 1000, unit: 'V' })).filter((v: any) => Number.isFinite(v.value)).slice(0, 8),
                source: data.ns === 'root/OpenHardwareMonitor' ? 'openhardwaremonitor-wmi' : 'librehardwaremonitor-wmi',
            }
        } catch { return empty }
    }

    /** Temperatura CPU en Linux/macOS sin driver: sysfs thermal/hwmon o `sensors`. */
    private async readUnixCpuTemp(): Promise<{ value: number | null; source: string | null }> {
        if (process.platform === 'win32') return { value: null, source: null }
        try {
            const { readFile, readdir } = await import('node:fs/promises')
            if (process.platform === 'linux') {
                try {
                    const zones = await readdir('/sys/class/thermal').catch(() => [] as string[])
                    const vals: number[] = []
                    for (const z of zones.filter((z) => z.startsWith('thermal_zone'))) {
                        try {
                            const raw = await readFile(`/sys/class/thermal/${z}/temp`, 'utf8')
                            const v = Number(raw.trim())
                            if (Number.isFinite(v)) vals.push(v > 1000 ? v / 1000 : v)
                        } catch {}
                    }
                    if (vals.length > 0) return { value: Math.round(Math.max(...vals) * 10) / 10, source: 'sys-thermal-zone' }
                } catch {}
                try {
                    const out = await runCommand(['sensors', '-j'])
                    if (out.exitCode === 0 && out.stdout.trim().startsWith('{')) {
                        const data = JSON.parse(out.stdout)
                        const vals: number[] = []
                        const walk = (o: any): void => {
                            if (!o || typeof o !== 'object') return
                            for (const [k, v] of Object.entries(o)) {
                                if (/temp\d*_input/i.test(k) && typeof v === 'number' && v > -50 && v < 150) vals.push(v)
                                else walk(v)
                            }
                        }
                        walk(data)
                        if (vals.length > 0) return { value: Math.round(Math.max(...vals) * 10) / 10, source: 'lm-sensors' }
                    }
                } catch {}
            }
        } catch {}
        return { value: null, source: null }
    }

    /**
     * Temperatura CPU dedicada (Fase 2, paridad Macro-Deck LHM):
     * LHM/OHM-WMI → endpoint (ACPI/LHM-remote) → sysfs/sensors (Linux) →
     * degradado honesto explicando PawnIO/admin (igual que Macro-Deck).
     */
    private async cpuTemp(_params: any, _context: any): Promise<any> {
        const lhm = await this.readLhmWmi()
        if (lhm.temps.length > 0) {
            const value = Math.round(Math.max(...lhm.temps) * 10) / 10
            const state = value >= 90 ? 'crit' : value >= 75 ? 'warn' : 'ok'
            return { action: 'cpu-temp', component: 'cpu', metric: 'temperature', value, unit: '°C', state, monitored: true, source: lhm.source }
        }
        const metrics = await this.fetchEndpointMetrics()
        if (typeof metrics?.cpu?.temperature === 'number') {
            const value = Math.round(metrics.cpu.temperature * 10) / 10
            const state = value >= 90 ? 'crit' : value >= 75 ? 'warn' : 'ok'
            return { action: 'cpu-temp', component: 'cpu', metric: 'temperature', value, unit: '°C', state, monitored: true, source: metrics?.sources?.cpuTemp ?? 'system-metrics' }
        }
        const unix = await this.readUnixCpuTemp()
        if (unix.value != null) {
            const state = unix.value >= 90 ? 'crit' : unix.value >= 75 ? 'warn' : 'ok'
            return { action: 'cpu-temp', component: 'cpu', metric: 'temperature', value: unix.value, unit: '°C', state, monitored: true, source: unix.source }
        }
        this.context.log('warn', 'cpu-temp: sin sensor (se necesita LHM/OHM + driver con admin en Windows)')
        return degraded('cpu-temp', 'Sin sensor de CPU: instala LibreHardwareMonitor/OpenHardwareMonitor con driver (PawnIO/WinRing0) y ejecútalo como admin, o activa su Remote Web Server en :8085', { component: 'cpu', metric: 'temperature' })
    }

    /**
     * Uso GPU dedicado: endpoint (GPU Engine / nvidia-smi / LHM) →
     * nvidia-smi directo → rocm-smi (Linux) → degradado.
     */
    private async gpuUsage(_params: any, _context: any): Promise<any> {
        const metrics = await this.fetchEndpointMetrics()
        if (typeof metrics?.gpu?.usage === 'number') {
            const value = Math.round(metrics.gpu.usage * 10) / 10
            const state = value >= 90 ? 'crit' : value >= 75 ? 'warn' : 'ok'
            return { action: 'gpu-usage', component: 'gpu', metric: 'usage', value, unit: '%', state, monitored: true, source: metrics?.sources?.gpuUsage ?? 'system-metrics' }
        }
        try {
            const smi = await runCommand(['nvidia-smi', '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'])
            const value = parseFloat(smi.stdout.trim().split('\n')[0] ?? '')
            if (smi.exitCode === 0 && Number.isFinite(value)) {
                const state = value >= 90 ? 'crit' : value >= 75 ? 'warn' : 'ok'
                return { action: 'gpu-usage', component: 'gpu', metric: 'usage', value, unit: '%', state, monitored: true, source: 'nvidia-smi' }
            }
        } catch {}
        if (process.platform === 'linux') {
            try {
                const rocm = await runCommand(['rocm-smi', '--showuse'])
                const m = rocm.stdout.match(/([\d.]+)\s*%/)
                const value = m ? Number(m[1]) : NaN
                if (rocm.exitCode === 0 && Number.isFinite(value)) {
                    const state = value >= 90 ? 'crit' : value >= 75 ? 'warn' : 'ok'
                    return { action: 'gpu-usage', component: 'gpu', metric: 'usage', value, unit: '%', state, monitored: true, source: 'rocm-smi' }
                }
            } catch {}
        }
        return degraded('gpu-usage', 'Sin sensor de uso GPU: instala drivers NVIDIA (nvidia-smi), LHM/HWiNFO o rocm-smi en Linux', { component: 'gpu', metric: 'usage' })
    }

    /** Ventiladores: endpoint/LHM-remote → LHM-WMI directo → sensors/hwmon (Linux) → degradado. */
    private async fanSpeed(_params: any, _context: any): Promise<any> {
        const metrics = await this.fetchEndpointMetrics()
        if (Array.isArray(metrics?.fans) && metrics.fans.length > 0) {
            return { action: 'fan-speed', fans: metrics.fans, value: metrics.fans[0].value, unit: 'RPM', monitored: true, source: metrics?.sources?.hardware ?? 'system-metrics' }
        }
        const lhm = await this.readLhmWmi()
        if (lhm.fans.length > 0) {
            return { action: 'fan-speed', fans: lhm.fans, value: lhm.fans[0].value, unit: 'RPM', monitored: true, source: lhm.source }
        }
        if (process.platform === 'linux') {
            try {
                const out = await runCommand(['sensors', '-j'])
                if (out.exitCode === 0 && out.stdout.trim().startsWith('{')) {
                    const data = JSON.parse(out.stdout)
                    const fans: any[] = []
                    const walk = (o: any, prefix = ''): void => {
                        if (!o || typeof o !== 'object') return
                        for (const [k, v] of Object.entries(o)) {
                            if (/fan\d*_input/i.test(k) && typeof v === 'number' && Number.isFinite(v) && fans.length < 8) fans.push({ name: `${prefix}${k}`, value: Math.round(v), unit: 'RPM' })
                            else if (v && typeof v === 'object') walk(v, prefix)
                        }
                    }
                    walk(data)
                    if (fans.length > 0) return { action: 'fan-speed', fans, value: fans[0].value, unit: 'RPM', monitored: true, source: 'lm-sensors' }
                }
            } catch {}
        }
        return degraded('fan-speed', 'Sin ventiladores visibles: requiere LHM/OHM con driver (PawnIO/WinRing0) y admin en Windows, o lm-sensors/hwmon en Linux', { fans: [] })
    }

    /** Catálogo de sensores (paridad con el catalog LHM de Macro-Deck): qué hay y de dónde viene. */
    private async allSensors(_params: any, _context: any): Promise<any> {
        const metrics = (await this.fetchEndpointMetrics()) ?? {}
        const lhm = await this.readLhmWmi()
        const sensors: Array<{ id: string; label: string; value: number | string; unit: string; source: string | null; available: boolean }> = []
        const push = (id: string, label: string, value: any, unit: string, source: any) => {
            sensors.push({ id, label, value: typeof value === 'number' ? value : 'N/A', unit, source: source ?? null, available: typeof value === 'number' })
        };
        push('cpu.usage', 'CPU uso', metrics?.cpu?.usage, '%', metrics?.sources?.cpuUsage ?? 'system-metrics')
        push('cpu.temp', 'CPU temperatura', metrics?.cpu?.temperature, '°C', metrics?.sources?.cpuTemp)
        push('gpu.usage', 'GPU uso', metrics?.gpu?.usage, '%', metrics?.sources?.gpuUsage)
        push('gpu.temp', 'GPU temperatura', metrics?.gpu?.temperature, '°C', metrics?.sources?.gpuTemp)
        push('ram.usage', 'RAM uso', metrics?.ram?.usage, '%', 'system-metrics')
        push('ram.used', 'RAM usada', metrics?.ram?.used, 'GB', 'system-metrics')
        const fans = (metrics?.fans?.length ?? 0) > 0 ? metrics.fans : lhm.fans
        fans.slice(0, 8).forEach((f: any, i: number) => push(`fan.${i}`, `Ventilador ${f.name ?? i}`, f.value, 'RPM', metrics?.sources?.hardware ?? lhm.source))
        const volts = (metrics?.voltages?.length ?? 0) > 0 ? metrics.voltages : lhm.voltages
        volts.slice(0, 8).forEach((v: any, i: number) => push(`voltage.${i}`, `Voltaje ${v.name ?? i}`, v.value, 'V', metrics?.sources?.hardware ?? lhm.source))
        return {
            action: 'sensors',
            monitored: true,
            available: sensors.filter((s) => s.available).length,
            total: sensors.length,
            sensors,
            hint: 'CPU temp / fans / voltajes ausentes = instala LHM/OHM con driver y admin (Windows) como en Macro-Deck',
        }
    }

    /**
     * Uso de disco: df -k en Linux/macOS; en Windows wmic (si existe) y si no
     * PowerShell Get-CimInstance Win32_LogicalDisk (wmic está eliminado en
     * Windows 11 modernos). Sin comando disponible devuelve degradado.
     */
    private async diskUsage(params: any, _context: any): Promise<any> {
        const target = typeof params?.path === 'string' && params.path.trim() ? params.path.trim() : (process.platform === 'win32' ? 'C:' : '/')
        const diskResult = (sizeBytes: number, freeBytes: number, path: string, source: string) => {
            const used = sizeBytes - freeBytes
            const pct = Math.round((used / sizeBytes) * 1000) / 10
            return { action: 'disk-usage', path, usedGB: Math.round(used / 1e9 * 10) / 10, totalGB: Math.round(sizeBytes / 1e9 * 10) / 10, value: pct, unit: '%', monitored: true, source }
        }
        try {
            if (process.platform === 'win32') {
                const drive = /^[a-zA-Z]:/.test(target) ? target.slice(0, 2).toUpperCase() : 'C:'
                // 1) wmic (legacy; el binario no existe en Win11 moderno → throw → se sigue con CIM)
                try {
                    const out = await runCommand(['wmic', 'logicaldisk', 'where', `DeviceID='${drive}'`, 'get', 'Size,FreeSpace', '/format:csv'])
                    const line = out.stdout.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => /^\S+,\d*,\d*$/.test(l) || /^[^,]+,\d+,\d+/.test(l))
                    if (out.exitCode === 0 && line) {
                        const parts = line.split(',')
                        const free = Number(parts[parts.length - 2] || parts[1])
                        const size = Number(parts[parts.length - 1] || parts[2])
                        if (Number.isFinite(size) && size > 0 && Number.isFinite(free)) {
                            return diskResult(size, free, drive, 'wmic')
                        }
                    }
                } catch { /* sin wmic: se prueba CIM abajo */ }
                // 2) CIM vía PowerShell (funciona sin wmic ni admin)
                try {
                    const ps = `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress`
                    const cim = await runCommand(['powershell.exe', '-NoProfile', '-Command', ps])
                    if (cim.exitCode === 0 && cim.stdout.trim().startsWith('{')) {
                        const data = JSON.parse(cim.stdout.trim())
                        const size = Number(data.Size)
                        const free = Number(data.FreeSpace)
                        if (Number.isFinite(size) && size > 0 && Number.isFinite(free)) {
                            return diskResult(size, free, drive, 'cim-logicaldisk')
                        }
                    }
                } catch { /* degradado abajo */ }
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
     * Resumen del sistema en una llamada (widgets gauge v2.2).
     * Foto global: CPU/RAM/GPU vía endpoint, disco y uptime con los helpers
     * propios (rápidos, sin muestreo). `state` por el peor valor: usos en %
     * y temperaturas en °C comparten umbrales 75/90 (90% de carga o 90 °C
     * son críticos en ambos casos). El widget gauge muestra el pico.
     */
    private async systemSummary(params: any, _context: any): Promise<any> {
        let cpu: number | null = null
        let ram: number | null = null
        let gpuUsage: number | null = null
        let gpuTemp: number | null = null
        try {
            const { API_PORT } = await import('../config')
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 8000)
            try {
                const response = await fetch(`http://localhost:${API_PORT}/api/v1/system/metrics`, { signal: ctrl.signal })
                if (response.ok) {
                    const metrics = await response.json()
                    if (typeof metrics?.cpu?.usage === 'number') cpu = metrics.cpu.usage
                    if (typeof metrics?.ram?.usage === 'number') ram = metrics.ram.usage
                    if (typeof metrics?.gpu?.usage === 'number') gpuUsage = metrics.gpu.usage
                    if (typeof metrics?.gpu?.temperature === 'number') gpuTemp = metrics.gpu.temperature
                }
            } finally {
                clearTimeout(timer)
            }
        } catch (e) {
            this.context.log('warn', `summary: sin endpoint de métricas (${e instanceof Error ? e.message : String(e)})`)
        }
        // Disco y uptime con helpers propios (no dependen del endpoint)
        let disk: any = null
        let uptimeInfo: any = null
        try {
            const d = await this.diskUsage(params?.diskPath ? { path: params.diskPath } : {}, {})
            if (d?.monitored) disk = { path: d.path, value: d.value, unit: d.unit, usedGB: d.usedGB, totalGB: d.totalGB, source: d.source }
        } catch { /* summary sigue sin disco */ }
        try {
            const u = await this.uptime({}, {})
            if (u?.monitored) uptimeInfo = { value: u.value, unit: u.unit, human: u.human }
        } catch { /* summary sigue sin uptime */ }
        const peak = Math.max(cpu ?? 0, ram ?? 0, gpuUsage ?? 0, gpuTemp ?? 0)
        const state = peak >= 90 ? 'crit' : peak >= 75 ? 'warn' : 'ok'
        return {
            action: 'summary',
            state,
            cpu, ram,
            gpu: { usage: gpuUsage, temperature: gpuTemp },
            disk,
            uptime: uptimeInfo,
            monitored: cpu !== null || ram !== null || gpuUsage !== null || gpuTemp !== null,
            widget: {
                kind: 'gauge' as const,
                value: cpu ?? ram ?? gpuUsage ?? 0,
                label: cpu !== null ? `CPU ${Math.round(cpu)}%` : ram !== null ? `RAM ${Math.round(ram)}%` : gpuUsage !== null ? `GPU ${Math.round(gpuUsage)}%` : 'sin datos',
            },
        }
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
