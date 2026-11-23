/**
 * Native Audio Mixer Plugin
 * Volumen por aplicación, cambio de salida, silencio de micro y niveles.
 * Windows (nircmd / AudioDeviceCmdlets), Linux (pactl) y macOS (osascript).
 * Degrada con errores amigables en español si la herramienta no existe.
 */

import { runCommand, isCommandNotFound, missingToolError } from './sysrun'
import { CONTRACT_API_VERSION, CONTRACT_ENGINE } from './contract'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
    deleteSetting?: (key: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const NIRCMD_HINT = 'Instala nircmd.exe de NirSoft (https://www.nirsoft.net/utils/nircmd.html) y ponlo en el PATH.'
const PACTL_HINT = 'Instala PipeWire/PulseAudio (pactl) con tu gestor de paquetes, ej. "sudo apt install pulseaudio-utils".'
const AUDIODEV_HINT = 'Instala el módulo AudioDeviceCmdlets en PowerShell (Install-Module -Name AudioDeviceCmdlets).'

export class AudioMixerPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    /** Punto de inyección para tests (por defecto runCommand real). */
    protected async run(cmd: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return runCommand(cmd, { timeoutMs: opts?.timeoutMs ?? 15000, ...opts })
    }

    public getManifest() {
        return {
            id: 'audio-mixer',
            name: 'Mezclador de audio',
            version: '1.1.0',
            description: 'Volumen por aplicación, dispositivo de salida, silencio de micro y niveles',
            author: 'BunDeck',
            apiVersion: CONTRACT_API_VERSION,
            engine: CONTRACT_ENGINE,
            category: 'system',
            permissions: ['system'],
            instructions:
                'Control de audio del sistema.\n\n' +
                '· Windows: necesita nircmd.exe en el PATH para volumen por app y micro (listar/salidas usa AudioDeviceCmdlets).\n' +
                '· Linux: necesita pactl (PipeWire/PulseAudio).\n' +
                '· macOS: soporta volumen maestro y micro con osascript; el volumen por app y el cambio de salida no están soportados por el sistema.',
            actions: [
                {
                    id: 'app-volume',
                    name: 'Volumen de app',
                    description: 'Fija el volumen (0-100) o el silencio de una aplicación (o del maestro si se omite)',
                    icon: 'SlidersHorizontal',
                    schema: {
                        type: 'object',
                        properties: {
                            app: {
                                type: 'string',
                                title: 'Aplicación',
                                description: 'Nombre del proceso (ej. spotify.exe, firefox). Si se omite, se usa el volumen maestro.',
                                ui: { component: 'input', type: 'text', placeholder: 'spotify.exe' }
                            },
                            volume: {
                                type: 'number',
                                title: 'Volumen (0-100)',
                                description: 'Nivel de volumen deseado',
                                minimum: 0,
                                maximum: 100,
                                ui: { component: 'input', type: 'number', min: 0, max: 100, placeholder: '50' }
                            },
                            mute: {
                                type: 'string',
                                title: 'Silencio',
                                description: 'true silencia, false reactiva, toggle alterna. Si se omite no se toca el silencio.',
                                enum: ['true', 'false', 'toggle'],
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'true', label: 'Silenciar' },
                                        { value: 'false', label: 'Reactivar' },
                                        { value: 'toggle', label: 'Alternar' }
                                    ]
                                }
                            }
                        }
                    }
                },
                {
                    id: 'output-switch',
                    name: 'Cambiar salida',
                    description: 'Lista los dispositivos de salida o fija el predeterminado',
                    icon: 'Speaker',
                    schema: {
                        type: 'object',
                        properties: {
                            device: {
                                type: 'string',
                                title: 'Dispositivo',
                                description: 'Nombre o ID del dispositivo a usar. Si se omite, solo se listan los disponibles.',
                                ui: { component: 'input', type: 'text', placeholder: '(vacío = listar)' }
                            }
                        }
                    }
                },
                {
                    id: 'mic-mute',
                    name: 'Silenciar micro',
                    description: 'Silencia, reactiva o alterna el micrófono predeterminado',
                    icon: 'MicOff',
                    schema: {
                        type: 'object',
                        properties: {
                            muted: {
                                type: 'boolean',
                                title: 'Silenciado',
                                description: 'Estado deseado. Si se omite, se alterna.',
                                ui: { component: 'switch' }
                            }
                        }
                    }
                },
                {
                    id: 'get-levels',
                    name: 'Ver niveles',
                    description: 'Devuelve los niveles actuales (reales si el sistema lo permite)',
                    icon: 'Activity',
                    schema: { type: 'object', properties: {} }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('app-volume', this.executeAppVolume.bind(this))
        handlers.set('output-switch', this.executeOutputSwitch.bind(this))
        handlers.set('mic-mute', this.executeMicMute.bind(this))
        handlers.set('get-levels', this.executeGetLevels.bind(this))
        return handlers
    }

    // ---------- app-volume ----------

    private async executeAppVolume(params: any, _context: any): Promise<any> {
        const { app, volume, mute } = params ?? {}
        if (volume === undefined && mute === undefined) {
            throw new Error('Indica "volume" (0-100) o "mute" (true/false/toggle).')
        }
        if (volume !== undefined && (typeof volume !== 'number' || volume < 0 || volume > 100)) {
            throw new Error('El "volume" debe ser un número entre 0 y 100.')
        }
        if (mute !== undefined && !['true', 'false', 'toggle'].includes(String(mute))) {
            throw new Error('El parámetro "mute" debe ser "true", "false" o "toggle".')
        }
        const platform = process.platform
        this.context.log('info', `Mezclador: volumen app=${app ?? '(maestro)'} volume=${volume} mute=${mute}`, { platform })
        try {
            if (platform === 'win32') return await this.winAppVolume(app, volume, mute)
            if (platform === 'linux') return await this.linuxAppVolume(app, volume, mute)
            return await this.macAppVolume(app, volume, mute)
        } catch (error) {
            this.context.log('error', `Mezclador: no se pudo ajustar el volumen: ${this.msg(error)}`, { app })
            throw error
        }
    }

    private async winAppVolume(app: string | undefined, volume: number | undefined, mute: string | undefined): Promise<any> {
        const target = app && app.length > 0 ? app : null
        try {
            if (mute !== undefined) {
                const state = mute === 'true' ? '1' : mute === 'false' ? '0' : '2'
                const args = target
                    ? ['nircmd.exe', 'muteappvolume', target, state]
                    : ['nircmd.exe', 'mutesysvolume', state]
                const r = await this.run(args)
                this.checkOk(r, 'ajustar el silencio')
            }
            if (volume !== undefined) {
                const args = target
                    ? ['nircmd.exe', 'setappvolume', target, String(volume / 100)]
                    : ['nircmd.exe', 'setsysvolume', String(Math.round(volume * 655.35))]
                const r = await this.run(args)
                this.checkOk(r, 'ajustar el volumen')
            }
            return { platform: 'windows', method: 'nircmd', app: target ?? '(maestro)', volume: volume ?? null, mute: mute ?? null, applied: true }
        } catch (error) {
            if (isCommandNotFound(error) || (error as any)?.code === 'COMMAND_NOT_FOUND') throw missingToolError('nircmd.exe', NIRCMD_HINT)
            throw error
        }
    }

    private async linuxAppVolume(app: string | undefined, volume: number | undefined, mute: string | undefined): Promise<any> {
        try {
            const sinkRef = app && app.length > 0 ? await this.linuxSinkInputFor(app) : '@DEFAULT_SINK@'
            if (mute !== undefined) {
                const state = mute === 'true' ? '1' : mute === 'false' ? '0' : 'toggle'
                const cmd = app ? ['pactl', 'set-sink-input-mute', sinkRef, state] : ['pactl', 'set-sink-mute', sinkRef, state]
                const r = await this.run(cmd)
                this.checkOk(r, 'ajustar el silencio')
            }
            if (volume !== undefined) {
                const cmd = app
                    ? ['pactl', 'set-sink-input-volume', sinkRef, `${Math.round(volume)}%`]
                    : ['pactl', 'set-sink-volume', sinkRef, `${Math.round(volume)}%`]
                const r = await this.run(cmd)
                this.checkOk(r, 'ajustar el volumen')
            }
            return { platform: 'linux', method: 'pactl', app: app ?? '(maestro)', volume: volume ?? null, mute: mute ?? null, applied: true }
        } catch (error) {
            if (isCommandNotFound(error) || (error as any)?.code === 'COMMAND_NOT_FOUND') throw missingToolError('pactl', PACTL_HINT)
            throw error
        }
    }

    private async linuxSinkInputFor(app: string): Promise<string> {
        const r = await this.run(['pactl', 'list', 'sink-inputs'])
        this.checkOk(r, 'listar las aplicaciones con audio')
        const needle = app.toLowerCase()
        let current: string | null = null
        for (const line of r.stdout.split('\n')) {
            const idMatch = line.match(/^Sink Input #(\d+)/)
            if (idMatch) current = idMatch[1]
            if (current && /application\.process\.binary|application\.name|media\.name/i.test(line) && line.toLowerCase().includes(needle)) {
                return current
            }
        }
        throw new Error(`No hay ninguna aplicación con audio que coincida con "${app}". Ábrela y reproduce algo primero.`)
    }

    private async macAppVolume(app: string | undefined, volume: number | undefined, mute: string | undefined): Promise<any> {
        if (app && app.length > 0) {
            throw new Error('macOS no permite ajustar el volumen por aplicación con las herramientas del sistema: omite "app" para usar el volumen maestro.')
        }
        if (mute !== undefined) {
            const script = mute === 'toggle'
                ? 'set m to (output muted of (get volume settings))\nset volume without output muted'
                : mute === 'true' ? 'set volume with output muted' : 'set volume without output muted'
            const r = await this.run(['osascript', '-e', script])
            this.checkOk(r, 'ajustar el silencio')
            return { platform: 'macos', method: 'osascript', app: '(maestro)', mute, applied: true }
        }
        const r = await this.run(['osascript', '-e', `set volume output volume ${Math.round(volume!)}`])
        this.checkOk(r, 'ajustar el volumen')
        return { platform: 'macos', method: 'osascript', app: '(maestro)', volume, applied: true }
    }

    // ---------- output-switch ----------

    private async executeOutputSwitch(params: any, _context: any): Promise<any> {
        const { device } = params ?? {}
        const platform = process.platform
        this.context.log('info', `Mezclador: salida device=${device ?? '(listar)'}`, { platform })
        try {
            if (platform === 'linux') return await this.linuxOutput(device)
            if (platform === 'win32') return await this.winOutput(device)
            throw new Error('En macOS el cambio de salida no está soportado con las herramientas del sistema (usa Ajustes del Sistema → Sonido).')
        } catch (error) {
            this.context.log('error', `Mezclador: no se pudo cambiar la salida: ${this.msg(error)}`)
            throw error
        }
    }

    private async linuxOutput(device: string | undefined): Promise<any> {
        try {
            const list = await this.run(['pactl', 'list', 'short', 'sinks'])
            this.checkOk(list, 'listar las salidas de audio')
            const sinks = list.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
                const parts = l.split('\t')
                return { id: parts[0], name: parts[1], state: parts[4] ?? '' }
            })
            if (!device) return { platform: 'linux', devices: sinks, hint: 'Indica "device" con el nombre o ID para fijar la salida.' }
            const match = sinks.find(s => s.name === device || s.id === device)
                ?? sinks.find(s => s.name.toLowerCase().includes(device.toLowerCase()))
            if (!match) throw new Error(`No se encontró la salida "${device}". Disponibles: ${sinks.map(s => s.name).join(', ') || '(ninguna)'}.`)
            const r = await this.run(['pactl', 'set-default-sink', match.name])
            this.checkOk(r, 'fijar la salida')
            return { platform: 'linux', devices: sinks, selected: match.name, applied: true }
        } catch (error) {
            if (isCommandNotFound(error) || (error as any)?.code === 'COMMAND_NOT_FOUND') throw missingToolError('pactl', PACTL_HINT)
            throw error
        }
    }

    private async winOutput(device: string | undefined): Promise<any> {
        const listScript = 'Get-AudioDevice -List | Select-Object ID, Name, Type | Format-List | Out-String'
        let listOut: string
        try {
            const r = await this.run(['powershell.exe', '-NoProfile', '-Command', listScript])
            this.checkOk(r, 'listar las salidas de audio')
            listOut = r.stdout
        } catch (error) {
            if (isCommandNotFound(error) || (error as any)?.code === 'COMMAND_NOT_FOUND') throw missingToolError('PowerShell', 'PowerShell debería estar disponible en Windows.')
            throw new Error(`No se pudieron listar las salidas. ${AUDIODEV_HINT} Detalle: ${this.msg(error)}`)
        }
        if (!device) {
            return { platform: 'windows', devicesRaw: listOut.trim(), hint: 'Indica "device" con el nombre o ID para fijar la salida (requiere AudioDeviceCmdlets).' }
        }
        const setScript = `Set-AudioDevice -ID '${device.replace(/'/g, "''")}'`
        try {
            const r = await this.run(['powershell.exe', '-NoProfile', '-Command', setScript])
            this.checkOk(r, 'fijar la salida')
            return { platform: 'windows', selected: device, applied: true }
        } catch (error) {
            throw new Error(`No se pudo fijar la salida "${device}". ${AUDIODEV_HINT} Detalle: ${this.msg(error)}`)
        }
    }

    // ---------- mic-mute ----------

    private async executeMicMute(params: any, _context: any): Promise<any> {
        const { muted } = params ?? {}
        if (muted !== undefined && typeof muted !== 'boolean') {
            throw new Error('El parámetro "muted" debe ser booleano (o omitirse para alternar).')
        }
        const platform = process.platform
        this.context.log('info', `Mezclador: micro muted=${muted ?? 'toggle'}`, { platform })
        try {
            if (platform === 'linux') return await this.linuxMic(muted)
            if (platform === 'darwin') return await this.macMic(muted)
            return await this.winMic(muted)
        } catch (error) {
            this.context.log('error', `Mezclador: no se pudo silenciar el micro: ${this.msg(error)}`)
            throw error
        }
    }

    private async linuxMic(muted: boolean | undefined): Promise<any> {
        try {
            const state = muted === undefined ? 'toggle' : muted ? '1' : '0'
            const r = await this.run(['pactl', 'set-source-mute', '@DEFAULT_SOURCE@', state])
            this.checkOk(r, 'silenciar el micrófono')
            const q = await this.run(['pactl', 'get-source-mute', '@DEFAULT_SOURCE@'])
            const isMuted = /yes/i.test(q.stdout)
            return { platform: 'linux', method: 'pactl', muted: isMuted, applied: true }
        } catch (error) {
            if (isCommandNotFound(error) || (error as any)?.code === 'COMMAND_NOT_FOUND') throw missingToolError('pactl', PACTL_HINT)
            throw error
        }
    }

    private async macMic(muted: boolean | undefined): Promise<any> {
        if (muted === undefined) {
            const q = await this.run(['osascript', '-e', 'input volume of (get volume settings)'])
            this.checkOk(q, 'leer el estado del micrófono')
            const current = Number(q.stdout.trim())
            const target = current > 0 ? 0 : (Number(this.context.getSetting?.('micPrev') ?? '70') || 70)
            if (current > 0) this.context.setSetting?.('micPrev', String(current))
            const r = await this.run(['osascript', '-e', `set volume input volume ${target}`])
            this.checkOk(r, 'silenciar el micrófono')
            return { platform: 'macos', method: 'osascript', muted: target === 0, applied: true }
        }
        if (!muted) {
            const prev = Number(this.context.getSetting?.('micPrev') ?? '70') || 70
            const r = await this.run(['osascript', '-e', `set volume input volume ${prev}`])
            this.checkOk(r, 'reactivar el micrófono')
            return { platform: 'macos', method: 'osascript', muted: false, applied: true }
        }
        const q = await this.run(['osascript', '-e', 'input volume of (get volume settings)'])
        const current = Number(q.stdout.trim())
        if (current > 0) this.context.setSetting?.('micPrev', String(current))
        const r = await this.run(['osascript', '-e', 'set volume input volume 0'])
        this.checkOk(r, 'silenciar el micrófono')
        return { platform: 'macos', method: 'osascript', muted: true, applied: true }
    }

    private async winMic(muted: boolean | undefined): Promise<any> {
        const state = muted === undefined ? '2' : muted ? '1' : '0'
        try {
            const r = await this.run(['nircmd.exe', 'setsubunitvolumemute', 'capture', 'Microphone', state])
            this.checkOk(r, 'silenciar el micrófono')
            return { platform: 'windows', method: 'nircmd', muted: muted ?? 'toggle', applied: true }
        } catch (error) {
            if (isCommandNotFound(error) || (error as any)?.code === 'COMMAND_NOT_FOUND') {
                throw new Error(
                    `No se pudo silenciar el micro en Windows. ${NIRCMD_HINT} ` +
                    `Alternativa: ${AUDIODEV_HINT}`
                )
            }
            throw new Error(`No se pudo silenciar el micro con nircmd (¿nombre de dispositivo distinto?). Detalle: ${this.msg(error)}`)
        }
    }

    // ---------- get-levels ----------

    private async executeGetLevels(_params: any, _context: any): Promise<any> {
        if (process.platform === 'linux') {
            try {
                const v = await this.run(['pactl', 'get-sink-volume', '@DEFAULT_SINK@'])
                const m = await this.run(['pactl', 'get-sink-mute', '@DEFAULT_SINK@'])
                const pct = v.stdout.match(/(\d+)%/)?.[1]
                const muted = /yes/i.test(m.stdout)
                return {
                    platform: 'linux', master: pct !== undefined ? Number(pct) : null, muted,
                    simulated: false, source: 'pactl'
                }
            } catch (error) {
                this.context.log('warn', `Mezclador: pactl no disponible, devolviendo valores de ejemplo: ${this.msg(error)}`)
            }
        }
        return {
            platform: process.platform,
            master: 50,
            mic: 50,
            muted: false,
            simulated: true,
            nota: 'Valores de ejemplo: el sistema no expone niveles en tiempo real con las herramientas disponibles.'
        }
    }

    private checkOk(r: { exitCode: number; stderr: string }, what: string): void {
        if (r.exitCode !== 0) {
            const detail = r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : ''
            throw new Error(`No se pudo ${what} (código ${r.exitCode})${detail}.`)
        }
    }

    private msg(error: unknown): string {
        return error instanceof Error ? error.message : String(error)
    }

    public dispose(): void {
        // Sin recursos persistentes
    }
}
