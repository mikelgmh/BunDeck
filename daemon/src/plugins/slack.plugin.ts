/**
 * Native Slack Plugin
 * Abrir canales/DMs, contar no leídos y enviar mensajes vía Slack Web API.
 * El token es opcional por acción: si falta se usa el de los ajustes del plugin.
 */

import { openUrl } from './sysrun'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const SLACK_API = 'https://slack.com/api'
const REQUEST_TIMEOUT_MS = 15000

async function slackFetch(token: string, method: string, params: Record<string, string> = {}, body?: any): Promise<any> {
    const qs = new URLSearchParams(params).toString()
    const url = `${SLACK_API}/${method}${qs ? `?${qs}` : ''}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
        const res = await fetch(url, {
            method: body !== undefined ? 'POST' : 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        })
        const data = await res.json().catch(() => null) as any
        if (!res.ok) throw new Error(`Slack devolvió HTTP ${res.status}: ${res.statusText || method}`)
        if (!data?.ok) {
            const err = data?.error ?? 'error desconocido'
            if (err === 'invalid_auth' || err === 'not_authed') {
                throw new Error('Token de Slack no válido: revísalo en los ajustes del plugin (⋯). Necesita scopes channels:read, im:read, mpim:read, chat:write.')
            }
            throw new Error(`Slack rechazó la petición (${method}): ${humanSlackError(err)}`)
        }
        return data
    } catch (error: any) {
        if (error?.name === 'AbortError') throw new Error(`Slack tardó demasiado (timeout de 15s) en ${method}.`)
        throw error
    } finally {
        clearTimeout(timer)
    }
}

function humanSlackError(code: string): string {
    const map: Record<string, string> = {
        channel_not_found: 'canal no encontrado (usa el ID del canal, ej. C012345, no el nombre con #)',
        user_not_found: 'usuario no encontrado (usa el ID de usuario, ej. U012345)',
        not_in_channel: 'el bot no está en el canal: invítalo primero con /invite',
        missing_scope: 'al token le faltan scopes (channels:read, im:read, mpim:read, chat:write)',
        ratelimited: 'límite de Slack alcanzado: reintenta en unos segundos',
        invalid_channel: 'canal no válido',
        no_text: 'falta el texto del mensaje',
    }
    return map[code] ?? code
}

export class SlackPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    /** Punto de inyección para tests (apertura real de URL). */
    protected async open(target: string): Promise<void> {
        return openUrl(target)
    }

    public getManifest() {
        return {
            id: 'slack',
            name: 'Slack',
            version: '1.0.0',
            description: 'Abre canales y DMs, cuenta no leídos y envía mensajes',
            author: 'BunDeck',
            permissions: ['http', 'network'],
            settingsSchema: {
                type: 'object',
                properties: {
                    token: {
                        type: 'string',
                        title: 'Token OAuth',
                        description: 'Token de bot (xoxb-…) con scopes channels:read, im:read, mpim:read, chat:write. Los parámetros de cada acción tienen prioridad.',
                        ui: { component: 'input', type: 'password', placeholder: 'xoxb-…' }
                    },
                    defaultChannel: {
                        type: 'string',
                        title: 'Canal por defecto',
                        description: 'ID del canal usado si la acción no indica uno (ej. C012345)',
                        ui: { component: 'input', type: 'text', placeholder: 'C012345' }
                    }
                }
            },
            instructions:
                'Para conectar con Slack:\n\n' +
                '1. Crea una app en https://api.slack.com/apps con scopes channels:read, im:read, mpim:read, chat:write e instálala en tu workspace.\n' +
                '2. Pega el Bot Token (xoxb-…) en los ajustes del plugin (menú ⋯).\n' +
                '3. Invita al bot a los canales con /invite.\n' +
                'Los IDs de canal/usuario se ven en Slack (clic derecho → Ver detalles). "Abrir canal/DM" funciona sin token (abre el navegador).',
            actions: [
                {
                    id: 'open-channel',
                    name: 'Abrir canal',
                    description: 'Abre un canal de Slack en el navegador/app (sin token)',
                    icon: 'Hash',
                    schema: {
                        type: 'object',
                        properties: {
                            channel: {
                                type: 'string',
                                title: 'Canal',
                                description: 'ID del canal (ej. C012345). Con el nombre no siempre redirige: mejor usa el ID.',
                                ui: { component: 'input', type: 'text', placeholder: 'C012345' }
                            }
                        },
                        required: ['channel']
                    }
                },
                {
                    id: 'open-dm',
                    name: 'Abrir DM',
                    description: 'Abre un mensaje directo con un usuario (sin token)',
                    icon: 'User',
                    schema: {
                        type: 'object',
                        properties: {
                            user: {
                                type: 'string',
                                title: 'Usuario',
                                description: 'ID del usuario (ej. U012345)',
                                ui: { component: 'input', type: 'text', placeholder: 'U012345' }
                            }
                        },
                        required: ['user']
                    }
                },
                {
                    id: 'unread-count',
                    name: 'Contar no leídos',
                    description: 'Suma los mensajes no leídos de canales y DMs (requiere token)',
                    icon: 'Bell',
                    schema: {
                        type: 'object',
                        properties: {
                            token: {
                                type: 'string',
                                title: 'Token OAuth',
                                description: 'Si se omite se usa el de los ajustes del plugin',
                                ui: { component: 'input', type: 'password', placeholder: '(usa el de ajustes)' }
                            }
                        }
                    }
                },
                {
                    id: 'send-message',
                    name: 'Enviar mensaje',
                    description: 'Publica un mensaje en un canal (requiere token)',
                    icon: 'Send',
                    schema: {
                        type: 'object',
                        properties: {
                            channel: {
                                type: 'string',
                                title: 'Canal',
                                description: 'ID del canal (o el de por defecto en ajustes)',
                                ui: { component: 'input', type: 'text', placeholder: 'C012345' }
                            },
                            token: {
                                type: 'string',
                                title: 'Token OAuth',
                                description: 'Si se omite se usa el de los ajustes del plugin',
                                ui: { component: 'input', type: 'password', placeholder: '(usa el de ajustes)' }
                            },
                            text: {
                                type: 'string',
                                title: 'Texto',
                                description: 'Texto del mensaje (admite formato mrkdwn)',
                                ui: { component: 'textarea', placeholder: 'Hola desde LibreDeck :wave:' }
                            }
                        },
                        required: ['text']
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('open-channel', this.executeOpenChannel.bind(this))
        handlers.set('open-dm', this.executeOpenDm.bind(this))
        handlers.set('unread-count', this.executeUnreadCount.bind(this))
        handlers.set('send-message', this.executeSendMessage.bind(this))
        return handlers
    }

    private requireToken(params: any): string {
        const fromParams = params?.token
        if (typeof fromParams === 'string' && fromParams.trim().length > 0) return fromParams.trim()
        try {
            const saved = this.context.getSetting?.('token')
            if (typeof saved === 'string' && saved.trim().length > 0) return saved.trim()
        } catch { /* cae al error */ }
        throw new Error('Falta el token de Slack: ponlo en los ajustes del plugin (⋯) o en el parámetro "token".')
    }

    private requireChannel(params: any): string {
        const fromParams = params?.channel
        if (typeof fromParams === 'string' && fromParams.trim().length > 0) return fromParams.trim()
        try {
            const saved = this.context.getSetting?.('defaultChannel')
            if (typeof saved === 'string' && saved.trim().length > 0) return saved.trim()
        } catch { /* cae al error */ }
        throw new Error('Indica el "channel" (ID del canal, ej. C012345) o configura un canal por defecto en ajustes.')
    }

    private async executeOpenChannel(params: any, _context: any): Promise<any> {
        const channel = this.requireChannel(params)
        const url = `https://slack.com/app_redirect?channel=${encodeURIComponent(channel)}`
        this.context.log('info', `Slack: abriendo canal ${channel}`)
        await this.open(url)
        return { channel, url, opened: true }
    }

    private async executeOpenDm(params: any, _context: any): Promise<any> {
        const { user } = params ?? {}
        if (typeof user !== 'string' || user.trim().length === 0) {
            throw new Error('Indica el "user" (ID del usuario, ej. U012345).')
        }
        const url = `https://slack.com/app_redirect?user=${encodeURIComponent(user.trim())}`
        this.context.log('info', `Slack: abriendo DM con ${user}`)
        await this.open(url)
        return { user: user.trim(), url, opened: true }
    }

    private async executeUnreadCount(params: any, _context: any): Promise<any> {
        const token = this.requireToken(params)
        this.context.log('info', 'Slack: contando no leídos')
        const list = await slackFetch(token, 'conversations.list', {
            exclude_archived: 'true',
            types: 'public_channel,private_channel,im,mpim',
            limit: '200',
        })
        const channels = (list.channels ?? []) as Array<{ id: string; name?: string; is_im?: boolean }>
        const infos = await Promise.all(channels.map(async (c) => {
            try {
                const info = await slackFetch(token, 'conversations.info', { channel: c.id })
                const unread = Number(info.channel?.unread_count_display ?? info.channel?.unread_count ?? 0)
                return { id: c.id, name: info.channel?.name ?? c.name ?? c.id, unread: Number.isFinite(unread) ? unread : 0 }
            } catch {
                return { id: c.id, name: c.name ?? c.id, unread: 0 }
            }
        }))
        const withUnread = infos.filter(i => i.unread > 0).sort((a, b) => b.unread - a.unread)
        const total = withUnread.reduce((n, i) => n + i.unread, 0)
        this.context.log('info', `Slack: ${total} no leídos en ${withUnread.length} conversaciones`)
        return { total, conversations: withUnread.slice(0, 20), checked: channels.length }
    }

    private async executeSendMessage(params: any, _context: any): Promise<any> {
        const token = this.requireToken(params)
        const channel = this.requireChannel(params)
        const { text } = params ?? {}
        if (typeof text !== 'string' || text.trim().length === 0) {
            throw new Error('Indica el "text" del mensaje (no puede estar vacío).')
        }
        this.context.log('info', `Slack: enviando mensaje a ${channel}`)
        const data = await slackFetch(token, 'chat.postMessage', {}, { channel, text: text.trim() })
        return { channel, ts: data.ts ?? null, sent: true }
    }

    public dispose(): void {
        // Sin recursos persistentes
    }
}
