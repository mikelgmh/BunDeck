/**
 * Native Voicemod Plugin
 * Controla Voicemod mediante su API local HTTP (fetch, sin dependencias).
 * Requiere Voicemod abierto con el control local activado.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const REQUEST_TIMEOUT_MS = 8000

function notAvailable(host: string, port: number, detail?: string): Error {
    return new Error(
        `No se pudo contactar con Voicemod en http://${host}:${port}${detail ? `: ${detail}` : ''}. ` +
        `Comprueba que: 1) Voicemod está abierto, 2) el control/API local está activado en sus ajustes, ` +
        `3) el host y puerto de los ajustes del plugin son correctos.`
    )
}

export class VoicemodPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        const conn = {
            host: {
                type: 'string', title: 'Servidor Voicemod',
                description: 'Normalmente localhost (los parámetros tienen prioridad)',
                default: '127.0.0.1',
                ui: { component: 'input', type: 'text', placeholder: '127.0.0.1' }
            },
            port: {
                type: 'number', title: 'Puerto de la API local',
                description: 'Puerto del control/API local de Voicemod',
                default: 59129, minimum: 1, maximum: 65535,
                ui: { component: 'input', type: 'number', placeholder: '59129' }
            },
            apiKey: {
                type: 'string', title: 'Clave API',
                description: 'Si tu configuración de Voicemod exige clave (si no, déjala vacía)',
                ui: { component: 'input', type: 'password', placeholder: '(opcional)' }
            }
        }
        return {
            id: 'voicemod',
            name: 'Voicemod',
            version: '1.0.1',
            description: 'Controla Voicemod: voces, efectos, mute y estado del cambiador de voz',
            author: 'BunDeck',
            permissions: ['network'],
            settingsSchema: {
                type: 'object',
                properties: {
                    host: {
                        type: 'string', title: 'Servidor Voicemod',
                        description: 'Equipo con Voicemod (normalmente localhost)',
                        default: '127.0.0.1',
                        ui: { component: 'input', type: 'text', placeholder: '127.0.0.1' }
                    },
                    port: {
                        type: 'number', title: 'Puerto de la API local',
                        description: 'Puerto del control/API local de Voicemod',
                        default: 59129, minimum: 1, maximum: 65535,
                        ui: { component: 'input', type: 'number', placeholder: '59129' }
                    },
                    apiKey: {
                        type: 'string', title: 'Clave API',
                        description: 'Si tu configuración de Voicemod exige clave (si no, déjala vacía)',
                        ui: { component: 'input', type: 'password', placeholder: '(opcional)' }
                    }
                }
            },
            instructions: 'Para controlar Voicemod:\n\n1. Abre Voicemod en este equipo y activa su control/API local (mira su documentación para el puerto y la clave).\n2. Pon host, puerto y clave en los ajustes del plugin (⋯). Los parámetros de cada botón tienen prioridad.\n3. Usa "Estado" para comprobar la conexión antes de automatizar.',
            actions: [
                {
                    id: 'get-status', name: 'Estado de Voicemod', icon: 'Activity',
                    description: 'Comprueba la conexión y devuelve la voz activa',
                    surface: 'control',
                    component: 'voice-panel',
                    schema: {
                        type: 'object',
                        properties: {
                            ...conn,
                            carouselMs: {
                                type: 'number', title: 'Carrusel (ms)',
                                description: 'En teclas pequeñas rota los controles de voz cada N ms (>0; ausente = 4000; <=0 = desactivado).',
                                minimum: 0,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'set-voice', name: 'Cambiar de voz', icon: 'AudioLines',
                    description: 'Activa una voz por su ID',
                    schema: {
                        type: 'object',
                        properties: {
                            ...conn,
                            voiceId: { type: 'string', title: 'ID de la voz', description: 'ID de la voz en Voicemod (míralo con "Estado" o en la app)', ui: { component: 'input', type: 'text', placeholder: 'ID de la voz' } }
                        },
                        required: ['voiceId']
                    }
                },
                {
                    id: 'toggle-effect', name: 'Alternar efecto/voz', icon: 'Sparkles',
                    description: 'Activa o desactiva el cambiador de voz (o una voz concreta)',
                    schema: {
                        type: 'object',
                        properties: {
                            ...conn,
                            enabled: { type: 'boolean', title: 'Activado', description: 'Estado deseado. Si se omite, se alterna.', ui: { component: 'switch' } },
                            voiceId: { type: 'string', title: 'ID de la voz', description: 'Opcional: voz a activar al encender', ui: { component: 'input', type: 'text', placeholder: '(opcional)' } }
                        },
                        required: []
                    }
                },
                {
                    id: 'mute', name: 'Silenciar Voicemod', icon: 'MicOff',
                    description: 'Silencia o reactiva la salida de Voicemod',
                    schema: {
                        type: 'object',
                        properties: {
                            ...conn,
                            muted: { type: 'boolean', title: 'Silenciado', description: 'Estado deseado. Si se omite, se alterna.', ui: { component: 'switch' } }
                        },
                        required: []
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('get-status', this.executeGetStatus.bind(this))
        handlers.set('set-voice', this.executeSetVoice.bind(this))
        handlers.set('toggle-effect', this.executeToggleEffect.bind(this))
        handlers.set('mute', this.executeMute.bind(this))
        return handlers
    }

    private setting(key: string): string | null {
        try {
            const v = this.context.getSetting?.(key)
            return typeof v === 'string' && v.length > 0 ? v : null
        } catch {
            return null
        }
    }

    private connection(params: any): { host: string; port: number; apiKey?: string; base: string } {
        const host = (typeof params?.host === 'string' && params.host.trim() ? params.host.trim() : null) ?? this.setting('host') ?? '127.0.0.1'
        const rawPort = params?.port ?? (this.setting('port') !== null ? Number(this.setting('port')) : undefined)
        const port = typeof rawPort === 'number' && Number.isFinite(rawPort) ? rawPort : 59129
        const apiKey = (typeof params?.apiKey === 'string' && params.apiKey ? params.apiKey : null) ?? this.setting('apiKey') ?? undefined
        return { host, port, apiKey, base: `http://${host}:${port}` }
    }

    private async request(conn: { host: string; port: number; apiKey?: string; base: string }, label: string, path: string, options: { method?: string; body?: unknown }): Promise<any> {
        const url = `${conn.base}${path}`
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            this.context.log('info', `Voicemod ${label}: ${options.method ?? 'GET'} ${conn.host}:${conn.port}${path}`)
            const headers: Record<string, string> = { 'Content-Type': 'application/json' }
            if (conn.apiKey) headers['X-API-Key'] = conn.apiKey
            let response: Response
            try {
                response = await fetch(url, {
                    method: options.method ?? 'GET',
                    headers,
                    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                    signal: controller.signal,
                })
            } catch (err: any) {
                if (err?.name === 'AbortError') throw new Error(`Voicemod en ${conn.base} no responde (timeout de 8s). ¿Está abierto con el control local activado?`)
                throw notAvailable(conn.host, conn.port, err?.cause ? String((err.cause as any)?.code ?? err.message) : err instanceof Error ? err.message : String(err))
            }
            const text = await response.text().catch(() => '')
            let body: any = null
            try { body = text ? JSON.parse(text) : null } catch { body = text }
            if (!response.ok) {
                throw new Error(`Voicemod devolvió error ${response.status} en "${label}": ${typeof body === 'string' ? body.slice(0, 200) : body?.message ?? response.statusText}`)
            }
            return body
        } finally {
            clearTimeout(timer)
        }
    }

    private async executeGetStatus(params: any, _context: any): Promise<any> {
        const conn = this.connection(params)
        try {
            // Intento principal + alternativa de ruta (según versión de Voicemod).
            let body: any = null
            let pathUsed = ''
            for (const path of ['/api/status', '/status']) {
                try {
                    body = await this.request(conn, 'estado', path, {})
                    pathUsed = path
                    break
                } catch (e) {
                    if (path === '/status') throw e
                }
            }
            this.context.log('info', `Voicemod: conectado (${pathUsed})`)
            return { action: 'get-status', connected: true, path: pathUsed, status: body }
        } catch (error) {
            this.context.log('error', `Voicemod: sin conexión: ${error}`)
            throw error
        }
    }

    private async executeSetVoice(params: any, _context: any): Promise<any> {
        const voiceId = typeof params?.voiceId === 'string' ? params.voiceId.trim() : ''
        if (!voiceId) throw new Error('La acción "Cambiar de voz" requiere el parámetro "voiceId" (mira los IDs disponibles en la app de Voicemod).')
        const conn = this.connection(params)
        try {
            const body = await this.request(conn, 'cambiar voz', '/api/voice', { method: 'POST', body: { voiceId } })
            this.context.log('info', `Voicemod: voz cambiada a "${voiceId}"`)
            return { action: 'set-voice', voiceId, result: body }
        } catch (error) {
            this.context.log('error', `Voicemod: no se pudo cambiar la voz: ${error}`)
            throw error
        }
    }

    private async executeToggleEffect(params: any, _context: any): Promise<any> {
        const conn = this.connection(params)
        try {
            let enabled: boolean | undefined = typeof params?.enabled === 'boolean' ? params.enabled : undefined
            if (enabled === undefined) {
                const status = await this.request(conn, 'estado', '/api/status', {}).catch(() => this.request(conn, 'estado', '/status', {}))
                const current = status?.voiceChangerEnabled ?? status?.enabled ?? status?.active
                enabled = typeof current === 'boolean' ? !current : true
            }
            const voiceId = typeof params?.voiceId === 'string' && params.voiceId.trim() ? params.voiceId.trim() : undefined
            const body = await this.request(conn, 'alternar efecto', '/api/voice-changer', {
                method: 'POST',
                body: { enabled, ...(voiceId ? { voiceId } : {}) },
            })
            this.context.log('info', `Voicemod: cambiador ${enabled ? 'activado' : 'desactivado'}`)
            return { action: 'toggle-effect', enabled, voiceId: voiceId ?? null, result: body }
        } catch (error) {
            this.context.log('error', `Voicemod: no se pudo alternar el efecto: ${error}`)
            throw error
        }
    }

    private async executeMute(params: any, _context: any): Promise<any> {
        const conn = this.connection(params)
        try {
            let muted: boolean | undefined = typeof params?.muted === 'boolean' ? params.muted : undefined
            if (muted === undefined) {
                const status = await this.request(conn, 'estado', '/api/status', {}).catch(() => this.request(conn, 'estado', '/status', {}))
                const current = status?.muted ?? status?.mute
                muted = typeof current === 'boolean' ? !current : true
            }
            const body = await this.request(conn, 'silenciar', '/api/mute', { method: 'POST', body: { muted } })
            this.context.log('info', `Voicemod: silenciado=${muted}`)
            return { action: 'mute', muted, result: body }
        } catch (error) {
            this.context.log('error', `Voicemod: no se pudo silenciar: ${error}`)
            throw error
        }
    }

    public dispose(): void {
        // Sin estado persistente.
    }
}
