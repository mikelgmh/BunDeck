/**
 * Native Premiere Pro Plugin
 * Controla Adobe Premiere Pro mediante atajos de teclado configurables
 * (transporte JKL/Espacio, marcas, historia, guardado y exportación).
 * Sin dependencias nuevas: PowerShell SendKeys (Windows), osascript
 * (macOS) o xdotool/ydotool (Linux).
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
    if (parts.length === 0) throw new Error('Hotkey vacío: indica una combinación como "ctrl+m"')
    return { key: parts[parts.length - 1], modifiers: parts.slice(0, -1) }
}

/** Presets de transporte (JKL + Espacio). */
export const PREMIERE_TRANSPORT: Record<string, string> = {
    'play-pause': 'space',
    'reverse': 'j',
    'shuttle-stop': 'k',
    'forward': 'l',
    'frame-back': 'left',
    'frame-forward': 'right',
    'go-start': 'home',
    'go-end': 'end',
}

/** Presets de marcas. */
export const PREMIERE_MARKS: Record<string, string> = {
    'mark-in': 'i',
    'mark-out': 'o',
    'clear-in-out': 'alt+x',
    'add-marker': 'm',
    'go-next-marker': 'shift+down',
    'go-prev-marker': 'shift+up',
}

export class PremierePlugin {
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
            id: 'premiere',
            name: 'Adobe Premiere Pro',
            version: '1.0.0',
            description: 'Controla Premiere: transporte JKL, marcas de entrada/salida, marcadores, historial, guardado y exportación',
            author: 'BunDeck',
            permissions: ['keyboard', 'input'],
            actions: [
                {
                    id: 'transport',
                    name: 'Transporte',
                    description: 'Reproduce, pausa y navega por la línea de tiempo (JKL, Espacio, flechas, Inicio/Fin)',
                    icon: 'Play',
                    schema: {
                        type: 'object',
                        properties: {
                            operation: {
                                type: 'string', title: 'Operación',
                                description: 'Operación de transporte',
                                enum: Object.keys(PREMIERE_TRANSPORT),
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'play-pause', label: 'Reproducir / Pausar (Espacio)' },
                                        { value: 'reverse', label: 'Retroceder (J)' },
                                        { value: 'shuttle-stop', label: 'Detener shuttle (K)' },
                                        { value: 'forward', label: 'Avanzar (L)' },
                                        { value: 'frame-back', label: 'Fotograma atrás (←)' },
                                        { value: 'frame-forward', label: 'Fotograma adelante (→)' },
                                        { value: 'go-start', label: 'Ir al inicio (Inicio)' },
                                        { value: 'go-end', label: 'Ir al final (Fin)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado para esta operación'),
                        },
                        required: ['operation'],
                    },
                },
                {
                    id: 'mark',
                    name: 'Marca entrada/salida',
                    description: 'Marca puntos de entrada (I) y salida (O) o los limpia',
                    icon: 'Scissors',
                    schema: {
                        type: 'object',
                        properties: {
                            point: {
                                type: 'string', title: 'Punto',
                                description: 'Punto a marcar',
                                enum: ['mark-in', 'mark-out', 'clear-in-out'],
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'mark-in', label: 'Entrada (I)' },
                                        { value: 'mark-out', label: 'Salida (O)' },
                                        { value: 'clear-in-out', label: 'Limpiar entrada/salida (Alt+X)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado'),
                        },
                        required: ['point'],
                    },
                },
                {
                    id: 'marker',
                    name: 'Marcador',
                    description: 'Añade marcadores y salta entre ellos',
                    icon: 'Flag',
                    schema: {
                        type: 'object',
                        properties: {
                            operation: {
                                type: 'string', title: 'Operación',
                                description: 'Operación de marcador',
                                enum: ['add-marker', 'go-next-marker', 'go-prev-marker'],
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'add-marker', label: 'Añadir marcador (M)' },
                                        { value: 'go-next-marker', label: 'Siguiente marcador (Mayús+↓)' },
                                        { value: 'go-prev-marker', label: 'Marcador anterior (Mayús+↑)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado'),
                        },
                        required: ['operation'],
                    },
                },
                {
                    id: 'history',
                    name: 'Deshacer / Rehacer',
                    description: 'Deshace o rehace cambios',
                    icon: 'Undo',
                    schema: {
                        type: 'object',
                        properties: {
                            operation: {
                                type: 'string', title: 'Operación',
                                description: 'Operación de historial',
                                enum: ['undo', 'redo'],
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'undo', label: 'Deshacer (Ctrl+Z)' },
                                        { value: 'redo', label: 'Rehacer (Mayús+Ctrl+Z)' },
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
                    name: 'Guardar proyecto',
                    description: 'Guarda el proyecto actual (Ctrl+S)',
                    icon: 'Save',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: hotkeyProp('Atajo personalizado de guardado'),
                        },
                        required: [],
                    },
                },
                {
                    id: 'export',
                    name: 'Exportar',
                    description: 'Abre el diálogo de exportación (Ctrl+M) con preset opcional',
                    icon: 'Share',
                    schema: {
                        type: 'object',
                        properties: {
                            preset: {
                                type: 'string', title: 'Preset',
                                description: 'Nombre informativo del preset de exportación (solo para el registro; Premiere no permite elegir preset por atajo)',
                                ui: { component: 'input', type: 'text', placeholder: 'Ej. YouTube 1080p' },
                            },
                            hotkey: {
                                type: 'string', title: 'Atajo de exportación',
                                description: 'Atajo que abre la exportación (por defecto Ctrl+M)',
                                ui: { component: 'input', type: 'text', placeholder: 'ctrl+m' },
                            },
                        },
                        required: [],
                    },
                },
                {
                    id: 'jog-shuttle',
                    name: 'Jog / Shuttle',
                    description: 'Control jog/shuttle experimental: envía J, K o L (sin rueda física; el giro lo simula con pulsaciones)',
                    icon: 'Disc',
                    schema: {
                        type: 'object',
                        properties: {
                            mode: {
                                type: 'string', title: 'Modo',
                                description: 'Dirección del shuttle',
                                enum: ['shuttle-back', 'shuttle-stop', 'shuttle-forward'],
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'shuttle-back', label: 'Shuttle atrás (J)' },
                                        { value: 'shuttle-stop', label: 'Detener (K)' },
                                        { value: 'shuttle-forward', label: 'Shuttle adelante (L)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado'),
                        },
                        required: ['mode'],
                    },
                },
            ],
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('transport', this.executeTransport.bind(this))
        handlers.set('mark', this.executeMark.bind(this))
        handlers.set('marker', this.executeMarker.bind(this))
        handlers.set('history', this.executeHistory.bind(this))
        handlers.set('save', this.executeSave.bind(this))
        handlers.set('export', this.executeExport.bind(this))
        handlers.set('jog-shuttle', this.executeJog.bind(this))
        return handlers
    }

    private resolve(custom: unknown, preset: string | undefined): string {
        if (typeof custom === 'string' && custom.trim().length > 0) return custom.trim()
        if (preset) return preset
        throw new Error('Sin atajo: indica el parámetro "hotkey"')
    }

    private async executeTransport(params: any, _context: any): Promise<any> {
        const operation = params?.operation
        if (typeof operation !== 'string' || !PREMIERE_TRANSPORT[operation]) {
            throw new Error(`Operación de transporte no válida: "${operation}". Usa una de: ${Object.keys(PREMIERE_TRANSPORT).join(', ')}`)
        }
        const hotkey = this.resolve(params?.hotkey, PREMIERE_TRANSPORT[operation])
        this.context.log('info', `Premiere: transporte ${operation} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'transport', operation, hotkey, ...press }
    }

    private async executeMark(params: any, _context: any): Promise<any> {
        const point = params?.point
        if (typeof point !== 'string' || !PREMIERE_MARKS[point]) {
            throw new Error(`Punto no válido: "${point}". Usa mark-in, mark-out o clear-in-out`)
        }
        const hotkey = this.resolve(params?.hotkey, PREMIERE_MARKS[point])
        this.context.log('info', `Premiere: marca ${point} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'mark', point, hotkey, ...press }
    }

    private async executeMarker(params: any, _context: any): Promise<any> {
        const operation = params?.operation
        if (!['add-marker', 'go-next-marker', 'go-prev-marker'].includes(operation)) {
            throw new Error(`Operación de marcador no válida: "${operation}". Usa add-marker, go-next-marker o go-prev-marker`)
        }
        const hotkey = this.resolve(params?.hotkey, PREMIERE_MARKS[operation])
        this.context.log('info', `Premiere: marcador ${operation} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'marker', operation, hotkey, ...press }
    }

    private async executeHistory(params: any, _context: any): Promise<any> {
        const operation = params?.operation
        if (operation !== 'undo' && operation !== 'redo') {
            throw new Error('La operación de historial debe ser "undo" o "redo"')
        }
        const hotkey = this.resolve(params?.hotkey, operation === 'undo' ? 'ctrl+z' : 'shift+ctrl+z')
        this.context.log('info', `Premiere: historial ${operation} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'history', operation, hotkey, ...press }
    }

    private async executeSave(params: any, _context: any): Promise<any> {
        const hotkey = this.resolve(params?.hotkey, 'ctrl+s')
        this.context.log('info', `Premiere: guardar (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'save', hotkey, ...press }
    }

    private async executeExport(params: any, _context: any): Promise<any> {
        const hotkey = this.resolve(params?.hotkey, 'ctrl+m')
        const preset = typeof params?.preset === 'string' ? params.preset : ''
        this.context.log('info', `Premiere: exportar${preset ? ` (preset ${preset})` : ''} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'export', preset, hotkey, ...press }
    }

    private async executeJog(params: any, _context: any): Promise<any> {
        const mode = params?.mode
        const map: Record<string, string> = { 'shuttle-back': 'j', 'shuttle-stop': 'k', 'shuttle-forward': 'l' }
        if (typeof mode !== 'string' || !map[mode]) {
            throw new Error(`Modo jog/shuttle no válido: "${mode}". Usa shuttle-back, shuttle-stop o shuttle-forward`)
        }
        const hotkey = this.resolve(params?.hotkey, map[mode])
        this.context.log('info', `Premiere: jog/shuttle ${mode} (${hotkey}) [experimental]`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'jog-shuttle', mode, hotkey, experimental: true, note: 'Sin rueda física: simula pulsaciones J/K/L', ...press }
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
            const proc = Bun.spawn({
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
            const proc = Bun.spawn({
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
                const proc = Bun.spawn({ cmd: [tool, 'key', combo], stdio: ['ignore', 'pipe', 'pipe'] })
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
