/**
 * Native Govee Plugin
 * Controla luces Govee vía Govee Cloud API v1 (apikey en cabecera
 * Govee-API-Key): encendido/apagado, brillo, color y escenas.
 * Sin credenciales se degrada con un error legible.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const GOVEE_BASE = 'https://developer-api.govee.com/v1/devices'
const REQUEST_TIMEOUT_MS = 15000

function maskKey(key: string): string {
    if (!key || key.length <= 8) return '****'
    return `${key.slice(0, 4)}****${key.slice(-4)}`
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

export class GoveePlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        const apiKeyProp = {
            type: 'string', title: 'API key',
            description: 'API key de Govee (app Govee Home → Perfil → Configuración → Solicitar API key)',
            ui: { component: 'input', type: 'password', placeholder: 'Pega aquí tu API key de Govee' },
        }
        const deviceProp = {
            type: 'string', title: 'ID de dispositivo',
            description: 'MAC/ID del dispositivo (ej. 22:33:44:AA:BB:CC:DD:EE)',
            ui: { component: 'input', type: 'text', placeholder: 'MAC del dispositivo' },
        }
        const modelProp = {
            type: 'string', title: 'Modelo',
            description: 'Modelo del dispositivo (ej. H6159)',
            ui: { component: 'input', type: 'text', placeholder: 'H6159' },
        }
        return {
            id: 'govee',
            name: 'Govee',
            version: '1.0.1',
            description: 'Controla luces Govee por la nube: encendido, brillo, color y modos de escena',
            author: 'BunDeck',
            permissions: ['http', 'network'],
            settingsSchema: {
                type: 'object',
                properties: {
                    apiKey: {
                        type: 'string', title: 'API key',
                        description: 'API key de Govee. Los parámetros de cada acción tienen prioridad.',
                        ui: { component: 'input', type: 'password', placeholder: 'Pega aquí tu API key de Govee' },
                    },
                },
                required: ['apiKey'],
            },
            instructions: 'Para conectar con Govee:\n\n1. En la app Govee Home (Perfil → Configuración) solicita tu API key.\n2. Pégala en los ajustes del plugin (menú ⋯).\n3. En cada botón indica el modelo (ej. H6159) y el ID/MAC del dispositivo (lo ves en la app o con la acción "Listar dispositivos" si tu red lo permite).',
            actions: [
                {
                    id: 'toggle',
                    name: 'Encender / Apagar',
                    description: 'Enciende o apaga un dispositivo Govee',
                    i18n: { es: { name: 'Encender / Apagar', description: 'Enciende o apaga un dispositivo Govee' }, en: { name: 'Encender / Apagar', description: 'Enciende o apaga un dispositivo Govee' } }, // TODO i18n: EN temporal = ES
                    icon: 'Lightbulb',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            apiKey: apiKeyProp, device: deviceProp, model: modelProp,
                            action: {
                                type: 'string', title: 'Acción',
                                description: 'Qué hacer',
                                enum: ['on', 'off'], default: 'on',
                                ui: { component: 'select', options: [{ value: 'on', label: 'Encender' }, { value: 'off', label: 'Apagar' }] },
                            },
                        },
                        required: ['device', 'model', 'action'],
                    },
                },
                {
                    id: 'brightness',
                    name: 'Brillo',
                    description: 'Ajusta el brillo (0-100)',
                    i18n: { es: { name: 'Brillo', description: 'Ajusta el brillo (0-100)' }, en: { name: 'Brillo', description: 'Ajusta el brillo (0-100)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Sun',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            apiKey: apiKeyProp, device: deviceProp, model: modelProp,
                            brightness: {
                                type: 'integer', title: 'Brillo',
                                description: 'Brillo en porcentaje (0-100)',
                                minimum: 0, maximum: 100,
                                ui: { component: 'input', type: 'number', placeholder: '80' },
                            },
                        },
                        required: ['device', 'model', 'brightness'],
                    },
                },
                {
                    id: 'color',
                    name: 'Color',
                    description: 'Cambia el color (RGB 0-255)',
                    i18n: { es: { name: 'Color', description: 'Cambia el color (RGB 0-255)' }, en: { name: 'Color', description: 'Cambia el color (RGB 0-255)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Palette',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            apiKey: apiKeyProp, device: deviceProp, model: modelProp,
                            red: { type: 'integer', title: 'Rojo', description: 'Componente rojo (0-255)', minimum: 0, maximum: 255, ui: { component: 'input', type: 'number', placeholder: '255' } },
                            green: { type: 'integer', title: 'Verde', description: 'Componente verde (0-255)', minimum: 0, maximum: 255, ui: { component: 'input', type: 'number', placeholder: '0' } },
                            blue: { type: 'integer', title: 'Azul', description: 'Componente azul (0-255)', minimum: 0, maximum: 255, ui: { component: 'input', type: 'number', placeholder: '0' } },
                        },
                        required: ['device', 'model', 'red', 'green', 'blue'],
                    },
                },
                {
                    id: 'scene',
                    name: 'Escena / Modo',
                    description: 'Activa un modo de escena del dispositivo (requiere que el modelo lo soporte)',
                    i18n: { es: { name: 'Escena / Modo', description: 'Activa un modo de escena del dispositivo (requiere que el modelo lo soporte)' }, en: { name: 'Escena / Modo', description: 'Activa un modo de escena del dispositivo (requiere que el modelo lo soporte)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Sparkles',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            apiKey: apiKeyProp, device: deviceProp, model: modelProp,
                            scene: {
                                type: 'string', title: 'Escena',
                                description: 'Nombre o código de escena del dispositivo (ej. Sunset, Rainbow)',
                                ui: { component: 'input', type: 'text', placeholder: 'Sunset' },
                            },
                        },
                        required: ['device', 'model', 'scene'],
                    },
                },
            ],
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('toggle', this.executeToggle.bind(this))
        handlers.set('brightness', this.executeBrightness.bind(this))
        handlers.set('color', this.executeColor.bind(this))
        handlers.set('scene', this.executeScene.bind(this))
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

    private requireTarget(params: any): { apiKey: string; device: string; model: string } {
        const apiKey = String(params?.apiKey ?? this.setting('apiKey') ?? '')
        const device = String(params?.device ?? '').trim()
        const model = String(params?.model ?? '').trim()
        if (!apiKey) throw new Error('Falta la API key de Govee: ponla en los ajustes del plugin (⋯) o en apiKey')
        if (!device) throw new Error('El ID de dispositivo (device) es obligatorio (MAC del dispositivo en la app Govee)')
        if (!model) throw new Error('El modelo (model) es obligatorio (ej. H6159)')
        return { apiKey, device, model }
    }

    private controlUrl(): string {
        const base = process.env.GOVEE_API_BASE?.trim().replace(/\/+$/, '')
        return base ? `${base}/devices/control` : `${GOVEE_BASE}/control`
    }

    private async control(apiKey: string, device: string, model: string, cmd: { name: string; value: unknown }, label: string): Promise<void> {
        const url = this.controlUrl()
        let response: Response
        try {
            response = await fetchWithTimeout(url, {
                method: 'PUT',
                headers: { 'Govee-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ device, model, cmd }),
            })
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Tiempo de espera agotado (15s) contactando con la nube de Govee (${label})`)
            }
            throw new Error(`No se pudo contactar con la nube de Govee (${label}): ${error instanceof Error ? error.message : String(error)}`)
        }
        if (response.status === 401 || response.status === 403) {
            throw new Error('API key de Govee no válida (401/403): revísala en la app Govee Home')
        }
        if (response.status === 429) {
            throw new Error('Límite de peticiones de Govee excedido (429): espera un minuto e inténtalo de nuevo')
        }
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 200)
            throw new Error(`Govee devolvió el error ${response.status} en ${label}${detail ? `: ${detail}` : ''}`)
        }
    }

    private async executeToggle(params: any, _context: any): Promise<any> {
        const { apiKey, device, model } = this.requireTarget(params)
        const action = params?.action ?? 'on'
        if (action !== 'on' && action !== 'off') throw new Error(`Acción no válida: "${action}". Usa on u off`)
        this.context.log('info', `Govee: ${device} -> ${action}`, { apiKey: maskKey(apiKey) })
        await this.control(apiKey, device, model, { name: 'turn', value: action }, 'toggle')
        return { action: 'toggle', device, model, state: action, success: true }
    }

    private async executeBrightness(params: any, _context: any): Promise<any> {
        const { apiKey, device, model } = this.requireTarget(params)
        const brightness = Number(params?.brightness)
        if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
            throw new Error(`Brillo no válido: "${params?.brightness}". Debe ser un entero entre 0 y 100`)
        }
        this.context.log('info', `Govee: ${device} brillo ${brightness}`, { apiKey: maskKey(apiKey) })
        await this.control(apiKey, device, model, { name: 'brightness', value: brightness }, 'brightness')
        return { action: 'brightness', device, model, brightness, success: true }
    }

    private async executeColor(params: any, _context: any): Promise<any> {
        const { apiKey, device, model } = this.requireTarget(params)
        const rgb = { r: Number(params?.red), g: Number(params?.green), b: Number(params?.blue) }
        for (const [k, v] of Object.entries(rgb)) {
            if (!Number.isInteger(v) || v < 0 || v > 255) {
                throw new Error(`Componente de color no válido (${k}): debe ser un entero entre 0 y 255`)
            }
        }
        this.context.log('info', `Govee: ${device} color rgb(${rgb.r},${rgb.g},${rgb.b})`, { apiKey: maskKey(apiKey) })
        await this.control(apiKey, device, model, { name: 'color', value: { r: rgb.r, g: rgb.g, b: rgb.b } }, 'color')
        return { action: 'color', device, model, ...rgb, success: true }
    }

    private async executeScene(params: any, _context: any): Promise<any> {
        const { apiKey, device, model } = this.requireTarget(params)
        const scene = String(params?.scene ?? '').trim()
        if (!scene) throw new Error('La escena (scene) es obligatoria (ej. Sunset)')
        this.context.log('info', `Govee: ${device} escena ${scene}`, { apiKey: maskKey(apiKey) })
        await this.control(apiKey, device, model, { name: 'scene', value: scene }, 'scene')
        return { action: 'scene', device, model, scene, success: true, note: 'Si el modelo no soporta escenas por API, Govee devuelve error: usa color/brillo en su lugar' }
    }

    public dispose(): void {
        // Sin recursos que liberar
    }
}
