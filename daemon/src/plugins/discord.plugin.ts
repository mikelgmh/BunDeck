/**
 * Native Discord Plugin — voz en background (RPC) + fallback a atajos globales.
 *
 * Zero-config para el usuario final: SOLO pulsa Autorizar. La app de Discord
 * la crea el maintainer una vez (docs/discord-app-setup.md); el client_secret
 * vive únicamente en el relay, nunca en el binario. Camino power-user intacto:
 * con Client ID + Secret propios en ajustes, el intercambio es directo.
 *
 * Modo `rpc` (como el plugin oficial de Elgato): habla con el cliente Discord
 * local vía RPC (WebSocket 127.0.0.1:6463-6472) con OAuth (scopes
 * identify/rpc/rpc.voice.write). Discord pide permiso EXPLÍCITO una vez
 * (popup "Authorize"); el token queda en local y se renueva solo. Funciona
 * con el juego en primer plano: sin foco ni teclas.
 *
 * Modo `hotkey` (legacy/fallback): envía el atajo de teclado GLOBAL
 * configurado en Discord (Ajustes → Atajos de teclado). Requiere que Discord
 * esté en ejecución; NO necesita foco si el atajo es global. Sin dependencias
 * externas: solo Bun/Node builtins.
 */

import {
    DISCORD_DEFAULT_REDIRECT_URI,
    DISCORD_RPC_SCOPES,
    DiscordRpcConnection,
    DiscordRpcError,
    buildDiscordAuthorizeUrl,
    buildDiscordNeedsAuth,
    discordNotConfiguredMessage,
    exchangeDiscordCode,
    exchangeDiscordCodeViaProxy,
    isDiscordTokenExpired,
    normalizeDiscordTokenCapture,
    refreshDiscordToken,
    refreshDiscordTokenViaProxy,
    resolveDiscordClientId,
    resolveDiscordProxyUrl,
    resolveDiscordRedirectUri,
    resolveDiscordMode,
    type DiscordMode,
    type RpcConnectionOptions,
    type RpcVoiceState,
} from './discord-rpc'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
    deleteSetting?: (key: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

/** Inyección de dependencias (tests): por defecto lo real. */
export interface DiscordPluginDeps {
    hotkeyTap?: (hotkey: string, holdMs?: number) => Promise<{ hotkey: string; heldMs: number; platform: string }>
    hotkeyDown?: (hotkey: string) => Promise<{ hotkey: string; platform: string }>
    hotkeyUp?: (hotkey: string) => Promise<{ hotkey: string; platform: string }>
    openUrlFn?: (url: string) => Promise<void>
    createRpcConnection?: (opts: RpcConnectionOptions) => DiscordRpcConnection
    fetchFn?: typeof fetch
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
        proc = Bun.spawn({ windowsHide: true,  cmd, stdio: ['ignore', 'pipe', 'pipe'] })
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

/** Pulsa (down) un atajo. Para soltarlo usa `hotkeyUp` (push-to-talk press/release). */
export async function hotkeyDown(hotkey: string): Promise<{ hotkey: string; platform: string }> {
    const { modifiers, key } = parseHotkey(hotkey)
    const platform = process.platform

    if (platform === 'win32') {
        const vk = winVk(key)
        const modVk: Record<string, number> = { ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b }
        const press = (v: number, up: boolean) => `[K]::keybd_event(${v}, 0, ${up ? '2' : '0'}, [UIntPtr]::Zero)`
        const prelude = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo); }'; `
        const script = prelude + [...modifiers.map((m) => modVk[m]), vk].map((v) => press(v, false)).join('; ')
        await runCmd(['powershell.exe', '-NoProfile', '-Command', script], 'hotkey-down')
        return { hotkey, platform: 'windows' }
    }

    if (platform === 'darwin') {
        const code = macKeyCode(key)
        const flagMap: Record<string, string> = { ctrl: 'control down', alt: 'option down', shift: 'shift down', meta: 'command down' }
        const flags = modifiers.map((m) => flagMap[m]).filter(Boolean)
        const using = flags.length > 0 ? ` using {${flags.join(', ')}}` : ''
        await runCmd(['osascript', '-e', `tell application "System Events" to key down (key code ${code}${using})`], 'hotkey-down')
        return { hotkey, platform: 'macos' }
    }

    if (platform === 'linux') {
        const keyMap: Record<string, string> = { esc: 'Escape', enter: 'Return', return: 'Return', space: 'space', backspace: 'BackSpace', delete: 'Delete' }
        const main = keyMap[key] ?? (key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1))
        const combo = [...modifiers.map((m) => (m === 'meta' ? 'super' : m === 'ctrl' ? 'ctrl' : m)), main].join('+')
        await runCmd(['xdotool', 'keydown', combo], 'hotkey-down').catch(() => {
            throw new Error('No se pudo enviar el atajo en Linux: instala "xdotool" (sudo apt install xdotool) o "ydotool" para Wayland.')
        })
        return { hotkey, platform: 'linux' }
    }

    throw new Error(`Envío de atajos no soportado en la plataforma: ${platform}`)
}

/** Suelta (up) un atajo previamente pulsado con `hotkeyDown`. */
export async function hotkeyUp(hotkey: string): Promise<{ hotkey: string; platform: string }> {
    const { modifiers, key } = parseHotkey(hotkey)
    const platform = process.platform

    if (platform === 'win32') {
        const vk = winVk(key)
        const modVk: Record<string, number> = { ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b }
        const press = (v: number, up: boolean) => `[K]::keybd_event(${v}, 0, ${up ? '2' : '0'}, [UIntPtr]::Zero)`
        const prelude = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo); }'; `
        const script = prelude + [vk, ...modifiers.map((m) => modVk[m]).reverse()].map((v) => press(v, true)).join('; ')
        await runCmd(['powershell.exe', '-NoProfile', '-Command', script], 'hotkey-up')
        return { hotkey, platform: 'windows' }
    }

    if (platform === 'darwin') {
        const code = macKeyCode(key)
        const flagMap: Record<string, string> = { ctrl: 'control down', alt: 'option down', shift: 'shift down', meta: 'command down' }
        const flags = modifiers.map((m) => flagMap[m]).filter(Boolean)
        const using = flags.length > 0 ? ` using {${flags.join(', ')}}` : ''
        await runCmd(['osascript', '-e', `tell application "System Events" to key up (key code ${code}${using})`], 'hotkey-up')
        return { hotkey, platform: 'macos' }
    }

    if (platform === 'linux') {
        const keyMap: Record<string, string> = { esc: 'Escape', enter: 'Return', return: 'Return', space: 'space', backspace: 'BackSpace', delete: 'Delete' }
        const main = keyMap[key] ?? (key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1))
        const combo = [...modifiers.map((m) => (m === 'meta' ? 'super' : m === 'ctrl' ? 'ctrl' : m)), main].join('+')
        await runCmd(['xdotool', 'keyup', combo], 'hotkey-up').catch(() => {
            throw new Error('No se pudo enviar el atajo en Linux: instala "xdotool" (sudo apt install xdotool) o "ydotool" para Wayland.')
        })
        return { hotkey, platform: 'linux' }
    }

    throw new Error(`Envío de atajos no soportado en la plataforma: ${platform}`)
}

/**
 * Envía un atajo de teclado al sistema. Si holdMs > 0 mantiene las teclas
 * pulsadas ese tiempo (para push-to-talk) y luego las suelta.
 */
export async function sendHotkey(hotkey: string, holdMs = 0): Promise<{ hotkey: string; heldMs: number; platform: string }> {
    parseHotkey(hotkey) // valida primero: mismos mensajes de error que antes
    const hold = Math.max(0, Math.min(Math.floor(holdMs || 0), 30000))
    const down = await hotkeyDown(hotkey)
    if (hold > 0) {
        await new Promise((r) => setTimeout(r, hold))
    }
    await hotkeyUp(hotkey)
    return { hotkey, heldMs: hold, platform: down.platform }
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

interface RpcConfig {
    /** Client ID resuelto: ajuste del usuario (power-user) ?? env ?? baked-in. */
    clientId: string | null
    /** Client Secret SOLO del usuario: nunca hay secret baked-in (se extraería del binario). */
    clientSecret: string | null
    redirectUri: string
    /** Relay code→token resuelto: ajuste proxyUrl ?? env ?? baked-in. */
    proxyUrl: string | null
    /** Lo que puso el usuario en ajustes (para detectar power-user). */
    userClientId: string | null
    accessToken: string | null
    refreshToken: string | null
    tokenExpiresAt: string | null
}

export class DiscordPlugin {
    private context: PluginContext
    private deps: DiscordPluginDeps
    private rpc: DiscordRpcConnection | null = null

    constructor(context: PluginContext, deps: DiscordPluginDeps = {}) {
        this.context = context
        this.deps = deps
    }

    public getManifest() {
        return {
            id: 'discord',
            name: 'Discord',
            version: '1.2.0',
            description: 'Controla Discord en background vía RPC (mute/deafen/pulsar-para-hablar sin foco), con fallback a atajos globales. Conexión en 1 clic: solo pulsa Autorizar.',
            author: 'BunDeck',
            permissions: ['keyboard', 'process', 'network'],
            // Zero-config: el dialog muestra "Autorizar con Discord" y el
            // usuario no crea ninguna app ni copia claves. Solo power-users
            // con app propia rellenan Client ID/Secret (intercambio directo).
            oauth: {
                provider: 'discord',
                method: 'oauth-code',
                scopes: [...DISCORD_RPC_SCOPES],
                redirectUri: DISCORD_DEFAULT_REDIRECT_URI,
                notes: 'Un solo clic en Autorizar: LibreDeck usa su propia app de Discord, no necesitas crear nada ni copiar claves. Discord te pedirá permiso explícito UNA vez (popup "Authorize"); el token queda en local y se renueva solo. Sin este paso se usan atajos globales.',
            },
            settingsSchema: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string', title: 'Modo de control',
                        description: 'auto: intenta RPC en background y cae a atajos solo si no hay autorización. rpc: solo RPC (error claro si falta algo). hotkey: solo atajos globales.',
                        default: 'auto',
                        enum: ['auto', 'rpc', 'hotkey'],
                        ui: { component: 'select', options: [{ value: 'auto', label: 'Auto (RPC + fallback)' }, { value: 'rpc', label: 'Solo RPC (background)' }, { value: 'hotkey', label: 'Solo atajos globales' }] }
                    },
                    clientId: {
                        type: 'string', title: 'Client ID (avanzado: solo app propia)',
                        description: 'Opcional. Por defecto se usa el Client ID de LibreDeck (cero-config, 1 clic). Solo si usas TU propia app de Discord, pega su Client ID (discord.com/developers/applications → OAuth2 → General).',
                        ui: { component: 'input', type: 'text', placeholder: 'Vacío = app de LibreDeck' }
                    },
                    clientSecret: {
                        type: 'string', title: 'Client Secret (avanzado: solo app propia)',
                        description: 'Opcional. Solo para app propia: su Client Secret. Sin Secret propio el intercambio va por el relay de LibreDeck. Ningún secret va embebido en la app: el de LibreDeck vive solo en el relay.',
                        ui: { component: 'input', type: 'password', placeholder: '••••••' }
                    },
                    redirectUri: {
                        type: 'string', title: 'Redirect URI (avanzado: solo app propia)',
                        description: 'Opcional. Por defecto el redirect de LibreDeck. Solo para app propia: debe ser EXACTAMENTE el registrado en OAuth2 → Redirects.',
                        default: DISCORD_DEFAULT_REDIRECT_URI,
                        ui: { component: 'input', type: 'text', placeholder: DISCORD_DEFAULT_REDIRECT_URI }
                    },
                    proxyUrl: {
                        type: 'string', title: 'Relay URL (avanzado)',
                        description: 'Opcional. Endpoint que intercambia el code por el token custodiando el secret en servidor. Por defecto el relay de LibreDeck (o BUNDECK_DISCORD_PROXY_URL por env).',
                        ui: { component: 'input', type: 'text', placeholder: 'Vacío = relay de LibreDeck' }
                    },
                    accessToken: {
                        type: 'string', title: 'Access token',
                        description: 'Se rellena solo con "Autorizar con Discord" (o pega el code en la acción connect). No lo edites a mano.',
                        ui: { component: 'input', type: 'password', placeholder: 'Se obtiene con "Conectar"' }
                    },
                    refreshToken: {
                        type: 'string', title: 'Refresh token',
                        description: 'Se guarda solo junto al access token; sirve para renovarlo sin volver a autorizar.',
                        ui: { component: 'hidden' }
                    },
                    tokenExpiresAt: {
                        type: 'string', title: 'Caducidad del token',
                        description: 'Timestamp (ms) de caducidad; se guarda solo.',
                        ui: { component: 'hidden' }
                    },
                    muteHotkey: {
                        type: 'string', title: 'Atajo de silenciar (fallback)',
                        description: 'Atajo GLOBAL de "Silenciar" en Discord (Ajustes → Atajos de teclado). Solo se usa si no hay autorización RPC o el modo es hotkey.',
                        default: 'ctrl+shift+m',
                        ui: { component: 'input', type: 'text', placeholder: 'ctrl+shift+m' }
                    },
                    deafenHotkey: {
                        type: 'string', title: 'Atajo de ensordecer (fallback)',
                        description: 'Atajo GLOBAL de "Ensordecerse" en Discord. Solo se usa sin autorización RPC o en modo hotkey.',
                        default: 'ctrl+shift+d',
                        ui: { component: 'input', type: 'text', placeholder: 'ctrl+shift+d' }
                    },
                    pushToTalkHotkey: {
                        type: 'string', title: 'Atajo de pulsar-para-hablar (fallback)',
                        description: 'Atajo de "Pulsar para hablar" de Discord (se mantiene pulsado holdMs). Solo sin RPC.',
                        ui: { component: 'input', type: 'text', placeholder: 'ej. ctrl+shift+p' }
                    }
                }
            },
            instructions: [
                'MODO RPC (recomendado: funciona con el juego en primer plano, sin foco ni teclas). UN SOLO CLIC:',
                '1. Pulsa "Autorizar con Discord" (o ejecuta la acción discord.connect): se abre el navegador.',
                '2. Discord te pedirá permiso EXPLÍCITO una vez (popup "Authorize"): acepta. Sin ese clic, nada funciona — así debe ser.',
                '3. Listo: mute/deafen/pulsar-para-hablar van por RPC en background. El token se renueva solo vía LibreDeck.',
                '   No necesitas crear ninguna app ni copiar ningún Client ID/Secret.',
                '',
                'MODO HOTKEY (fallback sin autorización):',
                '1. En Discord ve a Ajustes → Atajos de teclado y crea atajos GLOBALES para Silenciar, Ensordecerse y Pulsar para hablar.',
                '2. OJO: deben ser globales (funcionan con Discord en segundo plano), no atajos normales de ventana.',
                '3. Copia esos mismos atajos en los ajustes de este plugin (o en cada botón).',
                '4. Discord debe estar en ejecución para que los atajos globales funcionen.',
                '',
                'AVANZADO (solo power-users con app propia): crea una app en https://discord.com/developers/applications, '
                + 'pega su Client ID + Client Secret + Redirect en los ajustes y el intercambio será directo con discord.com sin pasar por el relay.',
            ].join('\n'),
            actions: [
                {
                    id: 'toggle-mute', name: 'Silenciar / reactivar micro', icon: 'MicOff',
                    description: 'Alterna el micrófono en Discord (RPC en background si hay autorización; si no, tu atajo global)',
                    variables: [{ name: 'discordMuted', type: 'bool', label: 'Micro silenciado' }],
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: {
                                type: 'string', title: 'Atajo (fallback)',
                                description: 'Atajo global de Silenciar en Discord (si se omite usa el de los ajustes). Solo se usa sin RPC.',
                                ui: { component: 'input', type: 'text', placeholder: 'ctrl+shift+m' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'toggle-deafen', name: 'Ensordecerse / volver', icon: 'Headphones',
                    description: 'Alterna ensordecer en Discord (RPC en background si hay autorización; si no, tu atajo global)',
                    variables: [{ name: 'discordDeafened', type: 'bool', label: 'Ensordecido' }],
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: {
                                type: 'string', title: 'Atajo (fallback)',
                                description: 'Atajo global de Ensordecerse en Discord (si se omite usa el de los ajustes). Solo se usa sin RPC.',
                                ui: { component: 'input', type: 'text', placeholder: 'ctrl+shift+d' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'push-to-talk', name: 'Pulsar para hablar', icon: 'Radio',
                    description: 'Abre el micro mientras se mantiene (RPC en background si hay autorización; si no, tu atajo global durante holdMs)',
                    schema: {
                        type: 'object',
                        properties: {
                            hotkey: {
                                type: 'string', title: 'Atajo (fallback)',
                                description: 'Atajo de Pulsar para hablar en Discord (si se omite usa el de los ajustes). Solo se usa sin RPC.',
                                ui: { component: 'input', type: 'text', placeholder: 'ej. ctrl+shift+p' }
                            },
                            holdMs: {
                                type: 'number', title: 'Duración (ms)',
                                description: 'Tiempo que se mantiene abierto el micro (máx. 30000 ms)',
                                default: 1000, minimum: 100, maximum: 30000,
                                ui: { component: 'input', type: 'number', placeholder: '1000' }
                            },
                            phase: {
                                type: 'string', title: 'Fase',
                                description: 'press: abre el micro. release: lo cierra. Sin fase: abre, espera holdMs y cierra.',
                                enum: ['press', 'release'],
                                ui: { component: 'select', options: [{ value: 'press', label: 'Press (abrir)' }, { value: 'release', label: 'Release (cerrar)' }] }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'open-channel', name: 'Abrir canal de Discord', icon: 'MessageCircle',
                    description: 'Abre un canal, mensaje o invitación de Discord en el navegador/app (o salta a un canal de voz por RPC)',
                    schema: {
                        type: 'object',
                        properties: {
                            url: {
                                type: 'string', title: 'URL del canal',
                                description: 'URL https://discord.com/channels/... o https://discord.gg/... (opcional si usas canal de voz por RPC)',
                                ui: { component: 'input', type: 'text', placeholder: 'https://discord.com/channels/123/456' }
                            },
                            voiceChannelId: {
                                type: 'string', title: 'ID de canal de voz (RPC)',
                                description: 'Si se indica (y hay autorización RPC), salta a ese canal de voz sin abrir el navegador',
                                ui: { component: 'input', type: 'text', placeholder: '1234567890' }
                            },
                            guildId: {
                                type: 'string', title: 'ID del servidor (opcional)',
                                description: 'Servidor del canal de voz (recomendado para saltos por RPC)',
                                ui: { component: 'input', type: 'text', placeholder: '1234567890' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'connect', name: 'Autorizar con Discord (1 clic)', icon: 'Link',
                    description: 'Abre el navegador con el permiso explícito (cero-config) o canjea el code por el token vía relay',
                    schema: {
                        type: 'object',
                        properties: {
                            code: {
                                type: 'string', title: 'Código de autorización',
                                description: 'Code que devuelve Discord en el redirect (?code=...). Si se omite, devuelve la URL de autorización.',
                                ui: { component: 'input', type: 'text', placeholder: 'Pégalo si el navegador no volvió solo' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'status', name: 'Estado de conexión Discord', icon: 'Activity',
                    description: 'Muestra si el RPC está conectado, si falta autorización o si Discord está cerrado (sin lanzar errores)',
                    schema: { type: 'object', properties: {}, required: [] }
                },
                {
                    id: 'disconnect', name: 'Desconectar Discord', icon: 'Unlink',
                    description: 'Borra el token guardado y cierra la conexión RPC (revoca el acceso local)',
                    schema: { type: 'object', properties: {}, required: [] }
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
        handlers.set('connect', this.executeConnect.bind(this))
        handlers.set('status', this.executeStatus.bind(this))
        handlers.set('disconnect', this.executeDisconnect.bind(this))
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

    private saveSetting(key: string, value: string): void {
        try {
            this.context.setSetting?.(key, String(value))
        } catch { /* mejor esfuerzo */ }
    }

    private clearSetting(key: string): void {
        try {
            if (this.context.deleteSetting) this.context.deleteSetting(key)
            else this.context.setSetting?.(key, '')
        } catch { /* mejor esfuerzo */ }
    }

    private getMode(): DiscordMode {
        return resolveDiscordMode(this.setting('mode'))
    }

    private getRpcConfig(): RpcConfig {
        const userClientId = this.setting('clientId')
        const userRedirect = this.setting('redirectUri')
        return {
            clientId: resolveDiscordClientId(userClientId),
            clientSecret: this.setting('clientSecret'),
            redirectUri: resolveDiscordRedirectUri(userRedirect),
            proxyUrl: resolveDiscordProxyUrl(this.setting('proxyUrl')),
            userClientId,
            accessToken: this.setting('accessToken'),
            refreshToken: this.setting('refreshToken'),
            tokenExpiresAt: this.setting('tokenExpiresAt'),
        }
    }

    /** Power-user: el usuario puso su propia app (ID + Secret) → intercambio directo. */
    private isPowerUser(cfg: RpcConfig): boolean {
        return !!cfg.userClientId && !!cfg.clientSecret
    }

    private needsAuth(reason: 'missing-config' | 'token-expired' | 'no-token' | 'not-configured', missing?: string[]) {
        const cfg = this.getRpcConfig()
        return buildDiscordNeedsAuth({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, reason, missing })
    }

    private tokenExpired(): boolean {
        const cfg = this.getRpcConfig()
        if (!cfg.accessToken) return false
        return isDiscordTokenExpired({ tokenExpiresAt: cfg.tokenExpiresAt }, Date.now())
    }

    private async refreshTokenIfNeeded(): Promise<'ok' | 'no-refresh' | 'still-valid'> {
        const cfg = this.getRpcConfig()
        if (!cfg.accessToken || !this.tokenExpired()) return 'still-valid'
        if (!cfg.refreshToken) return 'no-refresh'
        this.context.log('info', 'Discord: token caducado, renovando…')
        // Power-user con app propia: renovación directa con su secret.
        // Zero-config: renovación vía relay (el secret vive en el servidor).
        const stored = this.isPowerUser(cfg)
            ? await refreshDiscordToken(
                { clientId: cfg.clientId ?? '', clientSecret: cfg.clientSecret ?? '', refreshToken: cfg.refreshToken, fetchFn: this.deps.fetchFn ?? fetch },
            )
            : await refreshDiscordTokenViaProxy(
                { refreshToken: cfg.refreshToken, proxyUrl: cfg.proxyUrl ?? '', fetchFn: this.deps.fetchFn ?? fetch },
            )
        this.saveSetting('accessToken', stored.accessToken)
        if (stored.refreshToken) this.saveSetting('refreshToken', stored.refreshToken)
        this.saveSetting('tokenExpiresAt', stored.expiresAt)
        this.dropRpc()
        return 'ok'
    }

    private createConnection(cfg: RpcConfig): DiscordRpcConnection {
        if (this.deps.createRpcConnection) {
            return this.deps.createRpcConnection({ clientId: cfg.clientId ?? '', accessToken: cfg.accessToken })
        }
        return new DiscordRpcConnection({ clientId: cfg.clientId ?? '', accessToken: cfg.accessToken })
    }

    private dropRpc(): void {
        const rpc = this.rpc
        this.rpc = null
        if (rpc) {
            try { void rpc.disconnect() } catch { /* noop */ }
        }
    }

    /**
     * Asegura conexión RPC autenticada (reutiliza la existente).
     * Lanza DiscordRpcError con código accionable si algo falla.
     */
    private async ensureRpc(): Promise<DiscordRpcConnection> {
        const cfg = this.getRpcConfig()
        if (!cfg.clientId) {
            throw new DiscordRpcError('needs-auth', 'Falta el Client ID en los ajustes del plugin de Discord.')
        }
        if (!cfg.accessToken) {
            throw new DiscordRpcError('needs-auth', 'Discord aún no está autorizado: ejecuta la acción discord.connect y acepta el permiso.')
        }
        if (!this.rpc) {
            this.rpc = this.createConnection(cfg)
        }
        try {
            await this.rpc.connect()
        } catch (err) {
            this.dropRpc()
            throw err
        }
        try {
            await this.rpc.authenticate(cfg.accessToken)
            try { await this.rpc.subscribeVoiceSettings() } catch { /* el cache se rellena con los SET */ }
        } catch (err) {
            this.dropRpc()
            throw err
        }
        return this.rpc
    }

    /**
     * Fallback a hotkey (modo auto): nunca silencioso — adjunta el error RPC
     * real (`rpcError`) y lo deja en warn server-side para diagnóstico.
     */
    private rpcFallback(code: string, message: string, retryable: boolean): { handled: boolean; result?: any } {
        const rpcError = { code, message }
        this.context.log('warn', `Discord: RPC no disponible (${code}): ${message}. Se usa el atajo global (fallback).`)
        return { handled: false, result: { status: 'error', code, transport: 'rpc', retryable, message, rpcError } }
    }

    /**
     * Si el RPC resolvió con error claro (token-expired, needs-auth,
     * voice-locked, not-configured, discord-closed…), lanza para que el
     * fallo aplanee a `success:false` (dispara `action.error`, toast y nivel
     * error en logs) en vez de un `success:true` ciego.
     */
    private throwIfRpcError(result: any, actionLabel: string): any {
        if (!result || typeof result !== 'object') return result
        if (result.status === 'error' || result.status === 'needs-auth') {
            const code = String(result.code ?? result.reason ?? result.status)
            const hint = typeof result.hint === 'string' && result.hint ? ` ${result.hint}` : ''
            const url = typeof result.authorizeUrl === 'string' && result.authorizeUrl ? ` Autoriza aquí: ${result.authorizeUrl}` : ''
            const detail = typeof result.message === 'string' && result.message
                ? result.message
                : typeof result.permissionNote === 'string' && result.permissionNote
                    ? result.permissionNote
                    : 'falló el control por RPC.'
            throw new Error(`Discord (${actionLabel}) [${code}]: ${detail}${hint}${url}`)
        }
        return result
    }

    /**
     * Intenta ejecutar `fn` por RPC. Devuelve `{ handled: true, result }`
     * si el modo RPC resolvió (éxito, needs-auth o error claro); con
     * `{ handled: false }` el llamador cae al fallback hotkey (modo auto
     * sin autorización).
     */
    private async withRpc<T>(fn: (rpc: DiscordRpcConnection) => Promise<T>): Promise<{ handled: boolean; result?: any }> {
        const mode = this.getMode()
        if (mode === 'hotkey') return { handled: false }
        const cfg = this.getRpcConfig()
        if (!cfg.clientId || !cfg.accessToken) {
            const result = this.needsAuth(!cfg.clientId ? 'not-configured' : 'no-token')
            if (mode === 'rpc') return { handled: true, result: { ...result, transport: 'rpc' } }
            return { handled: false, result }
        }
        try {
            const refreshed = await this.refreshTokenIfNeeded()
            if (refreshed === 'no-refresh') {
                const result = {
                    status: 'error' as const,
                    code: 'token-expired',
                    transport: 'rpc',
                    message: 'El token de Discord caducó y no hay refresh token: autoriza de nuevo (acción discord.connect).',
                    retryable: false,
                    hint: 'Pulsa Autorizar con Discord y acepta el permiso explícito en el navegador.',
                }
                // En auto NO caemos a hotkey: había auth y ahora es inválida
                // (caer en silencio ocultaría que hay que renovar).
                return { handled: true, result }
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            const code = err instanceof DiscordRpcError ? err.code : null
            if (code === 'discord-not-configured') {
                // Relay sin configurar: error claro para el maintainer + fallback a hotkey para el usuario.
                return {
                    handled: true,
                    result: {
                        status: 'error' as const, code, transport: 'rpc', retryable: false, message,
                        hint: 'Usa el fallback de atajos globales (modo hotkey) mientras el maintainer configura el relay (docs/discord-app-setup.md).',
                    },
                }
            }
            return { handled: true, result: { status: 'error', code: 'token-expired', transport: 'rpc', message, retryable: false } }
        }
        try {
            // Conexión persistente reutilizada que murió en silencio
            // (half-open sin onclose): el primer uso falla con
            // discord-closed/timeout. Se reintenta UNA vez con conexión
            // fresca (drop + connect) antes de rendirse al fallback.
            const reused = this.rpc !== null
            let retriedFresh = false
            for (;;) {
                try {
                    const rpc = await this.ensureRpc()
                    const data = await fn(rpc)
                    return { handled: true, result: data }
                } catch (err) {
                    if (err instanceof DiscordRpcError && err.code === 'discord-closed' && reused && !retriedFresh) {
                        retriedFresh = true
                        this.context.log('warn', `Discord: la conexión RPC reutilizada falló (${err.message}); reintentando con conexión fresca…`)
                        this.dropRpc()
                        continue
                    }
                    throw err
                }
            }
        } catch (err) {
            if (err instanceof DiscordRpcError) {
                if (err.code === 'voice-locked') {
                    return {
                        handled: true,
                        result: {
                            status: 'error', code: 'voice-locked', transport: 'rpc', retryable: false,
                            message: `Discord: otra aplicación tiene el control de voz. ${err.message}`,
                            hint: 'Cierra el plugin de Elgato / Macro Deck / otra app con RPC de Discord y reintenta (solo una puede tener el lock de voz).',
                        },
                    }
                }
                if (err.code === 'token-expired' || err.code === 'needs-auth') {
                    const result = {
                        status: 'error' as const, code: err.code, transport: 'rpc', retryable: false,
                        message: `Discord: autorización inválida o caducada. ${err.message}`,
                        hint: 'Reautoriza con la acción discord.connect (un solo clic en Autorizar).',
                    }
                    return { handled: true, result }
                }
                if (err.code === 'discord-not-configured') {
                    return {
                        handled: true,
                        result: {
                            status: 'error' as const, code: err.code, transport: 'rpc', retryable: false,
                            message: err.message,
                            hint: 'Usa el fallback de atajos globales (modo hotkey) mientras el maintainer configura el relay (docs/discord-app-setup.md).',
                        },
                    }
                }
                if (err.code === 'discord-closed') {
                    if (mode === 'rpc') {
                        return {
                            handled: true,
                            result: {
                                status: 'error', code: 'discord-closed', transport: 'rpc', retryable: true,
                                message: `Discord cerrado o sin RPC: ${err.message}`,
                                hint: 'Abre Discord en este equipo y reintenta.',
                            },
                        }
                    }
                    // auto: el fallback hotkey lo intentará (con rpcError adjunto)
                    return this.rpcFallback('discord-closed', err.message, true)
                }
                if (mode === 'rpc') {
                    return { handled: true, result: { status: 'error', code: err.code, transport: 'rpc', message: err.message, retryable: err.retryable } }
                }
                return this.rpcFallback(err.code, err.message, err.retryable)
            }
            if (mode === 'rpc') {
                return { handled: true, result: { status: 'error', code: 'rpc-error', transport: 'rpc', message: err instanceof Error ? err.message : String(err), retryable: false } }
            }
            return this.rpcFallback('rpc-error', err instanceof Error ? err.message : String(err), false)
        }
    }

    private resolveHotkey(params: any, paramKey: string, settingKey: string, fallback: string): string {
        const fromParams = typeof params?.[paramKey] === 'string' && params[paramKey].trim() ? params[paramKey].trim() : null
        return fromParams ?? this.setting(settingKey) ?? fallback
    }

    private async hotkeyTap(hotkey: string, holdMs = 0) {
        if (this.deps.hotkeyTap) return this.deps.hotkeyTap(hotkey, holdMs)
        return sendHotkey(hotkey, holdMs)
    }

    private async executeToggleMute(params: any, _context: any): Promise<any> {
        const attempted = await this.withRpc(async (rpc) => {
            const current = rpc.lastVoiceState.mute ?? false
            const state = await rpc.setVoiceSettings({ mute: !current })
            this.context.log('info', `Discord RPC: micro ${state.mute ? 'silenciado' : 'reactivado'} (background, sin foco)`)
            return { action: 'toggle-mute', transport: 'rpc', mute: state.mute, previousMute: current, port: rpc.connectedPort, pipe: rpc.connectedPipe, rpcTransport: rpc.connectedTransport, note: 'Controlado en background vía RPC: funciona con el juego en primer plano.' }
        })
        // Error claro del RPC (token, lock de voz, Discord cerrado en modo
        // rpc…): lanza para aplanar a success:false (toast + log error).
        if (attempted.handled) return this.throwIfRpcError(attempted.result, 'toggle-mute')
        const hotkey = this.resolveHotkey(params, 'hotkey', 'muteHotkey', 'ctrl+shift+m')
        this.context.log('info', `Discord: alternando micro con atajo "${hotkey}"`)
        try {
            const res = await this.hotkeyTap(hotkey)
            const rpcError = (attempted.result as any)?.rpcError ?? null
            return {
                action: 'toggle-mute', hotkey, ...res, transport: 'hotkey',
                ...(rpcError ? { rpcError } : {}),
                note: attempted.result?.status === 'needs-auth'
                    ? 'Sin autorización RPC: usado el atajo GLOBAL. Autoriza la app (discord.connect) para controlar en background sin depender del foco.'
                    : rpcError
                        ? `El RPC falló (${rpcError.code}): usado el atajo GLOBAL como fallback. El atajo debe ser GLOBAL en Discord (Ajustes → Atajos de teclado) y Discord debe estar en ejecución.`
                        : 'Discord debe estar en ejecución con ese atajo GLOBAL configurado (Discord → Ajustes → Atajos de teclado).',
            }
        } catch (error) {
            this.context.log('error', `Discord: no se pudo silenciar: ${error}`)
            throw error
        }
    }

    private async executeToggleDeafen(params: any, _context: any): Promise<any> {
        const attempted = await this.withRpc(async (rpc) => {
            const current = rpc.lastVoiceState.deaf ?? false
            const state = await rpc.setVoiceSettings({ deaf: !current })
            this.context.log('info', `Discord RPC: ensordecer ${state.deaf ? 'activado' : 'desactivado'} (background, sin foco)`)
            return { action: 'toggle-deafen', transport: 'rpc', deaf: state.deaf, previousDeaf: current, port: rpc.connectedPort, pipe: rpc.connectedPipe, rpcTransport: rpc.connectedTransport, note: 'Controlado en background vía RPC: funciona con el juego en primer plano.' }
        })
        // Error claro del RPC: lanza para aplanar a success:false.
        if (attempted.handled) return this.throwIfRpcError(attempted.result, 'toggle-deafen')
        const hotkey = this.resolveHotkey(params, 'hotkey', 'deafenHotkey', 'ctrl+shift+d')
        this.context.log('info', `Discord: alternando ensordecer con atajo "${hotkey}"`)
        try {
            const res = await this.hotkeyTap(hotkey)
            const rpcError = (attempted.result as any)?.rpcError ?? null
            return {
                action: 'toggle-deafen', hotkey, ...res, transport: 'hotkey',
                ...(rpcError ? { rpcError } : {}),
                note: attempted.result?.status === 'needs-auth'
                    ? 'Sin autorización RPC: usado el atajo GLOBAL. Autoriza la app (discord.connect) para controlar en background sin depender del foco.'
                    : rpcError
                        ? `El RPC falló (${rpcError.code}): usado el atajo GLOBAL como fallback. El atajo debe ser GLOBAL en Discord (Ajustes → Atajos de teclado) y Discord debe estar en ejecución.`
                        : 'Discord debe estar en ejecución con ese atajo GLOBAL configurado (Discord → Ajustes → Atajos de teclado).',
            }
        } catch (error) {
            this.context.log('error', `Discord: no se pudo ensordecer: ${error}`)
            throw error
        }
    }

    private async executePushToTalk(params: any, _context: any): Promise<any> {
        const phase = typeof params?.phase === 'string' ? params.phase.trim().toLowerCase() : ''
        if (phase !== '' && phase !== 'press' && phase !== 'release') {
            throw new Error(`Fase de push-to-talk no válida: "${params.phase}". Usa "press", "release" o nada (hold).`)
        }
        const holdMs = typeof params?.holdMs === 'number' && Number.isFinite(params.holdMs) ? params.holdMs : 1000

        const attempted = await this.withRpc(async (rpc) => {
            if (phase === 'press') {
                const state = await rpc.setVoiceSettings({ mute: false })
                this.context.log('info', 'Discord RPC: pulsar-para-hablar PRESS (micro abierto en background)')
                return { action: 'push-to-talk', transport: 'rpc', phase: 'press', mute: state.mute, note: 'Micro abierto por RPC. Ciérralo con phase "release".' }
            }
            if (phase === 'release') {
                const state = await rpc.setVoiceSettings({ mute: true })
                this.context.log('info', 'Discord RPC: pulsar-para-hablar RELEASE (micro cerrado en background)')
                return { action: 'push-to-talk', transport: 'rpc', phase: 'release', mute: state.mute, note: 'Micro cerrado por RPC.' }
            }
            const hold = Math.max(0, Math.min(Math.floor(holdMs || 0), 30000))
            await rpc.setVoiceSettings({ mute: false })
            this.context.log('info', `Discord RPC: pulsar-para-hablar HOLD ${hold} ms (background)`)
            await new Promise((r) => setTimeout(r, hold))
            const state = await rpc.setVoiceSettings({ mute: true })
            return { action: 'push-to-talk', transport: 'rpc', phase: 'hold', heldMs: hold, mute: state.mute }
        })
        if (attempted.handled) return this.throwIfRpcError(attempted.result, 'push-to-talk')

        const hotkey = this.resolveHotkey(params, 'hotkey', 'pushToTalkHotkey', '')
        if (!hotkey) {
            if (attempted.result?.status === 'needs-auth') return this.throwIfRpcError({ ...attempted.result, transport: 'rpc' }, 'push-to-talk')
            throw new Error('Falta el atajo de "Pulsar para hablar": configúralo en Discord (Ajustes → Atajos de teclado) y ponlo en los ajustes del plugin o en el parámetro "hotkey".')
        }
        const down = this.deps.hotkeyDown ?? hotkeyDown
        const up = this.deps.hotkeyUp ?? hotkeyUp
        this.context.log('info', `Discord: pulsar-para-hablar "${hotkey}" ${phase || `durante ${holdMs} ms`}`)
        try {
            if (phase === 'press') {
                const res = await down(hotkey)
                return { action: 'push-to-talk', hotkey, phase: 'press', transport: 'hotkey', ...res }
            }
            if (phase === 'release') {
                const res = await up(hotkey)
                return { action: 'push-to-talk', hotkey, phase: 'release', transport: 'hotkey', ...res }
            }
            const res = await this.hotkeyTap(hotkey, holdMs)
            return { action: 'push-to-talk', hotkey, ...res, transport: 'hotkey' }
        } catch (error) {
            this.context.log('error', `Discord: falló pulsar-para-hablar: ${error}`)
            throw error
        }
    }

    private async executeOpenChannel(params: any, _context: any): Promise<any> {
        const voiceChannelId = typeof params?.voiceChannelId === 'string' && params.voiceChannelId.trim() ? params.voiceChannelId.trim() : null
        const guildId = typeof params?.guildId === 'string' && params.guildId.trim() ? params.guildId.trim() : null
        if (voiceChannelId) {
            const attempted = await this.withRpc(async (rpc) => {
                await rpc.selectVoiceChannel({ guildId, channelId: voiceChannelId })
                this.context.log('info', `Discord RPC: salto a canal de voz ${voiceChannelId} (background)`)
                return { action: 'open-channel', transport: 'rpc', voiceChannelId, guildId, note: 'Salto al canal de voz por RPC, sin abrir el navegador.' }
            })
            if (attempted.handled) return attempted.result
            // auto sin auth: cae al método URL si hay url; si no, informa needs-auth
            if (!params?.url && attempted.result?.status === 'needs-auth') return { ...attempted.result, transport: 'rpc' }
        }
        const url = typeof params?.url === 'string' ? params.url.trim() : ''
        if (!url) {
            throw new Error('La acción "Abrir canal" requiere el parámetro "url" (ej. https://discord.com/channels/123/456) o "voiceChannelId" con autorización RPC.')
        }
        if (!/^https:\/\/(discord\.com|discord\.gg|discordapp\.com)\//.test(url)) {
            throw new Error(`URL de Discord no válida: "${url}". Usa https://discord.com/channels/... o https://discord.gg/....`)
        }
        this.context.log('info', `Discord: abriendo ${url}`)
        try {
            if (this.deps.openUrlFn) await this.deps.openUrlFn(url)
            else await openUrl(url)
            return { action: 'open-channel', url, opened: true, transport: 'browser' }
        } catch (error) {
            this.context.log('error', `Discord: no se pudo abrir el canal: ${error}`)
            throw error
        }
    }

    private async executeConnect(params: any, _context: any): Promise<any> {
        const code = typeof params?.code === 'string' && params.code.trim() ? params.code.trim() : null
        const cfg = this.getRpcConfig()
        if (code) {
            this.context.log('info', 'Discord: canjeando código OAuth por token…')
            try {
                const fetchFn = this.deps.fetchFn ?? fetch
                // Power-user con app propia: intercambio directo con discord.com.
                // Zero-config: intercambio vía relay (el secret vive en el servidor, nunca en el binario).
                const stored = this.isPowerUser(cfg)
                    ? await exchangeDiscordCode(
                        { clientId: cfg.clientId ?? '', clientSecret: cfg.clientSecret ?? '', code, redirectUri: cfg.redirectUri, fetchFn },
                    )
                    : await exchangeDiscordCodeViaProxy(
                        { code, redirectUri: cfg.redirectUri, proxyUrl: cfg.proxyUrl ?? '', fetchFn },
                    )
                this.saveSetting('accessToken', stored.accessToken)
                if (stored.refreshToken) this.saveSetting('refreshToken', stored.refreshToken)
                this.saveSetting('tokenExpiresAt', stored.expiresAt)
                this.dropRpc()
                // Verificación best-effort: si Discord está cerrado, el token
                // queda guardado igualmente (el permiso ya está concedido).
                try {
                    const rpc = await this.ensureRpc()
                    return { status: 'connected', transport: 'rpc', port: rpc.connectedPort, pipe: rpc.connectedPipe, rpcTransport: rpc.connectedTransport, verified: true, note: 'Autorizado y verificado contra el cliente Discord local.' }
                } catch (verifyErr) {
                    const message = verifyErr instanceof Error ? verifyErr.message : String(verifyErr)
                    const codeErr = verifyErr instanceof DiscordRpcError ? verifyErr.code : 'rpc-error'
                    return {
                        status: 'authorized', transport: 'rpc', verified: false, code: codeErr, message,
                        note: 'Permiso concedido y token guardado. Abre Discord en este equipo para controlarlo en background.',
                    }
                }
            } catch (error) {
                // Relay sin configurar: no lanzar, devolver error accionable
                // (maintainer configura; usuario usa hotkey mientras tanto).
                if (error instanceof DiscordRpcError && error.code === 'discord-not-configured') {
                    return {
                        status: 'error', code: 'discord-not-configured', transport: 'rpc', retryable: false,
                        message: error.message,
                        hint: 'Usa el fallback de atajos globales (modo hotkey) mientras el maintainer configura el relay (docs/discord-app-setup.md).',
                    }
                }
                this.context.log('error', `Discord: no se pudo canjear el código: ${error}`)
                throw error
            }
        }
        if (!cfg.clientId) {
            return { ...this.needsAuth('not-configured'), transport: 'rpc' }
        }
        let authorizeUrl: string | null = null
        try {
            authorizeUrl = buildDiscordAuthorizeUrl({ clientId: cfg.clientId, redirectUri: cfg.redirectUri })
        } catch {
            authorizeUrl = null
        }
        // Mejor esfuerzo: abrir el navegador para el permiso explícito.
        if (authorizeUrl) {
            try {
                if (this.deps.openUrlFn) await this.deps.openUrlFn(authorizeUrl)
                else await openUrl(authorizeUrl)
            } catch { /* si no hay navegador, la UI muestra la URL */ }
            this.context.log('info', 'Discord: abierta URL de autorización (permiso explícito en el navegador)')
        }
        return {
            ...buildDiscordNeedsAuth({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, reason: 'no-token' }),
            authorizeUrl,
            transport: 'rpc',
            browserOpened: true,
        }
    }

    private async executeStatus(_params: any, _context: any): Promise<any> {
        const mode = this.getMode()
        const cfg = this.getRpcConfig()
        const hasClientId = !!cfg.clientId
        const hasToken = !!cfg.accessToken
        const expired = hasToken && this.tokenExpired()
        if (!hasClientId || !hasToken || expired) {
            return {
                status: 'needs-auth',
                mode,
                transport: 'none',
                hasClientId,
                hasToken,
                tokenExpired: expired,
                rpcReachable: false,
                ...this.needsAuth(!hasClientId ? 'not-configured' : expired ? 'token-expired' : 'no-token'),
            }
        }
        // Sonda ligera: ¿responde el RPC local? (sin autenticar basta para saber si Discord está abierto)
        let rpcReachable = false
        let voice: RpcVoiceState | null = null
        let probeError: string | null = null
        try {
            const rpc = await this.ensureRpc()
            rpcReachable = true
            voice = rpc.lastVoiceState
        } catch (err) {
            probeError = err instanceof Error ? err.message : String(err)
            if (err instanceof DiscordRpcError && (err.code === 'token-expired' || err.code === 'needs-auth')) {
                return { status: 'needs-auth', mode, transport: 'none', hasClientId, hasToken, tokenExpired: true, rpcReachable: false, ...this.needsAuth('token-expired') }
            }
        }
        if (!rpcReachable) {
            return {
                status: 'discord-closed', mode, transport: 'none', hasClientId, hasToken,
                tokenExpired: false, rpcReachable: false, voice,
                message: probeError ?? 'Discord no responde al RPC local.',
                hint: 'Abre Discord en este equipo y reintenta. Sin RPC, las acciones usan el fallback de atajos globales (modo auto).',
                voiceKnown: false, inVoice: null,
                voiceHint: 'El mute por RPC solo se nota si estás EN UN CANAL DE VOZ de Discord: fuera de un canal, Discord acepta el comando pero no hay audio que silenciar.',
            }
        }
        return {
            status: 'connected', mode, transport: 'rpc', hasClientId, hasToken,
            tokenExpired: false, rpcReachable: true, voice, port: this.rpc?.connectedPort ?? null,
            pipe: this.rpc?.connectedPipe ?? null,
            rpcTransport: this.rpc?.connectedTransport ?? null,
            endpoint: this.rpc?.connectedLabel ?? null,
            // Diagnóstico de voz: el RPC expone mute/deaf, pero NO el canal
            // actual de forma fiable (sin GET_SELECTED_VOICE_CHANNEL). Si
            // voiceKnown es false o estás fuera de un canal, el mute no se
            // nota aunque Discord acepte el comando.
            voiceKnown: voice !== null && (voice.mute !== null || voice.deaf !== null),
            inVoice: null,
            voiceHint: 'El mute por RPC solo se nota si estás EN UN CANAL DE VOZ de Discord: fuera de un canal, Discord acepta el comando pero no hay audio que silenciar. Entra a un canal de voz y reintenta.',
        }
    }

    private async executeDisconnect(_params: any, _context: any): Promise<any> {
        this.dropRpc()
        this.clearSetting('accessToken')
        this.clearSetting('refreshToken')
        this.clearSetting('tokenExpiresAt')
        this.context.log('info', 'Discord: token borrado y RPC desconectado (acceso local revocado)')
        return { status: 'disconnected', transport: 'none', note: 'Token borrado en local. Para revocar también en Discord: User Settings → Authorized Apps → Remove.' }
    }

    /** Normaliza un token pegado/capturado y lo guarda (usado por token-capture). */
    public saveCapturedToken(payload: any, nowMs: number = Date.now()): { accessToken: string; expiresAt: string } {
        const stored = normalizeDiscordTokenCapture(payload, nowMs)
        this.saveSetting('accessToken', stored.accessToken)
        if (stored.refreshToken) this.saveSetting('refreshToken', stored.refreshToken)
        this.saveSetting('tokenExpiresAt', stored.expiresAt)
        this.dropRpc()
        return { accessToken: stored.accessToken, expiresAt: stored.expiresAt }
    }

    public getModeSetting(): DiscordMode {
        return this.getMode()
    }

    public dispose(): void {
        this.dropRpc()
    }
}
