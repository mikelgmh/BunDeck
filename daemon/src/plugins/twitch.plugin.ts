/**
 * Native Twitch Plugin
 * Controla tu canal de Twitch vía Helix API (fetch, sin dependencias).
 * Necesitas un Client ID y un token OAuth de usuario con los scopes adecuados.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const TWITCH_API_BASE = 'https://api.twitch.tv/helix'
const REQUEST_TIMEOUT_MS = 15000

function credError(): Error {
    return new Error('Falta la configuración de Twitch: pon "Client ID", "Token OAuth" y tu "Broadcaster" en los ajustes del plugin (⋯) o en los parámetros. El token necesita los scopes: channel:manage:broadcast, clips:edit, channel:manage:markers, chat:write, channel:read:commercials según la acción. Consigue el token con tu app de Twitch Developers (flujo Authorization Code + PKCE).')
}

export class TwitchPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        const creds = {
            clientId: {
                type: 'string', title: 'Client ID',
                description: 'Client ID de tu aplicación de Twitch Developers (los parámetros tienen prioridad)',
                ui: { component: 'input', type: 'text', placeholder: 'Client ID de Twitch' }
            },
            token: {
                type: 'string', title: 'Token OAuth',
                description: 'Token OAuth de usuario (Bearer). No se muestra en los registros.',
                ui: { component: 'input', type: 'password', placeholder: 'Token OAuth (oauth:…)' }
            },
            broadcaster: {
                type: 'string', title: 'Canal (broadcaster)',
                description: 'ID numérico del canal o nombre de login (los parámetros tienen prioridad)',
                ui: { component: 'input', type: 'text', placeholder: 'ID o login de tu canal' }
            }
        }
        return {
            id: 'twitch',
            name: 'Twitch',
            version: '1.0.0',
            description: 'Controla tu directo de Twitch: título, categoría, clips, marcadores, chat, anuncios y espectadores',
            author: 'BunDeck',
            permissions: ['network'],
            settingsSchema: {
                type: 'object',
                properties: {
                    clientId: {
                        type: 'string', title: 'Client ID',
                        description: 'Client ID de tu aplicación de Twitch Developers',
                        ui: { component: 'input', type: 'text', placeholder: 'Client ID de Twitch' }
                    },
                    token: {
                        type: 'string', title: 'Token OAuth',
                        description: 'Token OAuth de usuario con los scopes necesarios. No se muestra en los registros.',
                        ui: { component: 'input', type: 'password', placeholder: 'Token OAuth (oauth:…)' }
                    },
                    broadcaster: {
                        type: 'string', title: 'Canal (broadcaster)',
                        description: 'ID numérico de tu canal o tu nombre de login',
                        ui: { component: 'input', type: 'text', placeholder: 'ID o login de tu canal' }
                    }
                }
            },
            instructions: 'Para conectar con Twitch:\n\n1. Crea una aplicación en dev.twitch.tv/console (tipo "Otro", redirección http://localhost).\n2. Genera un token OAuth de usuario (flujo Authorization Code + PKCE) con los scopes: channel:manage:broadcast, clips:edit, channel:manage:markers, chat:write, channel:read:commercials.\n3. Pega el Client ID, el token y tu canal en los ajustes del plugin (⋯). Los parámetros de cada botón tienen prioridad.',
            actions: [
                {
                    id: 'set-title', name: 'Cambiar título del directo', icon: 'Type',
                    description: 'Actualiza el título de tu canal',
                    schema: { type: 'object', properties: { ...creds, title: { type: 'string', title: 'Título', description: 'Nuevo título del directo', ui: { component: 'input', type: 'text', placeholder: 'Jugando ranked con viewers' } } }, required: ['title'] }
                },
                {
                    id: 'set-category', name: 'Cambiar categoría/juego', icon: 'Gamepad2',
                    description: 'Cambia la categoría buscando por nombre o por ID de juego',
                    schema: { type: 'object', properties: { ...creds, gameName: { type: 'string', title: 'Nombre del juego', description: 'Nombre de la categoría (se resuelve a game_id automáticamente)', ui: { component: 'input', type: 'text', placeholder: 'Just Chatting' } }, gameId: { type: 'string', title: 'ID del juego', description: 'ID numérico de la categoría (alternativa a gameName)', ui: { component: 'input', type: 'text', placeholder: '509658' } } }, required: [] }
                },
                {
                    id: 'create-clip', name: 'Crear clip', icon: 'Scissors',
                    description: 'Crea un clip de los últimos momentos del directo',
                    schema: { type: 'object', properties: { ...creds, hasDelay: { type: 'boolean', title: 'Con retraso', description: 'true añade el retraso habitual del directo al clip', ui: { component: 'switch' } } }, required: [] }
                },
                {
                    id: 'create-marker', name: 'Crear marcador', icon: 'Flag',
                    description: 'Marca un momento del directo para encontrarlo luego en el VOD',
                    schema: { type: 'object', properties: { ...creds, description: { type: 'string', title: 'Descripción', description: 'Texto del marcador (máx. 140 caracteres)', ui: { component: 'input', type: 'text', placeholder: 'Momento épico' } } }, required: [] }
                },
                {
                    id: 'chat-message', name: 'Enviar mensaje al chat', icon: 'MessageSquare',
                    description: 'Envía un mensaje al chat de tu canal',
                    schema: { type: 'object', properties: { ...creds, message: { type: 'string', title: 'Mensaje', description: 'Texto a enviar (máx. 500 caracteres)', ui: { component: 'input', type: 'text', placeholder: '¡Hola a todos!' } } }, required: ['message'] }
                },
                {
                    id: 'ad-break', name: 'Poner anuncio', icon: 'Megaphone',
                    description: 'Inicia una pausa publicitaria en tu canal',
                    schema: { type: 'object', properties: { ...creds, length: { type: 'number', title: 'Duración (s)', description: '30, 60, 90, 120, 150 o 180 segundos', default: 30, enum: [30, 60, 90, 120, 150, 180], ui: { component: 'select', options: [{ value: 30, label: '30 s' }, { value: 60, label: '60 s' }, { value: 90, label: '90 s' }, { value: 120, label: '120 s' }, { value: 150, label: '150 s' }, { value: 180, label: '180 s' }] } } }, required: [] }
                },
                {
                    id: 'viewer-count', name: 'Ver espectadores', icon: 'Users',
                    description: 'Devuelve cuántos espectadores tienes ahora (0 si no estás en directo)',
                    schema: { type: 'object', properties: { ...creds }, required: [] }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('set-title', this.executeSetTitle.bind(this))
        handlers.set('set-category', this.executeSetCategory.bind(this))
        handlers.set('create-clip', this.executeCreateClip.bind(this))
        handlers.set('create-marker', this.executeCreateMarker.bind(this))
        handlers.set('chat-message', this.executeChatMessage.bind(this))
        handlers.set('ad-break', this.executeAdBreak.bind(this))
        handlers.set('viewer-count', this.executeViewerCount.bind(this))
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

    private creds(params: any): { clientId: string; token: string; broadcaster: string } {
        const clientId = (typeof params?.clientId === 'string' && params.clientId.trim() ? params.clientId.trim() : null) ?? this.setting('clientId')
        const token = (typeof params?.token === 'string' && params.token.trim() ? params.token.trim() : null) ?? this.setting('token')
        const broadcaster = (typeof params?.broadcaster === 'string' && params.broadcaster.trim() ? params.broadcaster.trim() : null) ?? this.setting('broadcaster')
        if (!clientId || !token || !broadcaster) throw credError()
        return { clientId, token, broadcaster }
    }

    private async apiFetch(creds: { clientId: string; token: string }, label: string, path: string, options: { method: string; query?: Record<string, string | undefined>; body?: unknown }): Promise<any> {
        const qs = Object.entries(options.query ?? {})
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
            .join('&')
        const url = `${TWITCH_API_BASE}${path}${qs ? `?${qs}` : ''}`
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            this.context.log('info', `Twitch ${label}: ${options.method} ${path}`)
            const response = await fetch(url, {
                method: options.method,
                headers: { 'Client-Id': creds.clientId, Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
                body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                signal: controller.signal,
            })
            if (response.status === 401 || response.status === 403) {
                this.context.log('error', `Twitch ${label}: ${response.status} (autenticación)`)
                throw new Error(`Twitch rechazó la petición (${response.status}): token inválido, caducado o sin los scopes necesarios para "${label}". Revisa el token en los ajustes del plugin.`)
            }
            if (!response.ok) {
                const text = await response.text().catch(() => '')
                this.context.log('error', `Twitch ${label}: error ${response.status}`)
                throw new Error(`Error de la API de Twitch (${response.status}) en "${label}": ${text.slice(0, 300) || response.statusText}`)
            }
            if (response.status === 204) return null
            const text = await response.text()
            return text ? JSON.parse(text) : null
        } catch (error: any) {
            if (error?.name === 'AbortError') throw new Error(`La petición a Twitch tardó demasiado (timeout de 15s): ${label}`)
            throw error
        } finally {
            clearTimeout(timer)
        }
    }

    /** Acepta ID numérico o login; si es login lo resuelve a user_id. */
    private async resolveBroadcasterId(creds: { clientId: string; token: string }, broadcaster: string): Promise<string> {
        if (/^\d+$/.test(broadcaster)) return broadcaster
        const login = broadcaster.replace(/^@/, '').toLowerCase()
        const res = await this.apiFetch(creds, 'resolver canal', '/users', { method: 'GET', query: { login } })
        const id = res?.data?.[0]?.id
        if (!id) throw new Error(`No se encontró el canal "${broadcaster}" en Twitch. Usa el ID numérico o revisa el login.`)
        return id
    }

    private async executeSetTitle(params: any, _context: any): Promise<any> {
        const title = typeof params?.title === 'string' ? params.title.trim() : ''
        if (!title) throw new Error('La acción "Cambiar título" requiere el parámetro "title".')
        const creds = this.creds(params)
        const broadcasterId = await this.resolveBroadcasterId(creds, creds.broadcaster)
        await this.apiFetch(creds, 'cambiar título', '/channels', { method: 'PATCH', query: { broadcaster_id: broadcasterId }, body: { title } })
        this.context.log('info', `Twitch: título actualizado a "${title}"`)
        return { action: 'set-title', title, broadcasterId, updated: true }
    }

    private async executeSetCategory(params: any, _context: any): Promise<any> {
        const creds = this.creds(params)
        let gameId = typeof params?.gameId === 'string' && params.gameId.trim() ? params.gameId.trim() : null
        const gameName = typeof params?.gameName === 'string' && params.gameName.trim() ? params.gameName.trim() : null
        if (!gameId && !gameName) {
            throw new Error('Indica "gameName" (ej. "Just Chatting") o "gameId" (ej. "509658"). Puedes ver el ID en la URL de la categoría de Twitch.')
        }
        if (!gameId && gameName) {
            const res = await this.apiFetch(creds, 'buscar categoría', '/search/categories', { method: 'GET', query: { query: gameName, first: '1' } })
            gameId = res?.data?.[0]?.id ?? null
            if (!gameId) throw new Error(`No se encontró ninguna categoría llamada "${gameName}" en Twitch. Revisa el nombre o usa "gameId".`)
        }
        const broadcasterId = await this.resolveBroadcasterId(creds, creds.broadcaster)
        await this.apiFetch(creds, 'cambiar categoría', '/channels', { method: 'PATCH', query: { broadcaster_id: broadcasterId }, body: { game_id: gameId } })
        this.context.log('info', `Twitch: categoría actualizada (game_id=${gameId})`)
        return { action: 'set-category', gameId, gameName: gameName ?? null, broadcasterId, updated: true }
    }

    private async executeCreateClip(params: any, _context: any): Promise<any> {
        const creds = this.creds(params)
        const broadcasterId = await this.resolveBroadcasterId(creds, creds.broadcaster)
        const res = await this.apiFetch(creds, 'crear clip', '/clips', {
            method: 'POST',
            query: { broadcaster_id: broadcasterId, ...(params?.hasDelay === true ? { has_delay: 'true' } : {}) },
        })
        const clip = res?.data?.[0]
        this.context.log('info', `Twitch: clip creado ${clip?.id ?? ''}`)
        return { action: 'create-clip', clipId: clip?.id ?? null, editUrl: clip?.edit_url ?? null, broadcasterId }
    }

    private async executeCreateMarker(params: any, _context: any): Promise<any> {
        const creds = this.creds(params)
        const broadcasterId = await this.resolveBroadcasterId(creds, creds.broadcaster)
        const description = typeof params?.description === 'string' ? params.description.slice(0, 140) : undefined
        const res = await this.apiFetch(creds, 'crear marcador', '/streams/markers', {
            method: 'POST',
            body: { user_id: broadcasterId, ...(description ? { description } : {}) },
        })
        const marker = res?.data?.[0]
        if (!marker) throw new Error('Twitch no devolvió el marcador: ¿estás en directo ahora mismo? Los marcadores solo funcionan durante la emisión.')
        return { action: 'create-marker', markerId: marker.id ?? null, positionSeconds: marker.position_seconds ?? null, broadcasterId }
    }

    private async executeChatMessage(params: any, _context: any): Promise<any> {
        const message = typeof params?.message === 'string' ? params.message.trim() : ''
        if (!message) throw new Error('La acción "Enviar mensaje" requiere el parámetro "message".')
        if (message.length > 500) throw new Error('El mensaje supera los 500 caracteres permitidos por Twitch.')
        const creds = this.creds(params)
        const broadcasterId = await this.resolveBroadcasterId(creds, creds.broadcaster)
        const res = await this.apiFetch(creds, 'enviar chat', '/chat/messages', {
            method: 'POST',
            body: { broadcaster_id: broadcasterId, sender_id: broadcasterId, message },
        })
        const sent = res?.data?.[0]
        return { action: 'chat-message', message, messageId: sent?.message_id ?? null, sent: sent ? !sent.is_sent : true }
    }

    private async executeAdBreak(params: any, _context: any): Promise<any> {
        const creds = this.creds(params)
        const length = params?.length ?? 30
        if (![30, 60, 90, 120, 150, 180].includes(Number(length))) {
            throw new Error('La duración del anuncio debe ser una de: 30, 60, 90, 120, 150 o 180 segundos.')
        }
        const broadcasterId = await this.resolveBroadcasterId(creds, creds.broadcaster)
        const res = await this.apiFetch(creds, 'pausa publicitaria', '/channels/commercial', {
            method: 'POST',
            body: { broadcaster_id: broadcasterId, length: Number(length) },
        })
        const ad = res?.data?.[0]
        return { action: 'ad-break', length: Number(length), retryAfter: ad?.retry_after ?? null, broadcasterId }
    }

    private async executeViewerCount(params: any, _context: any): Promise<any> {
        const creds = this.creds(params)
        const broadcasterId = await this.resolveBroadcasterId(creds, creds.broadcaster)
        const res = await this.apiFetch(creds, 'espectadores', '/streams', { method: 'GET', query: { user_id: broadcasterId } })
        const stream = res?.data?.[0]
        return {
            action: 'viewer-count',
            live: Boolean(stream),
            viewerCount: stream?.viewer_count ?? 0,
            title: stream?.title ?? null,
            gameName: stream?.game_name ?? null,
            broadcasterId,
        }
    }

    public dispose(): void {
        // Sin estado persistente.
    }
}
