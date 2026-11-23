/**
 * Native Blender Plugin
 * Controla Blender mediante atajos de teclado configurables:
 * operaciones de vista (viewport), render y guardado.
 * Sin dependencias nuevas.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const WIN_KEY_MAP: Record<string, string> = {
    'enter': '{ENTER}', 'return': '{ENTER}', 'tab': '{TAB}',
    'backspace': '{BACKSPACE}', 'delete': '{DELETE}', 'del': '{DELETE}',
    'escape': '{ESC}', 'esc': '{ESC}', 'space': ' ',
    'up': '{UP}', 'down': '{DOWN}', 'left': '{LEFT}', 'right': '{RIGHT}',
    'home': '{HOME}', 'end': '{END}', 'pageup': '{PGUP}', 'pagedown': '{PGDN}',
    'insert': '{INSERT}',
    'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}',
    'f5': '{F5}', 'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}',
    'f9': '{F9}', 'f10': '{F10}', 'f11': '{F11}', 'f12': '{F12}',
}

const MAC_KEY_CODES: Record<string, number> = {
    'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5, 'h': 4,
    'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46, 'n': 45, 'o': 31,
    'p': 35, 'q': 12, 'r': 15, 's': 1, 't': 17, 'u': 32, 'v': 9,
    'w': 13, 'x': 7, 'y': 16, 'z': 6,
    '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23,
    '6': 22, '7': 26, '8': 28, '9': 25,
    'return': 36, 'enter': 36, 'tab': 48, 'space': 49,
    'delete': 51, 'backspace': 51, 'escape': 53, 'esc': 53,
    'up': 126, 'down': 125, 'left': 123, 'right': 124,
    'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97,
    'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
    'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
}

function parseCombo(hotkey: string): { key: string; modifiers: string[] } {
    const parts = String(hotkey ?? '').split('+').map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (parts.length === 0) throw new Error('Hotkey vacío: indica una combinación como "f12"')
    return { key: parts[parts.length - 1], modifiers: parts.slice(0, -1) }
}

/** Presets de vista (teclado numérico de Blender). */
export const BLENDER_VIEWPORT: Record<string, string> = {
    'front': 'numpad1',
    'back': 'ctrl+numpad1',
    'top': 'numpad7',
    'bottom': 'ctrl+numpad7',
    'right': 'numpad3',
    'left': 'ctrl+numpad3',
    'camera': 'numpad0',
    'toggle-perspective': 'numpad5',
    'frame-all': 'home',
    'shade-solid': 'z',
}

/** Presets de render. */
export const BLENDER_RENDER: Record<string, string> = {
    'render-image': 'f12',
    'render-animation': 'ctrl+f12',
    'cancel-render': 'esc',
}

/** Presets de guardado. */
export const BLENDER_SAVE: Record<string, string> = {
    'save': 'ctrl+s',
    'save-as': 'shift+ctrl+s',
    'save-incremental': 'ctrl+alt+s',
}

export class BlenderPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        const hotkeyProp = (description: string) => ({
            type: 'string',
            title: 'Atajo personalizado',
            description,
            ui: { component: 'input', type: 'text', placeholder: 'Vacío = usar preset' },
        })
        return {
            id: 'blender',
            name: 'Blender',
            version: '1.0.0',
            description: 'Controla Blender: vistas del viewport, render y guardado vía atajos configurables',
            author: 'BunDeck',
            permissions: ['keyboard', 'input'],
            actions: [
                {
                    id: 'viewport',
                    name: 'Vista del viewport',
                    description: 'Cambia la vista 3D (frontal, cenital, cámara, sombreado…)',
                    icon: 'Box',
                    schema: {
                        type: 'object',
                        properties: {
                            view: {
                                type: 'string', title: 'Vista',
                                description: 'Vista a mostrar',
                                enum: Object.keys(BLENDER_VIEWPORT),
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'front', label: 'Frontal (Numpad 1)' },
                                        { value: 'back', label: 'Trasera (Ctrl+Numpad 1)' },
                                        { value: 'top', label: 'Cenital (Numpad 7)' },
                                        { value: 'bottom', label: 'Inferior (Ctrl+Numpad 7)' },
                                        { value: 'right', label: 'Derecha (Numpad 3)' },
                                        { value: 'left', label: 'Izquierda (Ctrl+Numpad 3)' },
                                        { value: 'camera', label: 'Cámara (Numpad 0)' },
                                        { value: 'toggle-perspective', label: 'Perspectiva/Orto (Numpad 5)' },
                                        { value: 'frame-all', label: 'Encuadrar todo (Inicio)' },
                                        { value: 'shade-solid', label: 'Menú de sombreado (Z)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado para esta vista'),
                        },
                        required: ['view'],
                    },
                },
                {
                    id: 'render',
                    name: 'Renderizar',
                    description: 'Lanza o cancela un render (F12, Ctrl+F12)',
                    icon: 'Image',
                    schema: {
                        type: 'object',
                        properties: {
                            operation: {
                                type: 'string', title: 'Operación',
                                description: 'Operación de render',
                                enum: Object.keys(BLENDER_RENDER),
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'render-image', label: 'Renderizar imagen (F12)' },
                                        { value: 'render-animation', label: 'Renderizar animación (Ctrl+F12)' },
                                        { value: 'cancel-render', label: 'Cancelar render (Esc)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado'),
                        },
                        required: ['operation'],
                    },
                },
                {
                    id: 'save',
                    name: 'Guardar',
                    description: 'Guarda el blend actual (Ctrl+S, incremental…)',
                    icon: 'Save',
                    schema: {
                        type: 'object',
                        properties: {
                            operation: {
                                type: 'string', title: 'Operación',
                                description: 'Operación de guardado',
                                enum: Object.keys(BLENDER_SAVE),
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'save', label: 'Guardar (Ctrl+S)' },
                                        { value: 'save-as', label: 'Guardar como (Mayús+Ctrl+S)' },
                                        { value: 'save-incremental', label: 'Guardado incremental (Ctrl+Alt+S)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado'),
                        },
                        required: ['operation'],
                    },
                },
                {
                    id: 'custom',
                    name: 'Atajo libre',
                    description: 'Envía cualquier atajo a Blender (para tus keymaps personalizados)',
                    icon: 'Keyboard',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: {
                                type: 'string', title: 'Atajo',
                                description: 'Combinación a enviar (ej. shift+a, ctrl+alt+q)',
                                ui: { component: 'input', type: 'text', placeholder: 'shift+a' },
                            },
                        },
                        required: ['hotkey'],
                    },
                },
            ],
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('viewport', this.executeViewport.bind(this))
        handlers.set('render', this.executeRender.bind(this))
        handlers.set('save', this.executeSave.bind(this))
        handlers.set('custom', this.executeCustom.bind(this))
        return handlers
    }

    private resolve(custom: unknown, preset: string | undefined, what: string): string {
        if (typeof custom === 'string' && custom.trim().length > 0) return custom.trim()
        if (preset) return preset
        throw new Error(`Sin atajo para "${what}": indica el parámetro "hotkey"`)
    }

    private async executeViewport(params: any, _context: any): Promise<any> {
        const view = params?.view
        if (typeof view !== 'string' || !BLENDER_VIEWPORT[view]) {
            throw new Error(`Vista no válida: "${view}". Usa una de: ${Object.keys(BLENDER_VIEWPORT).join(', ')}`)
        }
        const hotkey = this.resolve(params?.hotkey, BLENDER_VIEWPORT[view], view)
        this.context.log('info', `Blender: vista ${view} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'viewport', view, hotkey, ...press }
    }

    private async executeRender(params: any, _context: any): Promise<any> {
        const operation = params?.operation
        if (typeof operation !== 'string' || !BLENDER_RENDER[operation]) {
            throw new Error(`Operación de render no válida: "${operation}". Usa una de: ${Object.keys(BLENDER_RENDER).join(', ')}`)
        }
        const hotkey = this.resolve(params?.hotkey, BLENDER_RENDER[operation], operation)
        this.context.log('info', `Blender: render ${operation} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'render', operation, hotkey, ...press }
    }

    private async executeSave(params: any, _context: any): Promise<any> {
        const operation = params?.operation
        if (typeof operation !== 'string' || !BLENDER_SAVE[operation]) {
            throw new Error(`Operación de guardado no válida: "${operation}". Usa una de: ${Object.keys(BLENDER_SAVE).join(', ')}`)
        }
        const hotkey = this.resolve(params?.hotkey, BLENDER_SAVE[operation], operation)
        this.context.log('info', `Blender: guardar ${operation} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'save', operation, hotkey, ...press }
    }

    private async executeCustom(params: any, _context: any): Promise<any> {
        const hotkey = this.resolve(params?.hotkey, undefined, 'custom')
        this.context.log('info', `Blender: atajo libre (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'custom', hotkey, ...press }
    }

    private async pressHotkey(hotkey: string): Promise<any> {
        const { key, modifiers } = parseCombo(hotkey)
        const platform = process.platform
        if (platform === 'win32') return await this.pressWindows(key, modifiers, hotkey)
        if (platform === 'darwin') return await this.pressMac(key, modifiers, hotkey)
        if (platform === 'linux') return await this.pressLinux(key, modifiers, hotkey)
        throw new Error(`Atajos no soportados en la plataforma: ${platform}`)
    }

    private async pressWindows(key: string, modifiers: string[], hotkey: string): Promise<any> {
        if (modifiers.includes('win') || modifiers.includes('meta') || modifiers.includes('super')) {
            return { hotkey, simulated: false, platform: 'windows', note: 'La tecla Windows no está soportada por SendKeys' }
        }
        let seq = ''
        if (modifiers.includes('ctrl') || modifiers.includes('control')) seq += '^'
        if (modifiers.includes('alt')) seq += '%'
        if (modifiers.includes('shift')) seq += '+'
        seq += WIN_KEY_MAP[key] ?? key.toUpperCase()
        const escaped = seq.replace(/'/g, "''")
        try {
            const proc = Bun.spawn({ windowsHide: true, 
                cmd: ['powershell.exe', '-Command', `(New-Object -ComObject WScript.Shell).SendKeys('${escaped}')`],
                stdio: ['ignore', 'pipe', 'pipe'],
            })
            const stderr = await new Response(proc.stderr).text()
            await proc.exited
            if (proc.exitCode === 0) return { hotkey, simulated: true, platform: 'windows', method: 'powershell-sendkeys' }
            throw new Error(`PowerShell devolvió el código ${proc.exitCode}: ${stderr.slice(0, 200)}`)
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('PowerShell')) throw error
            throw new Error(`No se pudo enviar el atajo "${hotkey}" en Windows: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    private async pressMac(key: string, modifiers: string[], hotkey: string): Promise<any> {
        const code = MAC_KEY_CODES[key]
        if (code === undefined && !/^numpad\d$/.test(key)) throw new Error(`Tecla desconocida en macOS: "${key}"`)
        const flags: string[] = []
        if (modifiers.includes('cmd') || modifiers.includes('meta') || modifiers.includes('command')) flags.push('command down')
        if (modifiers.includes('ctrl') || modifiers.includes('control')) flags.push('control down')
        if (modifiers.includes('alt') || modifiers.includes('option')) flags.push('option down')
        if (modifiers.includes('shift')) flags.push('shift down')
        const modStr = flags.length > 0 ? ` using {${flags.join(', ')}}` : ''
        const keyExpr = /^numpad\d$/.test(key) ? `key "${key.replace('numpad', '')}"${modStr}` : `key code ${code}${modStr}`
        try {
            const proc = Bun.spawn({ windowsHide: true, 
                cmd: ['osascript', '-e', `tell application "System Events" to ${keyExpr}`],
                stdio: ['ignore', 'pipe', 'pipe'],
            })
            const stderr = await new Response(proc.stderr).text()
            await proc.exited
            if (proc.exitCode === 0) return { hotkey, simulated: true, platform: 'macos', method: 'osascript-keycode' }
            throw new Error(`osascript falló: ${stderr.slice(0, 200)}`)
        } catch (error) {
            if (error instanceof Error && (error.message.startsWith('osascript') || error.message.startsWith('Tecla'))) throw error
            throw new Error(`No se pudo enviar el atajo "${hotkey}" en macOS: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    private async pressLinux(key: string, modifiers: string[], hotkey: string): Promise<any> {
        const modMap: Record<string, string> = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super', win: 'super', super: 'super', cmd: 'super' }
        const mapped = modifiers.map((m) => modMap[m] ?? m)
        const keyMap: Record<string, string> = {
            return: 'Return', enter: 'Return', backspace: 'BackSpace', delete: 'Delete', del: 'Delete',
            escape: 'Escape', esc: 'Escape', space: 'space', tab: 'Tab', up: 'Up', down: 'Down',
            left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down', insert: 'Insert',
        }
        const normalizedKey = /^numpad\d$/.test(key) ? `KP_${key.replace('numpad', '')}` : (keyMap[key] ?? key)
        const combo = [...mapped, normalizedKey].join('+')
        for (const tool of ['xdotool', 'ydotool']) {
            try {
                const proc = Bun.spawn({ windowsHide: true,  cmd: [tool, 'key', combo], stdio: ['ignore', 'pipe', 'pipe'] })
                const stderr = await new Response(proc.stderr).text()
                await proc.exited
                if (proc.exitCode === 0) return { hotkey, simulated: true, platform: 'linux', method: tool }
                this.context.log('warn', `${tool} falló para "${hotkey}": ${stderr.slice(0, 120)}`)
            } catch { /* siguiente herramienta */ }
        }
        throw new Error(`No se pudo enviar el atajo "${hotkey}" en Linux: instala xdotool o ydotool`)
    }

    public dispose(): void {
        // Sin recursos que liberar
    }
}
