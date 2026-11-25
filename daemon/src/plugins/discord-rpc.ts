/**
 * Discord RPC transport — control de voz en background sin ventana en foco.
 *
 * Replica el comportamiento del plugin oficial de Elgato: en vez de enviar
 * teclas a la ventana con foco, habla con el cliente Discord local a través
 * de su servidor RPC (WebSocket en 127.0.0.1:6463-6472, equivalente al IPC
 * `discord-ipc-0..9`) usando comandos SET_VOICE_SETTINGS / AUTHENTICATE /
 * SUBSCRIBE, con OAuth2 (scopes `identify`, `rpc` y `rpc.voice.write`).
 * Zero-config para el usuario final: SOLO pulsa Autorizar. La app de Discord
 * la crea el maintainer una vez (docs/discord-app-setup.md) y el
 * client_secret vive únicamente en el relay (DEFAULT_DISCORD_PROXY_URL),
 * nunca en el binario. Camino power-user intacto: si el usuario pone su
 * propio Client ID + Secret en ajustes, el intercambio es directo con
 * discord.com. Discord pide permiso explícito UNA vez (popup "Authorize");
 * el token se guarda en local y se renueva.
 *
 * Sin dependencias externas: solo builtins (WebSocket/fetch). Todo lo
 * específico de Bun/Node se inyecta para poder testear sin red.
 */

export const DISCORD_RPC_PORTS = [6463, 6464, 6465, 6466, 6467, 6468, 6469, 6470, 6471, 6472] as const

export const DISCORD_API_BASE = 'https://discord.com/api'
export const DISCORD_OAUTH_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize'
export const DISCORD_TOKEN_URL = `${DISCORD_API_BASE}/oauth2/token`

/** Scopes mínimos para voz en background (los mismos que pide Elgato). */
export const DISCORD_RPC_SCOPES = ['identify', 'rpc', 'rpc.voice.write'] as const

/** Redirect de ejemplo: debe coincidir EXACTO con el registrado en el portal. */
export const DISCORD_DEFAULT_REDIRECT_URI = 'http://127.0.0.1:6463'

/**
 * Zero-config (LibreDeck): el usuario final SOLO pulsa Autorizar.
 *
 * La app de Discord la crea el MAINTAINER una sola vez
 * (ver docs/discord-app-setup.md) y rellena los valores baked-in de abajo
 * + despliega el relay que custodia el client_secret. El daemon NUNCA lleva
 * el secret embebido (se extraería del binario): el intercambio code→token
 * y la renovación van contra el relay, nunca contra discord.com con secret.
 *
 * Resolución: ajuste del usuario si lo puso (power-user) ?? env ?? baked-in.
 */
export const DISCORD_MAINTAINER_CLIENT_ID = '1575201215791497256'
export const DEFAULT_DISCORD_CLIENT_ID = DISCORD_MAINTAINER_CLIENT_ID
/** Redirect registrado en OAuth2 → Redirects de la app (ver docs/discord-app-setup.md). */
export const DEFAULT_DISCORD_REDIRECT_URI = DISCORD_DEFAULT_REDIRECT_URI
/** Redirects válidos a registrar en el portal de Discord (los 2 loopback + callback https). */
export const DISCORD_VALID_REDIRECT_URIS = [
    DISCORD_DEFAULT_REDIRECT_URI,
    'http://localhost:6463',
    'https://relay.bundeck.app/api/discord/callback',
] as const
/** Ruta del callback https del relay: reenvía el code al daemon local (sin secret). */
export const DISCORD_CALLBACK_PATH = '/api/discord/callback'
export const DEFAULT_DISCORD_CALLBACK_URL = 'https://relay.bundeck.app/api/discord/callback'
/** Relay que custodia el client_secret e intercambia code→token (o BUNDECK_DISCORD_PROXY_URL). */
export const DEFAULT_DISCORD_PROXY_URL = 'https://relay.bundeck.app/api/discord/rpc-token'
// TODO(maintainer): si cambias de dominio del relay, actualiza
// DEFAULT_DISCORD_PROXY_URL y DEFAULT_DISCORD_CALLBACK_URL (y registra el
// nuevo callback en OAuth2 → Redirects del portal).

/** Margen de seguridad antes de considerar el token caducado (60 s). */
export const DISCORD_TOKEN_EXPIRY_SKEW_MS = 60_000

export type DiscordRpcErrorCode =
    | 'discord-closed'
    | 'needs-auth'
    | 'discord-not-configured'
    | 'token-expired'
    | 'voice-locked'
    | 'rpc-error'

export class DiscordRpcError extends Error {
    public readonly code: DiscordRpcErrorCode
    public readonly retryable: boolean
    public readonly detail?: unknown

    constructor(code: DiscordRpcErrorCode, message: string, opts: { retryable?: boolean; detail?: unknown } = {}) {
        super(message)
        this.name = 'DiscordRpcError'
        this.code = code
        this.retryable = opts.retryable ?? (code === 'discord-closed')
        this.detail = opts.detail
    }
}

export interface DiscordAuthorizeParams {
    clientId: string
    redirectUri?: string
    scopes?: readonly string[] | string[]
    state?: string
}

/**
 * URL de autorización OAuth2. Abrir en el navegador: Discord muestra el
 * popup de permiso explícito ("Authorize") una sola vez por app.
 */
export function buildDiscordAuthorizeUrl(params: DiscordAuthorizeParams): string {
    const clientId = String(params.clientId ?? '').trim()
    if (!clientId) throw new Error('Falta el Client ID de Discord (discord.com/developers/applications → OAuth2).')
    const redirectUri = String(params.redirectUri ?? DISCORD_DEFAULT_REDIRECT_URI).trim() || DISCORD_DEFAULT_REDIRECT_URI
    const scopes = (params.scopes ?? DISCORD_RPC_SCOPES).map((s) => String(s).trim()).filter(Boolean)
    if (scopes.length === 0) throw new Error('Falta al menos un scope de Discord (p. ej. "rpc rpc.voice.write identify").')
    const url = new URL(DISCORD_OAUTH_AUTHORIZE_URL)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', scopes.join(' '))
    if (params.state) url.searchParams.set('state', String(params.state))
    return url.toString()
}

export interface DiscordStoredToken {
    accessToken: string
    refreshToken: string
    tokenType: string
    obtainedAt: string
    expiresAt: string
    expiresIn: string
}

/**
 * Normaliza la respuesta del token endpoint (o un pegado manual) al
 * formato plano que se guarda en settings. Función pura, testeable.
 */
export function normalizeDiscordTokenCapture(payload: any, nowMs: number = Date.now()): DiscordStoredToken {
    const accessToken = payload?.access_token ?? payload?.accessToken ?? payload?.token
    if (typeof accessToken !== 'string' || accessToken.trim().length < 10) {
        throw new Error('Token de Discord inválido: falta access_token (autoriza la app y pega el código de nuevo).')
    }
    const refreshToken = payload?.refresh_token ?? payload?.refreshToken ?? ''
    const expiresInRaw = Number(payload?.expires_in ?? payload?.expiresIn ?? 604800)
    const expiresIn = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? Math.floor(expiresInRaw) : 604800
    const obtainedAt = nowMs
    return {
        accessToken: accessToken.trim(),
        refreshToken: typeof refreshToken === 'string' ? refreshToken.trim() : '',
        tokenType: typeof payload?.token_type === 'string' ? payload.token_type : 'Bearer',
        obtainedAt: String(obtainedAt),
        expiresAt: String(obtainedAt + expiresIn * 1000),
        expiresIn: String(expiresIn),
    }
}

/** ¿El token guardado está caducado (con margen de seguridad)? */
export function isDiscordTokenExpired(values: Record<string, any>, nowMs: number = Date.now()): boolean {
    const exp = Number(values?.tokenExpiresAt ?? values?.expiresAt)
    if (!Number.isFinite(exp) || exp <= 0) return false // sin metadata: no bloquear, el RPC dirá 401
    return nowMs + DISCORD_TOKEN_EXPIRY_SKEW_MS >= exp
}

export interface DiscordTokenExchange {
    clientId: string
    clientSecret: string
    code: string
    redirectUri: string
    fetchFn?: typeof fetch
}

async function postTokenForm(body: Record<string, string>, fetchFn: typeof fetch, label: string): Promise<any> {
    const res = await fetchFn(DISCORD_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
        const msg = typeof (data as any)?.error_description === 'string' && (data as any).error_description
            ? (data as any).error_description
            : typeof (data as any)?.error === 'string' ? (data as any).error : `HTTP ${res.status}`
        throw new DiscordRpcError(
            'needs-auth',
            `Discord rechazó el intercambio de código (${label}): ${msg}. Revisa Client ID/Secret y que el redirect coincida EXACTO con el del portal.`,
            { retryable: false, detail: data },
        )
    }
    return data
}

/** Intercambia el `code` OAuth por access+refresh token y lo normaliza. */
export async function exchangeDiscordCode(ex: DiscordTokenExchange, nowMs: number = Date.now()): Promise<DiscordStoredToken> {
    const clientId = String(ex.clientId ?? '').trim()
    const clientSecret = String(ex.clientSecret ?? '').trim()
    const code = String(ex.code ?? '').trim()
    const redirectUri = String(ex.redirectUri ?? '').trim()
    if (!clientId || !clientSecret) {
        throw new DiscordRpcError('needs-auth', 'Falta el Client ID o el Client Secret en los ajustes del plugin de Discord.')
    }
    if (!code) throw new DiscordRpcError('needs-auth', 'Falta el código de autorización: abre la URL de autorización, acepta el permiso y pega el code.')
    if (!redirectUri) throw new DiscordRpcError('needs-auth', 'Falta el redirect URI: debe ser EXACTAMENTE el registrado en el portal de Discord.')
    const data = await postTokenForm(
        { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret },
        ex.fetchFn ?? fetch,
        'authorization_code',
    )
    return normalizeDiscordTokenCapture(data, nowMs)
}

/** ¿El valor es un placeholder sin rellenar (`__BUNDECK_*__`) o está vacío? */
export function isDiscordPlaceholder(value: unknown): boolean {
    const v = String(value ?? '').trim()
    return v.length === 0 || /^__BUNDECK_.*__$/.test(v)
}

function readDiscordEnv(name: string): string | null {
    try {
        const v = (globalThis as any)?.process?.env?.[name]
        return typeof v === 'string' && v.trim() ? v.trim() : null
    } catch {
        return null
    }
}

function firstUsable(...candidates: Array<string | null | undefined>): string | null {
    for (const c of candidates) {
        const v = String(c ?? '').trim()
        if (v && !isDiscordPlaceholder(v)) return v
    }
    return null
}

/**
 * Resolución zero-config: ajuste del usuario (power-user) ?? env ?? baked-in.
 * Devuelve null si el maintainer aún no rellenó el valor (placeholder).
 */
export function resolveDiscordClientId(userValue?: unknown): string | null {
    return firstUsable(
        String(userValue ?? ''),
        readDiscordEnv('BUNDECK_DISCORD_CLIENT_ID'),
        DEFAULT_DISCORD_CLIENT_ID,
    )
}

/** Igual que el Client ID; el redirect siempre tiene fallback local. */
export function resolveDiscordRedirectUri(userValue?: unknown): string {
    return firstUsable(
        String(userValue ?? ''),
        readDiscordEnv('BUNDECK_DISCORD_REDIRECT_URI'),
        DEFAULT_DISCORD_REDIRECT_URI,
        DISCORD_DEFAULT_REDIRECT_URI,
    ) ?? DISCORD_DEFAULT_REDIRECT_URI
}

/** URL del relay code→token: ajuste proxyUrl ?? env ?? baked-in. */
export function resolveDiscordProxyUrl(userValue?: unknown): string | null {
    return firstUsable(
        String(userValue ?? ''),
        readDiscordEnv('BUNDECK_DISCORD_PROXY_URL'),
        DEFAULT_DISCORD_PROXY_URL,
    )
}

/** ¿Hay zero-config utilizable (Client ID real disponible sin settings)? */
export function isDiscordZeroConfigReady(userClientId?: unknown): boolean {
    return resolveDiscordClientId(userClientId) !== null
}

/** Mensaje estándar cuando el maintainer aún no configuró app/relay. */
export function discordNotConfiguredMessage(): string {
    return 'Discord zero-config no disponible (discord-not-configured): el maintainer aún no rellenó '
        + 'DEFAULT_DISCORD_CLIENT_ID / DEFAULT_DISCORD_REDIRECT_URI / DEFAULT_DISCORD_PROXY_URL '
        + '(ver docs/discord-app-setup.md) ni definió BUNDECK_DISCORD_CLIENT_ID / BUNDECK_DISCORD_PROXY_URL por env. '
        + 'Mientras tanto usa el fallback de atajos globales (modo hotkey).'
}

export interface DiscordProxyExchange {
    code: string
    redirectUri: string
    proxyUrl: string
    fetchFn?: typeof fetch
}

async function postProxyJson(proxyUrl: string, payload: Record<string, unknown>, fetchFn: typeof fetch, label: string): Promise<any> {
    const res = await fetchFn(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
        const msg = typeof (data as any)?.error_description === 'string' && (data as any).error_description
            ? (data as any).error_description
            : typeof (data as any)?.error === 'string' ? (data as any).error : `HTTP ${res.status}`
        throw new DiscordRpcError(
            'needs-auth',
            `El relay de Discord rechazó el intercambio (${label}): ${msg}. Reautoriza con discord.connect.`,
            { retryable: false, detail: data },
        )
    }
    return data
}

/**
 * Intercambia el `code` OAuth vía el relay de LibreDeck (sin secret en el
 * cliente). El secret vive solo en el servidor del relay.
 */
export async function exchangeDiscordCodeViaProxy(ex: DiscordProxyExchange, nowMs: number = Date.now()): Promise<DiscordStoredToken> {
    const code = String(ex.code ?? '').trim()
    const redirectUri = String(ex.redirectUri ?? '').trim()
    const proxyUrl = String(ex.proxyUrl ?? '').trim()
    if (!proxyUrl || isDiscordPlaceholder(proxyUrl)) {
        throw new DiscordRpcError('discord-not-configured', discordNotConfiguredMessage(), { retryable: false })
    }
    if (!code) throw new DiscordRpcError('needs-auth', 'Falta el código de autorización: abre la URL de autorización, acepta el permiso y reintenta.')
    if (!redirectUri) throw new DiscordRpcError('needs-auth', 'Falta el redirect URI: debe ser EXACTAMENTE el registrado en la app de Discord.')
    const data = await postProxyJson(proxyUrl, { code, redirect_uri: redirectUri }, ex.fetchFn ?? fetch, 'authorization_code')
    return normalizeDiscordTokenCapture(data, nowMs)
}

/** Renueva el access token vía el relay (el refresh usa el secret del servidor). */
export async function refreshDiscordTokenViaProxy(
    opts: { refreshToken: string; proxyUrl: string; fetchFn?: typeof fetch },
    nowMs: number = Date.now(),
): Promise<DiscordStoredToken> {
    const refreshToken = String(opts.refreshToken ?? '').trim()
    const proxyUrl = String(opts.proxyUrl ?? '').trim()
    if (!proxyUrl || isDiscordPlaceholder(proxyUrl)) {
        throw new DiscordRpcError('discord-not-configured', discordNotConfiguredMessage(), { retryable: false })
    }
    if (!refreshToken) {
        throw new DiscordRpcError('token-expired', 'El token caducó y no hay refresh token guardado: autoriza de nuevo la app en Discord.', { retryable: false })
    }
    const data = await postProxyJson(
        proxyUrl,
        { grant_type: 'refresh_token', refresh_token: refreshToken },
        opts.fetchFn ?? fetch,
        'refresh_token',
    )
    const normalized = normalizeDiscordTokenCapture(data, nowMs)
    // Algunos intercambios no devuelven refresh nuevo: conserva el anterior.
    if (!normalized.refreshToken) normalized.refreshToken = refreshToken
    return normalized
}

/** Renueva el access token con el refresh token + secret (solo power-user con app propia). */
export async function refreshDiscordToken(
    opts: { clientId: string; clientSecret: string; refreshToken: string; fetchFn?: typeof fetch },
    nowMs: number = Date.now(),
): Promise<DiscordStoredToken> {
    const clientId = String(opts.clientId ?? '').trim()
    const clientSecret = String(opts.clientSecret ?? '').trim()
    const refreshToken = String(opts.refreshToken ?? '').trim()
    if (!clientId || !clientSecret) {
        throw new DiscordRpcError('needs-auth', 'Falta el Client ID o el Client Secret: no se puede renovar el token.')
    }
    if (!refreshToken) {
        throw new DiscordRpcError('token-expired', 'El token caducó y no hay refresh token guardado: autoriza de nuevo la app en Discord.', { retryable: false })
    }
    const data = await postTokenForm(
        { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret },
        opts.fetchFn ?? fetch,
        'refresh_token',
    )
    const normalized = normalizeDiscordTokenCapture(data, nowMs)
    // Algunos intercambios no devuelven refresh nuevo: conserva el anterior.
    if (!normalized.refreshToken) normalized.refreshToken = refreshToken
    return normalized
}

// ---------------- Protocolo RPC (opcodes + comandos) ----------------

export const RPC_OP_HANDSHAKE = 0
export const RPC_OP_FRAME = 1
export const RPC_OP_CLOSE = 2

let rpcNonceCounter = 0

export function nextRpcNonce(): string {
    rpcNonceCounter = (rpcNonceCounter + 1) % Number.MAX_SAFE_INTEGER
    return `libredeck-${Date.now().toString(36)}-${rpcNonceCounter}`
}

/** HANDSHAKE inicial (op 0): versión + client_id. */
export function buildRpcHandshake(clientId: string): { op: number; d: { v: number; client_id: string } } {
    const id = String(clientId ?? '').trim()
    if (!id) throw new Error('Falta el Client ID para el handshake RPC.')
    return { op: RPC_OP_HANDSHAKE, d: { v: 1, client_id: id } }
}

/** AUTHENTICATE (op 1 + cmd): valida el access token contra el cliente. */
export function buildRpcAuthenticate(accessToken: string, nonce: string = nextRpcNonce()): { op: number; d: Record<string, unknown> } {
    const token = String(accessToken ?? '').trim()
    if (!token) throw new Error('Falta el access token para AUTHENTICATE.')
    return { op: RPC_OP_FRAME, d: { cmd: 'AUTHENTICATE', args: { access_token: token }, nonce } }
}

/** SET_VOICE_SETTINGS: mute/deaf reales, sin foco ni teclas. */
export function buildRpcSetVoiceSettings(
    voice: { mute?: boolean | null; deaf?: boolean | null },
    nonce: string = nextRpcNonce(),
): { op: number; d: Record<string, unknown> } {
    const args: Record<string, unknown> = {}
    if (typeof voice.mute === 'boolean') args.mute = voice.mute
    if (typeof voice.deaf === 'boolean') args.deaf = voice.deaf
    if (Object.keys(args).length === 0) {
        throw new Error('SET_VOICE_SETTINGS requiere al menos mute o deaf (boolean).')
    }
    return { op: RPC_OP_FRAME, d: { cmd: 'SET_VOICE_SETTINGS', args, nonce } }
}

/** SUBSCRIBE a VOICE_SETTINGS_UPDATE: estado real de voz (para toggles). */
export function buildRpcSubscribeVoiceSettings(nonce: string = nextRpcNonce()): { op: number; d: Record<string, unknown> } {
    return { op: RPC_OP_FRAME, d: { cmd: 'SUBSCRIBE', evt: 'VOICE_SETTINGS_UPDATE', args: {}, nonce } }
}

/** SELECT_VOICE_CHANNEL: mover al usuario a un canal de voz. */
export function buildRpcSelectVoiceChannel(
    sel: { guildId?: string | null; channelId: string | null; timeout?: number | null },
    nonce: string = nextRpcNonce(),
): { op: number; d: Record<string, unknown> } {
    const channelId = sel.channelId === null ? null : String(sel.channelId ?? '').trim()
    if (channelId !== null && !channelId) throw new Error('SELECT_VOICE_CHANNEL requiere channelId (o null para desconectar).')
    const args: Record<string, unknown> = { channel_id: channelId }
    if (sel.guildId) args.guild_id = String(sel.guildId)
    if (typeof sel.timeout === 'number' && Number.isFinite(sel.timeout)) args.timeout = sel.timeout
    return { op: RPC_OP_FRAME, d: { cmd: 'SELECT_VOICE_CHANNEL', args, nonce } }
}

export type RpcParsedFrame =
    | { kind: 'ready'; data: any; nonce: string | null }
    | { kind: 'authenticated'; data: any; nonce: string | null }
    | { kind: 'voice-settings'; data: any; nonce: string | null }
    | { kind: 'result'; cmd: string; data: any; nonce: string | null }
    | { kind: 'error'; code: number | null; message: string; data: any; nonce: string | null }
    | { kind: 'unknown'; raw: any }

/**
 * Clasifica un frame JSON del socket RPC. Función pura: no toca red.
 * - READY → listo para AUTHENTICATE.
 * - data.code numérico → error (401x auth, voz bloqueada, …).
 */
export function parseRpcFrame(raw: string | Record<string, unknown>): RpcParsedFrame {
    let msg: any = raw
    if (typeof raw === 'string') {
        try {
            msg = JSON.parse(raw)
        } catch {
            return { kind: 'unknown', raw }
        }
    }
    if (!msg || typeof msg !== 'object') return { kind: 'unknown', raw }
    const nonce = typeof msg.nonce === 'string' ? msg.nonce : null
    const data = (msg as any).data ?? null
    if (data && typeof data === 'object' && typeof (data as any).code === 'number') {
        return {
            kind: 'error',
            code: (data as any).code as number,
            message: typeof (data as any).message === 'string' && (data as any).message ? (data as any).message : `RPC error ${(data as any).code}`,
            data,
            nonce,
        }
    }
    if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') return { kind: 'ready', data, nonce }
    if (msg.cmd === 'DISPATCH' && msg.evt === 'VOICE_SETTINGS_UPDATE') return { kind: 'voice-settings', data, nonce }
    if (msg.cmd === 'AUTHENTICATE') return { kind: 'authenticated', data, nonce }
    if (typeof msg.cmd === 'string') return { kind: 'result', cmd: msg.cmd as string, data, nonce }
    return { kind: 'unknown', raw: msg }
}

export interface RpcVoiceState {
    mute: boolean | null
    deaf: boolean | null
}

/** Extrae mute/deaf del payload VOICE_SETTINGS_UPDATE (o de SET result). */
export function normalizeRpcVoiceSettings(data: any): RpcVoiceState {
    if (!data || typeof data !== 'object') return { mute: null, deaf: null }
    const mute = typeof data.mute === 'boolean' ? data.mute : null
    const deaf = typeof data.deaf === 'boolean' ? data.deaf : null
    return { mute, deaf }
}

/** Clasifica un mensaje de error RPC a un código accionable. */
export function classifyRpcError(code: number | null, message: string): DiscordRpcErrorCode {
    const msg = String(message ?? '').toLowerCase()
    if (code === 4006 || code === 4007 || /unauthor|invalid.*token|expired|401/.test(msg)) return 'token-expired'
    if (/lock|locked|otra aplic|another app|en uso/.test(msg)) return 'voice-locked'
    return 'rpc-error'
}

// ---------------- Transporte (socket inyectable) ----------------

export interface MinimalRpcSocket {
    send(data: string): void
    close(): void
    onopen: ((ev?: unknown) => void) | null
    onmessage: ((ev: { data: string }) => void) | null
    onerror: ((ev: unknown) => void) | null
    onclose: ((ev: unknown) => void) | null
}

export type RpcConnectFn = (port: number, clientId: string) => Promise<MinimalRpcSocket>

async function defaultConnectFn(port: number, clientId: string, timeoutMs = 3000): Promise<MinimalRpcSocket> {
    const url = `ws://127.0.0.1:${port}/?v=1&client_id=${encodeURIComponent(clientId)}`
    return new Promise<MinimalRpcSocket>((resolve, reject) => {
        let ws: any
        try {
            ws = new (globalThis as any).WebSocket(url)
        } catch (err) {
            reject(new DiscordRpcError('discord-closed', `No se pudo abrir el socket RPC (puerto ${port}): ${err instanceof Error ? err.message : String(err)}`, { detail: err }))
            return
        }
        const timer = setTimeout(() => {
            try { ws.close() } catch { /* noop */ }
            reject(new DiscordRpcError('discord-closed', `Discord no responde en el puerto ${port}: ¿está abierto Discord en este equipo?`, { retryable: true }))
        }, timeoutMs)
        const done = (fn: () => void) => { clearTimeout(timer); fn() }
        ws.onopen = () => done(() => resolve(ws as MinimalRpcSocket))
        ws.onerror = (ev: unknown) => done(() => reject(new DiscordRpcError(
            'discord-closed',
            `No se pudo conectar al RPC de Discord (puerto ${port}): ¿está abierto Discord en este equipo?`,
            { retryable: true, detail: ev },
        )))
    })
}

export interface RpcConnectionOptions {
    clientId: string
    accessToken?: string | null
    ports?: readonly number[] | number[]
    connectFn?: RpcConnectFn
    timeoutMs?: number
}

interface PendingRequest {
    resolve: (data: any) => void
    reject: (err: Error) => void
    cmd: string
}

/**
 * Conexión RPC mínima al cliente Discord local. Prueba los puertos
 * 6463-6472 en orden, hace handshake, espera READY y expone comandos
 * con promesas por nonce. El socket se inyecta en tests.
 */
export class DiscordRpcConnection {
    private readonly clientId: string
    private accessToken: string | null
    private readonly ports: number[]
    private readonly connectFn: RpcConnectFn
    private readonly timeoutMs: number
    private socket: MinimalRpcSocket | null = null
    private port: number | null = null
    private ready = false
    private pending = new Map<string, PendingRequest>()
    private voiceCache: RpcVoiceState = { mute: null, deaf: null }

    constructor(opts: RpcConnectionOptions) {
        this.clientId = String(opts.clientId ?? '').trim()
        if (!this.clientId) throw new Error('DiscordRpcConnection requiere clientId.')
        this.accessToken = typeof opts.accessToken === 'string' && opts.accessToken.trim() ? opts.accessToken.trim() : null
        this.ports = [...(opts.ports ?? DISCORD_RPC_PORTS)]
        this.connectFn = opts.connectFn ?? ((p, id) => defaultConnectFn(p, id, opts.timeoutMs ?? 3000))
        this.timeoutMs = opts.timeoutMs ?? 8000
    }

    public get connectedPort(): number | null { return this.port }
    public get isReady(): boolean { return this.ready && this.socket !== null }
    public get lastVoiceState(): RpcVoiceState { return { ...this.voiceCache } }

    /** Conecta al primer puerto disponible y espera READY. */
    public async connect(): Promise<{ port: number }> {
        if (this.isReady && this.port !== null) return { port: this.port }
        let lastError: unknown = null
        for (const port of this.ports) {
            try {
                const socket = await this.connectFn(port, this.clientId)
                this.socket = socket
                this.port = port
                this.attach(socket)
                // Handshake inmediato (op 0). El servidor responde READY.
                socket.send(JSON.stringify(buildRpcHandshake(this.clientId)))
                await this.waitReady()
                return { port }
            } catch (err) {
                lastError = err
                try { this.socket?.close() } catch { /* noop */ }
                this.socket = null
                this.port = null
                this.ready = false
                if (err instanceof DiscordRpcError && (err.code === 'needs-auth' || err.code === 'token-expired')) throw err
                continue // probar siguiente puerto
            }
        }
        if (lastError instanceof DiscordRpcError) throw lastError
        throw new DiscordRpcError(
            'discord-closed',
            'No se encontró el cliente Discord (RPC 6463-6472 sin respuesta). Abre Discord en este equipo y reintenta.',
            { retryable: true, detail: lastError },
        )
    }

    public async authenticate(accessToken?: string): Promise<any> {
        const token = String(accessToken ?? this.accessToken ?? '').trim()
        if (!token) {
            throw new DiscordRpcError('needs-auth', 'Falta el access token: autoriza la app en Discord primero.', { retryable: false })
        }
        this.accessToken = token
        const msg = buildRpcAuthenticate(token)
        const data = await this.request(msg, 'AUTHENTICATE')
        return data
    }

    public async subscribeVoiceSettings(): Promise<any> {
        return this.request(buildRpcSubscribeVoiceSettings(), 'SUBSCRIBE')
    }

    public async setVoiceSettings(voice: { mute?: boolean | null; deaf?: boolean | null }): Promise<RpcVoiceState> {
        const data = await this.request(buildRpcSetVoiceSettings(voice), 'SET_VOICE_SETTINGS')
        const state = normalizeRpcVoiceSettings(data)
        if (state.mute !== null || state.deaf !== null) this.voiceCache = { ...this.voiceCache, ...state }
        // Si el servidor no devuelve estado, conserva lo pedido como mejor esfuerzo.
        if (state.mute === null && typeof voice.mute === 'boolean') this.voiceCache.mute = voice.mute
        if (state.deaf === null && typeof voice.deaf === 'boolean') this.voiceCache.deaf = voice.deaf
        return { ...this.voiceCache }
    }

    public async selectVoiceChannel(sel: { guildId?: string | null; channelId: string | null }): Promise<any> {
        return this.request(buildRpcSelectVoiceChannel(sel), 'SELECT_VOICE_CHANNEL')
    }

    public async disconnect(): Promise<void> {
        for (const [, p] of this.pending) {
            try { p.reject(new Error('Conexión RPC cerrada')) } catch { /* noop */ }
        }
        this.pending.clear()
        try { this.socket?.close() } catch { /* noop */ }
        this.socket = null
        this.port = null
        this.ready = false
    }

    private attach(socket: MinimalRpcSocket): void {
        socket.onmessage = (ev) => this.handleMessage(String((ev as any)?.data ?? ''))
        socket.onerror = () => { /* el timeout de request ya cubre el fallo */ }
        socket.onclose = () => {
            this.ready = false
            for (const [, p] of this.pending) {
                try { p.reject(new DiscordRpcError('discord-closed', 'La conexión RPC con Discord se cerró.', { retryable: true })) } catch { /* noop */ }
            }
            this.pending.clear()
        }
    }

    private waitReady(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.socket!.onmessage = null
                reject(new DiscordRpcError('discord-closed', 'Discord no completó el handshake RPC a tiempo: ¿está abierto y actualizado?', { retryable: true }))
            }, this.timeoutMs)
            const prev = this.socket!.onmessage
            this.socket!.onmessage = (ev) => {
                const frame = parseRpcFrame(String((ev as any)?.data ?? ''))
                if (frame.kind === 'ready') {
                    clearTimeout(timer)
                    this.ready = true
                    this.socket!.onmessage = prev
                    resolve()
                    return
                }
                if (frame.kind === 'error') {
                    clearTimeout(timer)
                    reject(new DiscordRpcError(classifyRpcError(frame.code, frame.message), `Discord RPC rechazó el handshake: ${frame.message}`, { detail: frame.data }))
                    return
                }
                // Otros frames durante el handshake: se ignoran.
            }
        })
    }

    private request(msg: { op: number; d: Record<string, unknown> }, cmd: string): Promise<any> {
        if (!this.socket) {
            return Promise.reject(new DiscordRpcError('discord-closed', 'Sin conexión RPC: llama a connect() primero.', { retryable: true }))
        }
        const nonce = String((msg.d as any)?.nonce ?? nextRpcNonce())
        ;(msg.d as any).nonce = nonce
        return new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(nonce)
                reject(new DiscordRpcError('discord-closed', `Discord no respondió al comando ${cmd} (¿se cerró la app?)`, { retryable: true }))
            }, this.timeoutMs)
            this.pending.set(nonce, {
                cmd,
                resolve: (data) => { clearTimeout(timer); resolve(data) },
                reject: (err) => { clearTimeout(timer); reject(err) },
            })
            try {
                this.socket!.send(JSON.stringify(msg))
            } catch (err) {
                this.pending.delete(nonce)
                clearTimeout(timer)
                reject(new DiscordRpcError('discord-closed', `No se pudo enviar ${cmd} a Discord: ${err instanceof Error ? err.message : String(err)}`, { retryable: true }))
            }
        })
    }

    private handleMessage(raw: string): void {
        const frame = parseRpcFrame(raw)
        if (frame.kind === 'voice-settings') {
            const st = normalizeRpcVoiceSettings(frame.data)
            if (st.mute !== null || st.deaf !== null) this.voiceCache = { ...this.voiceCache, ...st }
            if (frame.nonce && this.pending.has(frame.nonce)) {
                const p = this.pending.get(frame.nonce)!
                this.pending.delete(frame.nonce)
                p.resolve(frame.data)
            }
            return
        }
        if ((frame.kind === 'result' || frame.kind === 'authenticated') && frame.nonce && this.pending.has(frame.nonce)) {
            const p = this.pending.get(frame.nonce)!
            this.pending.delete(frame.nonce)
            p.resolve(frame.data)
            return
        }
        if (frame.kind === 'ready') {
            this.ready = true
            return
        }
        if (frame.kind === 'error') {
            if (frame.nonce && this.pending.has(frame.nonce)) {
                const p = this.pending.get(frame.nonce)!
                this.pending.delete(frame.nonce)
                p.reject(new DiscordRpcError(
                    classifyRpcError(frame.code, frame.message),
                    `Discord RPC: ${frame.message} (comando ${p.cmd})`,
                    { retryable: frame.code !== 4006, detail: frame.data },
                ))
                return
            }
            // Error sin nonce (p. ej. en handshake): se propaga como fallo genérico.
            return
        }
        // unknown / result sin nonce: se ignora (eventos no suscritos).
    }
}

// ---------------- Modo + needs-auth (lógica compartida) ----------------

export type DiscordMode = 'auto' | 'rpc' | 'hotkey'

/** Normaliza el ajuste `mode`: por defecto `auto` (RPC y cae a hotkey sin auth). */
export function resolveDiscordMode(raw: unknown): DiscordMode {
    const v = String(raw ?? 'auto').trim().toLowerCase()
    if (v === 'rpc' || v === 'hotkey' || v === 'auto') return v
    return 'auto'
}

export interface NeedsAuthParams {
    clientId?: string | null
    redirectUri?: string | null
    reason: 'missing-config' | 'token-expired' | 'no-token' | 'not-configured'
    missing?: string[]
}

export interface NeedsAuthResult {
    status: 'needs-auth'
    reason: string
    authorizeUrl: string | null
    missing: string[]
    instructions: string
    permissionNote: string
}

/**
 * Construye el payload `needs-auth`: URL de autorización (si hay Client ID),
 * qué falta y el aviso de permiso explícito. Nunca es silencioso.
 */
export function buildDiscordNeedsAuth(params: NeedsAuthParams): NeedsAuthResult {
    const clientId = String(params.clientId ?? '').trim()
    const redirectUri = String(params.redirectUri ?? '').trim() || DISCORD_DEFAULT_REDIRECT_URI
    let missing: string[]
    if (Array.isArray(params.missing) && params.missing.length > 0) {
        missing = params.missing
    } else if (params.reason === 'not-configured') {
        missing = ['clientId', 'relay no configurado (discord-not-configured: maintainer, ver docs/discord-app-setup.md)']
    } else {
        missing = [
            ...(clientId ? [] : ['clientId']),
            ...(params.reason === 'missing-config' ? ['accessToken (autoriza la app)'] : []),
            ...(params.reason === 'no-token' || params.reason === 'token-expired' ? ['accessToken (autoriza la app de nuevo)'] : []),
        ]
    }
    let authorizeUrl: string | null = null
    try {
        authorizeUrl = clientId ? buildDiscordAuthorizeUrl({ clientId, redirectUri }) : null
    } catch {
        authorizeUrl = null
    }
    return {
        status: 'needs-auth',
        reason: params.reason,
        authorizeUrl,
        missing,
        instructions: getDiscordSetupInstructions(authorizeUrl),
        permissionNote: 'Discord pedirá tu permiso explícito UNA vez (popup "Authorize"): BunDeck solo controla voz (mute/deafen), nunca lee tus mensajes.',
    }
}

/** Guía paso a paso: 1 clic Autorizar (zero-config) + fallback + avanzado. */
export function getDiscordSetupInstructions(authorizeUrl: string | null): string {
    return [
        'Conectar Discord en background (sin teclas ni foco): UN SOLO CLIC.',
        '',
        '1. Pulsa "Autorizar con Discord" (o ejecuta la acción discord.connect): se abre el navegador.',
        '2. Discord te pedirá permiso EXPLÍCITO una vez (popup "Authorize ... ?"): acepta. Sin ese clic, nada funciona (así debe ser).',
        '3. El token queda guardado en local y se renueva solo vía LibreDeck. Ya puedes mutear con el juego en primer plano.',
        authorizeUrl
            ? `   URL directa: ${authorizeUrl}`
            : '   (La URL de autorización aparecerá aquí cuando el relay esté configurado.)',
        '',
        'Sin este paso, el plugin usa el fallback de atajos GLOBALES (requiere configurarlos en Discord → Ajustes → Atajos de teclado).',
        '',
        'AVANZADO (solo power-users con app propia): crea una app en https://discord.com/developers/applications, '
        + 'pega su Client ID + Client Secret + Redirect en los ajustes y el intercambio será directo con discord.com sin pasar por el relay.',
    ].join('\n')
}
