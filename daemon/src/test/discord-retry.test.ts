/**
 * discord-retry.test.ts — conexión RPC robusta sin fallback silencioso.
 *
 * Cubre el hallazgo empírico: la conexión persistente `this.rpc` se reutiliza
 * muerta (half-open sin onclose) y el primer uso tras idle falla con
 * `discord-closed`. El plugin debe reintentar UNA vez con conexión fresca
 * antes de rendirse, y si aun así cae a hotkey el resultado incluye
 * `rpcError` + warn server-side. Los errores RPC claros aplanean a
 * `success:false` (disparan `action.error`, toast y nivel error en logs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { claimDataDir, setDataDir } from './helpers/test-data-dir'

const CLAIM = claimDataDir('ld-discord-retry-test-')
setDataDir(CLAIM.dir)
const { initDatabase, DatabaseService } = await import('../db')
const { ActionRunner } = await import('../action-runner')
import { DiscordRpcError } from '../plugins/discord-rpc'
import { DiscordPlugin } from '../plugins/discord.plugin'

function makeCtx(initial: Record<string, string> = {}) {
    const store: Record<string, string> = { ...initial }
    const logs: Array<[string, string]> = []
    const ctx: any = {
        log: (l: string, m: string, _meta?: any) => { logs.push([l, String(m)]) },
        getSetting: (k: string) => (k in store ? store[k] : null),
        setSetting: (k: string, v: string) => { store[k] = String(v) },
        deleteSetting: (k: string) => { delete store[k] },
    }
    return { ctx, store, logs }
}

/** Fake que puede "morir" a posteriori (half-open): connect/auth ok, pero
 *  el primer SET tras la muerte falla con discord-closed. */
class HalfOpenRpc {
    static created = 0
    public dead = false
    public state = { mute: false, deaf: false }
    public setCalls: any[] = []
    constructor() { HalfOpenRpc.created++ }
    get connectedPort() { return 6463 }
    get connectedPipe() { return null }
    get connectedTransport() { return 'pipe' as const }
    get lastVoiceState() { return { ...this.state } }
    async connect() { return { transport: 'pipe' as const, port: null, pipe: 'discord-ipc-0' } }
    async authenticate() { return { application: { id: 'x' } } }
    async subscribeVoiceSettings() { return { ...this.state } }
    async setVoiceSettings(v: any) {
        if (this.dead) throw new DiscordRpcError('discord-closed', 'La conexión RPC con Discord se cerró.', { retryable: true })
        if (typeof v?.mute === 'boolean') this.state.mute = v.mute
        if (typeof v?.deaf === 'boolean') this.state.deaf = v.deaf
        this.setCalls.push(v)
        return { ...this.state }
    }
    async disconnect() {}
}

describe('discord: retry con conexión fresca tras reuse muerta', () => {
    it('1er intento tras idle va por RPC (no cae a hotkey silencioso)', async () => {
        HalfOpenRpc.created = 0
        const conns: HalfOpenRpc[] = []
        const tapped: any[] = []
        const { ctx, logs } = makeCtx({ mode: 'auto', clientId: 'cid', accessToken: 'tok-abcdefghij' })
        const plugin = new DiscordPlugin(ctx, {
            createRpcConnection: () => { const c = new HalfOpenRpc(); conns.push(c); return c as any },
            hotkeyTap: async (h: string, hold?: number) => { tapped.push([h, hold]); return { hotkey: h, heldMs: hold ?? 0, platform: 'test' } },
        } as any)
        const toggle = plugin.getActionHandlers().get('toggle-mute')!

        // Calienta la caché con una conexión sana.
        const first = await toggle({}, {})
        expect(first.transport).toBe('rpc')
        expect(conns).toHaveLength(1)

        // La conexión persistente muere en silencio (sin onclose).
        conns[0].dead = true

        // Siguiente pulsación: reintenta con conexión fresca y funciona.
        const second = await toggle({}, {})
        expect(second.transport).toBe('rpc')
        expect(second.mute).toBe(true)
        expect(conns).toHaveLength(2)
        expect(tapped).toEqual([])
        // Warn server-side con el error real, no silencio.
        expect(logs.some(([l, m]) => l === 'warn' && /fresca/.test(m))).toBe(true)
    })

    it('si la fresca también falla en auto, cae a hotkey CON rpcError + warn', async () => {
        const tapped: any[] = []
        const { ctx, logs } = makeCtx({ mode: 'auto', clientId: 'cid', accessToken: 'tok-abcdefghij' })
        const plugin = new DiscordPlugin(ctx, {
            createRpcConnection: () => { throw new DiscordRpcError('discord-closed', 'Discord cerrado', { retryable: true }) },
            hotkeyTap: async (h: string, hold?: number) => { tapped.push([h, hold]); return { hotkey: h, heldMs: hold ?? 0, platform: 'test' } },
        } as any)
        const res = await plugin.getActionHandlers().get('toggle-mute')!({}, {})
        expect(res.transport).toBe('hotkey')
        expect(res.rpcError?.code).toBe('discord-closed')
        expect(tapped).toHaveLength(1)
        expect(logs.some(([l]) => l === 'warn')).toBe(true)
    })
})

describe('discord: error RPC aplana a success:false vía executeAction', () => {
    let db: InstanceType<typeof DatabaseService>
    let runner: InstanceType<typeof ActionRunner>

    beforeAll(async () => {
        await initDatabase()
        db = new DatabaseService()
        runner = new ActionRunner({ setActionCallbacks: () => {} } as any)
    })

    afterAll(() => {
        try { runner?.dispose() } catch { /* noop */ }
        CLAIM.restore()
        CLAIM.cleanup()
    })

    it('toggle-mute en rpc con token caducado → success:false + log error', async () => {
        db.setSetting('plugin.discord.mode', 'rpc')
        db.setSetting('plugin.discord.clientId', 'cid')
        db.setSetting('plugin.discord.accessToken', 'tok-caducado-abcdefghij')
        db.setSetting('plugin.discord.tokenExpiresAt', String(Date.now() - 5000))
        db.deleteSetting('plugin.discord.refreshToken')

        const res = await runner.executeAction(
            { type: 'discord.toggle-mute', parameters: {} },
            { timestamp: Date.now() } as any,
        )
        expect(res.success).toBe(false)
        expect(String(res.error)).toMatch(/token-expired|Discord/)
        // El error queda en Registros con nivel error (no se traga).
        const rows = db.getLogs(50, 'error')
        expect(rows.some((r) => r.message.includes('discord.toggle-mute'))).toBe(true)
    })
})
