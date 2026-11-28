/**
 * Native VoiceMeeter Plugin
 * Controla VoiceMeeter (VB-Audio) en Windows.
 *
 * VoiceMeeter no expone una API REST pública: la integración real se hace
 * mediante los atajos de teclado de "Macro Buttons" (que actúan sobre
 * strips/buses) + detección de instalación. Sin dependencias externas.
 * Solo funciona en Windows, donde vive VoiceMeeter.
 */

import { existsSync } from 'node:fs'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const VOICEMEETER_PATHS = [
    'C:\\Program Files (x86)\\VB\\Voicemeeter\\voicemeeter8x64.exe',
    'C:\\Program Files (x86)\\VB\\Voicemeeter\\voicemeeter8.exe',
    'C:\\Program Files\\VB\\Voicemeeter\\voicemeeter8x64.exe',
]

function findVoicemeeter(): string | null {
    for (const p of VOICEMEETER_PATHS) {
        try {
            if (existsSync(p)) return p
        } catch { /* sigue */ }
    }
    return null
}

async function runCmd(cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn({ windowsHide: true,  cmd, stdio: ['ignore', 'pipe', 'pipe'] })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    return { stdout, stderr, exitCode: proc.exitCode ?? -1 }
}

async function sendHotkeyWindows(hotkey: string): Promise<void> {
    // Reutiliza la técnica de keybd_event (igual que el plugin de Discord).
    const MODS: Record<string, number> = { ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b, win: 0x5b, super: 0x5b, cmd: 0x5b, command: 0x5b }
    const parts = hotkey.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean)
    if (parts.length === 0) throw new Error('El atajo está vacío.')
    const downs: number[] = []
    let key = ''
    for (const p of parts) {
        if (MODS[p] !== undefined) { if (!downs.includes(MODS[p])) downs.push(MODS[p]) } else key = p
    }
    if (!key) throw new Error(`El atajo "${hotkey}" no incluye tecla principal (formato "ctrl+alt+f13", por ejemplo).`)
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

export class VoicemeeterPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'voicemeeter',
            name: 'VoiceMeeter',
            version: '1.0.1',
            description: 'Controla VoiceMeeter (mute de strips/buses) vía Macro Buttons + atajos — solo Windows',
            author: 'BunDeck',
            permissions: ['keyboard', 'process', 'filesystem'],
            settingsSchema: {
                type: 'object',
                properties: {
                    muteHotkey: {
                        type: 'string', title: 'Atajo de mute principal',
                        description: 'Atajo asignado en Macro Buttons para mutear tu micro (ej. "ctrl+alt+f13")',
                        ui: { component: 'input', type: 'text', placeholder: 'ctrl+alt+f13' }
                    }
                }
            },
            instructions: 'VoiceMeeter no tiene API local pública, así que se controla con Macro Buttons:\n\n1. Abre VoiceMeeter → Macro Buttons, crea un botón con la acción (ej. Strip[0].Mute = 1) y asígnale un atajo de teclado.\n2. Pon ese mismo atajo en los ajustes de este plugin o en cada botón.\n3. Solo funciona en Windows con VoiceMeeter instalado. Usa "Estado" para comprobar la instalación.',
            actions: [
                {
                    id: 'device-info', name: 'Estado de VoiceMeeter', icon: 'Activity',
                    description: 'Comprueba si VoiceMeeter está instalado (y en ejecución)',
                    i18n: { es: { name: 'Estado de VoiceMeeter', description: 'Comprueba si VoiceMeeter está instalado (y en ejecución)' }, en: { name: 'Estado de VoiceMeeter', description: 'Comprueba si VoiceMeeter está instalado (y en ejecución)' } }, // TODO i18n: EN temporal = ES
                    schema: { type: 'object', properties: {}, required: [] }
                },
                {
                    id: 'strip-mute', name: 'Mutear strip (micro/línea)', icon: 'MicOff',
                    description: 'Envía el atajo de Macro Buttons que mutea un strip',
                    i18n: { es: { name: 'Mutear strip (micro/línea)', description: 'Envía el atajo de Macro Buttons que mutea un strip' }, en: { name: 'Mutear strip (micro/línea)', description: 'Envía el atajo de Macro Buttons que mutea un strip' } }, // TODO i18n: EN temporal = ES
                    surface: 'control',
                    component: 'voice-panel',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: { type: 'string', title: 'Atajo', description: 'Atajo asignado en Macro Buttons (si se omite usa el de los ajustes)', ui: { component: 'input', type: 'text', placeholder: 'ctrl+alt+f13' } },
                            strip: { type: 'number', title: 'Strip', description: 'Solo informativo: qué strip controla ese botón de Macro Buttons', minimum: 0, maximum: 7, ui: { component: 'input', type: 'number', placeholder: '0' } },
                            carouselMs: {
                                type: 'number', title: 'Carrusel (ms)',
                                description: 'En teclas pequeñas rota los controles de voz cada N ms (>0; ausente = 4000; <=0 = desactivado).',
                                minimum: 0,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'bus-mute', name: 'Mutear bus (salida A/B)', icon: 'VolumeX',
                    description: 'Envía el atajo de Macro Buttons que mutea un bus de salida',
                    i18n: { es: { name: 'Mutear bus (salida A/B)', description: 'Envía el atajo de Macro Buttons que mutea un bus de salida' }, en: { name: 'Mutear bus (salida A/B)', description: 'Envía el atajo de Macro Buttons que mutea un bus de salida' } }, // TODO i18n: EN temporal = ES
                    surface: 'control',
                    component: 'voice-panel',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: { type: 'string', title: 'Atajo', description: 'Atajo asignado en Macro Buttons', ui: { component: 'input', type: 'text', placeholder: 'ctrl+alt+f14' } },
                            bus: { type: 'string', title: 'Bus', description: 'Solo informativo (A1, A2, B1, B2…)', ui: { component: 'input', type: 'text', placeholder: 'A1' } },
                            carouselMs: {
                                type: 'number', title: 'Carrusel (ms)',
                                description: 'En teclas pequeñas rota los controles de voz cada N ms (>0; ausente = 4000; <=0 = desactivado).',
                                minimum: 0,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: ['hotkey']
                    }
                },
                {
                    id: 'open-voicemeeter', name: 'Abrir VoiceMeeter', icon: 'AppWindow',
                    description: 'Abre la ventana de VoiceMeeter',
                    i18n: { es: { name: 'Abrir VoiceMeeter', description: 'Abre la ventana de VoiceMeeter' }, en: { name: 'Abrir VoiceMeeter', description: 'Abre la ventana de VoiceMeeter' } }, // TODO i18n: EN temporal = ES
                    schema: { type: 'object', properties: {}, required: [] }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('device-info', this.executeDeviceInfo.bind(this))
        handlers.set('strip-mute', this.executeStripMute.bind(this))
        handlers.set('bus-mute', this.executeBusMute.bind(this))
        handlers.set('open-voicemeeter', this.executeOpen.bind(this))
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
            throw new Error(`VoiceMeeter solo existe en Windows (estás en ${process.platform}). Esta acción no puede ejecutarse aquí.`)
        }
    }

    private async executeDeviceInfo(_params: any, _context: any): Promise<any> {
        this.requireWindows()
        const exe = findVoicemeeter()
        if (!exe) {
            throw new Error('VoiceMeeter no está instalado (no se encontró en C:\\Program Files (x86)\\VB\\Voicemeeter\\). Descárgalo gratis en vb-audio.com e instálalo.')
        }
        let running = false
        try {
            const { stdout, exitCode } = await runCmd(['tasklist', '/FI', 'IMAGENAME eq voicemeeter*', '/FO', 'CSV', '/NH'])
            running = exitCode === 0 && /voicemeeter/i.test(stdout)
        } catch { /* tasklist falló: no sabemos */ }
        return {
            action: 'device-info',
            installed: true,
            path: exe,
            running,
            note: running ? 'VoiceMeeter está instalado y en ejecución.' : 'VoiceMeeter está instalado pero no parece en ejecución: ábrelo con la acción "Abrir VoiceMeeter".',
        }
    }

    private async executeStripMute(params: any, _context: any): Promise<any> {
        this.requireWindows()
        const exe = findVoicemeeter()
        if (!exe) throw new Error('VoiceMeeter no está instalado (mira la acción "Estado de VoiceMeeter").')
        const hotkey = (typeof params?.hotkey === 'string' && params.hotkey.trim() ? params.hotkey.trim() : null) ?? this.setting('muteHotkey')
        if (!hotkey) {
            throw new Error('Falta el atajo: crea un botón en Macro Buttons con la acción de mute del strip, asígnale un atajo y ponlo en el parámetro "hotkey" (o en los ajustes del plugin).')
        }
        const strip = typeof params?.strip === 'number' ? params.strip : null
        this.context.log('info', `VoiceMeeter: mute strip${strip ?? '?'} vía atajo "${hotkey}"`)
        await sendHotkeyWindows(hotkey)
        return { action: 'strip-mute', hotkey, strip, sent: true, note: 'El mute lo ejecuta tu botón de Macro Buttons; este plugin solo envía el atajo.' }
    }

    private async executeBusMute(params: any, _context: any): Promise<any> {
        this.requireWindows()
        const exe = findVoicemeeter()
        if (!exe) throw new Error('VoiceMeeter no está instalado (mira la acción "Estado de VoiceMeeter").')
        const hotkey = typeof params?.hotkey === 'string' ? params.hotkey.trim() : ''
        if (!hotkey) throw new Error('La acción "Mutear bus" requiere el parámetro "hotkey" (el atajo asignado en Macro Buttons).')
        const bus = typeof params?.bus === 'string' && params.bus.trim() ? params.bus.trim() : null
        this.context.log('info', `VoiceMeeter: mute bus ${bus ?? '?'} vía atajo "${hotkey}"`)
        await sendHotkeyWindows(hotkey)
        return { action: 'bus-mute', hotkey, bus, sent: true }
    }

    private async executeOpen(_params: any, _context: any): Promise<any> {
        this.requireWindows()
        const exe = findVoicemeeter()
        if (!exe) throw new Error('VoiceMeeter no está instalado (descárgalo en vb-audio.com).')
        this.context.log('info', `VoiceMeeter: abriendo ${exe}`)
        const proc = Bun.spawn({ windowsHide: true,  cmd: ['cmd', '/c', 'start', '""', exe], stdio: ['ignore', 'pipe', 'pipe'] })
        await proc.exited
        return { action: 'open-voicemeeter', path: exe, opened: true }
    }

    public dispose(): void {
        // Sin estado persistente.
    }
}
