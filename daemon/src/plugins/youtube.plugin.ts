/**
 * Native YouTube Plugin
 * Consulta datos públicos con API key (Data API v3) y gestiona el directo
 * con token OAuth cuando está disponible. Sin dependencias externas.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3'
const REQUEST_TIMEOUT_MS = 15000

import { CONTRACT_API_VERSION, CONTRACT_ENGINE } from './contract'

export class YoutubePlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'youtube',
            name: 'YouTube',
            version: '1.1.1',
            description: 'YouTube para creadores: espectadores del directo, chat en vivo, control de emisión y panel',
            author: 'BunDeck',
            apiVersion: CONTRACT_API_VERSION,
            engine: CONTRACT_ENGINE,
            category: 'integrations',
            permissions: ['network'],
            widgets: [
                { id: 'viewers', kind: 'text', title: 'Espectadores', description: 'Espectadores del directo actual', sourceAction: 'viewer-count', refreshMs: 60000 }
            ],
            settingsSchema: {
                type: 'object',
                properties: {
                    apiKey: {
                        type: 'string', title: 'API key (Data API v3)',
                        description: 'Clave de Google Cloud con YouTube Data API v3 activada. Sirve para espectadores y datos públicos.',
                        ui: { component: 'input', type: 'password', placeholder: 'AIza…' }
                    },
                    oauthToken: {
                        type: 'string', title: 'Token OAuth',
                        description: 'Token OAuth con scopes youtube.force-ssl. Solo necesario para chat y control de emisión.',
                        ui: { component: 'input', type: 'password', placeholder: 'ya29.…' }
                    },
                    videoId: {
                        type: 'string', title: 'ID de vídeo por defecto',
                        description: 'ID del directo habitual (lo que va tras watch?v=). Los parámetros tienen prioridad.',
                        ui: { component: 'input', type: 'text', placeholder: 'dQw4w9WgXcQ' }
                    }
                }
            },
            instructions: 'Para usar YouTube:\n\n1. Crea una clave en Google Cloud Console con "YouTube Data API v3" activada y pégala en API key: ya puedes ver espectadores.\n2. Para chat y control de emisión necesitas además un token OAuth (scope youtube.force-ssl).\n3. Puedes fijar el ID de vídeo habitual en los ajustes o pasarlo en cada botón.',
            actions: [
                {
                    id: 'viewer-count', name: 'Ver espectadores', icon: 'Users',
                    description: 'Devuelve espectadores actuales del directo y si sigue en vivo',
                    dynamic: true, surface: 'control', component: 'stream-studio',
                    pollMs: 60000, timeoutMs: REQUEST_TIMEOUT_MS,
                    states: [
                        { value: 'live', label: 'En directo', icon: 'Radio' },
                        { value: 'offline', label: 'Fuera de línea', icon: 'RadioTower' }
                    ],
                    schema: {
                        type: 'object',
                        properties: {
                            apiKey: { type: 'string', title: 'API key', description: 'Si se omite usa la de los ajustes', ui: { component: 'input', type: 'password', placeholder: 'AIza…' } },
                            videoId: { type: 'string', title: 'ID del vídeo', description: 'ID del directo (tras watch?v=). Si se omite usa el de los ajustes.', ui: { component: 'input', type: 'text', placeholder: 'ID del directo' } }
                        },
                        required: []
                    }
                },
                {
                    id: 'post-chat', name: 'Enviar mensaje al chat', icon: 'MessageSquare',
                    description: 'Envía un mensaje al chat en vivo (requiere token OAuth)',
                    schema: {
                        type: 'object',
                        properties: {
                            oauthToken: { type: 'string', title: 'Token OAuth', description: 'Si se omite usa el de los ajustes', ui: { component: 'input', type: 'password', placeholder: 'ya29.…' } },
                            apiKey: { type: 'string', title: 'API key', description: 'Para resolver el liveChatId si no lo indicas', ui: { component: 'input', type: 'password', placeholder: 'AIza…' } },
                            videoId: { type: 'string', title: 'ID del vídeo', description: 'Directo al que enviar el mensaje', ui: { component: 'input', type: 'text', placeholder: 'ID del directo' } },
                            liveChatId: { type: 'string', title: 'ID del chat en vivo', description: 'Si lo conoces (si no, se resuelve desde el vídeo)', ui: { component: 'input', type: 'text', placeholder: '(opcional)' } },
                            message: { type: 'string', title: 'Mensaje', description: 'Texto a enviar', ui: { component: 'input', type: 'text', placeholder: '¡Hola a todos!' } }
                        },
                        required: ['message']
                    }
                },
                {
                    id: 'start-broadcast', name: 'Pasar emisión a directo', icon: 'Radio',
                    description: 'Transiciona una emisión a "live" (requiere token OAuth + ID de emisión)',
                    schema: {
                        type: 'object',
                        properties: {
                            oauthToken: { type: 'string', title: 'Token OAuth', description: 'Si se omite usa el de los ajustes', ui: { component: 'input', type: 'password', placeholder: 'ya29.…' } },
                            broadcastId: { type: 'string', title: 'ID de emisión', description: 'ID de la liveBroadcast de YouTube Studio', ui: { component: 'input', type: 'text', placeholder: 'ID de la emisión' } }
                        },
                        required: ['broadcastId']
                    }
                },
                {
                    id: 'stop-broadcast', name: 'Terminar emisión', icon: 'Square',
                    description: 'Transiciona una emisión a "complete" (requiere token OAuth + ID de emisión)',
                    schema: {
                        type: 'object',
                        properties: {
                            oauthToken: { type: 'string', title: 'Token OAuth', description: 'Si se omite usa el de los ajustes', ui: { component: 'input', type: 'password', placeholder: 'ya29.…' } },
                            broadcastId: { type: 'string', title: 'ID de emisión', description: 'ID de la liveBroadcast de YouTube Studio', ui: { component: 'input', type: 'text', placeholder: 'ID de la emisión' } }
                        },
                        required: ['broadcastId']
                    }
                },
                {
                    id: 'open-dashboard', name: 'Abrir panel de YouTube Studio', icon: 'LayoutDashboard',
                    description: 'Abre el panel de control del directo en el navegador',
                    schema: {
                        type: 'object',
                        properties: {
                            videoId: { type: 'string', title: 'ID del vídeo', description: 'Si se indica abre directamente ese directo', ui: { component: 'input', type: 'text', placeholder: '(opcional)' } }
                        },
                        required: []
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('viewer-count', this.executeViewerCount.bind(this))
        handlers.set('post-chat', this.executePostChat.bind(this))
        handlers.set('start-broadcast', this.executeStartBroadcast.bind(this))
        handlers.set('stop-broadcast', this.executeStopBroadcast.bind(this))
        handlers.set('open-dashboard', this.executeOpenDashboard.bind(this))
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

    private apiKey(params: any): string {
        const v = (typeof params?.apiKey === 'string' && params.apiKey.trim() ? params.apiKey.trim() : null) ?? this.setting('apiKey')
        if (!v) throw new Error('Falta la API key: créala en Google Cloud Console (YouTube Data API v3 activada) y pégala en los ajustes del plugin o en el parámetro "apiKey".')
        return v
    }

    private oauth(params: any): string {
        const v = (typeof params?.oauthToken === 'string' && params.oauthToken.trim() ? params.oauthToken.trim() : null) ?? this.setting('oauthToken')
        if (!v) throw new Error('Esta acción necesita un token OAuth con scope youtube.force-ssl: genera uno en Google Cloud Console (OAuth consent + playground) y pégalo en los ajustes del plugin o en el parámetro "oauthToken".')
        return v
    }

    private videoId(params: any): string {
        const v = (typeof params?.videoId === 'string' && params.videoId.trim() ? params.videoId.trim() : null) ?? this.setting('videoId')
        if (!v) throw new Error('Falta el ID del vídeo: es lo que va tras "watch?v=" en la URL del directo. Ponlo en los ajustes o en el parámetro "videoId".')
        return v
    }

    private async ytFetch(label: string, url: string, options: { method?: string; token?: string; body?: unknown }): Promise<any> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            this.context.log('info', `YouTube ${label}: ${options.method ?? 'GET'} ${url.split('?')[0]}${url.includes('key=') ? ' (con api key)' : ''}`)
            const headers: Record<string, string> = { 'Content-Type': 'application/json' }
            if (options.token) headers.Authorization = `Bearer ${options.token}`
            const response = await fetch(url, {
                method: options.method ?? 'GET',
                headers,
                body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                signal: controller.signal,
            })
            const text = await response.text().catch(() => '')
            let body: any = null
            try { body = text ? JSON.parse(text) : null } catch { body = text }
            if (response.status === 401 || response.status === 403) {
                const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.message ?? response.statusText
                throw new Error(`YouTube rechazó la petición (${response.status}): ${reason}. Revisa la API key / token OAuth y que la cuota no esté agotada.`)
            }
            if (!response.ok) {
                const reason = body?.error?.message ?? response.statusText
                throw new Error(`Error de la API de YouTube (${response.status}) en "${label}": ${String(reason).slice(0, 300)}`)
            }
            return body
        } catch (error: any) {
            if (error?.name === 'AbortError') throw new Error(`La petición a YouTube tardó demasiado (timeout de 15s): ${label}`)
            throw error
        } finally {
            clearTimeout(timer)
        }
    }

    private async executeViewerCount(params: any, _context: any): Promise<any> {
        const key = this.apiKey(params)
        const videoId = this.videoId(params)
        const url = `${YT_API_BASE}/videos?part=liveStreamingDetails,snippet,statistics&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(key)}`
        const res = await this.ytFetch('espectadores', url, {})
        const video = res?.items?.[0]
        if (!video) throw new Error(`No se encontró ningún vídeo con ID "${videoId}". Revisa el ID (lo que va tras "watch?v=").`)
        const details = video.liveStreamingDetails ?? {}
        const live = Boolean(details.activeLiveChatId || details.actualStartTime) && !details.actualEndTime
        const viewerCount = details.concurrentViewers !== undefined ? Number(details.concurrentViewers) : 0
        return {
            action: 'viewer-count',
            state: live ? 'live' : 'offline',
            videoId,
            title: video.snippet?.title ?? null,
            live,
            viewerCount,
            likeCount: video.statistics?.likeCount !== undefined ? Number(video.statistics.likeCount) : null,
            widget: { kind: 'text' as const, value: String(viewerCount), label: live ? 'en directo' : 'offline' },
        }
    }

    private async resolveLiveChatId(apiKey: string, token: string, videoId: string): Promise<string> {
        const url = `${YT_API_BASE}/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(key)}`
        void token
        const res = await this.ytFetch('resolver chat', url, {})
        const chatId = res?.items?.[0]?.liveStreamingDetails?.activeLiveChatId
        if (!chatId) throw new Error(`El vídeo "${videoId}" no tiene un chat en vivo activo ahora mismo (¿está en directo?).`)
        return chatId
    }

    private async executePostChat(params: any, _context: any): Promise<any> {
        const message = typeof params?.message === 'string' ? params.message.trim() : ''
        if (!message) throw new Error('La acción "Enviar mensaje" requiere el parámetro "message".')
        const token = this.oauth(params)
        let liveChatId = typeof params?.liveChatId === 'string' && params.liveChatId.trim() ? params.liveChatId.trim() : null
        if (!liveChatId) {
            const key = this.apiKey(params)
            liveChatId = await this.resolveLiveChatId(key, token, this.videoId(params))
        }
        const url = `${YT_API_BASE}/liveChat/messages?part=snippet`
        const res = await this.ytFetch('enviar chat', url, { method: 'POST', token, body: { snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: message } } } })
        return { action: 'post-chat', liveChatId, message, messageId: res?.id ?? null, sent: true }
    }

    private async transitionBroadcast(params: any, target: 'live' | 'complete'): Promise<any> {
        const broadcastId = typeof params?.broadcastId === 'string' && params.broadcastId.trim() ? params.broadcastId.trim() : ''
        if (!broadcastId) throw new Error('Indica el parámetro "broadcastId" (el ID de la emisión en YouTube Studio → Configuración de emisión).')
        const token = this.oauth(params)
        const url = `${YT_API_BASE}/liveBroadcasts/transition?broadcastStatus=${target}&id=${encodeURIComponent(broadcastId)}&part=status`
        const res = await this.ytFetch(target === 'live' ? 'iniciar emisión' : 'terminar emisión', url, { method: 'POST', token })
        return { action: target === 'live' ? 'start-broadcast' : 'stop-broadcast', broadcastId, status: res?.status?.lifeCycleStatus ?? target }
    }

    private async executeStartBroadcast(params: any, _context: any): Promise<any> {
        return this.transitionBroadcast(params, 'live')
    }

    private async executeStopBroadcast(params: any, _context: any): Promise<any> {
        return this.transitionBroadcast(params, 'complete')
    }

    private async executeOpenDashboard(params: any, _context: any): Promise<any> {
        const videoId = typeof params?.videoId === 'string' && params.videoId.trim() ? params.videoId.trim() : this.setting('videoId')
        const url = videoId ? `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/livestreaming` : 'https://studio.youtube.com/channel/dashboard'
        this.context.log('info', `YouTube: abriendo panel ${url}`)
        const platform = process.platform
        try {
            if (platform === 'win32') {
                const proc = Bun.spawn({ windowsHide: true,  cmd: ['cmd', '/c', 'start', '""', url], stdio: ['ignore', 'pipe', 'pipe'] })
                await proc.exited
            } else if (platform === 'darwin') {
                const proc = Bun.spawn({ windowsHide: true,  cmd: ['open', url], stdio: ['ignore', 'pipe', 'pipe'] })
                await proc.exited
            } else if (platform === 'linux') {
                const proc = Bun.spawn({ windowsHide: true,  cmd: ['xdg-open', url], stdio: ['ignore', 'pipe', 'pipe'] })
                await proc.exited
            } else {
                throw new Error(`No se puede abrir el navegador en la plataforma: ${platform}`)
            }
            return { action: 'open-dashboard', url, opened: true }
        } catch (error) {
            this.context.log('error', `YouTube: no se pudo abrir el panel: ${error}`)
            throw error
        }
    }

    public dispose(): void {
        // Sin estado persistente.
    }
}
