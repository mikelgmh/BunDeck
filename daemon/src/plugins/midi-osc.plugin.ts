/**
 * Native MIDI/OSC Plugin
 * Envía mensajes OSC sobre UDP (protocolo OSC 1.0 codificado a mano,
 * sin dependencias nuevas, vía node:dgram) e informa sobre MIDI.
 * MIDI: placeholder degradado — BunDeck aún no incluye librería MIDI
 * nativa, así que send-midi devuelve instrucciones en vez de fallar.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const REQUEST_TIMEOUT_MS = 5000

function padTo4(len: number): number {
    return (4 - (len % 4)) % 4
}

function encodeOscString(s: string): Uint8Array {
    const bytes = Buffer.from(s, 'utf8')
    const total = bytes.length + 1 + padTo4(bytes.length + 1)
    const out = Buffer.alloc(total)
    bytes.copy(out, 0)
    // El resto queda a cero (terminador + relleno)
    return new Uint8Array(out)
}

function encodeOscInt(value: number): Uint8Array {
    const out = Buffer.alloc(4)
    out.writeInt32BE(Math.trunc(value), 0)
    return new Uint8Array(out)
}

function encodeOscFloat(value: number): Uint8Array {
    const out = Buffer.alloc(4)
    out.writeFloatBE(Number(value), 0)
    return new Uint8Array(out)
}

export type OscArg = number | string

/**
 * Codifica un mensaje OSC 1.0: dirección + type tags + argumentos.
 * Soporta int32 ('i'), float32 ('f') y string ('s'). Función pura,
 * testeable sin red.
 */
export function encodeOscMessage(address: string, args: OscArg[] = []): Uint8Array {
    if (typeof address !== 'string' || !address.startsWith('/')) {
        throw new Error(`Dirección OSC no válida: "${address}". Debe empezar por / (ej. /fader/1)`)
    }
    let tags = ','
    for (const a of args) {
        if (typeof a === 'number') tags += Number.isInteger(a) ? 'i' : 'f'
        else if (typeof a === 'string') tags += 's'
        else throw new Error(`Argumento OSC no soportado (usa número o texto): ${JSON.stringify(a)}`)
    }
    const parts: Uint8Array[] = [encodeOscString(address), encodeOscString(tags)]
    for (const a of args) {
        if (typeof a === 'number') parts.push(Number.isInteger(a) ? encodeOscInt(a) : encodeOscFloat(a))
        else parts.push(encodeOscString(a))
    }
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const p of parts) {
        out.set(p, offset)
        offset += p.length
    }
    return out
}

export class MidiOscPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'midi-osc',
            name: 'MIDI / OSC',
            version: '1.0.1',
            description: 'Envía mensajes OSC por UDP a consolas, Resolume o DAWs; incluye ayuda MIDI degradada sin librerías extra',
            author: 'BunDeck',
            permissions: ['network'],
            actions: [
                {
                    id: 'send-osc',
                    name: 'Enviar OSC',
                    description: 'Envía un mensaje OSC (dirección + argumentos) por UDP',
                    icon: 'Radio',
                    surface: 'control',
                    component: 'workflow-control',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            host: {
                                type: 'string', title: 'Servidor',
                                description: 'IP o nombre del equipo destino',
                                ui: { component: 'input', type: 'text', placeholder: '127.0.0.1' },
                            },
                            port: {
                                type: 'number', title: 'Puerto UDP',
                                description: 'Puerto UDP del receptor OSC',
                                minimum: 1, maximum: 65535,
                                ui: { component: 'input', type: 'number', placeholder: '8000' },
                            },
                            address: {
                                type: 'string', title: 'Dirección OSC',
                                description: 'Dirección OSC (debe empezar por /)',
                                ui: { component: 'input', type: 'text', placeholder: '/fader/1' },
                            },
                            args: {
                                type: 'array', title: 'Argumentos',
                                description: 'Argumentos del mensaje (números o textos; enteros → int32, decimales → float32)',
                                items: {},
                                ui: { component: 'input', type: 'text', placeholder: '[1, 0.5, "go"]' },
                            },
                            timeoutMs: {
                                type: 'number', title: 'Tiempo límite (ms)',
                                description: 'Tiempo máximo de envío en milisegundos',
                                default: 5000, minimum: 500, maximum: 30000,
                                ui: { component: 'hidden' },
                            },
                        },
                        required: ['host', 'port', 'address'],
                    },
                },
                {
                    id: 'send-midi',
                    name: 'Enviar MIDI (próximamente)',
                    description: 'Placeholder: BunDeck aún no incluye salida MIDI nativa; devuelve cómo hacerlo hoy',
                    icon: 'Music',
                    schema: {
                        type: 'object',
                        properties: {
                            note: {
                                type: 'number', title: 'Nota',
                                description: 'Nota MIDI (0-127)',
                                minimum: 0, maximum: 127,
                                ui: { component: 'input', type: 'number', placeholder: '60' },
                            },
                            velocity: {
                                type: 'number', title: 'Velocidad',
                                description: 'Velocidad (0-127)',
                                minimum: 0, maximum: 127, default: 100,
                                ui: { component: 'input', type: 'number', placeholder: '100' },
                            },
                            channel: {
                                type: 'number', title: 'Canal',
                                description: 'Canal MIDI (1-16)',
                                minimum: 1, maximum: 16, default: 1,
                                ui: { component: 'input', type: 'number', placeholder: '1' },
                            },
                        },
                        required: [],
                    },
                },
                {
                    id: 'list-ports',
                    name: 'Puertos disponibles',
                    description: 'Informa de las capacidades MIDI/OSC de este equipo',
                    icon: 'List',
                    schema: { type: 'object', properties: {}, required: [] },
                },
            ],
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('send-osc', this.executeSendOsc.bind(this))
        handlers.set('send-midi', this.executeSendMidi.bind(this))
        handlers.set('list-ports', this.executeListPorts.bind(this))
        return handlers
    }

    private async executeSendOsc(params: any, _context: any): Promise<any> {
        const host = params?.host
        const port = Number(params?.port)
        const address = params?.address
        if (typeof host !== 'string' || host.trim().length === 0) {
            throw new Error('El servidor (host) es obligatorio para enviar OSC (ej. 127.0.0.1)')
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Puerto UDP no válido: "${params?.port}". Debe ser un entero entre 1 y 65535`)
        }
        const rawArgs = params?.args ?? []
        const args: OscArg[] = Array.isArray(rawArgs) ? rawArgs : [rawArgs]
        for (const a of args) {
            if (typeof a !== 'number' && typeof a !== 'string') {
                throw new Error(`Argumento OSC no soportado (usa número o texto): ${JSON.stringify(a)}`)
            }
        }
        const packet = encodeOscMessage(address, args)
        const timeoutMs = typeof params?.timeoutMs === 'number' && params.timeoutMs > 0
            ? Math.min(Math.floor(params.timeoutMs), 30000)
            : REQUEST_TIMEOUT_MS
        this.context.log('info', `OSC: enviando ${address} a ${host}:${port}`, { args })
        const { createSocket } = await import('node:dgram')
        await new Promise<void>((resolve, reject) => {
            const socket = createSocket('udp4')
            const timer = setTimeout(() => {
                try { socket.close() } catch { /* noop */ }
                reject(new Error(`Tiempo de espera agotado (${timeoutMs} ms) enviando OSC a ${host}:${port}`))
            }, timeoutMs)
            socket.on('error', (err: Error) => {
                clearTimeout(timer)
                try { socket.close() } catch { /* noop */ }
                reject(new Error(`No se pudo enviar OSC a ${host}:${port}: ${err.message}`))
            })
            socket.send(Buffer.from(packet), port, host, (err: Error | null) => {
                clearTimeout(timer)
                try { socket.close() } catch { /* noop */ }
                if (err) reject(new Error(`No se pudo enviar OSC a ${host}:${port}: ${err.message}`))
                else resolve()
            })
        })
        this.context.log('info', `OSC: ${address} enviado a ${host}:${port} (${packet.length} bytes)`)
        return { action: 'send-osc', host, port, address, args, bytes: packet.length, sent: true }
    }

    private async executeSendMidi(params: any, _context: any): Promise<any> {
        const note = params?.note
        if (note !== undefined && (!Number.isInteger(Number(note)) || Number(note) < 0 || Number(note) > 127)) {
            throw new Error(`Nota MIDI no válida: "${note}". Debe ser un entero entre 0 y 127`)
        }
        this.context.log('info', 'MIDI: salida nativa no disponible, devolviendo guía degradada')
        return {
            action: 'send-midi',
            supported: false,
            degraded: true,
            requested: { note: note ?? null, velocity: params?.velocity ?? 100, channel: params?.channel ?? 1 },
            note: 'BunDeck aún no incluye librería MIDI nativa (sin dependencias nuevas). Alternativas hoy: envía OSC con la acción "Enviar OSC" (muchos DAWs y consolas lo aceptan) o usa un puente loopMIDI + una acción shell.',
        }
    }

    private async executeListPorts(_params: any, _context: any): Promise<any> {
        return {
            action: 'list-ports',
            platform: process.platform,
            osc: { supported: true, transport: 'UDP', encoding: 'OSC 1.0 (int32/float32/string)' },
            midi: {
                supported: false,
                inputs: [],
                outputs: [],
                note: 'Sin librería MIDI incluida: no se enumeran puertos. Usa OSC o un puente externo.',
            },
        }
    }

    public dispose(): void {
        // Sin recursos que liberar (cada envío abre y cierra su socket)
    }
}
