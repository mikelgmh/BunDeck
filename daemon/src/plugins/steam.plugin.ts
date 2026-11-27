/**
 * Native Steam Plugin
 * Lanza juegos por steam://rungameid/, abre la biblioteca y consulta
 * el estado de servidores vía la API pública de Steam.
 * Sin dependencias nuevas (open por SO + fetch con timeout).
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

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

async function openExternal(target: string, context: PluginContext, label: string): Promise<{ launched: boolean; method: string; note?: string }> {
    const platform = process.platform
    const cmd =
        platform === 'win32' ? ['cmd', '/c', 'start', '""', target]
        : platform === 'darwin' ? ['open', target]
        : ['xdg-open', target]
    context.log('info', `Steam: abriendo ${label}: ${target}`, { platform })
    try {
        const proc = Bun.spawn({ windowsHide: true,  cmd, stdio: ['ignore', 'pipe', 'pipe'] })
        const stderr = await new Response(proc.stderr).text()
        await proc.exited
        if (proc.exitCode === 0) return { launched: true, method: cmd[0] }
        return { launched: false, method: cmd[0], note: `El sistema devolvió el código ${proc.exitCode}: ${stderr.slice(0, 200)}` }
    } catch (error) {
        return { launched: false, method: cmd[0], note: `No se pudo abrir (¿Steam instalado?): ${error instanceof Error ? error.message : String(error)}` }
    }
}

export class SteamPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'steam',
            name: 'Steam',
            version: '1.0.2',
            description: 'Lanza juegos de Steam, abre la biblioteca y consulta si un juego/servidor está en línea',
            author: 'BunDeck',
            permissions: ['process', 'network'],
            actions: [
                {
                    id: 'launch-game',
                    name: 'Lanzar juego',
                    description: 'Abre un juego por su AppID (steam://rungameid/)',
                    icon: 'Gamepad2',
                    schema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string', title: 'AppID del juego',
                                description: 'ID numérico del juego en Steam (ej. 730 = CS2, 570 = Dota 2)',
                                ui: { component: 'input', type: 'text', placeholder: '730' },
                            },
                            args: {
                                type: 'string', title: 'Argumentos',
                                description: 'Argumentos de lanzamiento opcionales (se añaden a la URI)',
                                ui: { component: 'input', type: 'text', placeholder: 'Vacío = ninguno' },
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    id: 'open-library',
                    name: 'Abrir biblioteca',
                    description: 'Abre el cliente de Steam (biblioteca)',
                    icon: 'Library',
                    schema: { type: 'object', properties: {}, required: [] },
                },
                {
                    id: 'server-status',
                    name: 'Estado del juego',
                    description: 'Consulta el nombre, precio y estado de un juego vía la tienda pública de Steam',
                    icon: 'Activity',
                    surface: 'control',
                    component: 'status-cards',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string', title: 'AppID del juego',
                                description: 'ID numérico del juego en Steam',
                                ui: { component: 'input', type: 'text', placeholder: '730' },
                            },
                            country: {
                                type: 'string', title: 'País',
                                description: 'Código de país para precios (ISO, ej. ES, US, MX)',
                                default: 'ES',
                                ui: { component: 'input', type: 'text', placeholder: 'ES' },
                            },
                            timeoutMs: {
                                type: 'number', title: 'Tiempo límite (ms)',
                                description: 'Tiempo máximo de espera de la tienda de Steam',
                                default: 15000, minimum: 1000, maximum: 60000,
                                ui: { component: 'hidden' },
                            },
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    id: 'presence',
                    name: 'Presencia (próximamente)',
                    description: 'Placeholder: Steam no expone presencia de amigos sin API key; devuelve cómo activarla',
                    icon: 'Users',
                    surface: 'control',
                    component: 'status-cards',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            steamId: {
                                type: 'string', title: 'SteamID64',
                                description: 'Tu SteamID64 (se usa cuando configures API key)',
                                ui: { component: 'input', type: 'text', placeholder: '76561198…' },
                            },
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
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
        handlers.set('launch-game', this.executeLaunch.bind(this))
        handlers.set('open-library', this.executeLibrary.bind(this))
        handlers.set('server-status', this.executeStatus.bind(this))
        handlers.set('presence', this.executePresence.bind(this))
        return handlers
    }

    private requireAppId(params: any): string {
        const appId = String(params?.appId ?? '').trim()
        if (!/^\d+$/.test(appId)) {
            throw new Error(`AppID no válido: "${params?.appId}". Debe ser numérico (ej. 730 para CS2, 570 para Dota 2)`)
        }
        return appId
    }

    private async executeLaunch(params: any, _context: any): Promise<any> {
        const appId = this.requireAppId(params)
        const args = typeof params?.args === 'string' && params.args.trim() ? ` ${params.args.trim()}` : ''
        const uri = `steam://rungameid/${appId}${args ? `/${encodeURIComponent(args.trim())}` : ''}`
        const open = await openExternal(uri, this.context, `juego ${appId}`)
        this.context.log('info', `Steam: lanzar juego ${appId}: ${open.launched ? 'OK' : 'degradado'}`)
        return { action: 'launch-game', appId, uri, ...open }
    }

    private async executeLibrary(_params: any, _context: any): Promise<any> {
        const uri = 'steam://open/library'
        const open = await openExternal(uri, this.context, 'biblioteca')
        return { action: 'open-library', uri, ...open }
    }

    private async executeStatus(params: any, _context: any): Promise<any> {
        const appId = this.requireAppId(params)
        const country = typeof params?.country === 'string' && params.country.trim() ? params.country.trim().toUpperCase() : 'ES'
        const timeoutMs = typeof params?.timeoutMs === 'number' && params.timeoutMs > 0
            ? Math.min(Math.floor(params.timeoutMs), 60000)
            : REQUEST_TIMEOUT_MS
        const base = typeof params?.apiBase === 'string' && params.apiBase ? params.apiBase.replace(/\/+$/, '') : 'https://store.steampowered.com'
        const url = `${base}/api/appdetails?appids=${appId}&cc=${encodeURIComponent(country)}&l=spanish`
        this.context.log('info', `Steam: consultando estado de ${appId}`, { country })
        let response: Response
        try {
            response = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs)
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Tiempo de espera agotado (${timeoutMs} ms) consultando la tienda de Steam para ${appId}`)
            }
            throw new Error(`No se pudo conectar con la tienda de Steam: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!response.ok) {
            throw new Error(`La tienda de Steam devolvió el error ${response.status} para el juego ${appId}`)
        }
        const body: any = await response.json().catch(() => null)
        const entry = body?.[appId]
        if (!entry || entry.success !== true) {
            throw new Error(`Juego no encontrado en Steam (¿AppID ${appId} correcto?)`)
        }
        const data = entry.data ?? {}
        return {
            action: 'server-status',
            appId,
            name: data.name ?? null,
            online: true,
            isFree: data.is_free ?? null,
            price: data.price_overview?.final_formatted ?? data.price_overview?.final ?? null,
            shortDescription: typeof data.short_description === 'string' ? data.short_description.slice(0, 200) : null,
        }
    }

    private async executePresence(params: any, _context: any): Promise<any> {
        const steamId = typeof params?.steamId === 'string' ? params.steamId : ''
        return {
            action: 'presence',
            supported: false,
            degraded: true,
            steamId: steamId || null,
            note: 'La presencia de amigos requiere Steam Web API key (https://steamcommunity.com/dev/apikey) y exponerla aquí. Sin credenciales no se puede consultar: guarda tu API key y SteamID64 y vuelve a intentarlo.',
        }
    }

    public dispose(): void {
        // Sin recursos que liberar
    }
}
