/**
 * Native Soundboard Plugin
 * Reproduce archivos de audio locales (wav/mp3/ogg) desde <data>/sounds/.
 * Solo usa herramientas del sistema (afplay, paplay/aplay/ffplay, PowerShell).
 */

import { join, extname, basename, resolve } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const AUDIO_EXTS = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac'])

function dataDir(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getDataDir } = require('../paths')
        return getDataDir()
    } catch {
        return process.env.LIBREDECK_DATA_DIR ?? join(process.cwd(), '..', 'data')
    }
}

export class SoundboardPlugin {
    private context: PluginContext
    private currentProc: any = null
    private currentFile: string | null = null

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'soundboard',
            name: 'Soundboard',
            version: '1.0.0',
            description: 'Reproduce efectos de sonido locales (wav/mp3) para tu directo',
            author: 'BunDeck',
            permissions: ['filesystem', 'process'],
            settingsSchema: {
                type: 'object',
                properties: {
                    soundsDir: {
                        type: 'string', title: 'Carpeta de sonidos',
                        description: 'Carpeta con tus audios (por defecto <datos>/sounds). Los parámetros tienen prioridad.',
                        ui: { component: 'input', type: 'text', placeholder: '<datos>/sounds' }
                    },
                    defaultVolume: {
                        type: 'number', title: 'Volumen por defecto (%)',
                        description: '0–100. Solo se aplica en reproductores que lo soporten (Linux/macOS).',
                        default: 100, minimum: 0, maximum: 100,
                        ui: { component: 'input', type: 'number', placeholder: '100' }
                    }
                }
            },
            instructions: 'Cómo usar la soundboard:\n\n1. Copia tus audios (.wav recomendado, también .mp3/.ogg) en la carpeta de sonidos (por defecto <datos>/sounds; la crea la acción "Listar sonidos" si no existe).\n2. En el botón usa "Reproducir sonido" con el nombre del archivo (ej. "aplausos.wav").\n3. Consejo: .wav funciona en todos los sistemas sin instalar nada; para .mp3 en Windows se abre tu reproductor habitual.',
            actions: [
                {
                    id: 'play', name: 'Reproducir sonido', icon: 'Play',
                    description: 'Reproduce un archivo de audio local',
                    schema: {
                        type: 'object',
                        properties: {
                            file: { type: 'string', title: 'Archivo', description: 'Nombre (dentro de la carpeta de sonidos) o ruta completa', ui: { component: 'input', type: 'text', placeholder: 'aplausos.wav' } },
                            volume: { type: 'number', title: 'Volumen (%)', description: '0–100 (Linux/macOS; en Windows se ignora)', minimum: 0, maximum: 100, ui: { component: 'input', type: 'number', placeholder: '100' } },
                            soundsDir: { type: 'string', title: 'Carpeta de sonidos', description: 'Si se omite usa la de los ajustes', ui: { component: 'input', type: 'text', placeholder: '(la de los ajustes)' } }
                        },
                        required: ['file']
                    }
                },
                {
                    id: 'stop', name: 'Detener sonido', icon: 'Square',
                    description: 'Detiene la reproducción iniciada por este plugin',
                    schema: { type: 'object', properties: {}, required: [] }
                },
                {
                    id: 'set-output', name: 'Ver salida de audio', icon: 'Speaker',
                    description: 'Muestra qué salida de audio usa el sistema (informativo)',
                    schema: { type: 'object', properties: {}, required: [] }
                },
                {
                    id: 'list-sounds', name: 'Listar sonidos', icon: 'ListMusic',
                    description: 'Lista los audios disponibles en la carpeta de sonidos',
                    schema: {
                        type: 'object',
                        properties: {
                            soundsDir: { type: 'string', title: 'Carpeta de sonidos', description: 'Si se omite usa la de los ajustes', ui: { component: 'input', type: 'text', placeholder: '(la de los ajustes)' } }
                        },
                        required: []
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('play', this.executePlay.bind(this))
        handlers.set('stop', this.executeStop.bind(this))
        handlers.set('set-output', this.executeSetOutput.bind(this))
        handlers.set('list-sounds', this.executeListSounds.bind(this))
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

    private soundsDir(params: any): string {
        const fromParams = typeof params?.soundsDir === 'string' && params.soundsDir.trim() ? params.soundsDir.trim() : null
        return fromParams ?? this.setting('soundsDir') ?? join(dataDir(), 'sounds')
    }

    private resolveFile(soundsDir: string, file: string): string {
        const trimmed = String(file ?? '').trim()
        if (!trimmed) throw new Error('La acción "Reproducir sonido" requiere el parámetro "file" (ej. "aplausos.wav").')
        const candidate = trimmed.includes('/') || trimmed.includes('\\') ? resolve(trimmed) : join(soundsDir, trimmed)
        // Evita salidas de la carpeta cuando se usa nombre relativo.
        if (!trimmed.includes('/') && !trimmed.includes('\\') && !candidate.startsWith(resolve(soundsDir))) {
            throw new Error(`Ruta de archivo no válida: "${trimmed}".`)
        }
        if (!existsSync(candidate)) {
            throw new Error(`No se encontró el archivo "${trimmed}" en ${soundsDir}. Pon el nombre exacto (mira la acción "Listar sonidos") o usa una ruta completa.`)
        }
        const ext = extname(candidate).toLowerCase()
        if (!AUDIO_EXTS.has(ext)) {
            throw new Error(`Formato no soportado: "${ext}". Usa ${[...AUDIO_EXTS].join(', ')}.`)
        }
        return candidate
    }

    private async executePlay(params: any, _context: any): Promise<any> {
        const dir = this.soundsDir(params)
        const file = this.resolveFile(dir, params?.file)
        const volume = typeof params?.volume === 'number' && Number.isFinite(params.volume)
            ? Math.max(0, Math.min(100, Math.round(params.volume)))
            : (() => { const d = Number(this.setting('defaultVolume')); return Number.isFinite(d) ? Math.max(0, Math.min(100, Math.round(d))) : 100 })()
        const platform = process.platform
        const ext = extname(file).toLowerCase()
        this.context.log('info', `Soundboard: reproduciendo ${basename(file)}`, { platform, volume })

        try {
            if (platform === 'darwin') {
                const args = volume >= 100 ? [file] : ['-v', String(volume / 100), file]
                this.currentProc = Bun.spawn({ cmd: ['afplay', ...args], stdio: ['ignore', 'pipe', 'pipe'] })
                this.currentFile = file
                await this.currentProc.exited
                if (this.currentProc.exitCode !== 0) throw new Error(`afplay terminó con código ${this.currentProc.exitCode}`)
                return { action: 'play', file, volume, platform: 'macos', finished: true }
            }
            if (platform === 'linux') {
                const players: Array<{ cmd: string[]; label: string }> = volume >= 100
                    ? [{ cmd: ['paplay', file], label: 'paplay' }, { cmd: ['aplay', file], label: 'aplay' }, { cmd: ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', file], label: 'ffplay' }]
                    : [{ cmd: ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(volume * 0.256) - 0 >= 0 ? Math.round((volume / 100) * 100) : volume), file], label: 'ffplay' }, { cmd: ['paplay', '--volume', String(Math.round(volume * 655.36)), file], label: 'paplay' }]
                let lastErr = ''
                for (const p of players) {
                    try {
                        this.currentProc = Bun.spawn({ cmd: p.cmd, stdio: ['ignore', 'pipe', 'pipe'] })
                        this.currentFile = file
                        await this.currentProc.exited
                        if (this.currentProc.exitCode === 0) return { action: 'play', file, volume, platform: 'linux', player: p.label, finished: true }
                        lastErr = `${p.label} (código ${this.currentProc.exitCode})`
                    } catch (e) {
                        lastErr = `${p.label} no disponible`
                    }
                }
                throw new Error(`No hay reproductor de audio disponible en Linux (${lastErr}). Instala PulseAudio (paplay), ALSA (aplay) o ffmpeg (ffplay).`)
            }
            if (platform === 'win32') {
                if (ext === '.wav') {
                    const ps = `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`
                    const proc = Bun.spawn({ cmd: ['powershell.exe', '-NoProfile', '-Command', ps], stdio: ['ignore', 'pipe', 'pipe'] })
                    this.currentProc = proc
                    this.currentFile = file
                    const stderr = await new Response(proc.stderr).text()
                    await proc.exited
                    if (proc.exitCode !== 0) throw new Error(`PowerShell no pudo reproducir el wav: ${stderr.trim() || `código ${proc.exitCode}`}`)
                    return { action: 'play', file, volume: 100, platform: 'windows', player: 'SoundPlayer', finished: true }
                }
                // .mp3/.ogg en Windows: abrir con la app predeterminada (no bloqueante).
                const proc = Bun.spawn({ cmd: ['cmd', '/c', 'start', '""', file], stdio: ['ignore', 'pipe', 'pipe'] })
                await proc.exited
                return { action: 'play', file, platform: 'windows', player: 'default-app', finished: false, note: 'En Windows los .mp3/.ogg se abren con tu reproductor predeterminado (para reproducción interna usa .wav).' }
            }
            throw new Error(`Reproducción de audio no soportada en la plataforma: ${platform}`)
        } catch (error) {
            this.context.log('error', `Soundboard: no se pudo reproducir ${basename(file)}: ${error}`)
            throw error
        } finally {
            this.currentProc = null
            this.currentFile = null
        }
    }

    private async executeStop(_params: any, _context: any): Promise<any> {
        if (!this.currentProc) {
            return { action: 'stop', stopped: false, note: 'No hay ninguna reproducción en curso de este plugin.' }
        }
        try {
            this.currentProc.kill()
        } catch { /* ya terminó */ }
        const file = this.currentFile
        this.currentProc = null
        this.currentFile = null
        this.context.log('info', `Soundboard: reproducción detenida (${file ? basename(file) : '?'})`)
        return { action: 'stop', stopped: true, file }
    }

    private async executeSetOutput(_params: any, _context: any): Promise<any> {
        const platform = process.platform
        const run = async (cmd: string[]): Promise<string | null> => {
            try {
                const proc = Bun.spawn({ cmd, stdio: ['ignore', 'pipe', 'pipe'] })
                const out = await new Response(proc.stdout).text()
                await proc.exited
                return proc.exitCode === 0 ? out.trim() : null
            } catch {
                return null
            }
        }
        if (platform === 'win32') {
            return { action: 'set-output', platform: 'windows', output: 'Dispositivo predeterminado de Windows', note: 'La soundboard usa la salida predeterminada de Windows (Ajustes → Sonido). Para enviarla a otra app (Discord/OBS), usa VoiceMeeter o un cable virtual y elige ese dispositivo como predeterminado.' }
        }
        if (platform === 'darwin') {
            const out = await run(['system_profiler', 'SPAudioDataType'])
            const line = out?.split('\n').map((l) => l.trim()).find((l) => /^Default Output/.test(l) || /Default Output Device/.test(l)) ?? null
            return { action: 'set-output', platform: 'macos', output: line ?? 'Salida predeterminada de macOS', note: 'La soundboard usa la salida predeterminada de macOS (Ajustes → Sonido).' }
        }
        if (platform === 'linux') {
            const out = await run(['pactl', 'get-default-sink'])
            return { action: 'set-output', platform: 'linux', output: out ?? 'Salida predeterminada de PulseAudio/PipeWire', note: out ? undefined : 'No se detectó pactl: la soundboard usa la salida predeterminada del sistema.' }
        }
        return { action: 'set-output', platform, output: null, note: `Plataforma no soportada: ${platform}` }
    }

    private async executeListSounds(params: any, _context: any): Promise<any> {
        const dir = this.soundsDir(params)
        const { mkdir } = await import('node:fs/promises')
        try {
            await mkdir(dir, { recursive: true })
        } catch { /* si no se puede crear, readdir lo dirá */ }
        let entries: string[]
        try {
            entries = await readdir(dir)
        } catch (error) {
            throw new Error(`No se pudo leer la carpeta de sonidos ${dir}: ${error instanceof Error ? error.message : String(error)}`)
        }
        const sounds: Array<{ name: string; size: number }> = []
        for (const name of entries) {
            if (!AUDIO_EXTS.has(extname(name).toLowerCase())) continue
            try {
                const s = await stat(join(dir, name))
                if (s.isFile()) sounds.push({ name, size: s.size })
            } catch { /* ignora carreras */ }
        }
        sounds.sort((a, b) => a.name.localeCompare(b.name))
        return {
            action: 'list-sounds',
            soundsDir: dir,
            count: sounds.length,
            sounds,
            note: sounds.length === 0 ? `Carpeta vacía: copia tus .wav/.mp3 en ${dir}.` : undefined,
        }
    }

    public dispose(): void {
        try { this.currentProc?.kill() } catch { /* noop */ }
        this.currentProc = null
    }
}
