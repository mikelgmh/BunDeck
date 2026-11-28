/**
 * Native Home Assistant Plugin
 * Una sola acción «Entidad»: el dominio se deduce del entity_id
 * (light.salon, switch.cafetera, cover.salon, climate.salon, scene.x,
 * automation.x, sensor.x…). Las acciones antiguas se conservan como
 * alias ocultos para no romper botones existentes.
 */

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

/** Dominios de solo lectura: cualquier acción de escritura se rechaza. */
const READ_ONLY_DOMAINS = new Set(['sensor', 'binary_sensor'])

function normalizeBaseUrl(baseUrl: string): string {
    return (baseUrl || '').trim().replace(/\/+$/, '')
}

function maskToken(token: string): string {
    if (!token || token.length <= 8) return '****'
    return `${token.slice(0, 4)}****${token.slice(-4)}`
}

function domainOf(entityId: string): string {
    return String(entityId).split('.')[0]?.trim().toLowerCase() ?? ''
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
        const entityIdProp = {
            type: 'string',
            title: 'Entidad',
            description: 'Cualquier entidad: light.salon, switch.cafetera, cover.salon, climate.salon, scene.pelicula, automation.buenos_dias, sensor.temperatura…',
            examples: ['light.salon'],
            ui: {
                component: 'input',
                type: 'text',
                placeholder: 'light.salon'
            }
        }
        const hiddenAlias = { deprecated: true, hidden: true }
        return {
            id: 'homeassistant',
            name: 'Home Assistant',
            version: '2.1.1',
            description: 'Controla cualquier entidad de Home Assistant con una sola acción; la lista de entidades se obtiene de tu instancia',
            author: 'BunDeck',
            apiVersion: CONTRACT_API_VERSION,
            engine: CONTRACT_ENGINE,
            category: 'integrations',
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
            instructions: 'Para conectar con Home Assistant:\n\n1. En Home Assistant abre tu perfil de usuario y crea un "Token de acceso de larga duración".\n2. Pega la URL base (ej. http://homeassistant.local:8123) y el token en los ajustes del plugin (menú ⋯).\n3. Añade la acción «Entidad», indica cualquier entity_id (ej. light.salon, cover.salon, climate.salon) y elige la acción.',
            actions: [
                {
                    id: 'entity',
                    name: 'Entidad',
                    description: 'Controla o lee cualquier entidad: el dominio se deduce del entity_id (luz, interruptor, persiana, clima, escena, automatización, sensor…)',
                    i18n: { es: { name: 'Entidad', description: 'Controla o lee cualquier entidad: el dominio se deduce del entity_id (luz, interruptor, persiana, clima, escena, automatización, sensor…)' }, en: { name: 'Entidad', description: 'Controla o lee cualquier entidad: el dominio se deduce del entity_id (luz, interruptor, persiana, clima, escena, automatización, sensor…)' } }, // TODO i18n: EN temporal = ES
                    icon: 'House',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    dynamic: true,
                    pollMs: 15000,
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    states: [
                        { value: 'on', label: 'Encendido', icon: 'ToggleRight' },
                        { value: 'off', label: 'Apagado', icon: 'ToggleLeft' }
                    ],
                    optionsFrom: { field: 'entityId', sourceAction: 'entity-list', cacheMs: 30000, forwardParams: ['baseUrl', 'token'] },
                    schema: {
                        type: 'object',
                        properties: {
                            baseUrl: baseUrlProp,
                            token: tokenProp,
                            entityId: entityIdProp,
                            action: {
                                type: 'string',
                                title: 'Acción',
                                description: 'Qué hacer con la entidad',
                                enum: ['toggle', 'on', 'off', 'open', 'close', 'stop', 'set-position', 'activate', 'trigger', 'set-climate', 'read'],
                                default: 'toggle',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'toggle', label: 'Alternar' },
                                        { value: 'on', label: 'Encender' },
                                        { value: 'off', label: 'Apagar' },
                                        { value: 'open', label: 'Abrir (persiana)' },
                                        { value: 'close', label: 'Cerrar (persiana)' },
                                        { value: 'stop', label: 'Detener (persiana)' },
                                        { value: 'set-position', label: 'Ir a posición (persiana)' },
                                        { value: 'activate', label: 'Activar (escena / script)' },
                                        { value: 'trigger', label: 'Disparar (automatización)' },
                                        { value: 'set-climate', label: 'Ajustar clima (modo / temperatura)' },
                                        { value: 'read', label: 'Leer estado (sensor / cualquiera)' }
                                    ]
                                }
                            },
                            brightness: {
                                type: 'integer',
                                title: 'Brillo',
                                description: 'Brillo 0-255. Solo luces al encender.',
                                minimum: 0,
                                maximum: 255,
                                ui: { component: 'input', type: 'number', placeholder: '255' }
                            },
                            colorTemp: {
                                type: 'integer',
                                title: 'Temperatura de color',
                                description: 'Kelvin 1000-10000. Solo luces al encender.',
                                minimum: 1000,
                                maximum: 10000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            },
                            position: {
                                type: 'integer',
                                title: 'Posición',
                                description: 'Posición 0-100. Solo persianas con «Ir a posición».',
                                minimum: 0,
                                maximum: 100,
                                ui: { component: 'input', type: 'number', placeholder: '50' }
                            },
                            hvacMode: {
                                type: 'string',
                                title: 'Modo',
                                description: 'Modo HVAC. Solo clima con «Ajustar clima».',
                                enum: ['off', 'heat', 'cool', 'auto', 'fan_only', 'dry'],
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'off', label: 'Apagado' },
                                        { value: 'heat', label: 'Calor' },
                                        { value: 'cool', label: 'Frío' },
                                        { value: 'auto', label: 'Automático' },
                                        { value: 'fan_only', label: 'Solo ventilador' },
                                        { value: 'dry', label: 'Deshumidificar' }
                                    ]
                                }
                            },
                            temperature: {
                                type: 'number',
                                title: 'Temperatura',
                                description: 'Temperatura objetivo en °C. Solo clima con «Ajustar clima».',
                                minimum: 5,
                                maximum: 35,
                                ui: { component: 'input', type: 'number', placeholder: '21' }
                            }
                        },
                        required: ['entityId']
                    }
                },
                {
                    // Fuente de opciones para el campo Entidad (no se muestra: la llama la UI).
                    id: 'entity-list',
                    name: 'Listar entidades',
                    description: 'Devuelve las entidades de Home Assistant con sus acciones compatibles',
                    i18n: { es: { name: 'Listar entidades', description: 'Devuelve las entidades de Home Assistant con sus acciones compatibles' }, en: { name: 'Listar entidades', description: 'Devuelve las entidades de Home Assistant con sus acciones compatibles' } }, // TODO i18n: EN temporal = ES
                    icon: 'List',
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    ...hiddenAlias,
                    schema: {
                        type: 'object',
                        properties: {
                            baseUrl: baseUrlProp,
                            token: tokenProp
                        },
                        required: []
                    }
                },
                // ---- Alias heredados (ocultos): no se muestran en la biblioteca,
                // ---- pero siguen funcionando para no romper botones existentes.
                {
                    id: 'light',
                    name: 'Luz (clásico)',
                    description: 'Alias de «Entidad» para light.*',
                    i18n: { es: { name: 'Luz (clásico)', description: 'Alias de «Entidad» para light.*' }, en: { name: 'Luz (clásico)', description: 'Alias de «Entidad» para light.*' } }, // TODO i18n: EN temporal = ES
                    icon: 'Lightbulb',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    ...hiddenAlias,
                    states: [
                        { value: 'on', label: 'Encendida', icon: 'Lightbulb' },
                        { value: 'off', label: 'Apagada', icon: 'LightbulbOff' }
                    ],
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
                                ui: { component: 'input', type: 'text', placeholder: 'light.salon' }
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
                                ui: { component: 'input', type: 'number', placeholder: '255' }
                            },
                            colorTemp: {
                                type: 'integer',
                                title: 'Temperatura de color',
                                description: 'Temperatura de color en kelvin. Solo para encender.',
                                minimum: 1000,
                                maximum: 10000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: ['entityId']
                    }
                },
                {
                    id: 'scene',
                    name: 'Ambiente (clásico)',
                    description: 'Alias de «Entidad» → Activar para scene.*',
                    i18n: { es: { name: 'Ambiente (clásico)', description: 'Alias de «Entidad» → Activar para scene.*' }, en: { name: 'Ambiente (clásico)', description: 'Alias de «Entidad» → Activar para scene.*' } }, // TODO i18n: EN temporal = ES
                    icon: 'Sparkles',
                    ...hiddenAlias,
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
                                ui: { component: 'input', type: 'text', placeholder: 'scene.pelicula' }
                            }
                        },
                        required: ['entityId']
                    }
                },
                {
                    id: 'switch',
                    name: 'Interruptor (clásico)',
                    description: 'Alias de «Entidad» para switch.*',
                    i18n: { es: { name: 'Interruptor (clásico)', description: 'Alias de «Entidad» para switch.*' }, en: { name: 'Interruptor (clásico)', description: 'Alias de «Entidad» para switch.*' } }, // TODO i18n: EN temporal = ES
                    icon: 'Plug',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    ...hiddenAlias,
                    states: [
                        { value: 'on', label: 'Encendido', icon: 'Plug' },
                        { value: 'off', label: 'Apagado', icon: 'PlugZap' }
                    ],
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
                                ui: { component: 'input', type: 'text', placeholder: 'switch.cafetera' }
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
                },
                {
                    id: 'scene-activate',
                    name: 'Activar escena (clásico)',
                    description: 'Alias de «Entidad» → Activar',
                    i18n: { es: { name: 'Activar escena (clásico)', description: 'Alias de «Entidad» → Activar' }, en: { name: 'Activar escena (clásico)', description: 'Alias de «Entidad» → Activar' } }, // TODO i18n: EN temporal = ES
                    icon: 'Sparkles',
                    ...hiddenAlias,
                    schema: {
                        type: 'object',
                        properties: {
                            baseUrl: baseUrlProp,
                            token: tokenProp,
                            entityId: {
                                type: 'string',
                                title: 'Escena',
                                description: 'Entidad de la escena (ej. scene.atardecer)',
                                examples: ['scene.atardecer'],
                                ui: { component: 'input', type: 'text', placeholder: 'scene.atardecer' }
                            }
                        },
                        required: ['entityId']
                    }
                },
                {
                    id: 'automation-trigger',
                    name: 'Disparar automatización (clásico)',
                    description: 'Alias de «Entidad» → Disparar',
                    i18n: { es: { name: 'Disparar automatización (clásico)', description: 'Alias de «Entidad» → Disparar' }, en: { name: 'Disparar automatización (clásico)', description: 'Alias de «Entidad» → Disparar' } }, // TODO i18n: EN temporal = ES
                    icon: 'Zap',
                    ...hiddenAlias,
                    schema: {
                        type: 'object',
                        properties: {
                            baseUrl: baseUrlProp,
                            token: tokenProp,
                            entityId: {
                                type: 'string',
                                title: 'Automatización',
                                description: 'Entidad de la automatización (ej. automation.buenos_dias)',
                                examples: ['automation.buenos_dias'],
                                ui: { component: 'input', type: 'text', placeholder: 'automation.buenos_dias' }
                            }
                        },
                        required: ['entityId']
                    }
                },
                {
                    id: 'cover-control',
                    name: 'Persiana / Toldo (clásico)',
                    description: 'Alias de «Entidad» para cover.*',
                    i18n: { es: { name: 'Persiana / Toldo (clásico)', description: 'Alias de «Entidad» para cover.*' }, en: { name: 'Persiana / Toldo (clásico)', description: 'Alias de «Entidad» para cover.*' } }, // TODO i18n: EN temporal = ES
                    icon: 'Blinds',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    ...hiddenAlias,
                    schema: {
                        type: 'object',
                        properties: {
                            baseUrl: baseUrlProp,
                            token: tokenProp,
                            entityId: {
                                type: 'string',
                                title: 'Entidad',
                                description: 'Entidad de la persiana (ej. cover.salon)',
                                examples: ['cover.salon'],
                                ui: { component: 'input', type: 'text', placeholder: 'cover.salon' }
                            },
                            action: {
                                type: 'string',
                                title: 'Acción',
                                description: 'Acción a realizar',
                                enum: ['open', 'close', 'stop', 'set-position'],
                                default: 'open',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'open', label: 'Abrir' },
                                        { value: 'close', label: 'Cerrar' },
                                        { value: 'stop', label: 'Detener' },
                                        { value: 'set-position', label: 'Ir a posición' }
                                    ]
                                }
                            },
                            position: {
                                type: 'integer',
                                title: 'Posición',
                                description: 'Posición 0-100 (solo para Ir a posición)',
                                minimum: 0,
                                maximum: 100,
                                ui: { component: 'input', type: 'number', placeholder: '50' }
                            }
                        },
                        required: ['entityId']
                    }
                },
                {
                    id: 'climate-set',
                    name: 'Climatización (clásico)',
                    description: 'Alias de «Entidad» → Ajustar clima',
                    i18n: { es: { name: 'Climatización (clásico)', description: 'Alias de «Entidad» → Ajustar clima' }, en: { name: 'Climatización (clásico)', description: 'Alias de «Entidad» → Ajustar clima' } }, // TODO i18n: EN temporal = ES
                    icon: 'Thermometer',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    ...hiddenAlias,
                    schema: {
                        type: 'object',
                        properties: {
                            baseUrl: baseUrlProp,
                            token: tokenProp,
                            entityId: {
                                type: 'string',
                                title: 'Entidad',
                                description: 'Entidad del clima (ej. climate.salon)',
                                examples: ['climate.salon'],
                                ui: { component: 'input', type: 'text', placeholder: 'climate.salon' }
                            },
                            hvacMode: {
                                type: 'string',
                                title: 'Modo',
                                description: 'Modo HVAC (vacío = no cambiar)',
                                enum: ['off', 'heat', 'cool', 'auto', 'fan_only', 'dry'],
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'off', label: 'Apagado' },
                                        { value: 'heat', label: 'Calor' },
                                        { value: 'cool', label: 'Frío' },
                                        { value: 'auto', label: 'Automático' },
                                        { value: 'fan_only', label: 'Solo ventilador' },
                                        { value: 'dry', label: 'Deshumidificar' }
                                    ]
                                }
                            },
                            temperature: {
                                type: 'number',
                                title: 'Temperatura',
                                description: 'Temperatura objetivo en °C (vacío = no cambiar)',
                                minimum: 5,
                                maximum: 35,
                                ui: { component: 'input', type: 'number', placeholder: '21' }
                            }
                        },
                        required: ['entityId']
                    }
                },
                {
                    id: 'sensor-value',
                    name: 'Leer sensor (clásico)',
                    description: 'Alias de «Entidad» → Leer estado',
                    i18n: { es: { name: 'Leer sensor (clásico)', description: 'Alias de «Entidad» → Leer estado' }, en: { name: 'Leer sensor (clásico)', description: 'Alias de «Entidad» → Leer estado' } }, // TODO i18n: EN temporal = ES
                    icon: 'Gauge',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    dynamic: true,
                    pollMs: 30000,
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    ...hiddenAlias,
                    schema: {
                        type: 'object',
                        properties: {
                            baseUrl: baseUrlProp,
                            token: tokenProp,
                            entityId: {
                                type: 'string',
                                title: 'Entidad',
                                description: 'Entidad del sensor (ej. sensor.temperatura_salon)',
                                examples: ['sensor.temperatura_salon'],
                                ui: { component: 'input', type: 'text', placeholder: 'sensor.temperatura_salon' }
                            }
                        },
                        required: ['entityId']
                    }
                },
                {
                    id: 'get-state',
                    name: 'Estado de entidad (clásico)',
                    description: 'Alias de «Entidad» → Leer estado',
                    i18n: { es: { name: 'Estado de entidad (clásico)', description: 'Alias de «Entidad» → Leer estado' }, en: { name: 'Estado de entidad (clásico)', description: 'Alias de «Entidad» → Leer estado' } }, // TODO i18n: EN temporal = ES
                    icon: 'Activity',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    dynamic: true,
                    pollMs: 15000,
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    ...hiddenAlias,
                    states: [
                        { value: 'on', label: 'Encendido', icon: 'ToggleRight' },
                        { value: 'off', label: 'Apagado', icon: 'ToggleLeft' }
                    ],
                    schema: {
                        type: 'object',
                        properties: {
                            baseUrl: baseUrlProp,
                            token: tokenProp,
                            entityId: {
                                type: 'string',
                                title: 'Entidad',
                                description: 'Cualquier entidad (ej. light.salon, switch.cafetera, sensor.temperatura)',
                                examples: ['light.salon'],
                                ui: { component: 'input', type: 'text', placeholder: 'light.salon' }
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
        handlers.set('entity', this.executeEntityAction.bind(this))
        handlers.set('entity-list', this.executeEntityListAction.bind(this))
        // Alias heredados: delegan en la acción unificada.
        handlers.set('light', async (p, c) => this.executeEntityAction({ ...p, action: p?.action ?? 'toggle' }, c))
        handlers.set('switch', async (p, c) => this.executeEntityAction({ ...p, action: p?.action ?? 'toggle' }, c))
        handlers.set('cover-control', async (p, c) => this.executeEntityAction({ ...p, action: p?.action ?? 'open' }, c))
        handlers.set('scene', async (p, c) => this.executeEntityAction({ ...p, action: 'activate' }, c))
        handlers.set('scene-activate', async (p, c) => this.executeEntityAction({ ...p, action: 'activate' }, c))
        handlers.set('automation-trigger', async (p, c) => this.executeEntityAction({ ...p, action: 'trigger' }, c))
        handlers.set('climate-set', async (p, c) => this.executeEntityAction({ ...p, action: 'set-climate' }, c))
        handlers.set('sensor-value', async (p, c) => this.executeEntityAction({ ...p, action: 'read' }, c))
        handlers.set('get-state', async (p, c) => this.executeEntityAction({ ...p, action: 'read' }, c))
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

    private requireConnection(params: any): { baseUrl: string; token: string } {
        // Conexión con fallback a los ajustes del plugin (sin exigir entidad:
        // la usa entity-list para descubrir entidades).
        const baseUrl = params?.baseUrl ?? this.setting('baseUrl')
        const token = params?.token ?? this.setting('token')
        if (!baseUrl) throw new Error('La URL base es obligatoria: ponla en los ajustes del plugin (⋯) o en baseUrl, ej. http://homeassistant.local:8123')
        if (!token) throw new Error('El token de acceso es obligatorio: ponlo en los ajustes del plugin (⋯) o en token')
        return { baseUrl: normalizeBaseUrl(String(baseUrl)), token: String(token) }
    }

    private requireBaseParams(params: any): { baseUrl: string; token: string; entityId: string } {
        // Los parámetros de la acción tienen prioridad; si faltan, se usan los ajustes del plugin.
        const { baseUrl, token } = this.requireConnection(params)
        const entityId = params?.entityId
        if (!entityId) throw new Error('La entidad (entityId) es obligatoria, ej. light.salon')
        return { baseUrl, token, entityId: String(entityId) }
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

    private hasValue(v: unknown): boolean {
        return v !== undefined && v !== null && v !== ''
    }

    /** Acciones de «Entidad» válidas por dominio (las muestra entity-list y las aplica executeEntityAction). */
    public static supportedActionsFor(domain: string): string[] {
        if (domain === 'scene' || domain === 'script') return ['activate', 'read']
        if (domain === 'automation') return ['trigger', 'read']
        if (domain === 'climate') return ['set-climate', 'read']
        if (domain === 'cover') return ['toggle', 'on', 'off', 'open', 'close', 'stop', 'set-position', 'read']
        if (READ_ONLY_DOMAINS.has(domain)) return ['read']
        return ['toggle', 'on', 'off', 'read']
    }

    /** Descubre entidades (GET /api/states) con sus acciones compatibles. Fuente de `optionsFrom`. */
    private async executeEntityListAction(params: any, _context: any): Promise<any> {
        const { baseUrl, token } = this.requireConnection(params)
        this.context.log('info', `Home Assistant: listar entidades en ${baseUrl}`, { token: maskToken(token) })
        let response: Response
        try {
            response = await fetchWithTimeout(`${baseUrl}/api/states`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` }
            })
        } catch (error) {
            throw toConnectionError(error, baseUrl)
        }
        if (response.status === 401) {
            throw new Error('Token inválido o sin autorización (401): revisa el long-lived access token de Home Assistant')
        }
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 200)
            throw new Error(`Home Assistant devolvió el error ${response.status} al listar entidades${detail ? `: ${detail}` : ''}`)
        }
        const states: any[] = await response.json().catch(() => [])
        const options = (Array.isArray(states) ? states : [])
            .filter((s) => s && typeof s.entity_id === 'string')
            .map((s) => {
                const entityId: string = s.entity_id
                const domain = domainOf(entityId)
                const state = s.state ?? 'unknown'
                const friendly = s.attributes?.friendly_name
                return {
                    value: entityId,
                    label: friendly && friendly !== entityId ? `${friendly} (${entityId})` : entityId,
                    domain,
                    state: String(state),
                    actions: HomeAssistantPlugin.supportedActionsFor(domain)
                }
            })
            .sort((a, b) => a.value.localeCompare(b.value))
        this.context.log('info', `Home Assistant: ${options.length} entidades encontradas`)
        return { success: true, count: options.length, options, action: 'entity-list' }
    }

    /** Acción unificada: deduce el dominio del entity_id y llama al servicio que toca. */
    private async executeEntityAction(params: any, _context: any): Promise<any> {
        const { baseUrl, token, entityId } = this.requireBaseParams(params)
        const domain = domainOf(entityId)
        if (!domain || !entityId.includes('.')) {
            throw new Error(`Entidad no válida: "${entityId}". Usa el formato dominio.nombre, ej. light.salon, cover.salon, climate.salon`)
        }
        const action: string = params?.action ?? 'toggle'
        const valid = ['toggle', 'on', 'off', 'open', 'close', 'stop', 'set-position', 'activate', 'trigger', 'set-climate', 'read']
        if (!valid.includes(action)) {
            throw new Error(`Acción no válida: "${action}". Usa ${valid.join(', ')}.`)
        }

        // ---- Solo lectura (vale para cualquier dominio, único camino para sensores).
        if (action === 'read') {
            this.context.log('info', `Home Assistant: leer ${entityId} en ${baseUrl}`, { token: maskToken(token) })
            const full = await this.readState(baseUrl, token, entityId)
            if (!full) {
                throw new Error(`No se pudo leer "${entityId}": no existe o no responde (revisa la entidad)`)
            }
            const raw: string = String(full.state ?? 'unknown')
            const discreteState = raw === 'on' ? 'on' : raw === 'off' ? 'off' : raw
            return { success: true, entityId, domain, state: discreteState, rawState: raw, fullState: full, attributes: full.attributes ?? null, action: 'read' }
        }

        // ---- Sensores: solo se pueden leer.
        if (READ_ONLY_DOMAINS.has(domain)) {
            throw new Error(`"${entityId}" es de solo lectura: usa la acción «Leer estado» en lugar de "${action}"`)
        }

        // ---- Escenas y scripts: solo activar.
        if (domain === 'scene' || domain === 'script') {
            if (!['activate', 'on', 'toggle'].includes(action)) {
                throw new Error(`"${entityId}" solo se puede activar: usa «Activar» en lugar de "${action}"`)
            }
            this.context.log('info', `Home Assistant: activar ${entityId} en ${baseUrl}`, { token: maskToken(token) })
            await this.callService(baseUrl, token, domain, 'turn_on', entityId)
            const state = await this.readState(baseUrl, token, entityId)
            return { success: true, entityId, domain, action: 'activate', service: `${domain}.turn_on`, state }
        }

        // ---- Automatizaciones: solo disparar.
        if (domain === 'automation') {
            if (!['trigger', 'activate', 'on', 'toggle'].includes(action)) {
                throw new Error(`"${entityId}" solo se puede disparar: usa «Disparar» en lugar de "${action}"`)
            }
            this.context.log('info', `Home Assistant: disparar automatización ${entityId} en ${baseUrl}`, { token: maskToken(token) })
            await this.callService(baseUrl, token, 'automation', 'trigger', entityId)
            const state = await this.readState(baseUrl, token, entityId)
            return { success: true, entityId, domain, action: 'trigger', service: 'automation.trigger', state }
        }

        // ---- Clima: solo ajustar modo/temperatura.
        if (domain === 'climate') {
            if (action !== 'set-climate') {
                throw new Error(`"${entityId}" es climatización: usa «Ajustar clima» con modo o temperatura en lugar de "${action}"`)
            }
            return this.applyClimate(baseUrl, token, entityId, params)
        }
        if (action === 'set-climate') {
            throw new Error(`«Ajustar clima» solo vale para climate.*: "${entityId}" es del dominio ${domain}`)
        }

        // ---- Persianas / toldos / cortinas.
        if (domain === 'cover') {
            return this.applyCover(baseUrl, token, entityId, action, params)
        }
        if (['open', 'close', 'stop', 'set-position'].includes(action)) {
            throw new Error(`«${action}» solo vale para cover.*: "${entityId}" es del dominio ${domain}`)
        }
        if (['activate', 'trigger'].includes(action)) {
            throw new Error(`«${action}» no vale para "${entityId}" (dominio ${domain}): las escenas se activan y las automatizaciones se disparan`)
        }

        // ---- Resto (light, switch, fan, input_boolean, group y genéricos):
        // ---- encender / apagar / alternar con el servicio del propio dominio.
        if (!['on', 'off', 'toggle'].includes(action)) {
            throw new Error(`Acción no válida para "${entityId}": usa on, off o toggle (o «Leer estado» para consultar)`)
        }
        const service = action === 'on' ? 'turn_on' : action === 'off' ? 'turn_off' : 'toggle'
        const serviceData: Record<string, unknown> = {}
        if (domain === 'light' && service === 'turn_on') {
            if (this.hasValue(params?.brightness)) {
                const brightness = Number(params.brightness)
                if (!Number.isInteger(brightness) || brightness < 0 || brightness > 255) {
                    throw new Error('El brillo (brightness) debe ser un entero entre 0 y 255')
                }
                serviceData.brightness = brightness
            }
            if (this.hasValue(params?.colorTemp)) {
                const colorTemp = Number(params.colorTemp)
                if (!Number.isInteger(colorTemp) || colorTemp < 1000 || colorTemp > 10000) {
                    throw new Error('La temperatura de color (colorTemp) debe ser un entero en kelvin (1000-10000)')
                }
                serviceData.color_temp_kelvin = colorTemp
            }
        } else if ((this.hasValue(params?.brightness) || this.hasValue(params?.colorTemp)) && service === 'turn_on') {
            throw new Error(`Brillo y temperatura de color solo aplican a light.*: "${entityId}" es del dominio ${domain}`)
        }
        if (this.hasValue(params?.position)) {
            throw new Error(`La posición solo aplica a cover.* con «Ir a posición»: quítala para "${entityId}"`)
        }
        if (this.hasValue(params?.hvacMode) || this.hasValue(params?.temperature)) {
            throw new Error(`Modo y temperatura solo aplican a climate.* con «Ajustar clima»: quítalos para "${entityId}"`)
        }

        this.context.log('info', `Home Assistant: ${domain} ${action} ${entityId} en ${baseUrl}`, { token: maskToken(token) })
        await this.callService(baseUrl, token, domain, service, entityId, serviceData)
        this.context.log('info', `Home Assistant: ${entityId} -> ${service} OK`)
        const state = await this.readState(baseUrl, token, entityId)
        const discreteState = state?.state === 'on' ? 'on' : state?.state === 'off' ? 'off' : action
        return { success: true, entityId, domain, action, state, discreteState, service: `${domain}.${service}` }
    }

    private async applyCover(baseUrl: string, token: string, entityId: string, action: string, params: any): Promise<any> {
        // on/off como alias amables de abrir/cerrar.
        const normalized = action === 'on' ? 'open' : action === 'off' ? 'close' : action
        const serviceMap: Record<string, string> = { open: 'open_cover', close: 'close_cover', stop: 'stop_cover', toggle: 'toggle', 'set-position': 'set_cover_position' }
        const service = serviceMap[normalized]
        if (!service) {
            throw new Error(`Acción de persiana no válida: "${action}". Usa open, close, stop, set-position o toggle.`)
        }
        const extraData: Record<string, unknown> = {}
        if (normalized === 'set-position') {
            const position = Number(params?.position)
            if (!Number.isInteger(position) || position < 0 || position > 100) {
                throw new Error('La posición (position) debe ser un entero entre 0 y 100 para set-position')
            }
            extraData.position = position
        }
        this.context.log('info', `Home Assistant: persiana ${normalized} ${entityId} en ${baseUrl}`, { token: maskToken(token) })
        await this.callService(baseUrl, token, 'cover', service, entityId, extraData)
        this.context.log('info', `Home Assistant: persiana ${entityId} -> ${service} OK`)
        const state = await this.readState(baseUrl, token, entityId)
        return { success: true, entityId, domain: 'cover', action: normalized, service: `cover.${service}`, state }
    }

    private async applyClimate(baseUrl: string, token: string, entityId: string, params: any): Promise<any> {
        const hvacMode = params?.hvacMode
        const temperature = params?.temperature
        if (!this.hasValue(hvacMode) && !this.hasValue(temperature)) {
            throw new Error('Indica al menos hvacMode o temperature para climatización')
        }
        const applied: string[] = []
        if (this.hasValue(hvacMode)) {
            if (!['off', 'heat', 'cool', 'auto', 'fan_only', 'dry'].includes(hvacMode)) {
                throw new Error(`Modo HVAC no válido: "${hvacMode}". Usa off, heat, cool, auto, fan_only o dry.`)
            }
            this.context.log('info', `Home Assistant: clima ${entityId} modo ${hvacMode}`, { token: maskToken(token) })
            await this.callService(baseUrl, token, 'climate', 'set_hvac_mode', entityId, { hvac_mode: hvacMode })
            applied.push(`climate.set_hvac_mode(${hvacMode})`)
        }
        if (this.hasValue(temperature)) {
            const temp = Number(temperature)
            if (!Number.isFinite(temp) || temp < 5 || temp > 35) {
                throw new Error('La temperatura (temperature) debe estar entre 5 y 35 °C')
            }
            await this.callService(baseUrl, token, 'climate', 'set_temperature', entityId, { temperature: temp })
            applied.push(`climate.set_temperature(${temp})`)
        }
        this.context.log('info', `Home Assistant: clima ${entityId} actualizado: ${applied.join(', ')}`)
        const state = await this.readState(baseUrl, token, entityId)
        return { success: true, entityId, domain: 'climate', action: 'set-climate', applied, state }
    }

    public dispose(): void {
        // Sin recursos que liberar (fetch con timeout por petición)
    }
}
