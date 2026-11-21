/**
 * Native OBS Studio Plugin
 * Control OBS Studio through obs-websocket v5 (WebSocket, default port 4455).
 * Cross-platform: only the global WebSocket (Bun) and node:crypto are used,
 * no external binaries, no PowerShell, no new dependencies.
 */

import { createHash } from 'node:crypto'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const OBS_DEFAULT_HOST = 'localhost'
const OBS_DEFAULT_PORT = 4455
const OBS_DEFAULT_TIMEOUT_MS = 10000
const OBS_MAX_TIMEOUT_MS = 60000
const OBS_RPC_VERSION = 1

const OBS_OP_HELLO = 0
const OBS_OP_IDENTIFY = 1
const OBS_OP_IDENTIFIED = 2
const OBS_OP_REQUEST = 6
const OBS_OP_REQUEST_RESPONSE = 7

/** Close code sent by obs-websocket v5 when authentication fails. */
const OBS_CLOSE_AUTH_FAILED = 4009

type ObsSend = (requestType: string, requestData?: Record<string, any>) => Promise<any>

interface ObsConnection {
    host: string
    port: number
    password?: string
    timeoutMs: number
    url: string
}

/**
 * Connection properties shared by every action schema.
 */
function obsConnectionProps(): Record<string, any> {
    return {
        host: {
            type: 'string',
            title: 'Servidor OBS',
            description: 'Dirección del equipo con OBS Studio (normalmente localhost)',
            default: 'localhost',
            ui: {
                component: 'input',
                type: 'text',
                placeholder: 'localhost'
            }
        },
        port: {
            type: 'number',
            title: 'Puerto WebSocket',
            description: 'Puerto del servidor WebSocket de OBS (por defecto 4455)',
            default: 4455,
            minimum: 1,
            maximum: 65535,
            ui: {
                component: 'input',
                type: 'number',
                min: 1,
                max: 65535,
                placeholder: '4455'
            }
        },
        password: {
            type: 'string',
            title: 'Contraseña',
            description: 'Contraseña del servidor WebSocket (OBS → Herramientas → Ajustes del servidor WebSocket). Déjala vacía si no tiene.',
            ui: {
                component: 'input',
                type: 'password',
                placeholder: '(opcional)'
            }
        },
        timeoutMs: {
            type: 'number',
            title: 'Tiempo límite (ms)',
            description: 'Tiempo máximo de espera de la conexión y la respuesta de OBS en milisegundos',
            default: 10000,
            minimum: 500,
            maximum: 60000,
            ui: {
                component: 'hidden'
            }
        }
    }
}

export class ObsPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        const connection = obsConnectionProps()
        return {
            id: 'obs',
            name: 'OBS Studio',
            version: '1.0.0',
            description: 'Controla OBS Studio (escenas, fuentes, directo, grabación y audio) vía obs-websocket v5',
            author: 'BunDeck',
            permissions: ['network'],
            settingsSchema: {
                type: 'object',
                properties: {
                    host: {
                        type: 'string',
                        title: 'Servidor OBS',
                        description: 'Dirección del equipo con OBS Studio. Los parámetros de cada acción tienen prioridad sobre estos valores.',
                        default: 'localhost',
                        ui: { component: 'input', type: 'text', placeholder: 'localhost' }
                    },
                    port: {
                        type: 'number',
                        title: 'Puerto WebSocket',
                        description: 'Puerto del servidor WebSocket de OBS',
                        default: 4455,
                        minimum: 1,
                        maximum: 65535,
                        ui: { component: 'input', type: 'number', placeholder: '4455' }
                    },
                    password: {
                        type: 'string',
                        title: 'Contraseña',
                        description: 'Contraseña del servidor WebSocket de OBS (déjala vacía si no tiene)',
                        ui: { component: 'input', type: 'password', placeholder: '(opcional)' }
                    }
                }
            },
            instructions: 'Para conectar con OBS Studio:\n\n1. En OBS ve a Herramientas → Ajustes del servidor WebSocket y actívalo (puerto 4455 por defecto, obs-websocket v5).\n2. Si el servidor tiene contraseña, ponla aquí o en cada acción.\n3. Guarda estos ajustes y luego usa las acciones (Cambiar de escena, Grabar, etc.). Los parámetros de cada botón tienen prioridad sobre estos valores.',
            actions: [
                {
                    id: 'scene',
                    name: 'Cambiar de escena',
                    description: 'Cambia la escena actual del programa en OBS',
                    icon: 'Layers',
                    schema: {
                        type: 'object',
                        properties: {
                            ...connection,
                            scene: {
                                type: 'string',
                                title: 'Escena',
                                description: 'Nombre exacto de la escena a la que cambiar',
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'Escena principal'
                                }
                            }
                        },
                        required: ['scene']
                    }
                },
                {
                    id: 'source',
                    name: 'Alternar fuente',
                    description: 'Muestra, oculta o alterna la visibilidad de una fuente en una escena',
                    icon: 'Eye',
                    schema: {
                        type: 'object',
                        properties: {
                            ...connection,
                            scene: {
                                type: 'string',
                                title: 'Escena',
                                description: 'Escena que contiene la fuente. Si se omite se usa la escena actual del programa.',
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: '(escena actual)'
                                }
                            },
                            source: {
                                type: 'string',
                                title: 'Fuente',
                                description: 'Nombre exacto de la fuente (ej. la cámara o una imagen)',
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'Cámara'
                                }
                            },
                            visible: {
                                type: 'boolean',
                                title: 'Visible',
                                description: 'Estado deseado. Si se omite, se alterna el estado actual.',
                                ui: {
                                    component: 'switch'
                                }
                            }
                        },
                        required: ['source']
                    }
                },
                {
                    id: 'stream',
                    name: 'Iniciar / detener directo',
                    description: 'Inicia, detiene o alterna la emisión en directo',
                    icon: 'Radio',
                    schema: {
                        type: 'object',
                        properties: {
                            ...connection,
                            action: {
                                type: 'string',
                                title: 'Acción del directo',
                                description: 'Qué hacer con la emisión en directo',
                                enum: ['start', 'stop', 'toggle'],
                                default: 'toggle',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'start', label: 'Iniciar directo' },
                                        { value: 'stop', label: 'Detener directo' },
                                        { value: 'toggle', label: 'Alternar' }
                                    ]
                                }
                            }
                        },
                        required: ['action']
                    }
                },
                {
                    id: 'record',
                    name: 'Grabar',
                    description: 'Inicia, detiene o alterna la grabación',
                    icon: 'Video',
                    schema: {
                        type: 'object',
                        properties: {
                            ...connection,
                            action: {
                                type: 'string',
                                title: 'Acción de grabación',
                                description: 'Qué hacer con la grabación',
                                enum: ['start', 'stop', 'toggle'],
                                default: 'toggle',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'start', label: 'Iniciar grabación' },
                                        { value: 'stop', label: 'Detener grabación' },
                                        { value: 'toggle', label: 'Alternar' }
                                    ]
                                }
                            }
                        },
                        required: ['action']
                    }
                },
                {
                    id: 'replay',
                    name: 'Guardar repetición',
                    description: 'Guarda el búfer de repetición (replay buffer) en disco',
                    icon: 'History',
                    schema: {
                        type: 'object',
                        properties: {
                            ...connection
                        },
                        required: []
                    }
                },
                {
                    id: 'mute',
                    name: 'Micrófono (mutear)',
                    description: 'Silencia, reactiva o alterna el audio de una fuente de entrada',
                    icon: 'MicOff',
                    schema: {
                        type: 'object',
                        properties: {
                            ...connection,
                            source: {
                                type: 'string',
                                title: 'Fuente de audio',
                                description: 'Nombre exacto de la fuente de entrada (ej. el micrófono)',
                                ui: {
                                    component: 'input',
                                    type: 'text',
                                    placeholder: 'Micrófono'
                                }
                            },
                            muted: {
                                type: 'boolean',
                                title: 'Silenciado',
                                description: 'Estado deseado. Si se omite, se alterna el estado actual.',
                                ui: {
                                    component: 'switch'
                                }
                            }
                        },
                        required: ['source']
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('scene', this.executeSceneAction.bind(this))
        handlers.set('source', this.executeSourceAction.bind(this))
        handlers.set('stream', this.executeStreamAction.bind(this))
        handlers.set('record', this.executeRecordAction.bind(this))
        handlers.set('replay', this.executeReplayAction.bind(this))
        handlers.set('mute', this.executeMuteAction.bind(this))
        return handlers
    }

    /**
     * Cambiar de escena (SetCurrentProgramScene).
     */
    private async executeSceneAction(params: any, _context: any): Promise<any> {
        const { scene } = params ?? {}
        if (typeof scene !== 'string' || scene.length === 0) {
            throw new Error('La acción "Cambiar de escena" requiere el parámetro "scene" (nombre de la escena).')
        }
        const { host, port } = this.resolveConnection(params)
        this.context.log('info', `OBS: cambiando a la escena "${scene}"`, { host, port })
        try {
            await this.withObsSession(params, (send) => send('SetCurrentProgramScene', { sceneName: scene }))
            this.context.log('info', `OBS: escena cambiada a "${scene}"`)
            return { action: 'scene', scene, changed: true, host, port }
        } catch (error) {
            this.context.log('error', `OBS: no se pudo cambiar a la escena "${scene}": ${error}`, { host, port })
            throw error
        }
    }

    /**
     * Alternar fuente/visibilidad. Sin "visible" lee el estado con
     * GetSceneItemEnabled y lo invierte.
     */
    private async executeSourceAction(params: any, _context: any): Promise<any> {
        const { scene, source, visible } = params ?? {}
        if (typeof source !== 'string' || source.length === 0) {
            throw new Error('La acción "Alternar fuente" requiere el parámetro "source" (nombre de la fuente).')
        }
        if (visible !== undefined && typeof visible !== 'boolean') {
            throw new Error('La acción "Alternar fuente" espera "visible" de tipo boolean (o omitirlo para alternar).')
        }
        const { host, port } = this.resolveConnection(params)
        this.context.log('info', `OBS: cambiando visibilidad de la fuente "${source}"`, { scene, visible, host, port })
        try {
            const result = await this.withObsSession(params, async (send) => {
                let sceneName: string | undefined = typeof scene === 'string' && scene.length > 0 ? scene : undefined
                if (!sceneName) {
                    const current = await send('GetCurrentProgramScene')
                    sceneName = current?.currentProgramSceneName
                    if (typeof sceneName !== 'string' || sceneName.length === 0) {
                        throw new Error('No se pudo determinar la escena actual del programa en OBS.')
                    }
                }
                let sceneItemId: unknown
                try {
                    const item = await send('GetSceneItemId', { sceneName, sourceName: source })
                    sceneItemId = item?.sceneItemId
                } catch (error) {
                    throw new Error(`No se encontró la fuente "${source}" en la escena "${sceneName}". Comprueba el nombre exacto en OBS. Detalle: ${this.messageOf(error)}`)
                }
                if (typeof sceneItemId !== 'number') {
                    throw new Error(`No se encontró la fuente "${source}" en la escena "${sceneName}". Comprueba el nombre exacto en OBS.`)
                }
                let target: boolean
                if (typeof visible === 'boolean') {
                    target = visible
                } else {
                    const state = await send('GetSceneItemEnabled', { sceneName, sceneItemId })
                    target = !state?.sceneItemEnabled
                }
                await send('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: target })
                return { scene: sceneName, source, visible: target }
            })
            this.context.log('info', `OBS: fuente "${source}" ahora visible=${result.visible}`, { scene: result.scene })
            return { action: 'source', ...result, host, port }
        } catch (error) {
            this.context.log('error', `OBS: no se pudo cambiar la fuente "${source}": ${error}`, { host, port })
            throw error
        }
    }

    /**
     * Iniciar/detener directo (StartStream/StopStream/ToggleStream).
     */
    private async executeStreamAction(params: any, _context: any): Promise<any> {
        const { action = 'toggle' } = params ?? {}
        if (action !== 'start' && action !== 'stop' && action !== 'toggle') {
            throw new Error('La acción de directo requiere "action" con uno de estos valores: start, stop, toggle.')
        }
        const { host, port } = this.resolveConnection(params)
        const requestType = action === 'start' ? 'StartStream' : action === 'stop' ? 'StopStream' : 'ToggleStream'
        this.context.log('info', `OBS: directo -> ${action}`, { host, port })
        try {
            const response = await this.withObsSession(params, (send) => send(requestType))
            this.context.log('info', `OBS: directo ${action} ejecutado`, { outputActive: response?.outputActive })
            return { action: 'stream', requested: action, requestType, outputActive: response?.outputActive ?? null, host, port }
        } catch (error) {
            this.context.log('error', `OBS: no se pudo ejecutar el directo (${action}): ${error}`, { host, port })
            throw error
        }
    }

    /**
     * Grabar (StartRecord/StopRecord/ToggleRecord).
     */
    private async executeRecordAction(params: any, _context: any): Promise<any> {
        const { action = 'toggle' } = params ?? {}
        if (action !== 'start' && action !== 'stop' && action !== 'toggle') {
            throw new Error('La acción de grabación requiere "action" con uno de estos valores: start, stop, toggle.')
        }
        const { host, port } = this.resolveConnection(params)
        const requestType = action === 'start' ? 'StartRecord' : action === 'stop' ? 'StopRecord' : 'ToggleRecord'
        this.context.log('info', `OBS: grabación -> ${action}`, { host, port })
        try {
            const response = await this.withObsSession(params, (send) => send(requestType))
            this.context.log('info', `OBS: grabación ${action} ejecutada`, { outputActive: response?.outputActive })
            return {
                action: 'record',
                requested: action,
                requestType,
                outputActive: response?.outputActive ?? null,
                outputPath: response?.outputPath ?? null,
                host,
                port
            }
        } catch (error) {
            this.context.log('error', `OBS: no se pudo ejecutar la grabación (${action}): ${error}`, { host, port })
            throw error
        }
    }

    /**
     * Guardar repetición (SaveReplayBuffer).
     */
    private async executeReplayAction(params: any, _context: any): Promise<any> {
        const { host, port } = this.resolveConnection(params)
        this.context.log('info', 'OBS: guardando repetición (replay buffer)', { host, port })
        try {
            await this.withObsSession(params, (send) => send('SaveReplayBuffer'))
            this.context.log('info', 'OBS: repetición guardada')
            return { action: 'replay', saved: true, host, port }
        } catch (error) {
            const message = this.messageOf(error)
            if (message.startsWith('OBS rechazó la petición')) {
                const friendly = new Error(`No se pudo guardar la repetición: el búfer de repetición no está activo. Actívalo en OBS (Ajustes → Salida → Búfer de repetición) e inicia la salida de repetición. Detalle: ${message}`)
                this.context.log('error', `OBS: ${friendly.message}`, { host, port })
                throw friendly
            }
            this.context.log('error', `OBS: no se pudo guardar la repetición: ${error}`, { host, port })
            throw error
        }
    }

    /**
     * Micrófono (mutear). Sin "muted" alterna con ToggleInputMute.
     */
    private async executeMuteAction(params: any, _context: any): Promise<any> {
        const { source, muted } = params ?? {}
        if (typeof source !== 'string' || source.length === 0) {
            throw new Error('La acción "Micrófono" requiere el parámetro "source" (nombre de la fuente de audio).')
        }
        if (muted !== undefined && typeof muted !== 'boolean') {
            throw new Error('La acción "Micrófono" espera "muted" de tipo boolean (o omitirlo para alternar).')
        }
        const { host, port } = this.resolveConnection(params)
        this.context.log('info', `OBS: cambiando silencio de "${source}"`, { muted, host, port })
        try {
            const result = await this.withObsSession(params, async (send) => {
                if (typeof muted === 'boolean') {
                    try {
                        await send('SetInputMute', { inputName: source, inputMuted: muted })
                    } catch (error) {
                        throw new Error(`No se encontró la fuente de audio "${source}" en OBS. Comprueba el nombre exacto. Detalle: ${this.messageOf(error)}`)
                    }
                    return { source, muted }
                }
                try {
                    const response = await send('ToggleInputMute', { inputName: source })
                    return { source, muted: response?.inputMuted ?? null, toggled: true }
                } catch (error) {
                    throw new Error(`No se encontró la fuente de audio "${source}" en OBS. Comprueba el nombre exacto. Detalle: ${this.messageOf(error)}`)
                }
            })
            this.context.log('info', `OBS: "${source}" ahora silenciado=${result.muted}`)
            return { action: 'mute', ...result, host, port }
        } catch (error) {
            this.context.log('error', `OBS: no se pudo cambiar el silencio de "${source}": ${error}`, { host, port })
            throw error
        }
    }

    /**
     * Abre una sesión obs-websocket v5 (Hello -> Identify -> requests),
     * ejecuta fn y cierra el socket SIEMPRE.
     */
    private async withObsSession(params: any, fn: (send: ObsSend) => Promise<any>): Promise<any> {
        const connection = this.resolveConnection(params)
        const { url, password, timeoutMs, host, port } = connection
        const pending = new Map<string, { resolve: (value: any) => void; reject: (err: Error) => void; requestType: string }>()
        let requestCounter = 0
        let socket: WebSocket | undefined

        const closeSocket = () => {
            try {
                socket?.close()
            } catch {
                // ignore: already closing/closed
            }
        }

        const failPending = (err: Error) => {
            for (const entry of pending.values()) {
                entry.reject(err)
            }
            pending.clear()
        }

        let handshakeResolve: () => void = () => {}
        let handshakeReject: (err: Error) => void = () => {}
        const handshake = new Promise<void>((resolve, reject) => {
            handshakeResolve = resolve
            handshakeReject = reject
        })

        const handleMessage = (raw: unknown) => {
            let msg: any
            try {
                msg = JSON.parse(String(raw))
            } catch {
                return
            }
            if (!msg || typeof msg.op !== 'number') {
                return
            }
            if (msg.op === OBS_OP_HELLO) {
                const auth = msg.d?.authentication as { challenge: string; salt: string } | undefined
                const payload: Record<string, any> = { rpcVersion: OBS_RPC_VERSION, eventSubscriptions: 0 }
                if (auth?.challenge && auth?.salt) {
                    if (!password) {
                        handshakeReject(new Error(`OBS en ${url} requiere contraseña: configúrala en los parámetros (la de OBS → Herramientas → Ajustes del servidor WebSocket).`))
                        return
                    }
                    payload.authentication = ObsPlugin.computeAuth(password, auth.salt, auth.challenge)
                }
                try {
                    socket?.send(JSON.stringify({ op: OBS_OP_IDENTIFY, d: payload }))
                } catch (err) {
                    handshakeReject(this.connectionError(url, port, err))
                }
            } else if (msg.op === OBS_OP_IDENTIFIED) {
                handshakeResolve()
            } else if (msg.op === OBS_OP_REQUEST_RESPONSE) {
                const d = msg.d ?? {}
                const entry = typeof d.requestId === 'string' ? pending.get(d.requestId) : undefined
                if (!entry) {
                    return
                }
                pending.delete(d.requestId)
                const status = d.requestStatus ?? {}
                if (status.result) {
                    entry.resolve(d.responseData ?? {})
                } else {
                    entry.reject(new Error(`OBS rechazó la petición "${entry.requestType}" (código ${status.code ?? '?'})${status.comment ? `: ${status.comment}` : ''}.`))
                }
            }
        }

        const send: ObsSend = (requestType, requestData) => {
            if (!socket || socket.readyState !== WebSocket.OPEN) {
                return Promise.reject(new Error(`La conexión con OBS en ${url} no está abierta. Comprueba que OBS Studio sigue en ejecución.`))
            }
            requestCounter += 1
            const requestId = `libredeck-${Date.now()}-${requestCounter}`
            return new Promise<any>((resolve, reject) => {
                pending.set(requestId, { resolve, reject, requestType })
                try {
                    socket?.send(JSON.stringify({ op: OBS_OP_REQUEST, d: { requestType, requestId, requestData: requestData ?? {} } }))
                } catch (err) {
                    pending.delete(requestId)
                    reject(this.connectionError(url, port, err))
                }
            })
        }

        const timer = setTimeout(() => {
            const err = new Error(`Tiempo de espera agotado (${timeoutMs} ms) esperando a OBS en ${url}. Comprueba que OBS Studio está abierto y que el servidor WebSocket está activado (OBS → Herramientas → Ajustes del servidor WebSocket) en el puerto ${port} (obs-websocket v5).`)
            failPending(err)
            handshakeReject(err)
            closeSocket()
        }, timeoutMs)

        try {
            try {
                socket = new WebSocket(url)
            } catch (err) {
                throw this.connectionError(url, port, err)
            }

            socket.addEventListener('message', (event: any) => handleMessage(event?.data))
            socket.addEventListener('error', () => {
                const err = this.connectionError(url, port)
                failPending(err)
                handshakeReject(err)
            })
            socket.addEventListener('close', (event: any) => {
                if (event?.code === OBS_CLOSE_AUTH_FAILED) {
                    const err = new Error(`Autenticación con OBS fallida en ${url}: contraseña incorrecta. Revisa la contraseña del servidor WebSocket en OBS (Herramientas → Ajustes del servidor WebSocket).`)
                    failPending(err)
                    handshakeReject(err)
                    return
                }
                const err = this.connectionError(url, port, event?.code !== undefined && event?.code !== 1005 ? `código de cierre ${event.code}` : undefined)
                failPending(err)
                handshakeReject(err)
            })

            await handshake
            return await fn(send)
        } finally {
            clearTimeout(timer)
            failPending(new Error(`La sesión con OBS en ${url} terminó antes de recibir respuesta.`))
            closeSocket()
        }
    }

    private setting(key: string): string | null {
        try {
            const v = this.context.getSetting?.(key)
            return typeof v === 'string' && v.length > 0 ? v : null
        } catch {
            return null
        }
    }

    private resolveConnection(params: any): ObsConnection {
        const host = typeof params?.host === 'string' && params.host.length > 0 ? params.host : (this.setting('host') ?? OBS_DEFAULT_HOST)
        const rawPort = params?.port ?? (this.setting('port') !== null ? Number(this.setting('port')) : undefined)
        const port = typeof rawPort === 'number' && Number.isFinite(rawPort) ? rawPort : OBS_DEFAULT_PORT
        const password = typeof params?.password === 'string' && params.password.length > 0 ? params.password : (this.setting('password') ?? undefined)
        const timeoutMs = typeof params?.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
            ? Math.min(Math.floor(params.timeoutMs), OBS_MAX_TIMEOUT_MS)
            : OBS_DEFAULT_TIMEOUT_MS
        return { host, port, password, timeoutMs, url: `ws://${host}:${port}` }
    }

    private connectionError(url: string, port: number, cause?: unknown): Error {
        const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : typeof cause === 'string' && cause.length > 0 ? `: ${cause}` : ''
        return new Error(`No se pudo conectar a OBS en ${url}${detail}. Comprueba que OBS Studio está abierto y que el servidor WebSocket está activado (OBS → Herramientas → Ajustes del servidor WebSocket) en el puerto ${port} (obs-websocket v5).`)
    }

    private messageOf(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }

    /**
     * Auth de obs-websocket v5:
     * authentication = base64(sha256(challenge + base64(sha256(password + salt)))).
     */
    private static computeAuth(password: string, salt: string, challenge: string): string {
        const secret = createHash('sha256').update(password + salt).digest('base64')
        return createHash('sha256').update(secret + challenge).digest('base64')
    }

    public dispose(): void {
        // Sin estado persistente: cada acción abre y cierra su propio socket.
    }
}
