/**
 * Native Photoshop Plugin
 * Controla Adobe Photoshop mediante atajos de teclado configurables.
 * No usa SDK ni dependencias nuevas: envía hotkeys del SO (PowerShell
 * SendKeys en Windows, osascript en macOS, xdotool/ydotool en Linux).
 * Cada acción trae presets con el atajo por defecto de Photoshop y un
 * campo `hotkey` opcional para sobreescribirlo (útil si el usuario
 * personalizó sus atajos).
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
    '[': 33, ']': 30,
}

function parseCombo(hotkey: string): { key: string; modifiers: string[] } {
    const parts = String(hotkey ?? '').split('+').map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (parts.length === 0) throw new Error('Hotkey vacío: indica una combinación como "ctrl+s"')
    return { key: parts[parts.length - 1], modifiers: parts.slice(0, -1) }
}

/** Presets de herramientas de Photoshop (atajo por defecto en inglés). */
export const PHOTOSHOP_TOOLS: Record<string, string> = {
    'move': 'v', 'marquee': 'm', 'lasso': 'l', 'quick-select': 'w',
    'crop': 'c', 'eyedropper': 'i', 'brush': 'b', 'clone': 's',
    'eraser': 'e', 'gradient': 'g', 'text': 't', 'hand': 'h', 'zoom': 'z',
}

/** Presets de operaciones de capa. */
export const PHOTOSHOP_LAYER_OPS: Record<string, string> = {
    'new': 'shift+ctrl+n',
    'duplicate': 'ctrl+j',
    'merge-down': 'ctrl+e',
    'merge-visible': 'shift+ctrl+e',
    'group': 'ctrl+g',
    'ungroup': 'shift+ctrl+g',
    'hide': 'ctrl+,',
}

/** Presets de historial. */
export const PHOTOSHOP_HISTORY: Record<string, string> = {
    'undo': 'ctrl+z',
    'redo': 'shift+ctrl+z',
    'step-backward': 'alt+ctrl+z',
    'step-forward': 'shift+ctrl+z',
}

/** Presets de guardado/exportación. */
export const PHOTOSHOP_SAVE: Record<string, string> = {
    'save': 'ctrl+s',
    'save-as': 'shift+ctrl+s',
    'export-web': 'alt+shift+ctrl+w',
    'export-as': 'alt+shift+ctrl+w',
}

export class PhotoshopPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        const hotkeyProp = (description: string) => ({
            type: 'string',
            title: 'Atajo personalizado',
            description,
            ui: { component: 'input', type: 'text', placeholder: 'Vacío = usar preset (ej. ctrl+s)' },
        })
        return {
            id: 'photoshop',
            name: 'Adobe Photoshop',
            version: '1.0.1',
            description: 'Controla Photoshop: herramientas, capas, pincel, acciones, historial y guardado vía atajos configurables',
            author: 'BunDeck',
            permissions: ['keyboard', 'input'],
            actions: [
                {
                    id: 'tool-select',
                    name: 'Seleccionar herramienta',
                    description: 'Activa una herramienta de Photoshop (mover, marco, lazo, pincel, texto, mano, zoom…)',
                    icon: 'Brush',
                    schema: {
                        type: 'object',
                        properties: {
                            tool: {
                                type: 'string', title: 'Herramienta',
                                description: 'Herramienta a activar',
                                enum: Object.keys(PHOTOSHOP_TOOLS),
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'move', label: 'Mover (V)' },
                                        { value: 'marquee', label: 'Marco (M)' },
                                        { value: 'lasso', label: 'Lazo (L)' },
                                        { value: 'quick-select', label: 'Selección rápida (W)' },
                                        { value: 'crop', label: 'Recortar (C)' },
                                        { value: 'eyedropper', label: 'Cuentagotas (I)' },
                                        { value: 'brush', label: 'Pincel (B)' },
                                        { value: 'clone', label: 'Tampón de clonar (S)' },
                                        { value: 'eraser', label: 'Borrador (E)' },
                                        { value: 'gradient', label: 'Degradado (G)' },
                                        { value: 'text', label: 'Texto (T)' },
                                        { value: 'hand', label: 'Mano (H)' },
                                        { value: 'zoom', label: 'Zoom (Z)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado para esta herramienta (si cambiaste los atajos de Photoshop)'),
                        },
                        required: ['tool'],
                    },
                },
                {
                    id: 'layer-ops',
                    name: 'Operación de capa',
                    description: 'Crea, duplica, combina o agrupa capas',
                    icon: 'Layers',
                    schema: {
                        type: 'object',
                        properties: {
                            op: {
                                type: 'string', title: 'Operación',
                                description: 'Operación de capa a ejecutar',
                                enum: Object.keys(PHOTOSHOP_LAYER_OPS),
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'new', label: 'Nueva capa (Mayús+Ctrl+N)' },
                                        { value: 'duplicate', label: 'Duplicar capa (Ctrl+J)' },
                                        { value: 'merge-down', label: 'Combinar hacia abajo (Ctrl+E)' },
                                        { value: 'merge-visible', label: 'Combinar visibles (Mayús+Ctrl+E)' },
                                        { value: 'group', label: 'Agrupar (Ctrl+G)' },
                                        { value: 'ungroup', label: 'Desagrupar (Mayús+Ctrl+G)' },
                                        { value: 'hide', label: 'Ocultar capa (Ctrl+,)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado para esta operación'),
                        },
                        required: ['op'],
                    },
                },
                {
                    id: 'brush-size',
                    name: 'Tamaño de pincel',
                    description: 'Aumenta o reduce el tamaño del pincel',
                    icon: 'Circle',
                    surface: 'control',
                    component: 'creative-tools',
                    schema: {
                        type: 'object',
                        properties: {
                            direction: {
                                type: 'string', title: 'Dirección',
                                description: 'Aumentar o reducir el pincel',
                                enum: ['increase', 'decrease'],
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'increase', label: 'Aumentar ( ] )' },
                                        { value: 'decrease', label: 'Reducir ( [ )' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado (por defecto [ y ])'),
                        },
                        required: ['direction'],
                    },
                },
                {
                    id: 'run-action',
                    name: 'Ejecutar acción',
                    description: 'Dispara una acción del panel Acciones mediante su atajo de teclado (las acciones de Photoshop se lanzan con la tecla asignada en el panel)',
                    icon: 'Play',
                    schema: {
                        type: 'object',
                        properties: {
                            actionName: {
                                type: 'string', title: 'Nombre de la acción',
                                description: 'Nombre informativo de la acción (solo para el registro)',
                                ui: { component: 'input', type: 'text', placeholder: 'Mi acción de retoque' },
                            },
                            hotkey: {
                                type: 'string', title: 'Atajo de la acción',
                                description: 'Atajo asignado a la acción en Photoshop (obligatorio: Photoshop ejecuta acciones por atajo)',
                                ui: { component: 'input', type: 'text', placeholder: 'Ej. f2 o shift+f5' },
                            },
                        },
                        required: ['hotkey'],
                    },
                },
                {
                    id: 'history',
                    name: 'Deshacer / Rehacer',
                    description: 'Deshace o rehace cambios en Photoshop',
                    icon: 'Undo',
                    schema: {
                        type: 'object',
                        properties: {
                            operation: {
                                type: 'string', title: 'Operación',
                                description: 'Operación de historial',
                                enum: Object.keys(PHOTOSHOP_HISTORY),
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'undo', label: 'Deshacer (Ctrl+Z)' },
                                        { value: 'redo', label: 'Rehacer (Mayús+Ctrl+Z)' },
                                        { value: 'step-backward', label: 'Paso atrás (Alt+Ctrl+Z)' },
                                        { value: 'step-forward', label: 'Paso adelante (Mayús+Ctrl+Z)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado para esta operación'),
                        },
                        required: ['operation'],
                    },
                },
                {
                    id: 'save-export',
                    name: 'Guardar / Exportar',
                    description: 'Guarda el documento o lo exporta para web',
                    icon: 'Save',
                    schema: {
                        type: 'object',
                        properties: {
                            operation: {
                                type: 'string', title: 'Operación',
                                description: 'Operación de guardado',
                                enum: Object.keys(PHOTOSHOP_SAVE),
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'save', label: 'Guardar (Ctrl+S)' },
                                        { value: 'save-as', label: 'Guardar como (Mayús+Ctrl+S)' },
                                        { value: 'export-web', label: 'Exportar para web (Alt+Mayús+Ctrl+W)' },
                                        { value: 'export-as', label: 'Exportar como (Alt+Mayús+Ctrl+W)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado para esta operación'),
                        },
                        required: ['operation'],
                    },
                },
            ],
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('tool-select', this.executeTool.bind(this))
        handlers.set('layer-ops', this.executeLayer.bind(this))
        handlers.set('brush-size', this.executeBrush.bind(this))
        handlers.set('run-action', this.executeRunAction.bind(this))
        handlers.set('history', this.executeHistory.bind(this))
        handlers.set('save-export', this.executeSave.bind(this))
        return handlers
    }

    private resolveHotkey(custom: unknown, preset: string | undefined, what: string): string {
        if (typeof custom === 'string' && custom.trim().length > 0) return custom.trim()
        if (preset) return preset
        throw new Error(`Sin atajo para "${what}": indica el parámetro "hotkey" (ej. f2)`)
    }

    private async executeTool(params: any, _context: any): Promise<any> {
        const tool = params?.tool
        if (typeof tool !== 'string' || !PHOTOSHOP_TOOLS[tool]) {
            throw new Error(`Herramienta no válida: "${tool}". Usa una de: ${Object.keys(PHOTOSHOP_TOOLS).join(', ')}`)
        }
        const hotkey = this.resolveHotkey(params?.hotkey, PHOTOSHOP_TOOLS[tool], tool)
        this.context.log('info', `Photoshop: herramienta ${tool} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'tool-select', tool, hotkey, ...press }
    }

    private async executeLayer(params: any, _context: any): Promise<any> {
        const op = params?.op
        if (typeof op !== 'string' || !PHOTOSHOP_LAYER_OPS[op]) {
            throw new Error(`Operación de capa no válida: "${op}". Usa una de: ${Object.keys(PHOTOSHOP_LAYER_OPS).join(', ')}`)
        }
        const hotkey = this.resolveHotkey(params?.hotkey, PHOTOSHOP_LAYER_OPS[op], op)
        this.context.log('info', `Photoshop: capa ${op} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'layer-ops', op, hotkey, ...press }
    }

    private async executeBrush(params: any, _context: any): Promise<any> {
        const direction = params?.direction
        if (direction !== 'increase' && direction !== 'decrease') {
            throw new Error('La dirección del pincel debe ser "increase" o "decrease"')
        }
        const hotkey = this.resolveHotkey(params?.hotkey, direction === 'increase' ? ']' : '[', direction)
        this.context.log('info', `Photoshop: pincel ${direction} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'brush-size', direction, hotkey, ...press }
    }

    private async executeRunAction(params: any, _context: any): Promise<any> {
        const hotkey = this.resolveHotkey(params?.hotkey, undefined, params?.actionName ?? 'acción')
        const actionName = typeof params?.actionName === 'string' ? params.actionName : ''
        this.context.log('info', `Photoshop: ejecutar acción ${actionName || '(sin nombre)'} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'run-action', actionName, hotkey, ...press }
    }

    private async executeHistory(params: any, _context: any): Promise<any> {
        const operation = params?.operation
        if (typeof operation !== 'string' || !PHOTOSHOP_HISTORY[operation]) {
            throw new Error(`Operación de historial no válida: "${operation}". Usa una de: ${Object.keys(PHOTOSHOP_HISTORY).join(', ')}`)
        }
        const hotkey = this.resolveHotkey(params?.hotkey, PHOTOSHOP_HISTORY[operation], operation)
        this.context.log('info', `Photoshop: historial ${operation} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'history', operation, hotkey, ...press }
    }

    private async executeSave(params: any, _context: any): Promise<any> {
        const operation = params?.operation
        if (typeof operation !== 'string' || !PHOTOSHOP_SAVE[operation]) {
            throw new Error(`Operación de guardado no válida: "${operation}". Usa una de: ${Object.keys(PHOTOSHOP_SAVE).join(', ')}`)
        }
        const hotkey = this.resolveHotkey(params?.hotkey, PHOTOSHOP_SAVE[operation], operation)
        this.context.log('info', `Photoshop: guardar ${operation} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'save-export', operation, hotkey, ...press }
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
        if (code === undefined) throw new Error(`Tecla desconocida en macOS: "${key}"`)
        const flags: string[] = []
        if (modifiers.includes('cmd') || modifiers.includes('meta') || modifiers.includes('command')) flags.push('command down')
        if (modifiers.includes('ctrl') || modifiers.includes('control')) flags.push('control down')
        if (modifiers.includes('alt') || modifiers.includes('option')) flags.push('option down')
        if (modifiers.includes('shift')) flags.push('shift down')
        const modStr = flags.length > 0 ? ` using {${flags.join(', ')}}` : ''
        try {
            const proc = Bun.spawn({ windowsHide: true, 
                cmd: ['osascript', '-e', `tell application "System Events" to key code ${code}${modStr}`],
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
        const combo = [...mapped, keyMap[key] ?? key].join('+')
        for (const tool of ['xdotool', 'ydotool']) {
            try {
                const proc = Bun.spawn({ windowsHide: true,  cmd: [tool, 'key', combo], stdio: ['ignore', 'pipe', 'pipe'] })
                const stderr = await new Response(proc.stderr).text()
                await proc.exited
                if (proc.exitCode === 0) return { hotkey, simulated: true, platform: 'linux', method: tool }
                this.context.log('warn', `${tool} falló para "${hotkey}": ${stderr.slice(0, 120)}`)
            } catch { /* prueba con la siguiente herramienta */ }
        }
        throw new Error(`No se pudo enviar el atajo "${hotkey}" en Linux: instala xdotool o ydotool`)
    }

    public dispose(): void {
        // Sin recursos que liberar
    }
}
