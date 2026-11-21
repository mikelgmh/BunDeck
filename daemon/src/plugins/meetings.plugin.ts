/**
 * Native Meetings Plugin
 * Control unificado de Zoom / Teams / Meet mediante hotkeys configurables + apertura de URLs.
 * Los hotkeys se envían a la app activa (PowerShell SendKeys / xdotool / osascript).
 */

import { runCommand, openUrl } from './sysrun'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
    deleteSetting?: (key: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

export type MeetingApp = 'zoom' | 'teams' | 'meet'
export type MeetingCommand = 'mute' | 'unmute' | 'camera' | 'share' | 'leave' | 'join' | 'chat' | 'record' | 'hand'

/** Presets de hotkeys por app (formato "Ctrl+Shift+M"). Vacío = la app no tiene atajo. */
export const MEETING_PRESETS: Record<MeetingApp, Partial<Record<MeetingCommand, string>>> = {
    zoom: {
        mute: 'Alt+A',
        unmute: 'Alt+A',
        camera: 'Alt+V',
        share: 'Alt+S',
        leave: 'Alt+Q',
        chat: 'Alt+H',
        record: 'Alt+R',
        hand: 'Alt+Y',
    },
    teams: {
        mute: 'Ctrl+Shift+M',
        unmute: 'Ctrl+Shift+M',
        camera: 'Ctrl+Shift+O',
        share: 'Ctrl+Shift+E',
        leave: 'Ctrl+Shift+B',
        chat: 'Ctrl+2',
        hand: 'Ctrl+Shift+K',
    },
    meet: {
        // Google Meet (navegador): sin atajo para salir/compartir por defecto
        mute: 'Ctrl+D',
        unmute: 'Ctrl+D',
        camera: 'Ctrl+E',
        chat: 'Ctrl+Alt+C',
    },
}

const APPS: MeetingApp[] = ['zoom', 'teams', 'meet']
const COMMANDS: MeetingCommand[] = ['mute', 'unmute', 'camera', 'share', 'leave', 'join', 'chat', 'record', 'hand']

/**
 * Resuelve el hotkey para (app, command): explícito > ajuste guardado > preset.
 * Función pura (testeable sin ejecutar nada).
 */
export function resolveMeetingHotkey(
    app: string,
    command: string,
    opts: { explicit?: string; getSetting?: (key: string) => string | null } = {}
): string {
    const a = String(app ?? '').toLowerCase()
    const c = String(command ?? '').toLowerCase()
    if (!APPS.includes(a as MeetingApp)) {
        throw new Error(`App no válida: "${app}". Usa una de: ${APPS.join(', ')}.`)
    }
    if (!COMMANDS.includes(c as MeetingCommand)) {
        throw new Error(`Comando no válido: "${command}". Usa uno de: ${COMMANDS.join(', ')}.`)
    }
    if (typeof opts.explicit === 'string' && opts.explicit.trim().length > 0) {
        return opts.explicit.trim()
    }
    try {
        const saved = opts.getSetting?.(`hotkey.${a}.${c}`)
        if (typeof saved === 'string' && saved.trim().length > 0) return saved.trim()
    } catch { /* sin ajustes: preset */ }
    const preset = MEETING_PRESETS[a as MeetingApp][c as MeetingCommand]
    if (!preset) {
        throw new Error(`"${a}" no tiene atajo para "${c}": indica "hotkey" explícito (ej. "Ctrl+Shift+M") o guárdalo en los ajustes del plugin.`)
    }
    return preset
}

/** "Ctrl+Shift+M" -> { key: 'm', modifiers: ['ctrl','shift'] } */
export function parseCombo(combo: string): { key: string; modifiers: string[] } {
    const parts = String(combo).split('+').map(p => p.trim()).filter(Boolean)
    if (parts.length === 0) throw new Error(`Hotkey vacío: indica algo como "Ctrl+Shift+M".`)
    const key = parts[parts.length - 1]
    const modifiers = parts.slice(0, -1).map(m => m.toLowerCase())
    const known = ['ctrl', 'control', 'alt', 'shift', 'meta', 'win', 'cmd', 'command', 'option', 'super']
    for (const m of modifiers) {
        if (!known.includes(m)) throw new Error(`Modificador desconocido: "${m}" (usa ctrl, alt, shift, meta/win/cmd).`)
    }
    if (!key) throw new Error(`Hotkey inválido: "${combo}".`)
    return { key, modifiers }
}

export class MeetingsPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    /** Punto de inyección para tests (envío real de hotkeys). */
    protected async sendHotkey(key: string, modifiers: string[]): Promise<any> {
        const platform = process.platform
        if (platform === 'win32') return this.winSend(key, modifiers)
        if (platform === 'darwin') return this.macSend(key, modifiers)
        return this.linuxSend(key, modifiers)
    }

    /** Punto de inyección para tests (apertura real de URL). */
    protected async open(target: string): Promise<void> {
        return openUrl(target)
    }

    public getManifest() {
        return {
            id: 'meetings',
            name: 'Reuniones',
            version: '1.0.0',
            description: 'Controla Zoom, Teams y Meet: micro, cámara, compartir, salir y unirse',
            author: 'BunDeck',
            permissions: ['keyboard', 'system', 'network'],
            instructions:
                'Controla tu app de reuniones con hotkeys.\n\n' +
                '1. Lleva la ventana de la reunión al frente (el hotkey se envía a la app activa).\n' +
                '2. Usa "Control de reunión" con app (zoom/teams/meet) y comando (mute, camera, share, leave…).\n' +
                '3. Si un comando no tiene preset, indica "hotkey" explícito o guárdalo como ajuste hotkey.<app>.<comando>.\n' +
                '4. "Unirse a reunión" abre la URL de invitación en el navegador/app.',
            actions: [
                {
                    id: 'control',
                    name: 'Control de reunión',
                    description: 'Envía un hotkey a Zoom/Teams/Meet (micro, cámara, compartir, salir…)',
                    icon: 'Video',
                    schema: {
                        type: 'object',
                        properties: {
                            app: {
                                type: 'string',
                                title: 'Aplicación',
                                enum: ['zoom', 'teams', 'meet'],
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'zoom', label: 'Zoom' },
                                        { value: 'teams', label: 'Microsoft Teams' },
                                        { value: 'meet', label: 'Google Meet' },
                                    ]
                                }
                            },
                            command: {
                                type: 'string',
                                title: 'Comando',
                                enum: ['mute', 'unmute', 'camera', 'share', 'leave', 'join', 'chat', 'record', 'hand'],
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'mute', label: 'Silenciar micro' },
                                        { value: 'unmute', label: 'Reactivar micro' },
                                        { value: 'camera', label: 'Cámara on/off' },
                                        { value: 'share', label: 'Compartir pantalla' },
                                        { value: 'leave', label: 'Salir de la reunión' },
                                        { value: 'join', label: 'Unirse (abre URL si se indica)' },
                                        { value: 'chat', label: 'Abrir chat' },
                                        { value: 'record', label: 'Grabar' },
                                        { value: 'hand', label: 'Levantar mano' },
                                    ]
                                }
                            },
                            hotkey: {
                                type: 'string',
                                title: 'Hotkey personalizado',
                                description: 'Si se indica, tiene prioridad sobre el preset (ej. "Ctrl+Shift+M")',
                                ui: { component: 'input', type: 'text', placeholder: 'Ctrl+Shift+M' }
                            },
                            url: {
                                type: 'string',
                                title: 'URL de invitación',
                                description: 'Solo para "join": se abre antes de enviar el hotkey',
                                ui: { component: 'input', type: 'text', placeholder: 'https://…' }
                            }
                        },
                        required: ['app', 'command']
                    }
                },
                {
                    id: 'join',
                    name: 'Unirse a reunión',
                    description: 'Abre la URL de invitación en el navegador o la app',
                    icon: 'PhoneIncoming',
                    schema: {
                        type: 'object',
                        properties: {
                            url: {
                                type: 'string',
                                title: 'URL de invitación',
                                ui: { component: 'input', type: 'text', placeholder: 'https://zoom.us/j/… / https://teams.microsoft.com/… / https://meet.google.com/…' }
                            },
                            app: {
                                type: 'string',
                                title: 'Aplicación',
                                description: 'Solo informativo (para el registro)',
                                enum: ['zoom', 'teams', 'meet'],
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'zoom', label: 'Zoom' },
                                        { value: 'teams', label: 'Microsoft Teams' },
                                        { value: 'meet', label: 'Google Meet' },
                                    ]
                                }
                            }
                        },
                        required: ['url']
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('control', this.executeControl.bind(this))
        handlers.set('join', this.executeJoin.bind(this))
        return handlers
    }

    private async executeControl(params: any, _context: any): Promise<any> {
        const { app, command, hotkey, url } = params ?? {}
        const combo = resolveMeetingHotkey(app, command, { explicit: hotkey, getSetting: this.context.getSetting })
        this.context.log('info', `Reunión: ${app} -> ${command} (${combo})`)
        if (typeof url === 'string' && url.length > 0) {
            await this.open(url)
            // Dar tiempo a que la app tome el foco antes del hotkey
            await new Promise(r => setTimeout(r, 1500))
        }
        const { key, modifiers } = parseCombo(combo)
        const sent = await this.sendHotkey(key, modifiers)
        return { app, command, hotkey: combo, sent: true, detail: sent ?? null }
    }

    private async executeJoin(params: any, _context: any): Promise<any> {
        const { url, app } = params ?? {}
        if (typeof url !== 'string' || url.trim().length === 0) {
            throw new Error('Indica la "url" de invitación (enlace de Zoom, Teams o Meet).')
        }
        this.context.log('info', `Reunión: unirse ${app ?? ''} ${url}`)
        await this.open(url.trim())
        return { app: app ?? null, url: url.trim(), opened: true }
    }

    // ---------- envío por plataforma ----------

    private async winSend(key: string, modifiers: string[]): Promise<any> {
        const keyMap: Record<string, string> = {
            enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}',
            space: ' ', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
            home: '{HOME}', end: '{END}', delete: '{DELETE}', del: '{DELETE}', backspace: '{BACKSPACE}',
        }
        if (modifiers.includes('meta') || modifiers.includes('win') || modifiers.includes('cmd') || modifiers.includes('command') || modifiers.includes('super')) {
            throw new Error('La tecla Windows no está soportada con SendKeys: usa otro atajo o configura uno sin Win.')
        }
        let seq = ''
        if (modifiers.includes('ctrl') || modifiers.includes('control')) seq += '^'
        if (modifiers.includes('alt') || modifiers.includes('option')) seq += '%'
        if (modifiers.includes('shift')) seq += '+'
        const lower = key.toLowerCase()
        seq += keyMap[lower] ?? (key.length === 1 ? key.toUpperCase() : key)
        const escaped = seq.replace(/'/g, "''")
        const r = await runCommand(['powershell.exe', '-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).SendKeys('${escaped}')`])
        if (r.exitCode !== 0) throw new Error(`No se pudo enviar el hotkey.${r.stderr.trim() ? ` Detalle: ${r.stderr.trim().slice(0, 200)}` : ''}`)
        return { platform: 'windows', method: 'powershell-sendkeys', keySequence: seq }
    }

    private async macSend(key: string, modifiers: string[]): Promise<any> {
        const flags: string[] = []
        if (modifiers.includes('ctrl') || modifiers.includes('control')) flags.push('control down')
        if (modifiers.includes('alt') || modifiers.includes('option')) flags.push('option down')
        if (modifiers.includes('shift')) flags.push('shift down')
        if (modifiers.includes('cmd') || modifiers.includes('command') || modifiers.includes('meta')) flags.push('command down')
        const using = flags.length > 0 ? ` using {${flags.join(', ')}}` : ''
        const safe = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        const script = `tell application "System Events" to keystroke "${safe.length === 1 ? safe.toLowerCase() : safe}"${using}`
        const r = await runCommand(['osascript', '-e', script])
        if (r.exitCode !== 0) throw new Error(`No se pudo enviar el hotkey (¿permiso de Accesibilidad?).${r.stderr.trim() ? ` Detalle: ${r.stderr.trim().slice(0, 200)}` : ''}`)
        return { platform: 'macos', method: 'osascript-keystroke' }
    }

    private async linuxSend(key: string, modifiers: string[]): Promise<any> {
        const norm = modifiers.map(m => ({ ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super', win: 'super', super: 'super', cmd: 'super', command: 'super', option: 'alt' } as Record<string, string>)[m] ?? m)
        const keyMap: Record<string, string> = { return: 'Return', enter: 'Return', escape: 'Escape', esc: 'Escape', space: 'space', backspace: 'BackSpace', delete: 'Delete', del: 'Delete', tab: 'Tab' }
        const mapped = keyMap[key.toLowerCase()] ?? key
        const combo = [...norm, mapped].join('+')
        try {
            const r = await runCommand(['xdotool', 'key', combo])
            if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `xdotool devolvió código ${r.exitCode}`)
            return { platform: 'linux', method: 'xdotool', keyCombo: combo }
        } catch (error) {
            throw new Error(`No se pudo enviar el hotkey: instala xdotool (ej. "sudo apt install xdotool"). Detalle: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    public dispose(): void {
        // Sin recursos persistentes
    }
}
