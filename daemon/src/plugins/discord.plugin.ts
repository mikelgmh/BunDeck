/**
 * Native Discord Plugin
 * Controla Discord mediante atajos de teclado configurables + apertura de canales.
 *
 * Discord no expone una API local pública estable, así que la integración real
 * se hace como lo haría un Stream Deck: el botón envía el atajo de teclado
 * global que tengas configurado en Discord (Ajustes → Atajos de teclado) y
 * Discord ejecuta la acción. Sin dependencias externas: solo Bun/Node builtins.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const MOD_ALIASES: Record<string, string> = {
    ctrl: 'ctrl', control: 'ctrl',
    alt: 'alt', option: 'alt',
    shift: 'shift',
    meta: 'meta', win: 'meta', super: 'meta', cmd: 'meta', command: 'meta',
}

function parseHotkey(hotkey: string): { modifiers: string[]; key: string } {
    const parts = String(hotkey ?? '').split('+').map((p) => p.trim().toLowerCase()).filter(Boolean)
    if (parts.length === 0) {
        throw new Error('El parámetro "hotkey" está vacío: indica el atajo global configurado en Discord (ej. "ctrl+shift+m").')
    }
    const modifiers: string[] = []
    let key = ''
    for (const p of parts) {
        const mod = MOD_ALIASES[p]
        if (mod) {
            if (!modifiers.includes(mod)) modifiers.push(mod)
        } else {
            key = p
        }
    }
    if (!key) {
        throw new Error(`El atajo "${hotkey}" no incluye tecla principal: usa el formato "ctrl+shift+m".`)
    }
    return { modifiers, key }
}

/** Mapa mínimo tecla → código virtual (Windows) / key code (macOS). */
function winVk(key: string): number {
    if (/^[a-z]$/.test(key)) return 0x41 + (key.charCodeAt(0) - 97)
    if (/^[0-9]$/.test(key)) return 0x30 + Number(key)
    const m = key.match(/^f([1-9]|1[0-2])$/)
    if (m) return 0x6f + Number(m[1])
    const extra: Record<string, number> = {
        space: 0x20, enter: 0x0d, return: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b,
        backspace: 0x08, delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
        pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
    }
    if (extra[key] !== undefined) return extra[key]
    throw new Error(`Tecla no soportada en Windows: "${key}". Usa letras, dígitos o F1–F12.`)
}

function macKeyCode(key: string): number {
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    if (key.length === 1 && letters.includes(key)) {
        return [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6][letters.indexOf(key)]
    }
    if (/^[0-9]$/.test(key)) return [29, 18, 19, 20, 21, 23, 22, 26, 28, 25][Number(key)]
    const m = key.match(/^f([1-9]|1[0-2])$/)
    if (m) return [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111][Number(m[1]) - 1]
    const extra: Record<string, number> = {
        space: 49, enter: 36, return: 36, tab: 48, escape: 53, esc: 53,
        delete: 51, backspace: 51, up: 126, down: 125, left: 123, right: 124,
    }
    if (extra[key] !== undefined) return extra[key]
    throw new Error(`Tecla no soportada en macOS: "${key}". Usa letras, dígitos o F1–F12.`)
}

async function runCmd(cmd: string[], label: string): Promise<{ stdout: string; stderr: string }> {
    let proc: any
    try {
        proc = Bun.spawn({ cmd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
        throw new Error(`No se pudo lanzar la herramienta del sistema para "${label}": ${err instanceof Error ? err.message : String(err)}`)
    }
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    if (proc.exitCode !== 0) {
        throw new Error(`Falló el envío del atajo (${label}, código ${proc.exitCode}): ${stderr.trim() || stdout.trim() || 'sin detalle'}`)
    }
    return { stdout, stderr }
}

/**
 * Envía un atajo de teclado al sistema. Si holdMs > 0 mantiene las teclas
 * pulsadas ese tiempo (para push-to-talk) y luego las suelta.
 */
export async function sendHotkey(hotkey: string, holdMs = 0): Promise<{ hotkey: string; heldMs: number; platform: string }> {
    const { modifiers, key } = parseHotkey(hotkey)
    const hold = Math.max(0, Math.min(Math.floor(holdMs || 0), 30000))
    const platform = process.platform

    if (platform === 'win32') {
        const vk = winVk(key)
        const modVk: Record<string, number> = { ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b }
        const downs = modifiers.map((m) => modVk[m])
        const seq = (flags: (vkCode: number, up: boolean) => string) =>
            [...downs.map((v) => flags(v, false)), flags(vk, false), ...(hold > 0 ? [] : [flags(vk, true)]), ...downs.reverse().map((v) => flags(v, true))].join('; ')
        void seq
        const press = (v: number, up: boolean) => `[K]::keybd_event(${v}, 0, ${up ? '2' : '0'}, [UIntPtr]::Zero)`
        const prelude = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo); }'; `
        const downScript = prelude + [...downs.map((v) => press(v, false)), press(vk, false)].join('; ')
        if (hold > 0) {
            await runCmd(['powershell.exe', '-NoProfile', '-Command', downScript], 'hotkey-down')
            await new Promise((r) => setTimeout(r, hold))
            const upScript = prelude + [press(vk, true), ...downs.reverse().map((v) => press(v, true))].join('; ')
            await runCmd(['powershell.exe', '-NoProfile', '-Command', upScript], 'hotkey-up')
        } else {
            const tapScript = prelude + [...downs.map((v) => press(v, false)), press(vk, false), press(vk, true), ...downs.reverse().map((v) => press(v, true))].join('; ')
            await runCmd(['powershell.exe', '-NoProfile', '-Command', tapScript], 'hotkey')
        }
        return { hotkey, heldMs: hold, platform: 'windows' }
    }

    if (platform === 'darwin') {
        const code = macKeyCode(key)
        const flagMap: Record<string, string> = { ctrl: 'control down', alt: 'option down', shift: 'shift down', meta: 'command down' }
        const flags = modifiers.map((m) => flagMap[m]).filter(Boolean)
        const using = flags.length > 0 ? ` using {${flags.join(', ')}}` : ''
        if (hold > 0) {
            await runCmd(['osascript', '-e', `tell application "System Events" to key down (key code ${code}${using})`], 'hotkey-down')
            await new Promise((r) => setTimeout(r, hold))
            await runCmd(['osascript', '-e', `tell application "System Events" to key up (key code ${code}${using})`], 'hotkey-up')
        } else {
            await runCmd(['osascript', '-e', `tell application "System Events" to key code ${code}${using}`], 'hotkey')
        }
        return { hotkey, heldMs: hold, platform: 'macos' }
    }

    if (platform === 'linux') {
        const keyMap: Record<string, string> = { esc: 'Escape', enter: 'Return', return: 'Return', space: 'space', backspace: 'BackSpace', delete: 'Delete' }
        const main = keyMap[key] ?? (key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1))
        const combo = [...modifiers.map((m) => (m === 'meta' ? 'super' : m === 'ctrl' ? 'ctrl' : m)), main].join('+')
        if (hold > 0) {
            await runCmd(['xdotool', 'keydown', combo], 'hotkey-down').catch(() => {
                throw new Error('No se pudo enviar el atajo en Linux: instala "xdotool" (sudo apt install xdotool) o "ydotool" para Wayland.')
            })
            await new Promise((r) => setTimeout(r, hold))
            await runCmd(['xdotool', 'keyup', combo], 'hotkey-up')
        } else {
            await runCmd(['xdotool', 'key', combo], 'hotkey').catch(() => {
                throw new Error('No se pudo enviar el atajo en Linux: instala "xdotool" (sudo apt install xdotool) o "ydotool" para Wayland.')
            })
        }
        return { hotkey, heldMs: hold, platform: 'linux' }
    }

    throw new Error(`Envío de atajos no soportado en la plataforma: ${platform}`)
}

export async function openUrl(url: string): Promise<void> {
    const platform = process.platform
    if (platform === 'win32') {
        await runCmd(['cmd', '/c', 'start', '""', url], 'open-url')
    } else if (platform === 'darwin') {
        await runCmd(['open', url], 'open-url')
    } else if (platform === 'linux') {
        await runCmd(['xdg-open', url], 'open-url')
    } else {
        throw new Error(`No se puede abrir URLs en la plataforma: ${platform}`)
    }
}

export class DiscordPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'discord',
            name: 'Discord',
            version: '1.0.0',
            description: 'Controla Discord (mutear, ensordecer, pulsar-para-hablar y abrir canales) mediante atajos globales',
            author: 'BunDeck',
            permissions: ['keyboard', 'process'],
            settingsSchema: {
                type: 'object',
                properties: {
                    muteHotkey: {
                        type: 'string', title: 'Atajo de silenciar',
                        description: 'Atajo global de "Silenciar" tal como está en Discord (Ajustes → Atajos de teclado)',
                        default: 'ctrl+shift+m',
                        ui: { component: 'input', type: 'text', placeholder: 'ctrl+shift+m' }
                    },
                    deafenHotkey: {
                        type: 'string', title: 'Atajo de ensordecer',
                        description: 'Atajo global de "Ensordecerse" tal como está en Discord',
                        default: 'ctrl+shift+d',
                        ui: { component: 'input', type: 'text', placeholder: 'ctrl+shift+d' }
                    },
                    pushToTalkHotkey: {
                        type: 'string', title: 'Atajo de pulsar-para-hablar',
                        description: 'Atajo de "Pulsar para hablar" de Discord (se mantiene pulsado holdMs)',
                        ui: { component: 'input', type: 'text', placeholder: 'ej. ctrl+shift+p' }
                    }
                }
            },
            instructions: 'Discord no tiene API local pública, así que este plugin pulsa tus atajos globales:\n\n1. En Discord ve a Ajustes → Atajos de teclado y crea atajos GLOBALES para Silenciar, Ensordecerse y Pulsar para hablar.\n2. Copia esos mismos atajos en los ajustes de este plugin (o en cada botón).\n3. Discord debe estar en ejecución para que los atajos globales funcionen.',
            actions: [
                {
                    id: 'toggle-mute', name: 'Silenciar / reactivar micro', icon: 'MicOff',
                    description: 'Alterna el micrófono en Discord (envía tu atajo global de Silenciar)',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: {
                                type: 'string', title: 'Atajo',
                                description: 'Atajo global de Silenciar en Discord (si se omite usa el de los ajustes)',
                                ui: { component: 'input', type: 'text', placeholder: 'ctrl+shift+m' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'toggle-deafen', name: 'Ensordecerse / volver', icon: 'Headphones',
                    description: 'Alterna ensordecer en Discord (envía tu atajo global de Ensordecerse)',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: {
                                type: 'string', title: 'Atajo',
                                description: 'Atajo global de Ensordecerse en Discord (si se omite usa el de los ajustes)',
                                ui: { component: 'input', type: 'text', placeholder: 'ctrl+shift+d' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'push-to-talk', name: 'Pulsar para hablar', icon: 'Radio',
                    description: 'Mantiene pulsado tu atajo de Pulsar para hablar durante holdMs milisegundos',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: {
                                type: 'string', title: 'Atajo',
                                description: 'Atajo de Pulsar para hablar en Discord (si se omite usa el de los ajustes)',
                                ui: { component: 'input', type: 'text', placeholder: 'ej. ctrl+shift+p' }
                            },
                            holdMs: {
                                type: 'number', title: 'Duración (ms)',
                                description: 'Tiempo que se mantiene pulsado (máx. 30000 ms)',
                                default: 1000, minimum: 100, maximum: 30000,
                                ui: { component: 'input', type: 'number', placeholder: '1000' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'open-channel', name: 'Abrir canal de Discord', icon: 'MessageCircle',
                    description: 'Abre un canal, mensaje o invitación de Discord en el navegador/app',
                    schema: {
                        type: 'object',
                        properties: {
                            url: {
                                type: 'string', title: 'URL del canal',
                                description: 'URL https://discord.com/channels/... o https://discord.gg/...',
                                ui: { component: 'input', type: 'text', placeholder: 'https://discord.com/channels/123/456' }
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
        handlers.set('toggle-mute', this.executeToggleMute.bind(this))
        handlers.set('toggle-deafen', this.executeToggleDeafen.bind(this))
        handlers.set('push-to-talk', this.executePushToTalk.bind(this))
        handlers.set('open-channel', this.executeOpenChannel.bind(this))
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

    private resolveHotkey(params: any, paramKey: string, settingKey: string, fallback: string): string {
        const fromParams = typeof params?.[paramKey] === 'string' && params[paramKey].trim() ? params[paramKey].trim() : null
        return fromParams ?? this.setting(settingKey) ?? fallback
    }

    private async executeToggleMute(params: any, _context: any): Promise<any> {
        const hotkey = this.resolveHotkey(params, 'hotkey', 'muteHotkey', 'ctrl+shift+m')
        this.context.log('info', `Discord: alternando micro con atajo "${hotkey}"`)
        try {
            const res = await sendHotkey(hotkey)
            return { action: 'toggle-mute', hotkey, ...res, note: 'Discord debe estar en ejecución con ese atajo global configurado.' }
        } catch (error) {
            this.context.log('error', `Discord: no se pudo silenciar: ${error}`)
            throw error
        }
    }

    private async executeToggleDeafen(params: any, _context: any): Promise<any> {
        const hotkey = this.resolveHotkey(params, 'hotkey', 'deafenHotkey', 'ctrl+shift+d')
        this.context.log('info', `Discord: alternando ensordecer con atajo "${hotkey}"`)
        try {
            const res = await sendHotkey(hotkey)
            return { action: 'toggle-deafen', hotkey, ...res, note: 'Discord debe estar en ejecución con ese atajo global configurado.' }
        } catch (error) {
            this.context.log('error', `Discord: no se pudo ensordecer: ${error}`)
            throw error
        }
    }

    private async executePushToTalk(params: any, _context: any): Promise<any> {
        const hotkey = this.resolveHotkey(params, 'hotkey', 'pushToTalkHotkey', '')
        if (!hotkey) {
            throw new Error('Falta el atajo de "Pulsar para hablar": configúralo en Discord (Ajustes → Atajos de teclado) y ponlo en los ajustes del plugin o en el parámetro "hotkey".')
        }
        const holdMs = typeof params?.holdMs === 'number' && Number.isFinite(params.holdMs) ? params.holdMs : 1000
        this.context.log('info', `Discord: pulsar-para-hablar "${hotkey}" durante ${holdMs} ms`)
        try {
            const res = await sendHotkey(hotkey, holdMs)
            return { action: 'push-to-talk', hotkey, ...res }
        } catch (error) {
            this.context.log('error', `Discord: falló pulsar-para-hablar: ${error}`)
            throw error
        }
    }

    private async executeOpenChannel(params: any, _context: any): Promise<any> {
        const url = typeof params?.url === 'string' ? params.url.trim() : ''
        if (!url) {
            throw new Error('La acción "Abrir canal" requiere el parámetro "url" (ej. https://discord.com/channels/123/456).')
        }
        if (!/^https:\/\/(discord\.com|discord\.gg|discordapp\.com)\//.test(url)) {
            throw new Error(`URL de Discord no válida: "${url}". Usa https://discord.com/channels/... o https://discord.gg/....`)
        }
        this.context.log('info', `Discord: abriendo ${url}`)
        try {
            await openUrl(url)
            return { action: 'open-channel', url, opened: true }
        } catch (error) {
            this.context.log('error', `Discord: no se pudo abrir el canal: ${error}`)
            throw error
        }
    }

    public dispose(): void {
        // Sin estado persistente.
    }
}
