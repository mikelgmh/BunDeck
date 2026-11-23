/**
 * Native Email Plugin
 * Bandeja sin dependencias nativas: Gmail API / Outlook Graph con token,
 * más abrir/redactar vía cliente del sistema (mailto:). Sin IMAP nativo:
 * los proveedores modernos exigen OAuth y los tokens se guardan en ajustes.
 */

import { openUrl } from './sysrun'
import { CONTRACT_API_VERSION, CONTRACT_ENGINE } from './contract'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const REQUEST_TIMEOUT_MS = 15000

/** Proveedores soportados para no leídos. Función pura (testeable). */
export function emailProviderOf(provider: string): 'gmail' | 'outlook' {
    const p = String(provider ?? '').toLowerCase()
    if (p === 'outlook' || p === 'microsoft' || p === 'graph' || p === 'hotmail' || p === 'live') return 'outlook'
    return 'gmail'
}

/** Construye el mailto: de redactar. Función pura (testeable). */
export function buildMailto(to: string, subject: string, body: string): string {
    const qs = new URLSearchParams()
    if (subject) qs.set('subject', subject)
    if (body) qs.set('body', body)
    const q = qs.toString()
    return `mailto:${encodeURIComponent(to)}${q ? `?${q}` : ''}`
}

export class EmailPlugin {
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
            id: 'email',
            name: 'Correo',
            version: '1.0.0',
            description: 'No leídos de Gmail/Outlook, abrir bandeja y redactar (mailto:) con tu cliente habitual',
            author: 'BunDeck',
            apiVersion: CONTRACT_API_VERSION,
            engine: CONTRACT_ENGINE,
            category: 'utility',
            permissions: ['network'] as string[],
            settingsSchema: {
                type: 'object',
                properties: {
                    provider: {
                        type: 'string', title: 'Proveedor',
                        description: 'De dónde leer los no leídos',
                        enum: ['gmail', 'outlook'], default: 'gmail',
                        ui: { component: 'select', options: [{ value: 'gmail', label: 'Gmail' }, { value: 'outlook', label: 'Outlook / Microsoft 365' }] }
                    },
                    token: {
                        type: 'string', title: 'Token OAuth',
                        description: 'Gmail: scope gmail.readonly. Outlook: scope Mail.Read. No se muestra en los registros.',
                        secret: true,
                        ui: { component: 'input', type: 'password', placeholder: 'Pega tu token OAuth' }
                    },
                    inboxUrl: {
                        type: 'string', title: 'URL de la bandeja',
                        description: 'Se abre con "Abrir bandeja" (por defecto según proveedor)',
                        ui: { component: 'input', type: 'text', placeholder: '(por defecto)' }
                    }
                }
            },
            instructions: 'Para ver no leídos:\n\n· Gmail: crea un OAuth Client en Google Cloud (scope gmail.readonly), consigue un token y pégalo en los ajustes.\n· Outlook: registra una app en Entra ID (scope Mail.Read) y pega el token.\n· Sin token, "Abrir bandeja" y "Redactar" funcionan igual con tu cliente de correo habitual.',
            widgets: [
                { id: 'unread', kind: 'text', title: 'Sin leer', description: 'Correos sin leer de la bandeja', sourceAction: 'unread', refreshMs: 300000 }
            ],
            actions: [
                {
                    id: 'unread',
                    name: 'Sin leer',
                    description: 'Cuenta correos sin leer (requiere token OAuth del proveedor)',
                    icon: 'Mail',
                    dynamic: true,
                    pollMs: 300000,
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    states: [
                        { value: 'empty', label: 'Sin correos', icon: 'MailOpen' },
                        { value: 'pending', label: 'Con pendientes', icon: 'Mail' }
                    ],
                    schema: {
                        type: 'object',
                        properties: {
                            provider: { type: 'string', title: 'Proveedor', enum: ['gmail', 'outlook'], description: 'Si se omite usa el de ajustes', ui: { component: 'select', options: [{ value: 'gmail', label: 'Gmail' }, { value: 'outlook', label: 'Outlook' }] } },
                            token: { type: 'string', title: 'Token OAuth', description: 'Si se omite usa el de ajustes', secret: true, ui: { component: 'input', type: 'password', placeholder: '(ajustes)' } },
                            label: { type: 'string', title: 'Etiqueta/carpeta', description: 'Gmail: labelIds (INBOX por defecto). Outlook: carpeta (Inbox por defecto)', ui: { component: 'input', type: 'text', placeholder: '(por defecto)' } }
                        },
                        required: []
                    }
                },
                {
                    id: 'open-inbox',
                    name: 'Abrir bandeja',
                    description: 'Abre tu bandeja en el navegador',
                    icon: 'Inbox',
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    schema: {
                        type: 'object',
                        properties: {
                            url: { type: 'string', title: 'URL', description: 'Si se omite usa la de ajustes o la del proveedor', ui: { component: 'input', type: 'text', placeholder: '(por defecto)' } }
                        },
                        required: []
                    }
                },
                {
                    id: 'compose',
                    name: 'Redactar',
                    description: 'Abre tu cliente de correo con destinatario/asunto/cuerpo (mailto:)',
                    icon: 'PenLine',
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    schema: {
                        type: 'object',
                        properties: {
                            to: { type: 'string', title: 'Para', description: 'Destinatario', ui: { component: 'input', type: 'text', placeholder: 'alguien@ejemplo.com' } },
                            subject: { type: 'string', title: 'Asunto', ui: { component: 'input', type: 'text', placeholder: '(opcional)' } },
                            body: { type: 'string', title: 'Cuerpo', ui: { component: 'textarea', type: 'text', placeholder: '(opcional)' } }
                        },
                        required: ['to']
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('unread', this.executeUnread.bind(this))
        handlers.set('open-inbox', this.executeOpenInbox.bind(this))
        handlers.set('compose', this.executeCompose.bind(this))
        return handlers
    }

    private setting(key: string): string | null {
        try {
            const v = this.context.getSetting?.(key)
            return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
        } catch {
            return null
        }
    }

    private token(params: any): string {
        const v = (typeof params?.token === 'string' && params.token.trim() ? params.token.trim() : null) ?? this.setting('token')
        if (!v) throw new Error('Falta el token OAuth: pégalo en los ajustes del plugin (⋯) o en el parámetro "token" (Gmail scope gmail.readonly, Outlook scope Mail.Read).')
        return v
    }

    private provider(params: any): 'gmail' | 'outlook' {
        const raw = (typeof params?.provider === 'string' && params.provider ? params.provider : null) ?? this.setting('provider') ?? 'gmail'
        return emailProviderOf(raw)
    }

    private async apiJson(label: string, url: string, token: string): Promise<any> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            this.context.log('info', `Correo ${label}: GET ${url.split('?')[0]}`)
            const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
            if (res.status === 401 || res.status === 403) {
                throw new Error(`El proveedor rechazó el token (HTTP ${res.status}): caducado o sin el scope necesario (Gmail: gmail.readonly, Outlook: Mail.Read).`)
            }
            if (!res.ok) throw new Error(`El proveedor devolvió HTTP ${res.status} en "${label}".`)
            return await res.json()
        } catch (error: any) {
            if (error?.name === 'AbortError') throw new Error(`El proveedor tardó demasiado (timeout de 15s): ${label}`)
            throw error
        } finally {
            clearTimeout(timer)
        }
    }

    private async executeUnread(params: any, _context: any): Promise<any> {
        const provider = this.provider(params)
        const token = this.token(params)
        if (provider === 'gmail') {
            const label = typeof params?.label === 'string' && params.label ? params.label : 'INBOX'
            const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`is:unread in:${label}`)}&maxResults=5&fields=resultSizeEstimate,messages(id)`
            const res = await this.apiJson('gmail sin leer', url, token)
            const count = Number(res?.resultSizeEstimate ?? 0)
            this.context.log('info', `Correo Gmail: ${count} sin leer`)
            return {
                action: 'unread', provider, count,
                state: count > 0 ? 'pending' : 'empty',
                sampleIds: Array.isArray(res?.messages) ? res.messages.map((m: any) => m?.id).filter(Boolean) : [],
                widget: { kind: 'text' as const, value: String(count), label: count === 1 ? 'sin leer' : 'sin leer' },
            }
        }
        const folder = typeof params?.label === 'string' && params.label ? params.label : 'Inbox'
        const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages?$filter=isRead%20eq%20false&$top=5&$select=id,subject,from&$count=true`
        const res = await this.apiJson('outlook sin leer', url, token)
        const count = typeof res?.['@odata.count'] === 'number' ? res['@odata.count'] : (Array.isArray(res?.value) ? res.value.length : 0)
        this.context.log('info', `Correo Outlook: ${count} sin leer`)
        return {
            action: 'unread', provider, count,
            state: count > 0 ? 'pending' : 'empty',
            sample: Array.isArray(res?.value) ? res.value.map((m: any) => ({ id: m?.id ?? null, subject: m?.subject ?? null })) : [],
            widget: { kind: 'text' as const, value: String(count), label: 'sin leer' },
        }
    }

    private async executeOpenInbox(params: any, _context: any): Promise<any> {
        const fromParams = typeof params?.url === 'string' && params.url.trim() ? params.url.trim() : null
        const configured = this.setting('inboxUrl')
        const provider = this.provider(params)
        const target = fromParams ?? configured ?? (provider === 'gmail' ? 'https://mail.google.com/' : 'https://outlook.live.com/mail/')
        this.context.log('info', `Correo: abriendo ${target}`)
        await this.open(target)
        return { url: target, opened: true }
    }

    private async executeCompose(params: any, _context: any): Promise<any> {
        const to = typeof params?.to === 'string' ? params.to.trim() : ''
        if (!to) throw new Error('La acción "Redactar" requiere el parámetro "to" (destinatario).')
        const subject = typeof params?.subject === 'string' ? params.subject : ''
        const body = typeof params?.body === 'string' ? params.body : ''
        const target = buildMailto(to, subject, body)
        this.context.log('info', `Correo: redactando para ${to}`)
        await this.open(target)
        return { to, opened: true }
    }

    public dispose(): void {
        // Sin recursos persistentes
    }
}
