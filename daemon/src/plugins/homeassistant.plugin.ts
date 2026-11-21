/**
 * Native Home Assistant Plugin
 * Controla luces, escenas e interruptores/enchufes de Home Assistant
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

function normalizeBaseUrl(baseUrl: string): string {
    return (baseUrl || '').trim().replace(/\/+$/, '')
}

function maskToken(token: string): string {
    if (!token || token.length <= 8) return '****'
    return `${token.slice(0, 4)}****${token.slice(-4)}`
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
        return await fetch(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

function toConnectionError(error: any, baseUrl: string): Error {
    if (error instanceof Error && error.name === 'AbortError') {
        return new Error(`Tiempo de espera agotado (15s) al conectar con Home Assistant en ${baseUrl}`)
    }
    return new Error(
        `No se pudo conectar con Home Assistant en ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`
    )
}

export class HomeAssistantPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        const baseUrlProp = {
            type: 'string',
            format: 'uri',
            title: 'URL base',
            description: 'URL base de Home Assistant',
            examples: ['http://homeassistant.local:8123'],
            ui: {
                component: 'input',
                type: 'url',
                placeholder: 'http://homeassistant.local:8123'
            }
        }
        const tokenProp = {
            type: 'string',
            title: 'Token de acceso',
            description: 'Token de acceso de larga duración (long-lived access token)',
            ui: {
                component: 'input',
                type: 'password',
                placeholder: 'Pega aquí tu token de larga duración'
            }
        }
        return {
            id: 'homeassistant',
            name: 'Home Assistant',
            version: '1.0.0',
            description: 'Controla luces, escenas e interruptores de Home Assistant',
            author: 'LibreDeck',
            permissions: ['http', 'network'],
            settingsSchema: {
                type: 'object',
                properties: {
                    baseUrl: {
                        type: 'string',
                        format: 'uri',
                        title: 'URL base',
                        description: 'URL base de Home Assistant. Los parámetros de cada acción tienen prioridad sobre estos valores.',
                        examples: ['http://homeassistant.local:8123'],
                        ui: { component: 'input', type: 'url', placeholder: 'http://homeassistant.local:8123' }
                    },
                    token: {
                        type: 'string',
                        title: 'Token de acceso',
                        description: 'Token de larga duración (perfil de usuario → Tokens de acceso de larga duración)',
                        ui: { component: 'input', type: 'password', placeholder: 'Pega aquí tu token de larga duración' }
                    }
                },
                required: ['baseUrl', 'token']
            },
            instructions: 'Para conectar con Home Assistant:\n\n1. En Home Assistant abre tu perfil de usuario y crea un "Token de acceso de larga duración".\n2. Pega la URL base (ej. http://homeassistant.local:8123) y el token en los ajustes del plugin (menú ⋯).\n3. En cada botón solo tendrás que indicar la entidad (ej. light.salon) y la acción.',
            actions: [
                {
                    id: 'light',
                    name: 'Luz',
                    description: 'Enciende, apaga o alterna una luz',
                    icon: 'Lightbulb',
                    schema: {
                        type: 'object',
                        properties: {
                            baseUrl: baseUrlProp,
                            token: tokenProp,
                            entityId: {
                                type: 'string',
                                title: 'Entidad',
                                description: 'Entidad de la luz (ej. light.salon)',
                                examples: ['light.salon'],
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'light.salon'
                                }
                            },
                            action: {
                                type: 'string',
                                title: 'Acción',
                                description: 'Acción a realizar sobre la luz',
                                enum: ['on', 'off', 'toggle'],
                                default: 'toggle',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'on', label: 'Encender' },
                                        { value: 'off', label: 'Apagar' },
                                        { value: 'toggle', label: 'Alternar' }
                                    ]
                                }
                            },
                            brightness: {
                                type: 'integer',
                                title: 'Brillo',
                                description: 'Brillo de la luz (0-255). Solo para encender.',
                                minimum: 0,
                                maximum: 255,
                                ui: {
                                    component: 'input',
                                    type: 'number',
                                    placeholder: '255'
                                }
                            },
                            colorTemp: {
                                type: 'integer',
                                title: 'Temperatura de color',
                                description: 'Temperatura de color en kelvin. Solo para encender.',
                                minimum: 1000,
                                maximum: 10000,
                                ui: {
                                    component: 'input',
                                    type: 'number',
                                    placeholder: '4000'
                                }
                            }
                        },
                        required: ['entityId']
                    }
                },
                {
                    id: 'scene',
                    name: 'Ambiente',
                    description: 'Activa una escena de Home Assistant',
                    icon: 'Sparkles',
                    schema: {
                        type: 'object',
                        properties: {
                            baseUrl: baseUrlProp,
                            token: tokenProp,
                            entityId: {
                                type: 'string',
                                title: 'Escena',
                                description: 'Entidad de la escena (ej. scene.pelicula)',
                                examples: ['scene.pelicula'],
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'scene.pelicula'
                                }
                            }
                        },
                        required: ['entityId']
                    }
                },
                {
                    id: 'switch',
                    name: 'Interruptor',
                    description: 'Enciende, apaga o alterna un interruptor o enchufe',
                    icon: 'Plug',
                    schema: {
                        type: 'object',
                        properties: {
                            baseUrl: baseUrlProp,
                            token: tokenProp,
                            entityId: {
                                type: 'string',
                                title: 'Entidad',
                                description: 'Entidad del interruptor (ej. switch.cafetera)',
                                examples: ['switch.cafetera'],
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'switch.cafetera'
                                }
                            },
                            action: {
                                type: 'string',
                                title: 'Acción',
                                description: 'Acción a realizar sobre el interruptor',
                                enum: ['on', 'off', 'toggle'],
                                default: 'toggle',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'on', label: 'Encender' },
                                        { value: 'off', label: 'Apagar' },
                                        { value: 'toggle', label: 'Alternar' }
                                    ]
                                }
                            }
                        },
                        required: ['entityId']
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('light', this.executeLightAction.bind(this))
        handlers.set('scene', this.executeSceneAction.bind(this))
        handlers.set('switch', this.executeSwitchAction.bind(this))
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

    private requireBaseParams(params: any): { baseUrl: string; token: string; entityId: string } {
        // Los parámetros de la acción tienen prioridad; si faltan, se usan los ajustes del plugin.
        const baseUrl = params?.baseUrl ?? this.setting('baseUrl')
        const token = params?.token ?? this.setting('token')
        const entityId = params?.entityId
        if (!baseUrl) throw new Error('La URL base es obligatoria: ponla en los ajustes del plugin (⋯) o en baseUrl, ej. http://homeassistant.local:8123')
        if (!token) throw new Error('El token de acceso es obligatorio: ponlo en los ajustes del plugin (⋯) o en token')
        if (!entityId) throw new Error('La entidad (entityId) es obligatoria, ej. light.salon')
        return { baseUrl: normalizeBaseUrl(String(baseUrl)), token: String(token), entityId: String(entityId) }
    }

    private async callService(
        baseUrl: string,
        token: string,
        domain: string,
        service: string,
        entityId: string,
        extraData: Record<string, unknown> = {}
    ): Promise<void> {
        const url = `${baseUrl}/api/services/${domain}/${service}`
        const body = JSON.stringify({ entity_id: entityId, ...extraData })
        let response: Response
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body
            })
        } catch (error) {
            throw toConnectionError(error, baseUrl)
        }
        if (response.status === 401) {
            throw new Error('Token inválido o sin autorización (401): revisa el long-lived access token de Home Assistant')
        }
        if (response.status === 404) {
            throw new Error(`Entidad no encontrada (404): "${entityId}" no existe en Home Assistant`)
        }
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 300)
            throw new Error(`Home Assistant devolvió el error ${response.status} al llamar a ${domain}.${service}${detail ? `: ${detail}` : ''}`)
        }
    }

    private async readState(baseUrl: string, token: string, entityId: string): Promise<any | null> {
        try {
            const response = await fetchWithTimeout(`${baseUrl}/api/states/${entityId}`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` }
            })
            if (!response.ok) return null
            return await response.json().catch(() => null)
        } catch {
            return null
        }
    }

    private async executeLightAction(params: any, _context: any): Promise<any> {
        const { baseUrl, token, entityId } = this.requireBaseParams(params)
        const action: string = params?.action ?? 'toggle'
        if (!['on', 'off', 'toggle'].includes(action)) {
            throw new Error(`Acción de luz no válida: "${action}". Usa on, off o toggle.`)
        }
        const service = action === 'on' ? 'turn_on' : action === 'off' ? 'turn_off' : 'toggle'
        const serviceData: Record<string, unknown> = {}
        if (service === 'turn_on') {
            if (params?.brightness !== undefined && params.brightness !== null && params.brightness !== '') {
                const brightness = Number(params.brightness)
                if (!Number.isInteger(brightness) || brightness < 0 || brightness > 255) {
                    throw new Error('El brillo (brightness) debe ser un entero entre 0 y 255')
                }
                serviceData.brightness = brightness
            }
            if (params?.colorTemp !== undefined && params.colorTemp !== null && params.colorTemp !== '') {
                const colorTemp = Number(params.colorTemp)
                if (!Number.isInteger(colorTemp) || colorTemp < 1000 || colorTemp > 10000) {
                    throw new Error('La temperatura de color (colorTemp) debe ser un entero en kelvin (1000-10000)')
                }
                serviceData.color_temp_kelvin = colorTemp
            }
        }

        this.context.log('info', `Home Assistant: luz ${action} ${entityId} en ${baseUrl}`, { token: maskToken(token) })
        await this.callService(baseUrl, token, 'light', service, entityId, serviceData)
        this.context.log('info', `Home Assistant: luz ${entityId} -> ${service} OK`)
        const state = await this.readState(baseUrl, token, entityId)
        return { success: true, entityId, action, service: `light.${service}`, state }
    }

    private async executeSceneAction(params: any, _context: any): Promise<any> {
        const { baseUrl, token, entityId } = this.requireBaseParams(params)
        this.context.log('info', `Home Assistant: activar escena ${entityId} en ${baseUrl}`, { token: maskToken(token) })
        await this.callService(baseUrl, token, 'scene', 'turn_on', entityId)
        this.context.log('info', `Home Assistant: escena ${entityId} activada`)
        const state = await this.readState(baseUrl, token, entityId)
        return { success: true, entityId, action: 'activate', service: 'scene.turn_on', state }
    }

    private async executeSwitchAction(params: any, _context: any): Promise<any> {
        const { baseUrl, token, entityId } = this.requireBaseParams(params)
        const action: string = params?.action ?? 'toggle'
        if (!['on', 'off', 'toggle'].includes(action)) {
            throw new Error(`Acción de interruptor no válida: "${action}". Usa on, off o toggle.`)
        }
        const service = action === 'on' ? 'turn_on' : action === 'off' ? 'turn_off' : 'toggle'
        this.context.log('info', `Home Assistant: interruptor ${action} ${entityId} en ${baseUrl}`, { token: maskToken(token) })
        await this.callService(baseUrl, token, 'switch', service, entityId)
        this.context.log('info', `Home Assistant: interruptor ${entityId} -> ${service} OK`)
        const state = await this.readState(baseUrl, token, entityId)
        return { success: true, entityId, action, service: `switch.${service}`, state }
    }

    public dispose(): void {
        // Sin recursos que liberar (fetch con timeout por petición)
    }
}
