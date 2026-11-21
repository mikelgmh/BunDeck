import { describe, it, expect, afterEach } from 'bun:test'
import { SpotifyPlugin } from '../plugins/spotify.plugin'

function makeCtx(store: Record<string, string> = {}) {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const sets: Array<[string, string]> = []
    return {
        logs,
        sets,
        ctx: {
            log: (level: string, message: string, meta?: any) => {
                logs.push({ level, message, meta })
            },
            getSetting: (key: string) => (key in store ? store[key] : null),
            setSetting: (key: string, value: string) => {
                sets.push([key, value])
                store[key] = value
            },
        },
    }
}

const realFetch = globalThis.fetch
function stubFetch(status: number) {
    globalThis.fetch = (async () => new Response(null, { status })) as typeof fetch
}
afterEach(() => {
    globalThis.fetch = realFetch
})

const now = Date.now()

describe('Spotify expiración (renovación silenciosa)', () => {
    it('token guardado caducado → error específico + avisa al host', async () => {
        const { ctx, sets } = makeCtx({
            token: 'tok-viejo-1234567890',
            tokenExpiresAt: String(now - 10_000),
        })
        const plugin = new SpotifyPlugin(ctx)
        const err = await plugin
            .getActionHandlers()
            .get('playback')!({ action: 'play' }, {})
            .catch((e: any) => e)
        expect(String(err.message)).toMatch(/caducado/)
        expect(sets.some(([k]) => k === 'autoRefreshRequestedAt')).toBe(true)
        // La petición explícita del usuario NO se toca desde aquí.
        expect(sets.some(([k]) => k === 'loginRequestedAt')).toBe(false)
    })

    it('token guardado fresco → funciona sin avisar', async () => {
        const { ctx, sets } = makeCtx({
            token: 'tok-fresco-1234567890',
            tokenExpiresAt: String(now + 3600_000),
        })
        stubFetch(204)
        const plugin = new SpotifyPlugin(ctx)
        const res = await plugin.getActionHandlers().get('playback')!({ action: 'play' }, {})
        expect(res.executed).toBe(true)
        expect(sets).toHaveLength(0)
    })

    it('token por parámetro no pasa por el chequeo de caducidad', async () => {
        const { ctx, sets } = makeCtx({
            token: 'tok-viejo-1234567890',
            tokenExpiresAt: String(now - 10_000),
        })
        stubFetch(204)
        const plugin = new SpotifyPlugin(ctx)
        const res = await plugin
            .getActionHandlers()
            .get('playback')!({ token: 'tok-manual-nuevo-1234567890', action: 'pause' }, {})
        expect(res.executed).toBe(true)
        expect(sets).toHaveLength(0)
    })

    it('401 con metadata automática → pide renovación en vez del error genérico', async () => {
        const { ctx, sets, logs } = makeCtx({
            token: 'tok-revocado-1234567890',
            tokenExpiresAt: String(now + 3600_000),
        })
        stubFetch(401)
        const plugin = new SpotifyPlugin(ctx)
        const err = await plugin
            .getActionHandlers()
            .get('playback')!({ action: 'play' }, {})
            .catch((e: any) => e)
        expect(String(err.message)).toMatch(/renovando en segundo plano/)
        expect(sets.some(([k]) => k === 'autoRefreshRequestedAt')).toBe(true)
        const dumped = JSON.stringify(logs)
        expect(dumped).not.toContain('tok-revocado-1234567890')
    })

    it('401 con token manual (sin metadata) → mensaje clásico, sin refresh', async () => {
        const { ctx, sets } = makeCtx({ token: 'tok-manual-1234567890' })
        stubFetch(401)
        const plugin = new SpotifyPlugin(ctx)
        const err = await plugin
            .getActionHandlers()
            .get('playback')!({ action: 'play' }, {})
            .catch((e: any) => e)
        expect(String(err.message)).toMatch(/token inválido o sin permisos/)
        expect(sets).toHaveLength(0)
    })

    it('throttle: señal reciente no re-señala (no insiste tras descartar)', async () => {
        const { ctx, sets } = makeCtx({
            token: 'tok-viejo-1234567890',
            tokenExpiresAt: String(now - 10_000),
            autoRefreshRequestedAt: String(now - 60_000),
        })
        const plugin = new SpotifyPlugin(ctx)
        const err = await plugin
            .getActionHandlers()
            .get('playback')!({ action: 'play' }, {})
            .catch((e: any) => e)
        expect(String(err.message)).toMatch(/caducado/)
        // No se toca loginRequestedAt: respeta el cierre reciente del usuario.
        expect(sets).toHaveLength(0)
    })
})
