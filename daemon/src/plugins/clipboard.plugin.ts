/**
 * Native Clipboard Plugin
 * Portapapeles multi-slot: guarda/pega/lista slots e historial reciente.
 * Los slots viven en los ajustes del plugin; el sistema se lee/escribe con
 * PowerShell (Windows), pbpaste/pbcopy (macOS) o xclip/xsel/wl-clipboard (Linux).
 */

import { runCommand, isCommandNotFound } from './sysrun'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
    deleteSetting?: (key: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

interface SlotEntry {
    text: string
    updatedAt: number
}

interface HistoryEntry {
    text: string
    ts: number
    source: string
}

const MAX_HISTORY = 50
const MAX_TEXT = 100_000

function validSlot(slot: unknown): string {
    if (typeof slot !== 'string' && typeof slot !== 'number') {
        throw new Error('Indica el "slot" (nombre o número, ej. 1, "firma", "snippet-sql").')
    }
    const s = String(slot).trim()
    if (s.length === 0 || s.length > 64) throw new Error('El "slot" debe tener entre 1 y 64 caracteres.')
    if (!/^[A-Za-z0-9 _-]+$/.test(s)) throw new Error('El "slot" solo admite letras, números, espacios y guiones.')
    return s
}

export class ClipboardPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    /** Punto de inyección para tests (lectura real del portapapeles). */
    protected async readSystemClipboard(): Promise<string> {
        const platform = process.platform
        if (platform === 'win32') {
            const r = await runCommand(['powershell.exe', '-NoProfile', '-Command', 'Get-Clipboard -Raw'])
            if (r.exitCode !== 0) throw new Error(`No se pudo leer el portapapeles.${r.stderr.trim() ? ` Detalle: ${r.stderr.trim().slice(0, 200)}` : ''}`)
            return r.stdout
        }
        if (platform === 'darwin') {
            const r = await runCommand(['pbpaste'])
            if (r.exitCode !== 0) throw new Error('No se pudo leer el portapapeles con pbpaste.')
            return r.stdout
        }
        const tools: Array<[string, string[]]> = [['xclip', ['xclip', '-selection', 'clipboard', '-o']], ['xsel', ['xsel', '--clipboard', '--output']], ['wl-paste', ['wl-paste', '--no-newline']]]
        for (const [name, cmd] of tools) {
            try {
                const r = await runCommand(cmd)
                if (r.exitCode === 0) return r.stdout
            } catch (error) {
                if (!isCommandNotFound(error) && (error as any)?.code !== 'COMMAND_NOT_FOUND') throw error
            }
        }
        throw new Error('No hay herramienta de portapapeles en Linux: instala xclip, xsel o wl-clipboard (ej. "sudo apt install xclip").')
    }

    /** Punto de inyección para tests (escritura real al portapapeles). */
    protected async writeSystemClipboard(text: string): Promise<void> {
        const platform = process.platform
        if (platform === 'win32') {
            const b64 = Buffer.from(text, 'utf8').toString('base64')
            const script = `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t`
            const r = await runCommand(['powershell.exe', '-NoProfile', '-Command', script])
            if (r.exitCode !== 0) throw new Error(`No se pudo escribir en el portapapeles.${r.stderr.trim() ? ` Detalle: ${r.stderr.trim().slice(0, 200)}` : ''}`)
            return
        }
        if (platform === 'darwin') {
            const proc = Bun.spawn(['pbcopy'], { windowsHide: true,  stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' } as any)
            try {
                await new Response(proc.stdin as any).text().catch(() => {})
            } catch { /* pbcopy lee de stdin de otra forma */ }
            // Fallback simple: printf por tubería mediante shell
            const r = await runCommand(['sh', '-c', 'pbcopy'], { stdin: text } as any).catch(() => null)
            if (!r || r.exitCode !== 0) throw new Error('No se pudo escribir en el portapapeles con pbcopy.')
            await proc.exited.catch(() => {})
            return
        }
        const attempts: Array<{ name: string; cmd: string[]; stdin?: boolean }> = [
            { name: 'xclip', cmd: ['xclip', '-selection', 'clipboard'], stdin: true },
            { name: 'xsel', cmd: ['xsel', '--clipboard', '--input'], stdin: true },
            { name: 'wl-copy', cmd: ['wl-copy'], stdin: true },
        ]
        for (const a of attempts) {
            try {
                const r = await runCommand(a.cmd, { stdin: text } as any)
                if (r.exitCode === 0) return
            } catch (error) {
                if (!isCommandNotFound(error) && (error as any)?.code !== 'COMMAND_NOT_FOUND') throw error
            }
        }
        throw new Error('No hay herramienta de portapapeles en Linux: instala xclip, xsel o wl-clipboard (ej. "sudo apt install xclip").')
    }

    public getManifest() {
        return {
            id: 'clipboard',
            name: 'Portapapeles',
            version: '1.0.2',
            description: 'Slots de portapapeles: guarda, pega, lista e historial',
            author: 'BunDeck',
            permissions: ['system'],
            instructions:
                'Varios portapapeles con nombre.\n\n' +
                '· "save-slot": guarda texto en un slot (si no indicas texto, captura el portapapeles actual).\n' +
                '· "paste-slot": copia el contenido del slot al portapapeles del sistema (listo para pegar con Ctrl+V).\n' +
                '· "history": últimos textos guardados/pegados (máx. 50).\n' +
                'En Linux necesitas xclip, xsel o wl-clipboard.',
            actions: [
                {
                    id: 'save-slot',
                    name: 'Guardar slot',
                    description: 'Guarda texto en un slot (o captura el portapapeles actual)',
                    i18n: { es: { name: 'Guardar slot', description: 'Guarda texto en un slot (o captura el portapapeles actual)' }, en: { name: 'Guardar slot', description: 'Guarda texto en un slot (o captura el portapapeles actual)' } }, // TODO i18n: EN temporal = ES
                    icon: 'ClipboardCopy',
                    surface: 'control',
                    component: 'workflow-control',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            slot: {
                                type: 'string', title: 'Slot',
                                ui: { component: 'input', type: 'text', placeholder: '1, firma, snippet-sql…' }
                            },
                            text: {
                                type: 'string', title: 'Texto',
                                description: 'Si se omite, se captura el portapapeles actual del sistema',
                                ui: { component: 'textarea', placeholder: '(vacío = capturar portapapeles)' }
                            }
                        },
                        required: ['slot']
                    }
                },
                {
                    id: 'paste-slot',
                    name: 'Pegar slot',
                    description: 'Copia el slot al portapapeles del sistema',
                    i18n: { es: { name: 'Pegar slot', description: 'Copia el slot al portapapeles del sistema' }, en: { name: 'Pegar slot', description: 'Copia el slot al portapapeles del sistema' } }, // TODO i18n: EN temporal = ES
                    icon: 'ClipboardPaste',
                    surface: 'control',
                    component: 'workflow-control',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            slot: {
                                type: 'string', title: 'Slot',
                                ui: { component: 'input', type: 'text', placeholder: '1, firma, snippet-sql…' }
                            }
                        },
                        required: ['slot']
                    }
                },
                {
                    id: 'list-slots',
                    name: 'Listar slots',
                    description: 'Muestra los slots guardados (vista previa)',
                    i18n: { es: { name: 'Listar slots', description: 'Muestra los slots guardados (vista previa)' }, en: { name: 'Listar slots', description: 'Muestra los slots guardados (vista previa)' } }, // TODO i18n: EN temporal = ES
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
                },
                {
                    id: 'history',
                    name: 'Historial',
                    description: 'Últimos textos guardados o pegados',
                    i18n: { es: { name: 'Historial', description: 'Últimos textos guardados o pegados' }, en: { name: 'Historial', description: 'Últimos textos guardados o pegados' } }, // TODO i18n: EN temporal = ES
                    icon: 'History',
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
                            },
                            limit: {
                                type: 'number', title: 'Límite',
                                default: 10, minimum: 1, maximum: 50,
                                ui: { component: 'input', type: 'number', min: 1, max: 50, placeholder: '10' }
                            }
                        }
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('save-slot', this.executeSaveSlot.bind(this))
        handlers.set('paste-slot', this.executePasteSlot.bind(this))
        handlers.set('list-slots', this.executeListSlots.bind(this))
        handlers.set('history', this.executeHistory.bind(this))
        return handlers
    }

    private readSlots(): Record<string, SlotEntry> {
        try {
            const raw = this.context.getSetting?.('slots')
            if (!raw) return {}
            const parsed = JSON.parse(raw)
            return parsed && typeof parsed === 'object' ? parsed : {}
        } catch {
            return {}
        }
    }

    private writeSlots(slots: Record<string, SlotEntry>): void {
        this.context.setSetting?.('slots', JSON.stringify(slots))
    }

    private readHistory(): HistoryEntry[] {
        try {
            const raw = this.context.getSetting?.('history')
            if (!raw) return []
            const parsed = JSON.parse(raw)
            return Array.isArray(parsed) ? parsed : []
        } catch {
            return []
        }
    }

    private pushHistory(text: string, source: string): void {
        const hist = this.readHistory()
        hist.unshift({ text: text.slice(0, 2000), ts: Date.now(), source })
        this.context.setSetting?.('history', JSON.stringify(hist.slice(0, MAX_HISTORY)))
    }

    private preview(text: string, len = 60): string {
        const flat = text.replace(/\s+/g, ' ')
        return flat.length > len ? flat.slice(0, len) + '…' : flat
    }

    private async executeSaveSlot(params: any, _context: any): Promise<any> {
        const slot = validSlot(params?.slot)
        let text = params?.text
        let captured = false
        if (text === undefined || text === null || String(text).length === 0) {
            text = await this.readSystemClipboard()
            captured = true
        }
        text = String(text)
        if (text.length === 0) throw new Error('Nada que guardar: el texto está vacío y el portapapeles también.')
        if (text.length > MAX_TEXT) throw new Error(`Texto demasiado largo (${text.length} caracteres, máx. ${MAX_TEXT}).`)
        const slots = this.readSlots()
        slots[slot] = { text, updatedAt: Date.now() }
        this.writeSlots(slots)
        this.pushHistory(text, `save:${slot}`)
        this.context.log('info', `Portapapeles: slot "${slot}" guardado (${text.length} caracteres${captured ? ', capturado' : ''})`)
        return { slot, saved: true, captured, length: text.length, preview: this.preview(text) }
    }

    private async executePasteSlot(params: any, _context: any): Promise<any> {
        const slot = validSlot(params?.slot)
        const slots = this.readSlots()
        const entry = slots[slot]
        if (!entry) {
            const names = Object.keys(slots)
            throw new Error(`El slot "${slot}" está vacío.${names.length > 0 ? ` Slots con contenido: ${names.join(', ')}.` : ' No hay slots guardados.'}`)
        }
        await this.writeSystemClipboard(entry.text)
        this.pushHistory(entry.text, `paste:${slot}`)
        this.context.log('info', `Portapapeles: slot "${slot}" copiado al sistema (pega con Ctrl+V)`)
        return { slot, pasted: true, length: entry.text.length, preview: this.preview(entry.text), hint: 'Contenido en el portapapeles: pega con Ctrl+V (o Cmd+V en macOS).' }
    }

    private async executeListSlots(_params: any, _context: any): Promise<any> {
        const slots = this.readSlots()
        return {
            slots: Object.entries(slots).map(([name, e]) => ({
                slot: name, length: e.text.length, preview: this.preview(e.text), updatedAt: e.updatedAt,
            })),
            count: Object.keys(slots).length,
        }
    }

    private async executeHistory(params: any, _context: any): Promise<any> {
        const limit = params?.limit ?? 10
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY) {
            throw new Error(`El "limit" debe ser un entero entre 1 y ${MAX_HISTORY}.`)
        }
        const hist = this.readHistory().slice(0, limit)
        return {
            entries: hist.map(h => ({ preview: this.preview(h.text, 80), length: h.text.length, ts: h.ts, source: h.source })),
            count: hist.length,
        }
    }

    public dispose(): void {
        // Sin recursos persistentes
    }
}
