/**
 * Native Philips Hue Extra Plugin
 * Controla un puente Hue local (Bridge REST API): lista luces, enciende/
 * apaga, ajusta brillo y color, y activa escenas. Sin credenciales el
 * plugin se degrada con un error legible (no cuelgues).
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const REQUEST_TIMEOUT_MS = 10000

function normalizeIp(ip: string): string {
    return (ip || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

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

function toConnectionError(error: any, base: string): Error {
    // La base incluye la API key (`http://ip/api/<key>`): nunca exponerla.
    const safeBase = base.replace(/\/api\/.+$/, '/api/****')
    if (error instanceof Error && error.name === 'AbortError') {
        return new Error(`Tiempo de espera agotado al conectar con el puente Hue en ${safeBase}`)
    }
    return new Error(`No se pudo conectar con el puente Hue en ${safeBase}: ${error instanceof Error ? error.message : String(error)}`)
}

export class HueExtraPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        const bridgeProp = {
            type: 'string', title: 'IP del puente',
            description: 'IP local del Hue Bridge (ej. 192.168.1.50)',
            ui: { component: 'input', type: 'text', placeholder: '192.168.1.50' },
        }
        const keyProp = {
            type: 'string', title: 'API key (usuario)',
            description: 'Nombre de usuario autorizado del puente (pulsa el botón físico y crea uno en http://<ip>/debug/clip.html)',
            ui: { component: 'input', type: 'password', placeholder: 'Pega aquí tu usuario del puente' },
        }
        return {
            id: 'hue-extra',
            name: 'Philips Hue Extra',
            version: '1.0.2',
            description: 'Controla luces Philips Hue en red local: lista, enciende/apaga, brillo, color y escenas',
            author: 'BunDeck',
            permissions: ['network'],
            settingsSchema: {
                type: 'object',
                properties: {
                    bridgeIp: {
                        type: 'string', title: 'IP del puente',
                        description: 'IP local del Hue Bridge. Los parámetros de cada acción tienen prioridad.',
                        ui: { component: 'input', type: 'text', placeholder: '192.168.1.50' },
                    },
                    apiKey: {
                        type: 'string', title: 'API key (usuario)',
                        description: 'Usuario autorizado del puente (botón físico → http://<ip>/debug/clip.html)',
                        ui: { component: 'input', type: 'password', placeholder: 'Pega aquí tu usuario del puente' },
                    },
                },
                required: ['bridgeIp', 'apiKey'],
            },
            instructions: 'Para conectar con tu Hue Bridge:\n\n1. Pulsa el botón físico del puente.\n2. Crea un usuario (API key) desde http://<ip-del-puente>/debug/clip.html (POST /api con {"devicetype":"libredeck"}).\n3. Pega la IP y la API key en los ajustes del plugin (menú ⋯).\n4. Usa las acciones indicando el ID de luz (míralo con "Listar luces") o de escena.',
            actions: [
                {
                    id: 'lights-list',
                    name: 'Listar luces',
                    description: 'Devuelve las luces del puente con su estado',
                    icon: 'List',
                    schema: {
                        type: 'object',
                        properties: {
                            bridgeIp: bridgeProp, apiKey: keyProp,
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            },
                            timeoutMs: { type: 'number', title: 'Tiempo límite (ms)', description: 'Tiempo máximo de espera', default: 10000, minimum: 1000, maximum: 30000, ui: { component: 'hidden' } },
                        },
                        required: [],
                    },
                },
                {
                    id: 'toggle',
                    name: 'Encender / Apagar',
                    description: 'Enciende, apaga o alterna una luz Hue',
                    icon: 'Lightbulb',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            bridgeIp: bridgeProp, apiKey: keyProp,
                            lightId: {
                                type: 'string', title: 'ID de luz',
                                description: 'ID numérico de la luz (míralo con "Listar luces")',
                                ui: { component: 'input', type: 'text', placeholder: '1' },
                            },
                            action: {
                                type: 'string', title: 'Acción',
                                description: 'Qué hacer con la luz',
                                enum: ['on', 'off', 'toggle'], default: 'toggle',
                                ui: { component: 'select', options: [{ value: 'on', label: 'Encender' }, { value: 'off', label: 'Apagar' }, { value: 'toggle', label: 'Alternar' }] },
                            },
                            timeoutMs: { type: 'number', title: 'Tiempo límite (ms)', description: 'Tiempo máximo de espera', default: 10000, minimum: 1000, maximum: 30000, ui: { component: 'hidden' } },
                        },
                        required: ['lightId'],
                    },
                },
                {
                    id: 'brightness',
                    name: 'Brillo',
                    description: 'Ajusta el brillo de una luz (1-254)',
                    icon: 'Sun',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            bridgeIp: bridgeProp, apiKey: keyProp,
                            lightId: {
                                type: 'string', title: 'ID de luz',
                                description: 'ID numérico de la luz',
                                ui: { component: 'input', type: 'text', placeholder: '1' },
                            },
                            brightness: {
                                type: 'integer', title: 'Brillo',
                                description: 'Brillo Hue (1-254)',
                                minimum: 1, maximum: 254,
                                ui: { component: 'input', type: 'number', placeholder: '200' },
                            },
                            timeoutMs: { type: 'number', title: 'Tiempo límite (ms)', description: 'Tiempo máximo de espera', default: 10000, minimum: 1000, maximum: 30000, ui: { component: 'hidden' } },
                        },
                        required: ['lightId', 'brightness'],
                    },
                },
                {
                    id: 'color',
                    name: 'Color',
                    description: 'Cambia el color de una luz (matiz 0-65535, saturación 0-254)',
                    icon: 'Palette',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            bridgeIp: bridgeProp, apiKey: keyProp,
                            lightId: {
                                type: 'string', title: 'ID de luz',
                                description: 'ID numérico de la luz',
                                ui: { component: 'input', type: 'text', placeholder: '1' },
                            },
                            hue: {
                                type: 'integer', title: 'Matiz',
                                description: 'Matiz (0-65535; 0=rojo, 25500=verde, 46920=azul)',
                                minimum: 0, maximum: 65535,
                                ui: { component: 'input', type: 'number', placeholder: '46920' },
                            },
                            saturation: {
                                type: 'integer', title: 'Saturación',
                                description: 'Saturación (0-254)',
                                minimum: 0, maximum: 254, default: 254,
                                ui: { component: 'input', type: 'number', placeholder: '254' },
                            },
                            timeoutMs: { type: 'number', title: 'Tiempo límite (ms)', description: 'Tiempo máximo de espera', default: 10000, minimum: 1000, maximum: 30000, ui: { component: 'hidden' } },
                        },
                        required: ['lightId', 'hue'],
                    },
                },
                {
                    id: 'scene',
                    name: 'Activar escena',
                    description: 'Recupera una escena Hue por su ID',
                    icon: 'Sparkles',
                    surface: 'control',
                    component: 'smart-home',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            bridgeIp: bridgeProp, apiKey: keyProp,
                            sceneId: {
                                type: 'string', title: 'ID de escena',
                                description: 'ID de la escena en el puente',
                                ui: { component: 'input', type: 'text', placeholder: 'Ej. abc123…' },
                            },
                            timeoutMs: { type: 'number', title: 'Tiempo límite (ms)', description: 'Tiempo máximo de espera', default: 10000, minimum: 1000, maximum: 30000, ui: { component: 'hidden' } },
                        },
                        required: ['sceneId'],
                    },
                },
            ],
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('lights-list', this.executeList.bind(this))
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

    private requireConn(params: any, timeoutDefault = REQUEST_TIMEOUT_MS): { base: string; timeoutMs: number } {
        const ip = normalizeIp(String(params?.bridgeIp ?? this.setting('bridgeIp') ?? ''))
        const key = String(params?.apiKey ?? this.setting('apiKey') ?? '')
        if (!ip) throw new Error('Falta la IP del puente Hue: ponla en los ajustes del plugin (⋯) o en bridgeIp (ej. 192.168.1.50)')
        if (!key) throw new Error('Falta la API key del puente Hue: ponla en los ajustes del plugin (⋯) o en apiKey')
        const timeoutMs = typeof params?.timeoutMs === 'number' && params.timeoutMs > 0
            ? Math.min(Math.floor(params.timeoutMs), 30000)
            : timeoutDefault
        return { base: `http://${ip}/api/${key}`, timeoutMs }
    }

    private async hueFetch(base: string, path: string, init: RequestInit, timeoutMs: number, label: string): Promise<any> {
        let response: Response
        try {
            response = await fetchWithTimeout(`${base}${path}`, init, timeoutMs)
        } catch (error) {
            throw toConnectionError(error, base)
        }
        if (response.status === 401 || response.status === 403) {
            throw new Error('API key del puente Hue no válida (401/403): pulsa el botón físico y crea un usuario nuevo')
        }
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 200)
            throw new Error(`El puente Hue devolvió el error ${response.status} en ${label}${detail ? `: ${detail}` : ''}`)
        }
        const body = await response.json().catch(() => null)
        if (Array.isArray(body)) {
            const err = body.find((e: any) => e?.error)
            if (err) throw new Error(`El puente Hue rechazó la petición (${label}): ${err.error.description ?? 'error desconocido'}`)
        }
        return body
    }

    private async executeList(params: any, _context: any): Promise<any> {
        const { base, timeoutMs } = this.requireConn(params)
        this.context.log('info', 'Hue: listando luces', { key: maskKey(base.split('/').pop() ?? '') })
        const body = await this.hueFetch(base, '/lights', { method: 'GET' }, timeoutMs, 'lights-list')
        const lights = Object.entries(body ?? {}).map(([id, l]: [string, any]) => ({
            id, name: l?.name ?? null, on: l?.state?.on ?? null,
            brightness: l?.state?.bri ?? null, reachable: l?.state?.reachable ?? null,
        }))
        return { action: 'lights-list', count: lights.length, lights }
    }

    private async executeToggle(params: any, _context: any): Promise<any> {
        const { base, timeoutMs } = this.requireConn(params)
        const lightId = String(params?.lightId ?? '').trim()
        if (!lightId) throw new Error('El ID de luz (lightId) es obligatorio (míralo con "Listar luces")')
        const action = params?.action ?? 'toggle'
        if (!['on', 'off', 'toggle'].includes(action)) throw new Error(`Acción no válida: "${action}". Usa on, off o toggle`)
        let target: boolean
        if (action === 'toggle') {
            const state = await this.hueFetch(base, `/lights/${encodeURIComponent(lightId)}`, { method: 'GET' }, timeoutMs, 'toggle-leer')
            target = !(state?.state?.on === true)
        } else {
            target = action === 'on'
        }
        this.context.log('info', `Hue: luz ${lightId} -> ${target ? 'on' : 'off'}`)
        await this.hueFetch(base, `/lights/${encodeURIComponent(lightId)}/state`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: target }),
        }, timeoutMs, 'toggle')
        return { action: 'toggle', lightId, on: target, success: true }
    }

    private async executeBrightness(params: any, _context: any): Promise<any> {
        const { base, timeoutMs } = this.requireConn(params)
        const lightId = String(params?.lightId ?? '').trim()
        if (!lightId) throw new Error('El ID de luz (lightId) es obligatorio')
        const brightness = Number(params?.brightness)
        if (!Number.isInteger(brightness) || brightness < 1 || brightness > 254) {
            throw new Error(`Brillo no válido: "${params?.brightness}". Debe ser un entero entre 1 y 254`)
        }
        this.context.log('info', `Hue: luz ${lightId} brillo ${brightness}`)
        await this.hueFetch(base, `/lights/${encodeURIComponent(lightId)}/state`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true, bri: brightness }),
        }, timeoutMs, 'brightness')
        return { action: 'brightness', lightId, brightness, success: true }
    }

    private async executeColor(params: any, _context: any): Promise<any> {
        const { base, timeoutMs } = this.requireConn(params)
        const lightId = String(params?.lightId ?? '').trim()
        if (!lightId) throw new Error('El ID de luz (lightId) es obligatorio')
        const hue = Number(params?.hue)
        if (!Number.isInteger(hue) || hue < 0 || hue > 65535) {
            throw new Error(`Matiz no válido: "${params?.hue}". Debe ser un entero entre 0 y 65535`)
        }
        const saturation = params?.saturation === undefined || params?.saturation === '' ? 254 : Number(params.saturation)
        if (!Number.isInteger(saturation) || saturation < 0 || saturation > 254) {
            throw new Error(`Saturación no válida: "${params?.saturation}". Debe ser un entero entre 0 y 254`)
        }
        this.context.log('info', `Hue: luz ${lightId} color hue=${hue} sat=${saturation}`)
        await this.hueFetch(base, `/lights/${encodeURIComponent(lightId)}/state`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true, hue, sat: saturation }),
        }, timeoutMs, 'color')
        return { action: 'color', lightId, hue, saturation, success: true }
    }

    private async executeScene(params: any, _context: any): Promise<any> {
        const { base, timeoutMs } = this.requireConn(params)
        const sceneId = String(params?.sceneId ?? '').trim()
        if (!sceneId) throw new Error('El ID de escena (sceneId) es obligatorio')
        this.context.log('info', `Hue: activando escena ${sceneId}`)
        await this.hueFetch(base, `/groups/0/action`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene: sceneId }),
        }, timeoutMs, 'scene')
        return { action: 'scene', sceneId, success: true }
    }

    public dispose(): void {
        // Sin recursos que liberar
    }
}
