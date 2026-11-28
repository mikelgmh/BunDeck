/**
 * Native DaVinci Resolve Plugin
 * Controla DaVinci Resolve mediante atajos de teclado configurables:
 * transporte, edición en la línea de tiempo, marcadores, inicio de
 * render, guardado y cambio de página (Media/Edit/Fusion/Color/
 * Fairlight/Deliver). Sin dependencias nuevas.
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
    if (parts.length === 0) throw new Error('Hotkey vacío: indica una combinación como "ctrl+s"')
    return { key: parts[parts.length - 1], modifiers: parts.slice(0, -1) }
}

/** Presets de transporte de DaVinci. */
export const DAVINCI_TRANSPORT: Record<string, string> = {
    'play-pause': 'space',
    'play-reverse': 'j',
    'stop': 'k',
    'play-forward': 'l',
    'frame-back': 'left',
    'frame-forward': 'right',
    'go-start': 'home',
    'go-end': 'end',
}

/** Presets de edición en la línea de tiempo. */
export const DAVINCI_EDIT: Record<string, string> = {
    'cut': 'ctrl+x',
    'copy': 'ctrl+c',
    'paste': 'ctrl+v',
    'paste-insert': 'shift+ctrl+v',
    'delete': 'backspace',
    'ripple-delete': 'shift+backspace',
    'blade': 'ctrl+\\',
}

/** Presets de páginas (Media/Edit/Fusion/Color/Fairlight/Deliver). */
export const DAVINCI_PAGES: Record<string, string> = {
    'media': 'shift+2',
    'edit': 'shift+3',
    'fusion': 'shift+4',
    'color': 'shift+5',
    'fairlight': 'shift+6',
    'deliver': 'shift+7',
}

export class DavinciPlugin {
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
            id: 'davinci',
            name: 'DaVinci Resolve',
            version: '1.0.1',
            description: 'Controla DaVinci Resolve: transporte, edición, marcadores, render, guardado y cambio de página',
            author: 'BunDeck',
            permissions: ['keyboard', 'input'],
            actions: [
                {
                    id: 'transport',
                    name: 'Transporte',
                    description: 'Reproduce, pausa, detiene y navega (Espacio, JKL, flechas, Inicio/Fin)',
                    i18n: { es: { name: 'Transporte', description: 'Reproduce, pausa, detiene y navega (Espacio, JKL, flechas, Inicio/Fin)' }, en: { name: 'Transporte', description: 'Reproduce, pausa, detiene y navega (Espacio, JKL, flechas, Inicio/Fin)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Play',
                    surface: 'control',
                    component: 'creative-tools',
                    schema: {
                        type: 'object',
                        properties: {
                            operation: {
                                type: 'string', title: 'Operación',
                                description: 'Operación de transporte',
                                enum: Object.keys(DAVINCI_TRANSPORT),
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'play-pause', label: 'Reproducir / Pausar (Espacio)' },
                                        { value: 'play-reverse', label: 'Reproducir atrás (J)' },
                                        { value: 'stop', label: 'Detener (K)' },
                                        { value: 'play-forward', label: 'Reproducir adelante (L)' },
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
                    id: 'edit',
                    name: 'Cortar / Copiar / Pegar',
                    description: 'Edita clips en la línea de tiempo (cortar, copiar, pegar, eliminar, cuchilla)',
                    i18n: { es: { name: 'Cortar / Copiar / Pegar', description: 'Edita clips en la línea de tiempo (cortar, copiar, pegar, eliminar, cuchilla)' }, en: { name: 'Cortar / Copiar / Pegar', description: 'Edita clips en la línea de tiempo (cortar, copiar, pegar, eliminar, cuchilla)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Scissors',
                    schema: {
                        type: 'object',
                        properties: {
                            operation: {
                                type: 'string', title: 'Operación',
                                description: 'Operación de edición',
                                enum: Object.keys(DAVINCI_EDIT),
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'cut', label: 'Cortar (Ctrl+X)' },
                                        { value: 'copy', label: 'Copiar (Ctrl+C)' },
                                        { value: 'paste', label: 'Pegar (Ctrl+V)' },
                                        { value: 'paste-insert', label: 'Pegar e insertar (Mayús+Ctrl+V)' },
                                        { value: 'delete', label: 'Eliminar (Retroceso)' },
                                        { value: 'ripple-delete', label: 'Eliminar con ripple (Mayús+Retroceso)' },
                                        { value: 'blade', label: 'Cuchilla (Ctrl+\\)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado'),
                        },
                        required: ['operation'],
                    },
                },
                {
                    id: 'marker',
                    name: 'Marcador',
                    description: 'Añade un marcador en el cabezal (M)',
                    i18n: { es: { name: 'Marcador', description: 'Añade un marcador en el cabezal (M)' }, en: { name: 'Marcador', description: 'Añade un marcador en el cabezal (M)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Flag',
                    schema: {
                        type: 'object',
                        properties: {
                            operation: {
                                type: 'string', title: 'Operación',
                                description: 'Operación de marcador',
                                enum: ['add-marker'],
                                ui: { component: 'select', options: [{ value: 'add-marker', label: 'Añadir marcador (M)' }] },
                            },
                            hotkey: hotkeyProp('Atajo personalizado'),
                        },
                        required: ['operation'],
                    },
                },
                {
                    id: 'render-start',
                    name: 'Iniciar render',
                    description: 'Inicia la cola de render en la página Deliver (requiere configurar el atajo en DaVinci si no usa el indicado)',
                    i18n: { es: { name: 'Iniciar render', description: 'Inicia la cola de render en la página Deliver (requiere configurar el atajo en DaVinci si no usa el indicado)' }, en: { name: 'Iniciar render', description: 'Inicia la cola de render en la página Deliver (requiere configurar el atajo en DaVinci si no usa el indicado)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Clapperboard',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: {
                                type: 'string', title: 'Atajo de render',
                                description: 'Atajo que inicia el render en tu DaVinci (sin atajo global por defecto: configúralo en Preferencias → Atajos)',
                                ui: { component: 'input', type: 'text', placeholder: 'Ej. ctrl+f12' },
                            },
                        },
                        required: ['hotkey'],
                    },
                },
                {
                    id: 'save-project',
                    name: 'Guardar proyecto',
                    description: 'Guarda el proyecto actual (Ctrl+S)',
                    i18n: { es: { name: 'Guardar proyecto', description: 'Guarda el proyecto actual (Ctrl+S)' }, en: { name: 'Guardar proyecto', description: 'Guarda el proyecto actual (Ctrl+S)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Save',
                    schema: {
                        type: 'object',
                        properties: { hotkey: hotkeyProp('Atajo personalizado de guardado') },
                        required: [],
                    },
                },
                {
                    id: 'switch-page',
                    name: 'Cambiar de página',
                    description: 'Salta a Media, Edit, Fusion, Color, Fairlight o Deliver',
                    i18n: { es: { name: 'Cambiar de página', description: 'Salta a Media, Edit, Fusion, Color, Fairlight o Deliver' }, en: { name: 'Cambiar de página', description: 'Salta a Media, Edit, Fusion, Color, Fairlight o Deliver' } }, // TODO i18n: EN temporal = ES
                    icon: 'LayoutGrid',
                    schema: {
                        type: 'object',
                        properties: {
                            page: {
                                type: 'string', title: 'Página',
                                description: 'Página de DaVinci a la que cambiar',
                                enum: Object.keys(DAVINCI_PAGES),
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'media', label: 'Media (Mayús+2)' },
                                        { value: 'edit', label: 'Edit (Mayús+3)' },
                                        { value: 'fusion', label: 'Fusion (Mayús+4)' },
                                        { value: 'color', label: 'Color (Mayús+5)' },
                                        { value: 'fairlight', label: 'Fairlight (Mayús+6)' },
                                        { value: 'deliver', label: 'Deliver (Mayús+7)' },
                                    ],
                                },
                            },
                            hotkey: hotkeyProp('Atajo personalizado para esta página'),
                        },
                        required: ['page'],
                    },
                },
            ],
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('transport', this.executeTransport.bind(this))
        handlers.set('edit', this.executeEdit.bind(this))
        handlers.set('marker', this.executeMarker.bind(this))
        handlers.set('render-start', this.executeRender.bind(this))
        handlers.set('save-project', this.executeSave.bind(this))
        handlers.set('switch-page', this.executePage.bind(this))
        return handlers
    }

    private resolve(custom: unknown, preset: string | undefined, what: string): string {
        if (typeof custom === 'string' && custom.trim().length > 0) return custom.trim()
        if (preset) return preset
        throw new Error(`Sin atajo para "${what}": indica el parámetro "hotkey"`)
    }

    private async executeTransport(params: any, _context: any): Promise<any> {
        const operation = params?.operation
        if (typeof operation !== 'string' || !DAVINCI_TRANSPORT[operation]) {
            throw new Error(`Operación de transporte no válida: "${operation}". Usa una de: ${Object.keys(DAVINCI_TRANSPORT).join(', ')}`)
        }
        const hotkey = this.resolve(params?.hotkey, DAVINCI_TRANSPORT[operation], operation)
        this.context.log('info', `DaVinci: transporte ${operation} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'transport', operation, hotkey, ...press }
    }

    private async executeEdit(params: any, _context: any): Promise<any> {
        const operation = params?.operation
        if (typeof operation !== 'string' || !DAVINCI_EDIT[operation]) {
            throw new Error(`Operación de edición no válida: "${operation}". Usa una de: ${Object.keys(DAVINCI_EDIT).join(', ')}`)
        }
        const hotkey = this.resolve(params?.hotkey, DAVINCI_EDIT[operation], operation)
        this.context.log('info', `DaVinci: edición ${operation} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'edit', operation, hotkey, ...press }
    }

    private async executeMarker(params: any, _context: any): Promise<any> {
        const operation = params?.operation
        if (operation !== 'add-marker') {
            throw new Error(`Operación de marcador no válida: "${operation}". Solo se soporta add-marker`)
        }
        const hotkey = this.resolve(params?.hotkey, 'm', operation)
        this.context.log('info', `DaVinci: marcador (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'marker', operation, hotkey, ...press }
    }

    private async executeRender(params: any, _context: any): Promise<any> {
        const hotkey = this.resolve(params?.hotkey, undefined, 'render-start')
        this.context.log('info', `DaVinci: iniciar render (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'render-start', hotkey, ...press }
    }

    private async executeSave(params: any, _context: any): Promise<any> {
        const hotkey = this.resolve(params?.hotkey, 'ctrl+s', 'save-project')
        this.context.log('info', `DaVinci: guardar proyecto (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'save-project', hotkey, ...press }
    }

    private async executePage(params: any, _context: any): Promise<any> {
        const page = params?.page
        if (typeof page !== 'string' || !DAVINCI_PAGES[page]) {
            throw new Error(`Página no válida: "${page}". Usa una de: ${Object.keys(DAVINCI_PAGES).join(', ')}`)
        }
        const hotkey = this.resolve(params?.hotkey, DAVINCI_PAGES[page], page)
        this.context.log('info', `DaVinci: cambiar a página ${page} (${hotkey})`)
        const press = await this.pressHotkey(hotkey)
        return { action: 'switch-page', page, hotkey, ...press }
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
            } catch { /* siguiente herramienta */ }
        }
        throw new Error(`No se pudo enviar el atajo "${hotkey}" en Linux: instala xdotool o ydotool`)
    }

    public dispose(): void {
        // Sin recursos que liberar
    }
}
