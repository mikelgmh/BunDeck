/**
 * Native Minecraft Plugin
 * Consulta el estado de servidores vía la API pública mcsrvstat.us
 * (sin credenciales) y abre el launcher de Minecraft.
 * Sin dependencias nuevas (fetch con timeout + apertura por SO).
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const REQUEST_TIMEOUT_MS = 15000
const DEFAULT_API_BASE = 'https://api.mcsrvstat.us/3'

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

function resolveTimeout(params: any): number {
    const t = params?.timeoutMs
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) return Math.min(Math.floor(t), 60000)
    return REQUEST_TIMEOUT_MS
}

function resolveApiBase(params: any): string {
    const base = params?.apiBase
    if (typeof base === 'string' && base.trim().length > 0) return base.trim().replace(/\/+$/, '')
    return DEFAULT_API_BASE
}

async function openExternal(target: string, context: PluginContext): Promise<{ launched: boolean; method: string; note?: string }> {
    const platform = process.platform
    const cmd =
        platform === 'win32' ? ['cmd', '/c', 'start', '""', target]
        : platform === 'darwin' ? ['open', target]
        : ['xdg-open', target]
    context.log('info', `Minecraft: abriendo ${target}`, { platform })
    try {
        const proc = Bun.spawn({ windowsHide: true,  cmd, stdio: ['ignore', 'pipe', 'pipe'] })
        const stderr = await new Response(proc.stderr).text()
        await proc.exited
        if (proc.exitCode === 0) return { launched: true, method: cmd[0] }
        return { launched: false, method: cmd[0], note: `El sistema devolvió el código ${proc.exitCode}: ${stderr.slice(0, 200)}` }
    } catch (error) {
        return { launched: false, method: cmd[0], note: `No se pudo abrir el launcher: ${error instanceof Error ? error.message : String(error)}` }
    }
}

export class MinecraftPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'minecraft',
            name: 'Minecraft',
            version: '1.0.2',
            description: 'Consulta si un servidor de Minecraft está en línea (jugadores, versión, latencia) y abre el launcher',
            author: 'BunDeck',
            permissions: ['network', 'process'],
            actions: [
                {
                    id: 'server-status',
                    name: 'Estado del servidor',
                    description: 'Pregunta a mcsrvstat.us si el servidor está en línea, su versión y jugadores',
                    i18n: { es: { name: 'Estado del servidor', description: 'Pregunta a mcsrvstat.us si el servidor está en línea, su versión y jugadores' }, en: { name: 'Estado del servidor', description: 'Pregunta a mcsrvstat.us si el servidor está en línea, su versión y jugadores' } }, // TODO i18n: EN temporal = ES
                    icon: 'Server',
                    surface: 'control',
                    component: 'status-cards',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            host: {
                                type: 'string', title: 'Servidor',
                                description: 'IP o dominio del servidor (ej. hypixel.net)',
                                ui: { component: 'input', type: 'text', placeholder: 'hypixel.net' },
                            },
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            },
                            apiBase: {
                                type: 'string', title: 'API de estado',
                                description: 'Base de la API pública (solo para pruebas; por defecto api.mcsrvstat.us)',
                                ui: { component: 'hidden' },
                            },
                            timeoutMs: {
                                type: 'number', title: 'Tiempo límite (ms)',
                                description: 'Tiempo máximo de espera',
                                default: 15000, minimum: 1000, maximum: 60000,
                                ui: { component: 'hidden' },
                            },
                        },
                        required: ['host'],
                    },
                },
                {
                    id: 'query-latency',
                    name: 'Latencia del servidor',
                    description: 'Mide el tiempo de respuesta al consultar el estado (ms)',
                    i18n: { es: { name: 'Latencia del servidor', description: 'Mide el tiempo de respuesta al consultar el estado (ms)' }, en: { name: 'Latencia del servidor', description: 'Mide el tiempo de respuesta al consultar el estado (ms)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Gauge',
                    surface: 'control',
                    component: 'status-cards',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            host: {
                                type: 'string', title: 'Servidor',
                                description: 'IP o dominio del servidor',
                                ui: { component: 'input', type: 'text', placeholder: 'hypixel.net' },
                            },
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            },
                            apiBase: {
                                type: 'string', title: 'API de estado',
                                description: 'Base de la API pública (solo para pruebas)',
                                ui: { component: 'hidden' },
                            },
                            timeoutMs: {
                                type: 'number', title: 'Tiempo límite (ms)',
                                description: 'Tiempo máximo de espera',
                                default: 15000, minimum: 1000, maximum: 60000,
                                ui: { component: 'hidden' },
                            },
                        },
                        required: ['host'],
                    },
                },
                {
                    id: 'open-launcher',
                    name: 'Abrir launcher',
                    description: 'Abre el launcher de Minecraft (protocolo minecraft:// o ruta personalizada)',
                    i18n: { es: { name: 'Abrir launcher', description: 'Abre el launcher de Minecraft (protocolo minecraft:// o ruta personalizada)' }, en: { name: 'Abrir launcher', description: 'Abre el launcher de Minecraft (protocolo minecraft:// o ruta personalizada)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Rocket',
                    schema: {
                        type: 'object',
                        properties: {
                            target: {
                                type: 'string', title: 'Destino',
                                description: 'URI o ruta del launcher (vacío = minecraft://)',
                                ui: { component: 'input', type: 'text', placeholder: 'Vacío = minecraft://' },
                            },
                        },
                        required: [],
                    },
                },
            ],
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('server-status', this.executeStatus.bind(this))
        handlers.set('query-latency', this.executeLatency.bind(this))
        handlers.set('open-launcher', this.executeLauncher.bind(this))
        return handlers
    }

    private requireHost(params: any): string {
        const host = String(params?.host ?? '').trim()
        if (!host) throw new Error('El servidor (host) es obligatorio (ej. hypixel.net)')
        if (/^https?:\/\//i.test(host)) throw new Error(`El servidor debe ser IP o dominio, sin protocolo: "${host}"`)
        return host
    }

    private async queryServer(host: string, apiBase: string, timeoutMs: number): Promise<any> {
        const url = `${apiBase}/${encodeURIComponent(host)}`
        this.context.log('info', `Minecraft: consultando ${host}`, { apiBase })
        let response: Response
        try {
            response = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs)
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Tiempo de espera agotado (${timeoutMs} ms) consultando el servidor ${host}`)
            }
            throw new Error(`No se pudo consultar el estado de ${host}: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!response.ok) {
            throw new Error(`La API de estado devolvió el error ${response.status} para ${host}`)
        }
        return await response.json().catch(() => null)
    }

    private async executeStatus(params: any, _context: any): Promise<any> {
        const host = this.requireHost(params)
        const body = await this.queryServer(host, resolveApiBase(params), resolveTimeout(params))
        if (!body) throw new Error(`Respuesta vacía de la API de estado para ${host}`)
        return {
            action: 'server-status',
            host,
            online: body.online === true,
            version: body.version ?? null,
            players: body.players ? { online: body.players.online ?? null, max: body.players.max ?? null } : null,
            motd: body.motd?.clean?.[0] ?? body.motd?.raw?.[0] ?? null,
            icon: body.icon ? '(icono disponible)' : null,
        }
    }

    private async executeLatency(params: any, _context: any): Promise<any> {
        const host = this.requireHost(params)
        const apiBase = resolveApiBase(params)
        const timeoutMs = resolveTimeout(params)
        const started = Date.now()
        const body = await this.queryServer(host, apiBase, timeoutMs)
        const latencyMs = Date.now() - started
        return {
            action: 'query-latency',
            host,
            online: body?.online === true,
            latencyMs,
            degraded: body?.online !== true,
            note: body?.online === true ? undefined : 'El servidor no respondió como en línea; la latencia mide solo la API de estado',
        }
    }

    private async executeLauncher(params: any, _context: any): Promise<any> {
        const target = typeof params?.target === 'string' && params.target.trim() ? params.target.trim() : 'minecraft://'
        const open = await openExternal(target, this.context)
        return { action: 'open-launcher', target, ...open }
    }

    public dispose(): void {
        // Sin recursos que liberar
    }
}
