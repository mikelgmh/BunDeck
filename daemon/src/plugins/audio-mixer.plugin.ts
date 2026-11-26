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
            version: '1.1.1',
            description: 'Volumen por aplicación, dispositivo de salida, silencio de micro y niveles',
            author: 'BunDeck',
            apiVersion: CONTRACT_API_VERSION,
            engine: CONTRACT_ENGINE,
            category: 'system',
            permissions: ['system'],
            instructions:
                'Control de audio del sistema.\n\n' +
                '· Windows: el volumen maestro funciona sin dependencias; el volumen por app necesita nircmd.exe en el PATH (listar/salidas usa AudioDeviceCmdlets).\n' +
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
                    surface: 'control',
                    component: 'audio-control',
                    freeModeOnly: true,
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
                    surface: 'control',
                    component: 'audio-control',
                    freeModeOnly: true,
                    variables: [{ name: 'audioMicMuted', type: 'bool', label: 'Micro silenciado' }],
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
                },
                {
                    id: 'volume-control',
                    name: 'Control de volumen',
                    description: 'Muestra un control de volumen en la tecla (arco en 1×1, sliders al redimensionar). Solo se representa en modo libre; en modo Fija la tecla se ve normal.',
                    icon: 'SlidersHorizontal',
                    surface: 'control',
                    component: 'volume-range',
                    freeModeOnly: true,
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
        handlers.set('volume-control', this.executeVolumeControl.bind(this))
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
        // Volumen por app en Windows sigue necesitando nircmd (sin API del sistema).
        if (target) {
            try {
                if (mute !== undefined) {
                    const state = mute === 'true' ? '1' : mute === 'false' ? '0' : '2'
                    const r = await this.run(['nircmd.exe', 'muteappvolume', target, state])
                    this.checkOk(r, 'ajustar el silencio')
                }
                if (volume !== undefined) {
                    const r = await this.run(['nircmd.exe', 'setappvolume', target, String(volume / 100)])
                    this.checkOk(r, 'ajustar el volumen')
                }
                return { platform: 'windows', method: 'nircmd', app: target, volume: volume ?? null, mute: mute ?? null, applied: true }
            } catch (error) {
                if (isCommandNotFound(error) || (error as any)?.code === 'COMMAND_NOT_FOUND') throw missingToolError('nircmd.exe', NIRCMD_HINT)
                throw error
            }
        }
        // Volumen maestro: Core Audio (MMDeviceEnumerator) vía PowerShell, sin dependencias.
        try {
            if (mute === 'toggle') {
                const cur = await this.winMasterGet()
                await this.winMasterSet(undefined, !cur.muted)
            } else if (mute !== undefined) {
                await this.winMasterSet(volume, mute === 'true')
            } else {
                // Solo volumen: desilencia (mover el slider reactiva el sonido).
                await this.winMasterSet(volume, volume !== undefined ? false : undefined)
            }
            const after = await this.winMasterGet()
            return { platform: 'windows', method: 'coreaudio', app: '(maestro)', volume: after.master, mute: mute ?? null, muted: after.muted, applied: true }
        } catch (error) {
            if (isCommandNotFound(error) || (error as any)?.code === 'COMMAND_NOT_FOUND') {
                throw new Error(`No se encontró PowerShell en este equipo. Detalle: ${this.msg(error)}`)
            }
            throw error
        }
    }

    /** C# inline para Core Audio: maestro + mute del endpoint predeterminado. */
    private static readonly WIN_COREAUDIO_CS = [
        'using System;',
        'using System.Runtime.InteropServices;',
        '[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
        'interface IAudioEndpointVolume {',
        ' int _0(); int _1(); int _2(); int _3();',
        ' int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);',
        ' int _4();',
        ' int GetMasterVolumeLevelScalar(out float pfLevel);',
        ' int _5(); int _6(); int _7(); int _8();',
        ' int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);',
        ' int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);',
        '}',
        '[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
        'interface IMMDevice {',
        ' int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);',
        '}',
        '[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }',
        '[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
        'interface IMMDeviceEnumerator {',
        ' int _0();',
        ' int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);',
        '}',
        'public class BdAudio {',
        ' static IAudioEndpointVolume Vol() {',
        '  var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());',
        '  IMMDevice dev; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));',
        '  Guid iid = typeof(IAudioEndpointVolume).GUID;',
        '  IAudioEndpointVolume v; Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, 0, out v));',
        '  return v;',
        ' }',
        ' public static float Get() { float l; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out l)); return l * 100f; }',
        ' public static void Set(float pct) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(pct / 100f, System.Guid.Empty)); }',
        ' public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }',
        ' public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, System.Guid.Empty)); }',
        '}'
    ].join(' ')

    private winPsPrelude(): string {
        return `Add-Type -TypeDefinition '${AudioMixerPlugin.WIN_COREAUDIO_CS}'`
    }

    private async winMasterGet(): Promise<{ master: number; muted: boolean }> {
        const script = `${this.winPsPrelude()}; [int]([BdAudio]::Get()); if ([BdAudio]::GetMute()) { 'mute:1' } else { 'mute:0' }`
        const r = await this.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30000 })
        this.checkOk(r, 'leer el volumen maestro')
        const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        const master = Number(lines[0])
        if (!Number.isFinite(master)) {
            throw new Error(`No se pudo leer el volumen maestro (salida inesperada: ${r.stdout.trim().slice(0, 120)}).`)
        }
        const muted = lines.some((l) => /mute:1/i.test(l))
        return { master: Math.min(100, Math.max(0, Math.round(master))), muted }
    }

    private async winMasterSet(volume: number | undefined, mute: boolean | undefined): Promise<void> {
        const steps: string[] = [this.winPsPrelude()]
        if (volume !== undefined) steps.push(`[BdAudio]::Set(${Math.round(volume)})`)
        if (mute !== undefined) steps.push(mute ? '[BdAudio]::SetMute($true)' : '[BdAudio]::SetMute($false)')
        const r = await this.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', steps.join('; ')], { timeoutMs: 30000 })
        this.checkOk(r, 'ajustar el volumen')
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

    // ---------- get-levels / volume-control ----------

    private async executeGetLevels(_params: any, _context: any): Promise<any> {
        return this.readLevels()
    }

    /**
     * La acción de control NO cambia nada al pulsar: solo devuelve los niveles
     * para que reglas/automatizaciones puedan leerlos. El slider de la UI
     * escribe con `app-volume` y lee con `get-levels` por su cuenta.
     * En modo Fija (sin representación de control) pulsar la tecla es inocuo.
     */
    private async executeVolumeControl(_params: any, _context: any): Promise<any> {
        const levels = await this.readLevels()
        return { ...levels, control: 'volume-range' }
    }

    private async readLevels(): Promise<any> {
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
        if (process.platform === 'darwin') {
            try {
                const v = await this.run(['osascript', '-e', 'output volume of (get volume settings)'])
                const m = await this.run(['osascript', '-e', 'output muted of (get volume settings)'])
                const master = Number(v.stdout.trim())
                const muted = /true/i.test(m.stdout.trim())
                if (Number.isFinite(master)) {
                    return { platform: 'darwin', master, muted, simulated: false, source: 'osascript' }
                }
            } catch (error) {
                this.context.log('warn', `Mezclador: osascript no disponible, devolviendo valores de ejemplo: ${this.msg(error)}`)
            }
        }
        if (process.platform === 'win32') {
            // Core Audio (MMDeviceEnumerator) vía PowerShell: volumen real del
            // endpoint predeterminado, sin dependencias. winmm está obsoleto y
            // suele devolver 100 aunque el maestro esté a otro nivel.
            try {
                const cur = await this.winMasterGet()
                return {
                    platform: 'windows', master: cur.master,
                    muted: cur.muted, simulated: false, source: 'coreaudio'
                }
            } catch (error) {
                this.context.log('warn', `Mezclador: no se pudo leer el volumen maestro: ${this.msg(error)}`)
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
