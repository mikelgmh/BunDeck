/**
 * discord-rpc.test.ts — Discord en background (RPC) + fallback hotkey.
 *
 * Sin red ni teclas reales: sockets RPC y fetch inyectados, hotkeys mockeados.
 * Cubre parse/handshake, normalización, needs-auth, fallback hotkey y que
 * las firmas de acciones existentes no cambian.
 */
import { describe, it, expect } from 'bun:test'
import {
    DEFAULT_DISCORD_CLIENT_ID,
    DEFAULT_DISCORD_PROXY_URL,
    DEFAULT_DISCORD_REDIRECT_URI,
    DISCORD_RPC_PORTS,
    DiscordRpcError,
    buildDiscordAuthorizeUrl,
    buildDiscordNeedsAuth,
    buildRpcAuthenticate,
    buildRpcHandshake,
    buildRpcSelectVoiceChannel,
    buildRpcSetVoiceSettings,
    buildRpcSubscribeVoiceSettings,
    classifyRpcError,
    discordNotConfiguredMessage,
    exchangeDiscordCode,
    exchangeDiscordCodeViaProxy,
    getDiscordSetupInstructions,
    isDiscordPlaceholder,
    isDiscordTokenExpired,
    isDiscordZeroConfigReady,
    normalizeDiscordTokenCapture,
    normalizeRpcVoiceSettings,
    parseRpcFrame,
    refreshDiscordTokenViaProxy,
    resolveDiscordClientId,
    resolveDiscordProxyUrl,
    resolveDiscordRedirectUri,
    resolveDiscordMode,
} from '../plugins/discord-rpc'
import { DiscordPlugin, sendHotkey } from '../plugins/discord.plugin'

// ---------- helpers ----------

function makeCtx(initial: Record<string, string> = {}) {
    const store: Record<string, string> = { ...initial }
    const ctx: any = {
        log: (_l: string, _m: string, _meta?: any) => {},
        getSetting: (k: string) => (k in store ? store[k] : null),
        setSetting: (k: string, v: string) => { store[k] = String(v) },
        deleteSetting: (k: string) => { delete store[k] },
    }
    return { ctx, store }
}

class FakeRpc {
    state = { mute: false, deaf: false }
    connectCalls = 0
    setCalls: any[] = []
    constructor(private behavior: 'ok' | 'closed' | 'locked' = 'ok') {}
    get connectedPort() { return 6463 }
    get lastVoiceState() { return { mute: this.state.mute, deaf: this.state.deaf } }
    async connect() {
        this.connectCalls++
        if (this.behavior === 'closed') throw new DiscordRpcError('discord-closed', 'Discord cerrado', { retryable: true })
        return { port: 6463 }
    }
    async authenticate() { return { application: { id: 'x' } } }
    async subscribeVoiceSettings() { return { ...this.state } }
    async setVoiceSettings(v: any) {
        if (this.behavior === 'locked') throw new DiscordRpcError('voice-locked', 'Voice locked by another application', { retryable: false })
        if (typeof v?.mute === 'boolean') this.state.mute = v.mute
        if (typeof v?.deaf === 'boolean') this.state.deaf = v.deaf
        this.setCalls.push(v)
        return { ...this.state }
    }
    async selectVoiceChannel(sel: any) { return { ok: true, ...sel } }
    async disconnect() {}
}

const okRpc = (behavior: 'ok' | 'closed' | 'locked' = 'ok') => ({
    createRpcConnection: () => new FakeRpc(behavior) as any,
    hotkeyTap: async (hotkey: string, holdMs = 0) => ({ hotkey, heldMs: holdMs, platform: 'test' }),
    openUrlFn: async (_url: string) => {},
})

// ---------- transporte puro ----------

describe('discord-rpc: authorize + token', () => {
    it('buildDiscordAuthorizeUrl incluye client_id, code y scopes de voz', () => {
        const url = buildDiscordAuthorizeUrl({ clientId: '123', redirectUri: 'http://127.0.0.1:6463' })
        expect(url).toContain('discord.com/oauth2/authorize')
        expect(url).toContain('client_id=123')
        expect(url).toContain('response_type=code')
        expect(url).toContain('rpc.voice.write')
        expect(url).toContain('identify')
    })

    it('rechaza clientId vacío', () => {
        expect(() => buildDiscordAuthorizeUrl({ clientId: '  ' })).toThrow(/Client ID/)
    })

    it('normaliza captures snake_case y camelCase', () => {
        const a = normalizeDiscordTokenCapture({ access_token: 'tok-abcdefghij', refresh_token: 'r1', expires_in: 3600 }, 1000)
        expect(a.accessToken).toBe('tok-abcdefghij')
        expect(a.refreshToken).toBe('r1')
        expect(a.expiresAt).toBe(String(1000 + 3600 * 1000))
        const b = normalizeDiscordTokenCapture({ accessToken: 'tok-abcdefghij' }, 1000)
        expect(b.accessToken).toBe('tok-abcdefghij')
        expect(Number(b.expiresIn)).toBeGreaterThan(0)
    })

    it('rechaza captures sin token', () => {
        expect(() => normalizeDiscordTokenCapture({}, 0)).toThrow(/access_token/)
        expect(() => normalizeDiscordTokenCapture({ access_token: 'x' }, 0)).toThrow(/access_token/)
    })

    it('isDiscordTokenExpired respeta el skew y la falta de metadata', () => {
        expect(isDiscordTokenExpired({ tokenExpiresAt: String(Date.now() - 1000) })).toBe(true)
        expect(isDiscordTokenExpired({ tokenExpiresAt: String(Date.now() + 3600_000) })).toBe(false)
        expect(isDiscordTokenExpired({})).toBe(false)
    })
})

describe('discord-rpc: protocolo', () => {
    it('puertos 6463-6472', () => {
        expect([...DISCORD_RPC_PORTS]).toEqual([6463, 6464, 6465, 6466, 6467, 6468, 6469, 6470, 6471, 6472])
    })

    it('handshake op 0 con versión y client_id', () => {
        expect(buildRpcHandshake('abc')).toEqual({ op: 0, d: { v: 1, client_id: 'abc' } })
        expect(() => buildRpcHandshake('')).toThrow(/Client ID/)
    })

    it('authenticate op 1 con cmd y nonce', () => {
        const m = buildRpcAuthenticate('tok-123')
        expect(m.op).toBe(1)
        expect((m.d as any).cmd).toBe('AUTHENTICATE')
        expect((m.d as any).args.access_token).toBe('tok-123')
        expect(typeof (m.d as any).nonce).toBe('string')
    })

    it('setVoiceSettings exige al menos un booleano', () => {
        const m = buildRpcSetVoiceSettings({ mute: true })
        expect((m.d as any).cmd).toBe('SET_VOICE_SETTINGS')
        expect((m.d as any).args).toEqual({ mute: true })
        expect(() => buildRpcSetVoiceSettings({})).toThrow(/mute o deaf/)
    })

    it('subscribe y select-voice tienen el cmd correcto', () => {
        expect((buildRpcSubscribeVoiceSettings().d as any).cmd).toBe('SUBSCRIBE')
        const sel = buildRpcSelectVoiceChannel({ guildId: 'g1', channelId: 'c9' })
        expect((sel.d as any).cmd).toBe('SELECT_VOICE_CHANNEL')
        expect((sel.d as any).args.channel_id).toBe('c9')
    })

    it('parseRpcFrame clasifica READY / AUTH / VOICE / ERROR / desconocido', () => {
        expect(parseRpcFrame(JSON.stringify({ cmd: 'DISPATCH', evt: 'READY', data: { v: 1 }, nonce: null })).kind).toBe('ready')
        expect(parseRpcFrame(JSON.stringify({ cmd: 'AUTHENTICATE', data: {}, nonce: 'n1' })).kind).toBe('authenticated')
        expect(parseRpcFrame(JSON.stringify({ cmd: 'DISPATCH', evt: 'VOICE_SETTINGS_UPDATE', data: { mute: true }, nonce: null })).kind).toBe('voice-settings')
        const err = parseRpcFrame(JSON.stringify({ cmd: 'SET_VOICE_SETTINGS', data: { code: 4006, message: 'Unauthorized' }, nonce: 'n2' }))
        expect(err.kind).toBe('error')
        if (err.kind === 'error') expect(err.code).toBe(4006)
        expect(parseRpcFrame('no-json{{{').kind).toBe('unknown')
    })

    it('normalizeRpcVoiceSettings extrae mute/deaf', () => {
        expect(normalizeRpcVoiceSettings({ mute: true, deaf: false })).toEqual({ mute: true, deaf: false })
        expect(normalizeRpcVoiceSettings(null)).toEqual({ mute: null, deaf: null })
    })

    it('classifyRpcError mapea auth y lock de voz', () => {
        expect(classifyRpcError(4006, 'Unauthorized')).toBe('token-expired')
        expect(classifyRpcError(5000, 'Voice locked by another application')).toBe('voice-locked')
        expect(classifyRpcError(9999, 'raro')).toBe('rpc-error')
    })
})

describe('discord-rpc: modo + needs-auth', () => {
    it('resolveDiscordMode: auto por defecto, ignora valores raros', () => {
        expect(resolveDiscordMode(undefined)).toBe('auto')
        expect(resolveDiscordMode('RPC')).toBe('rpc')
        expect(resolveDiscordMode('hotkey')).toBe('hotkey')
        expect(resolveDiscordMode('teclas')).toBe('auto')
    })

    it('needs-auth con Client ID trae URL y permiso explícito', () => {
        const r = buildDiscordNeedsAuth({ clientId: '123', redirectUri: 'http://127.0.0.1:6463', reason: 'no-token' })
        expect(r.status).toBe('needs-auth')
        expect(r.authorizeUrl).toContain('client_id=123')
        expect(r.instructions).toContain('discord.com/developers/applications')
        expect(r.permissionNote).toContain('Authorize')
    })

    it('needs-auth sin Client ID no inventa URL y lista qué falta', () => {
        const r = buildDiscordNeedsAuth({ reason: 'missing-config' })
        expect(r.status).toBe('needs-auth')
        expect(r.authorizeUrl).toBeNull()
        expect(r.missing).toContain('clientId')
    })

    it('las instrucciones explican el popup y el fallback', () => {
        expect(getDiscordSetupInstructions(null)).toContain('Authorize')
        expect(getDiscordSetupInstructions('https://x')).toContain('https://x')
    })
})

// ---------- plugin ----------

describe('DiscordPlugin manifest RPC', () => {
    it('expone 7 acciones, oauth discord y settings con títulos', () => {
        const { ctx } = makeCtx()
        const manifest = new DiscordPlugin(ctx).getManifest()
        expect(manifest.id).toBe('discord')
        expect(manifest.version).toBe('1.2.0')
        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(['connect', 'disconnect', 'open-channel', 'push-to-talk', 'status', 'toggle-deafen', 'toggle-mute'])
        expect(manifest.oauth.provider).toBe('discord')
        expect(manifest.oauth.scopes).toContain('rpc.voice.write')
        // Sin regresión: las 4 acciones originales siguen con schema válido y títulos.
        for (const action of manifest.actions) {
            expect(action.schema?.type).toBe('object')
            for (const [key, prop] of Object.entries<any>(action.schema.properties)) {
                expect(prop.title, `${action.id}.${key} debe tener title`).toBeDefined()
            }
        }
        // Nuevos ajustes RPC documentados (cero-config + avanzado power-user).
        for (const k of ['mode', 'clientId', 'clientSecret', 'redirectUri', 'proxyUrl', 'accessToken']) {
            expect(manifest.settingsSchema.properties[k]?.title, `settings.${k}`).toBeDefined()
        }
    })
})

describe('DiscordPlugin voz: RPC primero, hotkey de fallback', () => {
    it('auto sin auth cae al hotkey (sin romper botones existentes)', async () => {
        const { ctx } = makeCtx()
        const tapCalls: any[] = []
        const plugin = new DiscordPlugin(ctx, { ...okRpc(), hotkeyTap: async (h, hold) => { tapCalls.push([h, hold]); return { hotkey: h, heldMs: hold ?? 0, platform: 'test' } } })
        const res = await plugin.getActionHandlers().get('toggle-mute')!({ hotkey: 'ctrl+shift+m' }, {})
        expect(res.transport).toBe('hotkey')
        expect(tapCalls).toEqual([['ctrl+shift+m', 0]])
    })

    it('rpc sin config devuelve needs-auth (no lanza, no toca teclas)', async () => {
        const { ctx } = makeCtx({ mode: 'rpc' })
        let tapped = 0
        const plugin = new DiscordPlugin(ctx, { ...okRpc(), hotkeyTap: async (h, hold) => { tapped++; return { hotkey: h, heldMs: hold ?? 0, platform: 'test' } } })
        const res = await plugin.getActionHandlers().get('toggle-mute')!({}, {})
        expect(res.status).toBe('needs-auth')
        expect(res.instructions).toContain('discord.com/developers/applications')
        expect(tapped).toBe(0)
    })

    it('con auth usa RPC en background (mute real, sin hotkey)', async () => {
        const { ctx } = makeCtx({ clientId: 'cid', accessToken: 'tok-abcdefghij' })
        let tapped = 0
        const plugin = new DiscordPlugin(ctx, { ...okRpc('ok'), hotkeyTap: async (h, hold) => { tapped++; return { hotkey: h, heldMs: hold ?? 0, platform: 'test' } } })
        const res = await plugin.getActionHandlers().get('toggle-mute')!({}, {})
        expect(res.transport).toBe('rpc')
        expect(res.mute).toBe(true)
        expect(tapped).toBe(0)
    })

    it('Discord cerrado: auto cae a hotkey, rpc devuelve error reintentable', async () => {
        const mk = (mode: string) => {
            const { ctx } = makeCtx({ mode, clientId: 'cid', accessToken: 'tok-abcdefghij' })
            return new DiscordPlugin(ctx, { ...okRpc('closed'), hotkeyTap: async (h) => ({ hotkey: h, heldMs: 0, platform: 'test' }) })
        }
        const autoRes = await mk('auto').getActionHandlers().get('toggle-mute')!({}, {})
        expect(autoRes.transport).toBe('hotkey')
        const rpcRes = await mk('rpc').getActionHandlers().get('toggle-mute')!({}, {})
        expect(rpcRes.status).toBe('error')
        expect(rpcRes.code).toBe('discord-closed')
        expect(rpcRes.retryable).toBe(true)
    })

    it('token caducado sin refresh pide renovar (no cae a hotkey en silencio)', async () => {
        const { ctx } = makeCtx({ mode: 'auto', clientId: 'cid', accessToken: 'tok-abcdefghij', tokenExpiresAt: String(Date.now() - 5000) })
        const plugin = new DiscordPlugin(ctx, okRpc('ok'))
        const res = await plugin.getActionHandlers().get('toggle-deafen')!({}, {})
        expect(res.status).toBe('error')
        expect(res.code).toBe('token-expired')
    })

    it('token caducado con refresh+secret se renueva y ejecuta por RPC', async () => {
        const { ctx, store } = makeCtx({
            mode: 'rpc', clientId: 'cid', clientSecret: 'sec',
            accessToken: 'tok-old-abcdefghij', refreshToken: 'ref-1',
            tokenExpiresAt: String(Date.now() - 5000),
        })
        const fetchFn: any = async () => ({ ok: true, json: async () => ({ access_token: 'tok-new-abcdefghij', refresh_token: 'ref-2', expires_in: 3600 }) })
        const plugin = new DiscordPlugin(ctx, { ...okRpc('ok'), fetchFn })
        const res = await plugin.getActionHandlers().get('toggle-mute')!({}, {})
        expect(res.transport).toBe('rpc')
        expect(store.accessToken).toBe('tok-new-abcdefghij')
        expect(store.refreshToken).toBe('ref-2')
    })

    it('lock de voz por otra app: error claro sin fallback', async () => {
        for (const mode of ['auto', 'rpc']) {
            const { ctx } = makeCtx({ mode, clientId: 'cid', accessToken: 'tok-abcdefghij' })
            const plugin = new DiscordPlugin(ctx, okRpc('locked'))
            const res = await plugin.getActionHandlers().get('toggle-mute')!({}, {})
            expect(res.status, mode).toBe('error')
            expect(res.code, mode).toBe('voice-locked')
        }
    })

    it('push-to-talk press/release van por RPC sin holdMs', async () => {
        const { ctx } = makeCtx({ clientId: 'cid', accessToken: 'tok-abcdefghij' })
        let rpc: FakeRpc | null = null
        const plugin = new DiscordPlugin(ctx, { ...okRpc('ok'), createRpcConnection: () => (rpc = new FakeRpc('ok')) as any })
        const press = await plugin.getActionHandlers().get('push-to-talk')!({ phase: 'press' }, {})
        expect(press).toMatchObject({ transport: 'rpc', phase: 'press', mute: false })
        const release = await plugin.getActionHandlers().get('push-to-talk')!({ phase: 'release' }, {})
        expect(release).toMatchObject({ transport: 'rpc', phase: 'release', mute: true })
        expect(rpc!.setCalls).toEqual([{ mute: false }, { mute: true }])
    })
})

describe('DiscordPlugin acciones nuevas', () => {
    it('connect sin token usa el Client ID baked-in (no-token con URL, 1 clic)', async () => {
        const { ctx } = makeCtx()
        const plugin = new DiscordPlugin(ctx, okRpc())
        const res = await plugin.getActionHandlers().get('connect')!({}, {})
        expect(res.status).toBe('needs-auth')
        expect(res.reason).toBe('no-token')
        expect(res.authorizeUrl).toContain('1575201215791497256')
    })

    it('connect con Client ID devuelve URL y la abre (permiso explícito)', async () => {
        const { ctx } = makeCtx({ clientId: 'cid-1' })
        const opened: string[] = []
        const plugin = new DiscordPlugin(ctx, { ...okRpc(), openUrlFn: async (u) => { opened.push(u) } })
        const res = await plugin.getActionHandlers().get('connect')!({}, {})
        expect(res.status).toBe('needs-auth')
        expect(res.authorizeUrl).toContain('cid-1')
        expect(opened).toEqual([res.authorizeUrl])
    })

    it('connect con code intercambia token y lo guarda', async () => {
        const { ctx, store } = makeCtx({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://127.0.0.1:6463' })
        const fetchFn: any = async (url: string) => {
            expect(String(url)).toContain('discord.com/api/oauth2/token')
            return { ok: true, json: async () => ({ access_token: 'tok-code-abcdef', refresh_token: 'r-code', expires_in: 3600 }) }
        }
        const plugin = new DiscordPlugin(ctx, { ...okRpc('ok'), fetchFn })
        const res = await plugin.getActionHandlers().get('connect')!({ code: 'authcode-1' }, {})
        expect(['connected', 'authorized']).toContain(res.status)
        expect(store.accessToken).toBe('tok-code-abcdef')
    })

    it('status sin config informa needs-auth y status con RPC informa conectado', async () => {
        const noconf = new DiscordPlugin(makeCtx().ctx, okRpc())
        expect((await noconf.getActionHandlers().get('status')!({}, {})).status).toBe('needs-auth')
        const { ctx } = makeCtx({ clientId: 'cid', accessToken: 'tok-abcdefghij' })
        const ok = new DiscordPlugin(ctx, okRpc('ok'))
        const st = await ok.getActionHandlers().get('status')!({}, {})
        expect(st.status).toBe('connected')
        expect(st.transport).toBe('rpc')
    })

    it('disconnect borra el token', async () => {
        const { ctx, store } = makeCtx({ clientId: 'cid', accessToken: 'tok-abcdefghij', refreshToken: 'r', tokenExpiresAt: '1' })
        const plugin = new DiscordPlugin(ctx, okRpc())
        const res = await plugin.getActionHandlers().get('disconnect')!({}, {})
        expect(res.status).toBe('disconnected')
        expect(store.accessToken ?? '').toBe('')
    })
})

describe('DiscordPlugin sin regresión de firmas existentes', () => {
    it('sendHotkey sigue validando igual', async () => {
        await expect(sendHotkey('')).rejects.toThrow(/vacío/)
        await expect(sendHotkey('ctrl+shift+')).rejects.toThrow(/tecla principal/)
    })

    it('push-to-talk en modo hotkey sin atajo sigue pidiendo configurarlo', async () => {
        const { ctx } = makeCtx({ mode: 'hotkey' })
        const plugin = new DiscordPlugin(ctx, okRpc())
        await expect(plugin.getActionHandlers().get('push-to-talk')!({}, {})).rejects.toThrow(/Pulsar para hablar/)
    })

    it('open-channel exige url o canal de voz RPC', async () => {
        const { ctx } = makeCtx({ mode: 'hotkey' })
        const plugin = new DiscordPlugin(ctx, okRpc())
        await expect(plugin.getActionHandlers().get('open-channel')!({}, {})).rejects.toThrow(/url/)
        await expect(plugin.getActionHandlers().get('open-channel')!({ url: 'https://example.com/abc' }, {})).rejects.toThrow(/no válida/)
    })

    it('open-channel con voiceChannelId y auth usa RPC', async () => {
        const { ctx } = makeCtx({ clientId: 'cid', accessToken: 'tok-abcdefghij' })
        const plugin = new DiscordPlugin(ctx, okRpc('ok'))
        const res = await plugin.getActionHandlers().get('open-channel')!({ voiceChannelId: 'chan-1', guildId: 'g-1' }, {})
        expect(res.transport).toBe('rpc')
        expect(res.voiceChannelId).toBe('chan-1')
    })
})

// ---------- zero-config ----------

const DISCORD_ENV_KEYS = ['BUNDECK_DISCORD_CLIENT_ID', 'BUNDECK_DISCORD_REDIRECT_URI', 'BUNDECK_DISCORD_PROXY_URL'] as const

async function withCleanDiscordEnv(fn: () => Promise<void>): Promise<void> {
    const saved: Record<string, string | undefined> = {}
    for (const k of DISCORD_ENV_KEYS) {
        saved[k] = process.env[k]
        delete process.env[k]
    }
    try {
        await fn()
    } finally {
        for (const k of DISCORD_ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k]
            else process.env[k] = saved[k]
        }
    }
}

function mockProxyFetch(calls: Array<{ url: string; body: any }>, payload: any = { access_token: 'tok-proxy-abcdef', refresh_token: 'r-proxy', expires_in: 3600 }) {
    return async (url: any, init: any) => {
        let body: any = null
        try { body = JSON.parse(String(init?.body ?? '{}')) } catch { body = init?.body }
        calls.push({ url: String(url), body })
        return { ok: true, json: async () => payload }
    }
}

describe('discord zero-config: resolución de defaults', () => {
    it('Client ID baked-in real resuelve sin settings ni env', async () => {
        await withCleanDiscordEnv(async () => {
            expect(isDiscordPlaceholder(DEFAULT_DISCORD_CLIENT_ID)).toBe(false)
            expect(DEFAULT_DISCORD_CLIENT_ID).toBe('1575201215791497256')
            expect(resolveDiscordClientId(undefined)).toBe('1575201215791497256')
            expect(resolveDiscordClientId('')).toBe('1575201215791497256')
            expect(isDiscordZeroConfigReady()).toBe(true)
            // Redirect y proxy sí tienen default utilizable.
            expect(resolveDiscordRedirectUri(undefined)).toBe(DEFAULT_DISCORD_REDIRECT_URI)
            expect(resolveDiscordProxyUrl(undefined)).toBe(DEFAULT_DISCORD_PROXY_URL)
        })
    })

    it('prioridad: settings del usuario > env > baked-in', async () => {
        await withCleanDiscordEnv(async () => {
            process.env.BUNDECK_DISCORD_CLIENT_ID = 'env-cid'
            expect(resolveDiscordClientId(undefined)).toBe('env-cid')
            expect(resolveDiscordClientId('user-cid')).toBe('user-cid')
            expect(isDiscordZeroConfigReady('user-cid')).toBe(true)
            process.env.BUNDECK_DISCORD_PROXY_URL = 'https://relay.example/token'
            expect(resolveDiscordProxyUrl(undefined)).toBe('https://relay.example/token')
            expect(resolveDiscordProxyUrl('https://custom.example/t')).toBe('https://custom.example/t')
        })
    })

    it('sin secret embebido en el bundle: el directo exige secret propio del usuario', async () => {
        const mod: any = await import('../plugins/discord-rpc')
        expect(mod.DEFAULT_DISCORD_CLIENT_SECRET).toBeUndefined()
        expect(isDiscordPlaceholder(mod.DEFAULT_DISCORD_CLIENT_ID)).toBe(false)
        expect(mod.DEFAULT_DISCORD_CLIENT_ID).toBe('1575201215791497256')
        // Sin secret del usuario no hay intercambio directo posible.
        await expect(exchangeDiscordCode({ clientId: 'cid', clientSecret: '', code: 'c', redirectUri: 'r' } as any)).rejects.toMatchObject({ code: 'needs-auth' })
        await expect(exchangeDiscordCode({ clientId: '', clientSecret: '', code: 'c', redirectUri: 'r' } as any)).rejects.toMatchObject({ code: 'needs-auth' })
    })
})

describe('discord zero-config: intercambio vía proxy', () => {
    it('POST al proxy con {code, redirect_uri}, nunca a discord.com con secret', async () => {
        const calls: Array<{ url: string; body: any }> = []
        const stored = await exchangeDiscordCodeViaProxy({
            code: 'authcode-1', redirectUri: 'http://127.0.0.1:6463',
            proxyUrl: 'https://relay.test/token', fetchFn: mockProxyFetch(calls) as any,
        })
        expect(stored.accessToken).toBe('tok-proxy-abcdef')
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://relay.test/token')
        expect(calls[0].url).not.toContain('discord.com')
        expect(calls[0].body.code).toBe('authcode-1')
        expect(calls[0].body.redirect_uri).toBe('http://127.0.0.1:6463')
        expect(JSON.stringify(calls[0].body)).not.toMatch(/client_secret|clientSecret/)
    })

    it('proxy placeholder → discord-not-configured con guía del maintainer', async () => {
        await expect(exchangeDiscordCodeViaProxy({
            code: 'c', redirectUri: 'r', proxyUrl: '__BUNDECK_DISCORD_PROXY_URL__',
        })).rejects.toMatchObject({ code: 'discord-not-configured' })
        const err: any = await exchangeDiscordCodeViaProxy({ code: 'c', redirectUri: 'r', proxyUrl: '__BUNDECK_DISCORD_PROXY_URL__' }).catch((e) => e)
        expect(err).toBeInstanceOf(DiscordRpcError)
        expect(String(err.message)).toContain('docs/discord-app-setup.md')
        expect(discordNotConfiguredMessage()).toContain('discord-not-configured')
        await expect(refreshDiscordTokenViaProxy({ refreshToken: 'r', proxyUrl: '' })).rejects.toMatchObject({ code: 'discord-not-configured' })
    })

    it('refresh vía proxy conserva el refresh anterior si el relay no lo devuelve', async () => {
        const calls: Array<{ url: string; body: any }> = []
        const stored = await refreshDiscordTokenViaProxy({
            refreshToken: 'old-refresh', proxyUrl: 'https://relay.test/token',
            fetchFn: mockProxyFetch(calls, { access_token: 'tok-new-abcdef', expires_in: 3600 }) as any,
        })
        expect(stored.accessToken).toBe('tok-new-abcdef')
        expect(stored.refreshToken).toBe('old-refresh')
        expect(calls[0].body.grant_type).toBe('refresh_token')
        expect(JSON.stringify(calls[0].body)).not.toMatch(/client_secret|clientSecret/)
    })
})

describe('discord zero-config: needs-auth vs not-configured', () => {
    it('not-configured: sin URL, missing con clientId y guía de 1 clic', () => {
        const r = buildDiscordNeedsAuth({ reason: 'not-configured' })
        expect(r.status).toBe('needs-auth')
        expect(r.reason).toBe('not-configured')
        expect(r.authorizeUrl).toBeNull()
        expect(r.missing).toContain('clientId')
        expect(r.missing.join(' ')).toContain('discord-not-configured')
        expect(r.instructions).toContain('UN SOLO CLIC')
        expect(r.instructions).toContain('discord.com/developers/applications')
    })

    it('no-token con Client ID trae URL de 1 clic con el ID baked-in', () => {
        const r = buildDiscordNeedsAuth({ clientId: 'baked-cid', redirectUri: 'http://127.0.0.1:6463', reason: 'no-token' })
        expect(r.authorizeUrl).toContain('client_id=baked-cid')
        expect(r.instructions).toContain('Autorizar con Discord')
    })

    it('connect sin token, con baked-in real, devuelve no-token con URL (ya no not-configured)', async () => {
        await withCleanDiscordEnv(async () => {
            const { ctx } = makeCtx({ mode: 'rpc' })
            let tapped = 0
            const plugin = new DiscordPlugin(ctx, { ...okRpc(), hotkeyTap: async (h, hold) => { tapped++; return { hotkey: h, heldMs: hold ?? 0, platform: 'test' } } })
            const res = await plugin.getActionHandlers().get('connect')!({}, {})
            expect(res.status).toBe('needs-auth')
            expect(res.reason).toBe('no-token')
            expect(res.authorizeUrl).toContain('1575201215791497256')
            expect(tapped).toBe(0)
        })
    })

    it('connect con code sin secret va al proxy (no a discord.com)', async () => {
        await withCleanDiscordEnv(async () => {
            const { ctx, store } = makeCtx()
            const calls: Array<{ url: string; body: any }> = []
            const plugin = new DiscordPlugin(ctx, { ...okRpc('closed'), fetchFn: mockProxyFetch(calls) as any })
            const res = await plugin.getActionHandlers().get('connect')!({ code: 'authcode-9' }, {})
            // Sin clientId no se puede verificar contra el RPC local, pero el
            // token queda guardado igualmente (permiso ya concedido).
            expect(['connected', 'authorized']).toContain(res.status)
            expect(store.accessToken).toBe('tok-proxy-abcdef')
            expect(calls).toHaveLength(1)
            expect(calls[0].url).toBe(DEFAULT_DISCORD_PROXY_URL)
            expect(calls[0].url).not.toContain('discord.com')
        })
    })

    it('connect con code + ID/secret propios va directo a discord.com (power-user)', async () => {
        const { ctx, store } = makeCtx({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://127.0.0.1:6463' })
        const calls: Array<{ url: string; body: any }> = []
        const fetchFn: any = async (url: string, init: any) => {
            calls.push({ url: String(url), body: String(init?.body ?? '') })
            return { ok: true, json: async () => ({ access_token: 'tok-direct-abcdef', refresh_token: 'r-direct', expires_in: 3600 }) }
        }
        const plugin = new DiscordPlugin(ctx, { ...okRpc('ok'), fetchFn })
        const res = await plugin.getActionHandlers().get('connect')!({ code: 'authcode-1' }, {})
        expect(['connected', 'authorized']).toContain(res.status)
        expect(store.accessToken).toBe('tok-direct-abcdef')
        expect(calls[0].url).toContain('discord.com/api/oauth2/token')
        expect(calls[0].body).toContain('client_secret=sec')
    })

    it('renovación zero-config vía proxy sin secret (1 clic, sin app propia)', async () => {
        await withCleanDiscordEnv(async () => {
            process.env.BUNDECK_DISCORD_CLIENT_ID = 'baked-test-cid'
            const { ctx, store } = makeCtx({
                mode: 'rpc', accessToken: 'tok-old-abcdefghij', refreshToken: 'ref-1',
                tokenExpiresAt: String(Date.now() - 5000),
            })
            const calls: Array<{ url: string; body: any }> = []
            const plugin = new DiscordPlugin(ctx, { ...okRpc('ok'), fetchFn: mockProxyFetch(calls, { access_token: 'tok-renewed-abcdef', refresh_token: 'ref-2', expires_in: 3600 }) as any })
            const res = await plugin.getActionHandlers().get('toggle-mute')!({}, {})
            expect(res.transport).toBe('rpc')
            expect(store.accessToken).toBe('tok-renewed-abcdef')
            expect(calls).toHaveLength(1)
            expect(calls[0].url).toBe(DEFAULT_DISCORD_PROXY_URL)
        })
    })
})

describe('discord zero-config: redirects registrados (app real del maintainer)', () => {
    it('expone los 3 redirects a registrar: callback https + 2 loopback', async () => {
        const mod: any = await import('../plugins/discord-rpc')
        expect(mod.DISCORD_MAINTAINER_CLIENT_ID).toBe('1575201215791497256')
        expect(mod.DEFAULT_DISCORD_CLIENT_ID).toBe('1575201215791497256')
        expect([...mod.DISCORD_VALID_REDIRECT_URIS]).toEqual([
            'https://relay.bundeck.app/api/discord/callback',
            'http://127.0.0.1:6463',
            'http://localhost:6463',
        ])
        expect(mod.DEFAULT_DISCORD_CALLBACK_URL).toBe('https://relay.bundeck.app/api/discord/callback')
        expect(mod.DISCORD_CALLBACK_PATH).toBe('/api/discord/callback')
    })

    it('la URL de autorización usa el callback https por defecto (auto-entrega vía relay)', () => {
        const r = buildDiscordNeedsAuth({ clientId: '1575201215791497256', redirectUri: undefined, reason: 'no-token' })
        expect(r.authorizeUrl).toContain('client_id=1575201215791497256')
        expect(r.authorizeUrl).toContain(encodeURIComponent('https://relay.bundeck.app/api/discord/callback'))
    })

    it('los loopback siguen aceptados como override manual (registrados en Discord)', () => {
        const r = buildDiscordNeedsAuth({ clientId: '1575201215791497256', redirectUri: 'http://127.0.0.1:6463', reason: 'no-token' })
        expect(r.authorizeUrl).toContain(encodeURIComponent('http://127.0.0.1:6463'))
    })
})
