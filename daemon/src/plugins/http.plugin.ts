/**
 * Native HTTP Plugin
 * Make HTTP requests (con timeout, límite de tamaño y métodos validados).
 */

import { CONTRACT_API_VERSION, CONTRACT_ENGINE } from './contract'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const REQUEST_TIMEOUT_MS = 15000
const MAX_BODY_CHARS = 2 * 1024 * 1024 // 2MB
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export class HttpPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'http',
            name: 'HTTP Requests',
            version: '1.1.0',
            description: 'Make HTTP/HTTPS requests to APIs and webhooks',
            author: 'BunDeck',
            apiVersion: CONTRACT_API_VERSION,
            engine: CONTRACT_ENGINE,
            category: 'integrations',
            permissions: ['http', 'network'],
            actions: [
                {
                    id: 'http',
                    name: 'HTTP Request',
                    description: 'Make an HTTP request',
                    i18n: { es: { name: 'HTTP Request', description: 'Make an HTTP request' }, en: { name: 'HTTP Request', description: 'Make an HTTP request' } }, // TODO i18n: EN temporal = ES
                    icon: 'Globe',
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    schema: {
                        type: 'object',
                        properties: {
                            url: {
                                type: 'string',
                                format: 'uri',
                                title: 'URL',
                                description: 'The URL to request',
                                ui: {
                                    component: 'input',
                                    type: 'url',
                                    placeholder: 'https://api.example.com/endpoint'
                                }
                            },
                            method: {
                                type: 'string',
                                title: 'Método',
                                enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
                                default: 'GET',
                                description: 'HTTP method',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'GET', label: 'GET' },
                                        { value: 'POST', label: 'POST' },
                                        { value: 'PUT', label: 'PUT' },
                                        { value: 'DELETE', label: 'DELETE' },
                                        { value: 'PATCH', label: 'PATCH' }
                                    ]
                                }
                            },
                            headers: {
                                type: 'object',
                                title: 'Headers',
                                description: 'HTTP headers',
                                default: {},
                                ui: {
                                    component: 'hidden' // Can be shown in advanced mode
                                }
                            },
                            body: {
                                title: 'Cuerpo de la petición',
                                description: 'Request body (for POST/PUT/PATCH)',
                                default: null,
                                ui: {
                                    component: 'hidden' // Can be shown in advanced mode
                                }
                            },
                            timeoutMs: {
                                type: 'number',
                                title: 'Tiempo límite (ms)',
                                description: 'Timeout de la petición (por defecto 15000, máx 60000)',
                                default: REQUEST_TIMEOUT_MS,
                                minimum: 500,
                                maximum: 60000,
                                ui: { component: 'hidden' }
                            }
                        },
                        required: ['url']
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('http', this.executeHttpAction.bind(this))
        return handlers
    }

    private async executeHttpAction(params: any, context: any): Promise<any> {
        const { url, method = 'GET', headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = params

        if (!url) {
            throw new Error('URL is required for HTTP action')
        }
        const upperMethod = String(method).toUpperCase()
        if (!ALLOWED_METHODS.includes(upperMethod)) {
            throw new Error(`Método HTTP no permitido: "${method}" (válidos: ${ALLOWED_METHODS.join(', ')})`)
        }
        let parsed: URL
        try {
            parsed = new URL(url)
        } catch {
            throw new Error(`URL no válida: "${url}"`)
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error(`Protocolo no permitido: ${parsed.protocol} (solo http/https)`)
        }
        if (LOCAL_HOSTS.has(parsed.hostname)) {
            this.context.log('warn', `HTTP a localhost: ${upperMethod} ${url} (el plugin http no expone secretos del daemon)`)
        }
        const timeout = Math.min(Math.max(Number(timeoutMs) || REQUEST_TIMEOUT_MS, 500), 60000)

        this.context.log('info', `Making HTTP request: ${upperMethod} ${url}`)

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        try {
            const response = await fetch(url, {
                method: upperMethod,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            })

            const responseBody = await response.text()
            if (responseBody.length > MAX_BODY_CHARS) {
                throw new Error(`Respuesta HTTP excede 2MB (${responseBody.length} caracteres)`)
            }

            this.context.log('info', `HTTP request completed: ${upperMethod} ${url}`, {
                status: response.status,
                statusText: response.statusText
            })

            return {
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            }
        } catch (error: any) {
            if (error?.name === 'AbortError') {
                throw new Error(`La petición HTTP tardó demasiado (timeout de ${timeout} ms): ${upperMethod} ${url}`)
            }
            this.context.log('error', `HTTP request failed: ${error}`, { url, method: upperMethod })
            throw error
        } finally {
            clearTimeout(timer)
        }
    }

    public dispose(): void {
        // Cleanup if needed
    }
}
