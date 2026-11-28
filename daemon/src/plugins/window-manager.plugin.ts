/**
 * Native Window Manager Plugin
 * Maximizar, minimizar, acoplar, mover de monitor y guardar/restaurar layouts.
 * Windows (PowerShell + user32), Linux (wmctrl/xdotool) y macOS (osascript).
 * Degrada con errores amigables en español si la herramienta no existe.
 */

import { runCommand, isCommandNotFound, missingToolError } from './sysrun'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
    deleteSetting?: (key: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

type WindowAction = 'maximize' | 'minimize' | 'restore' | 'snap-left' | 'snap-right' | 'center' | 'move-to-monitor'

const ACTIONS: WindowAction[] = ['maximize', 'minimize', 'restore', 'snap-left', 'snap-right', 'center', 'move-to-monitor']
const WMCTRL_HINT = 'Instala wmctrl o xdotool (ej. "sudo apt install wmctrl xdotool"). En Wayland el control de ventanas está restringido por diseño.'

export class WindowManagerPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    /** Punto de inyección para tests (por defecto runCommand real). */
    protected async run(cmd: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return runCommand(cmd, opts)
    }

    public getManifest() {
        const actionOptions = [
            { value: 'maximize', label: 'Maximizar' },
            { value: 'minimize', label: 'Minimizar' },
            { value: 'restore', label: 'Restaurar' },
            { value: 'snap-left', label: 'Acoplar izquierda' },
            { value: 'snap-right', label: 'Acoplar derecha' },
            { value: 'center', label: 'Centrar' },
            { value: 'move-to-monitor', label: 'Mover de monitor' },
        ]
        return {
            id: 'window-manager',
            name: 'Gestor de ventanas',
            version: '1.0.2',
            description: 'Coloca la ventana activa y guarda/restaura layouts de posición',
            author: 'BunDeck',
            permissions: ['system'],
            instructions:
                'Actúa sobre la ventana activa.\n\n' +
                '· Windows: usa PowerShell + user32 (sin dependencias).\n' +
                '· Linux: necesita wmctrl o xdotool (sesión X11; en Wayland hay restricciones).\n' +
                '· macOS: usa System Events (la app necesita permiso de Accesibilidad).\n' +
                'Los layouts se guardan en los ajustes del plugin (geometría opcional x/y/w/h).',
            actions: [
                {
                    id: 'window-action',
                    name: 'Acción de ventana',
                    description: 'Maximiza, minimiza, acopla o mueve la ventana activa',
                    i18n: { es: { name: 'Acción de ventana', description: 'Maximiza, minimiza, acopla o mueve la ventana activa' }, en: { name: 'Acción de ventana', description: 'Maximiza, minimiza, acopla o mueve la ventana activa' } }, // TODO i18n: EN temporal = ES
                    icon: 'AppWindow',
                    schema: {
                        type: 'object',
                        properties: {
                            action: {
                                type: 'string',
                                title: 'Acción',
                                enum: ACTIONS,
                                ui: { component: 'select', options: actionOptions }
                            },
                            monitor: {
                                type: 'number',
                                title: 'Monitor',
                                description: 'Índice del monitor destino (solo para "Mover de monitor", empieza en 0)',
                                minimum: 0,
                                ui: { component: 'input', type: 'number', min: 0, placeholder: '0' }
                            }
                        },
                        required: ['action']
                    }
                },
                {
                    id: 'layout-save',
                    name: 'Guardar layout',
                    description: 'Guarda un layout con nombre (geometría opcional)',
                    i18n: { es: { name: 'Guardar layout', description: 'Guarda un layout con nombre (geometría opcional)' }, en: { name: 'Guardar layout', description: 'Guarda un layout con nombre (geometría opcional)' } }, // TODO i18n: EN temporal = ES
                    icon: 'Save',
                    schema: {
                        type: 'object',
                        properties: {
                            name: {
                                type: 'string',
                                title: 'Nombre del layout',
                                ui: { component: 'input', type: 'text', placeholder: 'streaming' }
                            },
                            x: { type: 'number', title: 'X', ui: { component: 'input', type: 'number' } },
                            y: { type: 'number', title: 'Y', ui: { component: 'input', type: 'number' } },
                            w: { type: 'number', title: 'Ancho', ui: { component: 'input', type: 'number' } },
                            h: { type: 'number', title: 'Alto', ui: { component: 'input', type: 'number' } },
                            note: {
                                type: 'string',
                                title: 'Nota',
                                ui: { component: 'input', type: 'text', placeholder: '(opcional)' }
                            }
                        },
                        required: ['name']
                    }
                },
                {
                    id: 'layout-restore',
                    name: 'Restaurar layout',
                    description: 'Aplica la geometría guardada de un layout a la ventana activa',
                    i18n: { es: { name: 'Restaurar layout', description: 'Aplica la geometría guardada de un layout a la ventana activa' }, en: { name: 'Restaurar layout', description: 'Aplica la geometría guardada de un layout a la ventana activa' } }, // TODO i18n: EN temporal = ES
                    icon: 'FolderOpen',
                    schema: {
                        type: 'object',
                        properties: {
                            name: {
                                type: 'string',
                                title: 'Nombre del layout',
                                ui: { component: 'input', type: 'text', placeholder: 'streaming' }
                            }
                        },
                        required: ['name']
                    }
                },
                {
                    id: 'layout-list',
                    name: 'Listar layouts',
                    description: 'Muestra los layouts guardados',
                    i18n: { es: { name: 'Listar layouts', description: 'Muestra los layouts guardados' }, en: { name: 'Listar layouts', description: 'Muestra los layouts guardados' } }, // TODO i18n: EN temporal = ES
                    icon: 'List',
                    surface: 'control',
                    component: 'workflow-control',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        }
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('window-action', this.executeWindowAction.bind(this))
        handlers.set('layout-save', this.executeLayoutSave.bind(this))
        handlers.set('layout-restore', this.executeLayoutRestore.bind(this))
        handlers.set('layout-list', this.executeLayoutList.bind(this))
        return handlers
    }

    // ---------- window-action ----------

    private async executeWindowAction(params: any, _context: any): Promise<any> {
        const { action, monitor } = params ?? {}
        if (!ACTIONS.includes(action)) {
            throw new Error(`Acción no válida: "${action}". Usa una de: ${ACTIONS.join(', ')}.`)
        }
        if (action === 'move-to-monitor' && (typeof monitor !== 'number' || monitor < 0)) {
            throw new Error('Para "move-to-monitor" indica "monitor" (número ≥ 0).')
        }
        const platform = process.platform
        this.context.log('info', `Ventanas: ${action}`, { monitor, platform })
        try {
            if (platform === 'win32') return await this.winAction(action, monitor)
            if (platform === 'linux') return await this.linuxAction(action, monitor)
            return await this.macAction(action, monitor)
        } catch (error) {
            this.context.log('error', `Ventanas: no se pudo ejecutar "${action}": ${this.msg(error)}`)
            throw error
        }
    }

    private ps(script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return this.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script])
    }

    private async winAction(action: WindowAction, monitor?: number): Promise<any> {
        const prelude = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int h2, bool r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
Add-Type -AssemblyName System.Windows.Forms
$h = [W32]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { throw "No hay ventana activa" }
`
        let script = prelude
        if (action === 'maximize') script += '[W32]::ShowWindow($h, 3) | Out-Null'
        else if (action === 'minimize') script += '[W32]::ShowWindow($h, 6) | Out-Null'
        else if (action === 'restore') script += '[W32]::ShowWindow($h, 9) | Out-Null'
        else if (action === 'snap-left' || action === 'snap-right') {
            const left = action === 'snap-left' ? '0' : '1'
            script += `$s = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea\n$hw = [int]($s.Width / 2)\n$x = ${left} -eq 0 ? $s.X : ($s.X + $hw)\n[W32]::MoveWindow($h, $x, $s.Y, $hw, $s.Height, $true) | Out-Null`
        } else if (action === 'center') {
            script += `$s = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea\n[W32]::GetWindowRect($h, [ref]$r = $null) | Out-Null\n$rect = New-Object W32+RECT\n[W32]::GetWindowRect($h, [ref]$rect) | Out-Null\n$w = $rect.R - $rect.L; $hh = $rect.B - $rect.T\n$x = $s.X + [int](($s.Width - $w) / 2); $y = $s.Y + [int](($s.Height - $hh) / 2)\n[W32]::MoveWindow($h, $x, $y, $w, $hh, $true) | Out-Null`
        } else {
            script += `$screens = [System.Windows.Forms.Screen]::AllScreens\n$i = ${monitor} % $screens.Length\n$b = $screens[$i].WorkingArea\n[W32]::ShowWindow($h, 9) | Out-Null\n[W32]::MoveWindow($h, $b.X + 50, $b.Y + 50, [int]($b.Width * 0.8), [int]($b.Height * 0.8), $true) | Out-Null`
        }
        const r = await this.ps(script)
        if (r.exitCode !== 0) throw new Error(`PowerShell no pudo colocar la ventana${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : ''}.`)
        return { platform: 'windows', method: 'user32', action, monitor: monitor ?? null, applied: true }
    }

    private async linuxAction(action: WindowAction, monitor?: number): Promise<any> {
        const hasWmctrl = await this.toolExists('wmctrl')
        const hasXdotool = await this.toolExists('xdotool')
        if (!hasWmctrl && !hasXdotool) throw missingToolError('wmctrl/xdotool', WMCTRL_HINT)
        const method = hasWmctrl ? 'wmctrl' : 'xdotool'
        if (method === 'xdotool' && (action === 'snap-left' || action === 'snap-right' || action === 'center' || action === 'move-to-monitor')) {
            throw new Error('Para acoplar/centrar/mover se necesita wmctrl (xdotool solo puede maximizar/minimizar). ' + WMCTRL_HINT)
        }
        if (method === 'wmctrl') {
            if (action === 'maximize') {
                const r = await this.run(['wmctrl', '-r', ':ACTIVE:', '-b', 'add,maximized_vert,maximized_horz'])
                this.checkOk(r, action)
            } else if (action === 'minimize') {
                const r = await this.run(['wmctrl', '-r', ':ACTIVE:', '-b', 'add,hidden'])
                if (r.exitCode !== 0 && hasXdotool) {
                    const f = await this.run(['xdotool', 'getactivewindow', 'windowminimize'])
                    this.checkOk(f, action)
                } else this.checkOk(r, action)
            } else if (action === 'restore') {
                const r = await this.run(['wmctrl', '-r', ':ACTIVE:', '-b', 'remove,maximized_vert,maximized_horz,hidden'])
                this.checkOk(r, action)
            } else {
                await this.linuxPlace(action, monitor)
            }
            return { platform: 'linux', method: 'wmctrl', action, monitor: monitor ?? null, applied: true }
        }
        // Solo xdotool: maximize/minimize/restore básico
        if (action === 'maximize') {
            const r = await this.run(['xdotool', 'getactivewindow', 'windowstate', '--add', 'MAXIMIZED_VERT', '--add', 'MAXIMIZED_HORZ'])
            this.checkOk(r, action)
        } else if (action === 'minimize') {
            const r = await this.run(['xdotool', 'getactivewindow', 'windowminimize'])
            this.checkOk(r, action)
        } else {
            const r = await this.run(['xdotool', 'getactivewindow', 'windowstate', '--remove', 'MAXIMIZED_VERT', '--remove', 'MAXIMIZED_HORZ'])
            this.checkOk(r, action)
        }
        return { platform: 'linux', method: 'xdotool', action, monitor: monitor ?? null, applied: true }
    }

    private async linuxPlace(action: WindowAction, monitor?: number): Promise<any> {
        const geo = await this.run(['xdotool', 'getdisplaygeometry'].filter(Boolean))
        let sw = 1920
        let sh = 1080
        const m = geo.stdout.trim().match(/(\d+)\s+(\d+)/)
        if (m) { sw = Number(m[1]); sh = Number(m[2]) }
        let x = 0, y = 0, w = sw, h = sh
        if (action === 'snap-left') { w = Math.floor(sw / 2) }
        else if (action === 'snap-right') { x = Math.floor(sw / 2); w = sw - x }
        else if (action === 'center') { w = Math.floor(sw * 0.7); h = Math.floor(sh * 0.7); x = Math.floor((sw - w) / 2); y = Math.floor((sh - h) / 2) }
        else if (action === 'move-to-monitor') {
            // Sin xrandr no conocemos la geometría de cada monitor: desplazamiento por índice.
            x = (monitor ?? 0) * sw
        }
        const r = await this.run(['wmctrl', '-r', ':ACTIVE:', '-e', `0,${x},${y},${w},${h}`])
        this.checkOk(r, action)
        return { x, y, w, h }
    }

    private async macAction(action: WindowAction, _monitor?: number): Promise<any> {
        if (action === 'move-to-monitor') {
            throw new Error('En macOS el movimiento entre monitores no está soportado con osascript (usa Mission Control o el menú Ventana).')
        }
        let script: string
        if (action === 'minimize') script = 'tell application "System Events" to set miniaturized of front window of (first process whose frontmost is true) to true'
        else if (action === 'maximize') script = 'tell application "System Events" to set zoomed of front window of (first process whose frontmost is true) to true'
        else if (action === 'restore') script = 'tell application "System Events" to set {miniaturized, zoomed} of front window of (first process whose frontmost is true) to {false, false}'
        else if (action === 'snap-left') script = 'tell application "System Events" to tell front window of (first process whose frontmost is true)\nset {sw, sh} to {1200, 800}\nset position to {0, 25}\nset size to {720, 800}\nend tell'
        else if (action === 'snap-right') script = 'tell application "System Events" to tell front window of (first process whose frontmost is true)\nset position to {720, 25}\nset size to {720, 800}\nend tell'
        else script = 'tell application "System Events" to tell front window of (first process whose frontmost is true)\nset position to {360, 150}\nset size to {720, 480}\nend tell'
        const r = await this.run(['osascript', '-e', script])
        if (r.exitCode !== 0) {
            throw new Error(`No se pudo colocar la ventana. Revisa el permiso de Accesibilidad para la app.${r.stderr.trim() ? ` Detalle: ${r.stderr.trim().slice(0, 300)}` : ''}`)
        }
        return { platform: 'macos', method: 'osascript', action, applied: true }
    }

    // ---------- layouts ----------

    private layoutKey(name: string): string {
        return `layout.${name}`
    }

    private readLayouts(): Record<string, any> {
        const out: Record<string, any> = {}
        try {
            const raw = this.context.getSetting?.('layouts')
            if (raw) {
                const parsed = JSON.parse(raw)
                if (parsed && typeof parsed === 'object') return parsed
            }
        } catch { /* corrupto: se reescribe */ }
        return out
    }

    private writeLayouts(layouts: Record<string, any>): void {
        this.context.setSetting?.('layouts', JSON.stringify(layouts))
    }

    private async executeLayoutSave(params: any, _context: any): Promise<any> {
        const { name, x, y, w, h, note } = params ?? {}
        if (typeof name !== 'string' || name.trim().length === 0) {
            throw new Error('Indica el "name" del layout (texto no vacío).')
        }
        const key = name.trim()
        if (!/^[A-Za-z0-9 _-]{1,64}$/.test(key)) {
            throw new Error('El nombre del layout solo admite letras, números, espacios, guiones (máx. 64).')
        }
        const hasGeometry = [x, y, w, h].every(v => typeof v === 'number' && Number.isFinite(v))
        const layouts = this.readLayouts()
        layouts[key] = {
            name: key,
            geometry: hasGeometry ? { x, y, w, h } : null,
            note: typeof note === 'string' ? note : '',
            platform: process.platform,
            savedAt: Date.now(),
        }
        this.writeLayouts(layouts)
        this.context.log('info', `Layout guardado: "${key}"`, { hasGeometry })
        return { saved: true, name: key, geometry: layouts[key].geometry, hint: hasGeometry ? undefined : 'Sin geometría: indica x/y/w/h para que "Restaurar layout" pueda colocarla.' }
    }

    private async executeLayoutRestore(params: any, context: any): Promise<any> {
        const { name } = params ?? {}
        if (typeof name !== 'string' || name.trim().length === 0) {
            throw new Error('Indica el "name" del layout a restaurar.')
        }
        const layouts = this.readLayouts()
        const layout = layouts[name.trim()]
        if (!layout) {
            const names = Object.keys(layouts)
            throw new Error(`No existe el layout "${name}".${names.length > 0 ? ` Guardados: ${names.join(', ')}.` : ' No hay layouts guardados.'}`)
        }
        const g = layout.geometry
        if (!g) {
            throw new Error(`El layout "${name}" no tiene geometría (se guardó sin x/y/w/h): edítalo con "Guardar layout" indicando la posición.`)
        }
        this.context.log('info', `Restaurando layout "${name}"`, g)
        const platform = process.platform
        if (platform === 'win32') {
            const script = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class W32 { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hh,bool r); }
"@\n$h=[W32]::GetForegroundWindow()\n[W32]::MoveWindow($h, ${g.x}, ${g.y}, ${g.w}, ${g.h}, $true) | Out-Null`
            const r = await this.ps(script)
            if (r.exitCode !== 0) throw new Error(`No se pudo aplicar el layout.${r.stderr.trim() ? ` Detalle: ${r.stderr.trim().slice(0, 200)}` : ''}`)
        } else if (platform === 'linux') {
            if (!(await this.toolExists('wmctrl'))) throw missingToolError('wmctrl', WMCTRL_HINT)
            const r = await this.run(['wmctrl', '-r', ':ACTIVE:', '-e', `0,${g.x},${g.y},${g.w},${g.h}`])
            this.checkOk(r, 'restaurar el layout')
        } else {
            const r = await this.run(['osascript', '-e', `tell application "System Events" to tell front window of (first process whose frontmost is true)\nset position to {${g.x}, ${g.y}}\nset size to {${g.w}, ${g.h}}\nend tell`])
            if (r.exitCode !== 0) throw new Error('No se pudo aplicar el layout (revisa el permiso de Accesibilidad).')
        }
        return { restored: true, name, geometry: g, action: 'layout-restore' }
    }

    private async executeLayoutList(_params: any, _context: any): Promise<any> {
        const layouts = this.readLayouts()
        return {
            layouts: Object.values(layouts).map((l: any) => ({ name: l.name, geometry: l.geometry, note: l.note, savedAt: l.savedAt })),
            count: Object.keys(layouts).length,
        }
    }

    private async toolExists(tool: string): Promise<boolean> {
        try {
            const cmd = process.platform === 'win32' ? ['where', tool] : ['which', tool]
            const r = await this.run(cmd)
            return r.exitCode === 0
        } catch {
            return false
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
