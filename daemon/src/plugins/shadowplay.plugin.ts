/**
 * Native ShadowPlay Plugin (NVIDIA Share / GeForce Experience overlay)
 * Guarda la repetición instantánea y controla la grabación mediante los
 * atajos globales de NVIDIA (Alt+F9, Alt+F10…). Sin dependencias externas.
 * Solo tiene sentido en Windows con GPU NVIDIA.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

async function sendHotkeyWindows(hotkey: string): Promise<void> {
    const MODS: Record<string, number> = { ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b, win: 0x5b, super: 0x5b, cmd: 0x5b, command: 0x5b }
    const parts = hotkey.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean)
    if (parts.length === 0) throw new Error('El atajo está vacío.')
    const downs: number[] = []
    let key = ''
    for (const p of parts) {
        if (MODS[p] !== undefined) { if (!downs.includes(MODS[p])) downs.push(MODS[p]) } else key = p
    }
    if (!key) throw new Error(`El atajo "${hotkey}" no incluye tecla principal (formato "alt+f10").`)
    const vkOf = (k: string): number => {
        if (/^[a-z]$/.test(k)) return 0x41 + (k.charCodeAt(0) - 97)
        if (/^[0-9]$/.test(k)) return 0x30 + Number(k)
        const m = k.match(/^f([1-9]|1[0-9]|2[0-4])$/)
        if (m) return 0x6f + Number(m[1])
        const extra: Record<string, number> = { space: 0x20, enter: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b }
        if (extra[k] !== undefined) return extra[k]
        throw new Error(`Tecla no soportada: "${k}". Usa letras, dígitos o F1–F24.`)
    }
    const vk = vkOf(key)
    const press = (v: number, up: boolean) => `[K]::keybd_event(${v}, 0, ${up ? '2' : '0'}, [UIntPtr]::Zero)`
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo); }'; ` +
        [...downs.map((v) => press(v, false)), press(vk, false), press(vk, true), ...downs.reverse().map((v) => press(v, true))].join('; ')
    const proc = Bun.spawn({ windowsHide: true,  cmd: ['powershell.exe', '-NoProfile', '-Command', script], stdio: ['ignore', 'pipe', 'pipe'] })
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    if (proc.exitCode !== 0) throw new Error(`No se pudo enviar el atajo "${hotkey}": ${stderr.trim() || `código ${proc.exitCode}`}`)
}

async function nvidiaShareRunning(): Promise<boolean> {
    try {
        const proc = Bun.spawn({ windowsHide: true,  cmd: ['tasklist', '/FI', 'IMAGENAME eq NVIDIA Share.exe', '/FO', 'CSV', '/NH'], stdio: ['ignore', 'pipe', 'pipe'] })
        const out = await new Response(proc.stdout).text()
        await proc.exited
        return proc.exitCode === 0 && /nvidia share/i.test(out)
    } catch {
        return false
    }
}

export class ShadowplayPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'shadowplay',
            name: 'ShadowPlay (NVIDIA)',
            version: '1.0.1',
            description: 'Guarda la repetición instantánea y controla la grabación de NVIDIA Share con sus atajos',
            author: 'BunDeck',
            permissions: ['keyboard', 'process'],
            settingsSchema: {
                type: 'object',
                properties: {
                    replayHotkey: {
                        type: 'string', title: 'Atajo de guardar repetición',
                        description: 'Atajo de "Guardar repetición instantánea" en GeForce Experience/NVIDIA App',
                        default: 'alt+f10',
                        ui: { component: 'input', type: 'text', placeholder: 'alt+f10' }
                    },
                    recordHotkey: {
                        type: 'string', title: 'Atajo de grabar',
                        description: 'Atajo de "Iniciar/detener grabación"',
                        default: 'alt+f9',
                        ui: { component: 'input', type: 'text', placeholder: 'alt+f9' }
                    },
                    overlayHotkey: {
                        type: 'string', title: 'Atajo del overlay',
                        description: 'Atajo para abrir el overlay (Alt+Z por defecto)',
                        default: 'alt+z',
                        ui: { component: 'input', type: 'text', placeholder: 'alt+z' }
                    }
                }
            },
            instructions: 'Para usar ShadowPlay:\n\n1. Abre NVIDIA App/GeForce Experience → Ajustes → Superposición dentro del juego (activada) y repetición instantánea (activada).\n2. Comprueba los atajos en Ajustes → Atajos de teclado (por defecto Alt+F9 grabar, Alt+F10 guardar repetición, Alt+Z overlay).\n3. Copia esos atajos en los ajustes de este plugin. Solo funciona en Windows con GPU NVIDIA y NVIDIA Share en ejecución.',
            actions: [
                {
                    id: 'instant-replay-save', name: 'Guardar repetición', icon: 'History',
                    description: 'Guarda los últimos minutos (repetición instantánea)',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: { type: 'string', title: 'Atajo', description: 'Si se omite usa el de los ajustes', ui: { component: 'input', type: 'text', placeholder: 'alt+f10' } }
                        },
                        required: []
                    }
                },
                {
                    id: 'toggle-record', name: 'Iniciar / detener grabación', icon: 'CircleDot',
                    description: 'Alterna la grabación de NVIDIA Share',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: { type: 'string', title: 'Atajo', description: 'Si se omite usa el de los ajustes', ui: { component: 'input', type: 'text', placeholder: 'alt+f9' } }
                        },
                        required: []
                    }
                },
                {
                    id: 'toggle-overlay', name: 'Abrir overlay', icon: 'Layers',
                    description: 'Abre el overlay de NVIDIA Share',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: { type: 'string', title: 'Atajo', description: 'Si se omite usa el de los ajustes', ui: { component: 'input', type: 'text', placeholder: 'alt+z' } }
                        },
                        required: []
                    }
                },
                {
                    id: 'check-status', name: 'Comprobar NVIDIA Share', icon: 'Activity',
                    description: 'Comprueba si NVIDIA Share está en ejecución',
                    surface: 'control',
                    component: 'stream-studio',
                    schema: { type: 'object', properties: {}, required: [] }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('instant-replay-save', this.executeReplaySave.bind(this))
        handlers.set('toggle-record', this.executeToggleRecord.bind(this))
        handlers.set('toggle-overlay', this.executeToggleOverlay.bind(this))
        handlers.set('check-status', this.executeCheckStatus.bind(this))
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

    private requireWindows(): void {
        if (process.platform !== 'win32') {
            throw new Error(`ShadowPlay (NVIDIA Share) solo existe en Windows con GPU NVIDIA (estás en ${process.platform}). En este equipo la acción no puede ejecutarse.`)
        }
    }

    private hotkey(params: any, settingKey: string, fallback: string): string {
        return (typeof params?.hotkey === 'string' && params.hotkey.trim() ? params.hotkey.trim() : null) ?? this.setting(settingKey) ?? fallback
    }

    private async press(label: string, hotkey: string): Promise<any> {
        this.requireWindows()
        this.context.log('info', `ShadowPlay: ${label} con atajo "${hotkey}"`)
        const running = await nvidiaShareRunning()
        if (!running) {
            throw new Error('NVIDIA Share no parece en ejecución: abre NVIDIA App/GeForce Experience, activa la "Superposición dentro del juego" y reintenta.')
        }
        await sendHotkeyWindows(hotkey)
        return { sent: true, hotkey }
    }

    private async executeReplaySave(params: any, _context: any): Promise<any> {
        try {
            const res = await this.press('guardar repetición', this.hotkey(params, 'replayHotkey', 'alt+f10'))
            return { action: 'instant-replay-save', ...res }
        } catch (error) {
            this.context.log('error', `ShadowPlay: no se pudo guardar la repetición: ${error}`)
            throw error
        }
    }

    private async executeToggleRecord(params: any, _context: any): Promise<any> {
        try {
            const res = await this.press('alternar grabación', this.hotkey(params, 'recordHotkey', 'alt+f9'))
            return { action: 'toggle-record', ...res }
        } catch (error) {
            this.context.log('error', `ShadowPlay: no se pudo alternar la grabación: ${error}`)
            throw error
        }
    }

    private async executeToggleOverlay(params: any, _context: any): Promise<any> {
        try {
            const res = await this.press('abrir overlay', this.hotkey(params, 'overlayHotkey', 'alt+z'))
            return { action: 'toggle-overlay', ...res }
        } catch (error) {
            this.context.log('error', `ShadowPlay: no se pudo abrir el overlay: ${error}`)
            throw error
        }
    }

    private async executeCheckStatus(_params: any, _context: any): Promise<any> {
        this.requireWindows()
        const running = await nvidiaShareRunning()
        return {
            action: 'check-status',
            running,
            note: running
                ? 'NVIDIA Share está en ejecución: los atajos deberían funcionar.'
                : 'NVIDIA Share no parece en ejecución: abre NVIDIA App/GeForce Experience y activa la superposición dentro del juego.',
        }
    }

    public dispose(): void {
        // Sin estado persistente.
    }
}
