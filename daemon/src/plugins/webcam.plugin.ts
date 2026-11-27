/**
 * Native Webcam Plugin
 * Utilidades de cámara: listar cámaras del sistema, foto rápida (si hay
 * ffmpeg) y abrir los ajustes de cámara del SO. Sin dependencias externas.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

async function runCmd(cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let proc: any
    try {
        proc = Bun.spawn({ windowsHide: true,  cmd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
        throw new Error(`No se pudo ejecutar "${cmd[0]}": ${err instanceof Error ? err.message : String(err)}`)
    }
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    return { stdout, stderr, exitCode: proc.exitCode ?? -1 }
}

export class WebcamPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'webcam',
            name: 'Webcam',
            version: '1.0.2',
            description: 'Utilidades de cámara: listar cámaras, foto rápida y ajustes del sistema',
            author: 'BunDeck',
            permissions: ['process', 'filesystem'],
            settingsSchema: {
                type: 'object',
                properties: {
                    snapshotDir: {
                        type: 'string', title: 'Carpeta de fotos',
                        description: 'Dónde guardar las fotos rápidas (por defecto <datos>/snapshots)',
                        ui: { component: 'input', type: 'text', placeholder: '<datos>/snapshots' }
                    }
                }
            },
            instructions: 'Para usar la webcam:\n\n1. "Listar cámaras" muestra qué cámaras ve el sistema (no necesita nada instalado salvo los drivers).\n2. "Foto rápida" necesita ffmpeg instalado (ffmpeg.org) y guarda un JPG.\n3. "Abrir ajustes" lleva a los ajustes de cámara/privacidad del sistema.',
            actions: [
                {
                    id: 'list-cameras', name: 'Listar cámaras', icon: 'Camera',
                    description: 'Muestra las cámaras detectadas por el sistema',
                    schema: { type: 'object', properties: {}, required: [] }
                },
                {
                    id: 'snapshot', name: 'Foto rápida', icon: 'ImagePlus',
                    description: 'Captura un fotograma de la cámara (requiere ffmpeg)',
                    surface: 'control',
                    component: 'status-cards',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            device: { type: 'string', title: 'Dispositivo', description: 'Nombre/índice de la cámara (si se omite, la predeterminada)', ui: { component: 'input', type: 'text', placeholder: '(predeterminada)' } },
                            outputPath: { type: 'string', title: 'Guardar en', description: 'Ruta del JPG (si se omite, carpeta de fotos + fecha)', ui: { component: 'input', type: 'text', placeholder: '(automático)' } },
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'open-settings', name: 'Abrir ajustes de cámara', icon: 'Settings',
                    description: 'Abre los ajustes de cámara/privacidad del sistema',
                    schema: { type: 'object', properties: {}, required: [] }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('list-cameras', this.executeListCameras.bind(this))
        handlers.set('snapshot', this.executeSnapshot.bind(this))
        handlers.set('open-settings', this.executeOpenSettings.bind(this))
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

    private async executeListCameras(_params: any, _context: any): Promise<any> {
        const platform = process.platform
        this.context.log('info', 'Webcam: listando cámaras', { platform })
        try {
            if (platform === 'win32') {
                const { stdout, exitCode, stderr } = await runCmd([
                    'powershell.exe', '-NoProfile', '-Command',
                    "Get-PnpDevice -Class Camera,Image -Status OK -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FriendlyName",
                ])
                // Sin cámaras (o sin clase PnP de cámara en el equipo)
                // Get-PnpDevice sale con código != 0 y stderr vacío: es lista
                // vacía, no error. Solo se lanza si hay mensaje de error real.
                if (exitCode !== 0 && stderr.trim()) throw new Error(`PowerShell no pudo enumerar cámaras: ${stderr.trim()}`)
                const cameras = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
                return {
                    action: 'list-cameras', platform: 'windows', count: cameras.length,
                    cameras: cameras.map((name) => ({ name })),
                    note: cameras.length === 0 ? 'No se detectó ninguna cámara: conecta una y revisa Ajustes → Privacidad → Cámara.' : undefined,
                }
            }
            if (platform === 'darwin') {
                const { stdout, exitCode } = await runCmd(['system_profiler', 'SPCameraDataType'])
                if (exitCode !== 0) throw new Error('system_profiler no pudo leer las cámaras del sistema.')
                const cameras = [...stdout.matchAll(/^\s{6}(\S[^\n:]*):/gm)].map((m) => ({ name: m[1].trim() })).filter((c) => c.name.length > 0)
                return {
                    action: 'list-cameras', platform: 'macos', count: cameras.length, cameras,
                    note: cameras.length === 0 ? 'No se detectó ninguna cámara: conecta una y autoriza a la app en Ajustes → Privacidad → Cámara.' : undefined,
                }
            }
            if (platform === 'linux') {
                const { stdout, exitCode } = await runCmd(['sh', '-c', 'ls -1 /dev/video* 2>/dev/null || true'])
                if (exitCode !== 0) throw new Error('No se pudieron listar los dispositivos de vídeo.')
                const devices = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
                let names: Array<{ name: string }> = devices.map((d) => ({ name: d }))
                try {
                    const v4l = await runCmd(['v4l2-ctl', '--list-devices'])
                    if (v4l.exitCode === 0 && v4l.stdout.trim()) {
                        names = v4l.stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('/')).map((name) => ({ name }))
                    }
                } catch { /* v4l2-ctl opcional */ }
                return {
                    action: 'list-cameras', platform: 'linux', count: devices.length,
                    cameras: names.length > 0 ? names : devices.map((d) => ({ name: d })),
                    note: devices.length === 0 ? 'No se detectó /dev/video*: conecta una cámara (instala v4l-utils para ver nombres).' : undefined,
                }
            }
            throw new Error(`Listado de cámaras no soportado en la plataforma: ${platform}`)
        } catch (error) {
            this.context.log('error', `Webcam: no se pudieron listar cámaras: ${error}`)
            throw error
        }
    }

    private async executeSnapshot(params: any, _context: any): Promise<any> {
        const platform = process.platform
        const device = typeof params?.device === 'string' && params.device.trim() ? params.device.trim() : null
        // ffmpeg debe existir.
        try {
            const check = await runCmd(['ffmpeg', '-version'])
            if (check.exitCode !== 0) throw new Error('no disponible')
        } catch {
            throw new Error('La "Foto rápida" necesita ffmpeg instalado (https://ffmpeg.org/download.html) y visible en el PATH. Instálalo y reintenta.')
        }
        let snapshotDir = typeof params?.outputPath === 'string' && params.outputPath.trim() ? null : (this.setting('snapshotDir') ?? null)
        if (!snapshotDir) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getDataDir } = require('../paths')
                snapshotDir = `${getDataDir()}/snapshots`
            } catch {
                snapshotDir = params?.outputPath ? undefined as any : 'snapshots'
            }
        }
        const { mkdir } = await import('node:fs/promises')
        const { join } = await import('node:path')
        let outputPath = typeof params?.outputPath === 'string' && params.outputPath.trim() ? params.outputPath.trim() : null
        if (!outputPath) {
            try { await mkdir(snapshotDir as string, { recursive: true }) } catch { /* se verá en ffmpeg */ }
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            outputPath = join(snapshotDir as string, `webcam-${stamp}.jpg`)
        }
        let input: string[]
        if (platform === 'win32') {
            input = device ? ['-f', 'dshow', '-i', `video=${device}`] : ['-f', 'dshow', '-i', 'video=0']
        } else if (platform === 'darwin') {
            input = ['-f', 'avfoundation', '-i', device ?? '0']
        } else if (platform === 'linux') {
            input = ['-f', 'v4l2', '-i', device ?? '/dev/video0']
        } else {
            throw new Error(`Foto rápida no soportada en la plataforma: ${platform}`)
        }
        this.context.log('info', `Webcam: capturando foto en ${outputPath}`, { device })
        const { exitCode, stderr } = await runCmd(['ffmpeg', '-y', ...input, '-frames:v', '1', outputPath])
        if (exitCode !== 0) {
            throw new Error(`ffmpeg no pudo capturar la cámara${device ? ` "${device}"` : ''}: ${stderr.trim().slice(-300) || `código ${exitCode}`}. Revisa el nombre del dispositivo (acción "Listar cámaras") y que ninguna app la esté usando.`)
        }
        return { action: 'snapshot', device, outputPath, saved: true }
    }

    private async executeOpenSettings(_params: any, _context: any): Promise<any> {
        const platform = process.platform
        this.context.log('info', 'Webcam: abriendo ajustes de cámara')
        try {
            if (platform === 'win32') {
                const proc = Bun.spawn({ windowsHide: true,  cmd: ['cmd', '/c', 'start', '""', 'ms-settings:privacy-webcam'], stdio: ['ignore', 'pipe', 'pipe'] })
                await proc.exited
                return { action: 'open-settings', opened: true, target: 'ms-settings:privacy-webcam' }
            }
            if (platform === 'darwin') {
                const proc = Bun.spawn({ windowsHide: true,  cmd: ['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'], stdio: ['ignore', 'pipe', 'pipe'] })
                await proc.exited
                return { action: 'open-settings', opened: true, target: 'Privacidad → Cámara' }
            }
            if (platform === 'linux') {
                for (const app of [['guvcview'], ['cheese']]) {
                    try {
                        const proc = Bun.spawn({ windowsHide: true,  cmd: [...app], stdio: ['ignore', 'pipe', 'pipe'] })
                        await proc.exited
                        if (proc.exitCode === 0) return { action: 'open-settings', opened: true, target: app[0] }
                    } catch { /* prueba el siguiente */ }
                }
                throw new Error('No se encontró guvcview ni cheese: instálalos (sudo apt install guvcview) o usa la configuración de tu escritorio.')
            }
            throw new Error(`Apertura de ajustes no soportada en la plataforma: ${platform}`)
        } catch (error) {
            this.context.log('error', `Webcam: no se pudieron abrir los ajustes: ${error}`)
            throw error
        }
    }

    public dispose(): void {
        // Sin estado persistente.
    }
}
