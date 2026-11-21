/**
 * streaming-e2e.test.ts — E2E de plugins de streaming vía ActionRunner real.
 *
 * Solo cubre lo que NO cubren los plugin-*.test.ts (que ya testean manifests
 * y validaciones unitarias directas): aquí todo pasa por
 * `ActionRunner.executeAction("<plugin>.<accion>", ...)` con stubs
 * (fetch mockeado, Bun.spawn fake, servidores locales falsos).
 * Sin red real ni hardware.
 *
 * Contratos de degradación fijados (ver asserts):
 * - Twitch sin credenciales → error ES que pide Client ID/token/broadcaster.
 * - YouTube start/stop sin OAuth → error ES que pide token OAuth.
 * - Soundboard stop sin reproducción → { stopped:false } (ok degradado).
 * - Voicemod con API caída → error ES "No se pudo contactar con Voicemod… abierto…".
 * - VoiceMeeter/ShadowPlay fuera de Windows → error "solo existe en Windows".
 * - Webcam snapshot sin ffmpeg → error con instrucciones de instalación.
 * - OBS auth errónea → error "contraseña incorrecta".
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'

// Aislar la DB real del daemon en un dir temporal (ActionRunner usa DatabaseService real).
process.env.LIBREDECK_DATA_DIR ??= join(tmpdir(), `libredeck-e2e-${process.pid}`)
await mkdir(process.env.LIBREDECK_DATA_DIR, { recursive: true })

import { ActionRunner } from '../action-runner'

const TMP_SOUNDS = join(process.env.LIBREDECK_DATA_DIR, `sounds-e2e-${Date.now()}`)

let runner: ActionRunner
beforeAll(async () => {
    const { initDatabase } = await import('../db')
    await initDatabase()
    runner = new ActionRunner({ setActionCallbacks: () => {} } as any)
})
afterAll(async () => {
    try { runner?.dispose() } catch { /* noop */ }
    await rm(process.env.LIBREDECK_DATA_DIR!, { recursive: true, force: true }).catch(() => {})
})

async function run(type: string, parameters: Record<string, any> = {}) {
    return runner.executeAction(
        { type, parameters, timeout: 15000 },
        { timestamp: Date.now() } as any,
    )
}

// ---------- helpers de stubs ----------
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; restoreSpawn(); restorePlatform() })

const OriginalSpawn = (Bun as any).spawn.bind(Bun)
let spawnCalls: string[][] = []
function installSpawn(handler: (cmd: string[]) => { stdout?: string; stderr?: string; exitCode?: number }) {
    spawnCalls = []
    ;(Bun as any).spawn = (opts: any) => {
        const cmd: string[] = opts?.cmd ?? []
        spawnCalls.push(cmd)
        const r = handler(cmd)
        return {
            stdout: new Response(r.stdout ?? '').body,
            stderr: new Response(r.stderr ?? '').body,
            exited: Promise.resolve(r.exitCode ?? 0),
            exitCode: r.exitCode ?? 0,
            kill() {}, close() {},
        }
    }
}
function restoreSpawn() { (Bun as any).spawn = OriginalSpawn; spawnCalls = [] }

const realPlatform = process.platform
function setPlatform(p: string) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
function restorePlatform() {
    try { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }) } catch { /* noop */ }
}

async function closedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = createServer()
        s.once('error', reject)
        s.listen(0, '127.0.0.1', () => {
            const a = s.address()
            const p = typeof a === 'object' && a !== null ? a.port : 0
            s.close((e?: Error) => (e ? reject(e) : resolve(p)))
        })
    })
}

function mockTwitchFetch() {
    globalThis.fetch = (async (url: any, init: any) => {
        const u = String(url)
        const method = init?.method ?? 'GET'
        if (u.includes('/helix/search/categories')) return Response.json({ data: [{ id: '509658', name: 'Just Chatting' }] })
        if (u.includes('/helix/users?')) return Response.json({ data: [{ id: '12345', login: 'test' }] })
        if (u.includes('/helix/channels/commercial')) return Response.json({ data: [{ retry_after: 300, length: 30 }] })
        if (u.includes('/helix/channels') && method === 'PATCH') return new Response(null, { status: 204 })
        if (u.includes('/helix/clips') && method === 'POST') return Response.json({ data: [{ id: 'clip123', edit_url: 'https://clips.twitch.tv/clip123' }] })
        if (u.includes('/helix/streams/markers')) return Response.json({ data: [{ id: 'marker1', position_seconds: 42 }] })
        if (u.includes('/helix/chat/messages')) return Response.json({ data: [{ message_id: 'msg1', is_sent: false }] })
        if (u.includes('/helix/streams?')) return Response.json({ data: [{ viewer_count: 123, title: 'Directo', game_name: 'Juego' }] })
        throw new Error(`twitch mock: URL no esperada ${method} ${u}`)
    }) as typeof fetch
}

function mockYoutubeFetch() {
    globalThis.fetch = (async (url: any, _init: any) => {
        const u = String(url)
        if (u.includes('/youtube/v3/videos?')) {
            return Response.json({
                items: [{ snippet: { title: 'Mi directo' }, liveStreamingDetails: { concurrentViewers: '42', activeLiveChatId: 'chat1' }, statistics: { likeCount: '5' } }],
            })
        }
        if (u.includes('/youtube/v3/liveBroadcasts/transition')) {
            const st = u.includes('broadcastStatus=live') ? 'live' : 'complete'
            return Response.json({ status: { lifeCycleStatus: st } })
        }
        if (u.includes('/youtube/v3/liveChat/messages')) return Response.json({ id: 'chatmsg1' })
        throw new Error(`youtube mock: URL no esperada ${u}`)
    }) as typeof fetch
}

// ---------- 1. Twitch ----------
describe('E2E Twitch vía ActionRunner (Helix mockeado)', () => {
    const creds = { clientId: 'cid', token: 'tok', broadcaster: '12345' }

    it('set-title ok', async () => {
        mockTwitchFetch()
        const r = await run('twitch.set-title', { ...creds, title: 'Nuevo título' })
        expect(r.success).toBe(true)
        expect(r.result.title).toBe('Nuevo título')
        expect(r.result.updated).toBe(true)
    })

    it('set-category resuelve gameName → id', async () => {
        mockTwitchFetch()
        const r = await run('twitch.set-category', { ...creds, gameName: 'Just Chatting' })
        expect(r.success).toBe(true)
        expect(r.result.gameId).toBe('509658')
    })

    it('create-clip ok', async () => {
        mockTwitchFetch()
        const r = await run('twitch.create-clip', creds)
        expect(r.success).toBe(true)
        expect(r.result.clipId).toBe('clip123')
    })

    it('create-marker ok', async () => {
        mockTwitchFetch()
        const r = await run('twitch.create-marker', { ...creds, description: 'épico' })
        expect(r.success).toBe(true)
        expect(r.result.markerId).toBe('marker1')
    })

    it('chat-message ok', async () => {
        mockTwitchFetch()
        const r = await run('twitch.chat-message', { ...creds, message: 'hola chat' })
        expect(r.success).toBe(true)
        expect(r.result.messageId).toBe('msg1')
    })

    it('ad-break ok', async () => {
        mockTwitchFetch()
        const r = await run('twitch.ad-break', { ...creds, length: 30 })
        expect(r.success).toBe(true)
        expect(r.result.length).toBe(30)
    })

    it('viewer-count ok (live)', async () => {
        mockTwitchFetch()
        const r = await run('twitch.viewer-count', creds)
        expect(r.success).toBe(true)
        expect(r.result.live).toBe(true)
        expect(r.result.viewerCount).toBe(123)
    })

    it('sin credenciales → error amigable en español', async () => {
        const r = await run('twitch.viewer-count', {})
        expect(r.success).toBe(false)
        expect(r.error ?? '').toMatch(/Client ID|configuración|Token/)
    })
})

// ---------- 2. YouTube ----------
describe('E2E YouTube vía ActionRunner', () => {
    it('viewer-count con API key mock', async () => {
        mockYoutubeFetch()
        const r = await run('youtube.viewer-count', { apiKey: 'k', videoId: 'vid123' })
        expect(r.success).toBe(true)
        expect(r.result.viewerCount).toBe(42)
        expect(r.result.live).toBe(true)
    })

    it('start-broadcast sin OAuth → error claro', async () => {
        const r = await run('youtube.start-broadcast', { broadcastId: 'b1' })
        expect(r.success).toBe(false)
        expect(r.error ?? '').toMatch(/OAuth/)
    })

    it('stop-broadcast sin OAuth → error claro', async () => {
        const r = await run('youtube.stop-broadcast', { broadcastId: 'b1' })
        expect(r.success).toBe(false)
        expect(r.error ?? '').toMatch(/OAuth/)
    })

    it('start-broadcast con OAuth mock transiciona a live', async () => {
        mockYoutubeFetch()
        const r = await run('youtube.start-broadcast', { oauthToken: 'ya29.x', broadcastId: 'b1' })
        expect(r.success).toBe(true)
        expect(r.result.status).toBe('live')
    })

    it('open-dashboard devuelve URL sin abrir nada real', async () => {
        installSpawn(() => ({ stdout: '', exitCode: 0 }))
        const r = await run('youtube.open-dashboard', { videoId: 'vid123' })
        expect(r.success).toBe(true)
        expect(r.result.url).toContain('studio.youtube.com')
        expect(r.result.opened).toBe(true)
    })
})

// ---------- 3. Discord ----------
describe('E2E Discord vía ActionRunner (spawn fake)', () => {
    it('toggle-mute envía el hotkey', async () => {
        installSpawn(() => ({ stdout: '', exitCode: 0 }))
        const r = await run('discord.toggle-mute', { hotkey: 'ctrl+shift+m' })
        expect(r.success).toBe(true)
        expect(r.result.hotkey).toBe('ctrl+shift+m')
    })

    it('toggle-deafen envía el hotkey', async () => {
        installSpawn(() => ({ stdout: '', exitCode: 0 }))
        const r = await run('discord.toggle-deafen', { hotkey: 'ctrl+shift+d' })
        expect(r.success).toBe(true)
        expect(r.result.hotkey).toBe('ctrl+shift+d')
    })

    it('toggle-mute con hotkey sin tecla → error de formato', async () => {
        const r = await run('discord.toggle-mute', { hotkey: 'ctrl+shift' })
        expect(r.success).toBe(false)
        expect(r.error ?? '').toMatch(/tecla principal/)
    })

    it('open-channel rechaza URL no discord', async () => {
        const r = await run('discord.open-channel', { url: 'https://example.com/abc' })
        expect(r.success).toBe(false)
        expect(r.error ?? '').toMatch(/no válida/)
    })

    it('push-to-talk acepta holdMs', async () => {
        installSpawn(() => ({ stdout: '', exitCode: 0 }))
        const r = await run('discord.push-to-talk', { hotkey: 'ctrl+shift+p', holdMs: 300 })
        expect(r.success).toBe(true)
        expect(r.result.heldMs).toBe(300)
    })
})

// ---------- 4. Soundboard ----------
describe('E2E Soundboard vía ActionRunner', () => {
    it('list-sounds crea la carpeta si falta', async () => {
        const dir = `${TMP_SOUNDS}-a`
        const r = await run('soundboard.list-sounds', { soundsDir: dir })
        expect(r.success).toBe(true)
        expect(r.result.soundsDir).toBe(dir)
        expect(r.result.count).toBe(0)
        expect(r.result.note ?? '').toMatch(/vacía/)
    })

    it('play con fichero inexistente → error con la ruta', async () => {
        const r = await run('soundboard.play', { soundsDir: TMP_SOUNDS, file: 'noexiste.wav' })
        expect(r.success).toBe(false)
        expect(r.error ?? '').toMatch(/noexiste\.wav|No se encontró/)
    })

    it('stop sin reproducción → ok degradado', async () => {
        const r = await run('soundboard.stop', {})
        expect(r.success).toBe(true)
        expect(r.result.stopped).toBe(false)
    })
})

// ---------- 5. Voicemod ----------
describe('E2E Voicemod vía ActionRunner', () => {
    it('API caída (puerto cerrado) → error "abre Voicemod…"', async () => {
        const port = await closedPort()
        const r = await run('voicemod.get-status', { host: '127.0.0.1', port })
        expect(r.success).toBe(false)
        expect(r.error ?? '').toMatch(/Voicemod/)
        expect(r.error ?? '').toMatch(/abierto|contactar/)
    })

    it('get-status y set-voice ok contra mini-servidor falso', async () => {
        const server = Bun.serve({
            port: 0,
            hostname: '127.0.0.1',
            fetch(req) {
                const u = new URL(req.url)
                if (u.pathname === '/api/status' || u.pathname === '/status') {
                    return Response.json({ voiceChangerEnabled: true, currentVoice: 'robot', muted: false })
                }
                if (u.pathname === '/api/voice') return Response.json({ ok: true, voiceId: 'robot' })
                if (u.pathname === '/api/voice-changer') return Response.json({ ok: true })
                if (u.pathname === '/api/mute') return Response.json({ ok: true })
                return new Response('nf', { status: 404 })
            },
        })
        try {
            const conn = { host: '127.0.0.1', port: server.port }
            const st = await run('voicemod.get-status', conn)
            expect(st.success).toBe(true)
            expect(st.result.connected).toBe(true)
            const sv = await run('voicemod.set-voice', { ...conn, voiceId: 'robot' })
            expect(sv.success).toBe(true)
            expect(sv.result.voiceId).toBe('robot')
        } finally {
            server.stop(true)
        }
    })
})

// ---------- 6. VoiceMeeter: contrato no-Windows ----------
describe('E2E VoiceMeeter fuera de Windows degrada sin lanzar', () => {
    it('device-info en linux informa que solo existe en Windows', async () => {
        setPlatform('linux')
        installSpawn(() => { throw new Error('no debería lanzarse nada') })
        const r = await run('voicemod.get-status', {}) // calienta runner; ignorar
        void r
        restoreSpawn()
        installSpawn((cmd) => { throw new Error(`spawn inesperado: ${cmd.join(' ')}`) })
        const vm = await run('voicemeeter.device-info', {})
        expect(vm.success).toBe(false)
        expect(vm.error ?? '').toMatch(/solo existe en Windows/)
        expect(spawnCalls.length).toBe(0)
    })

    it('strip-mute en darwin informa plataforma sin lanzar', async () => {
        setPlatform('darwin')
        installSpawn((cmd) => { throw new Error(`spawn inesperado: ${cmd.join(' ')}`) })
        const r = await run('voicemeeter.strip-mute', { hotkey: 'ctrl+alt+f13', strip: 0 })
        expect(r.success).toBe(false)
        expect(r.error ?? '').toMatch(/solo existe en Windows/)
        expect(spawnCalls.length).toBe(0)
    })
})

// ---------- 7. ShadowPlay ----------
describe('E2E ShadowPlay vía ActionRunner', () => {
    it('check-status sin Share informa no disponible (windows) o plataforma (otros)', async () => {
        if (process.platform !== 'win32') {
            const r = await run('shadowplay.check-status', {})
            expect(r.success).toBe(false)
            expect(r.error ?? '').toMatch(/solo existe en Windows/)
            return
        }
        installSpawn((cmd) => {
            if (cmd[0] === 'tasklist') return { stdout: '"Image Name","PID"\n', exitCode: 0 }
            return { stdout: '', exitCode: 0 }
        })
        const r = await run('shadowplay.check-status', {})
        expect(r.success).toBe(true)
        expect(r.result.running).toBe(false)
        expect(r.result.note ?? '').toMatch(/no parece en ejecución/)
    })

    it('hotkeys por defecto Alt+F10/F9 configurables (manifest)', async () => {
        const { ShadowplayPlugin } = await import('../plugins/shadowplay.plugin')
        const m = new ShadowplayPlugin({ log: () => {} } as any).getManifest()
        const byId = Object.fromEntries(m.settingsSchema.properties ? Object.entries(m.settingsSchema.properties) : [])
        expect((byId.replayHotkey as any).default).toBe('alt+f10')
        expect((byId.recordHotkey as any).default).toBe('alt+f9')
    })

    it('hotkey personalizado se propaga (Share en ejecución simulado)', async () => {
        if (process.platform !== 'win32') return // contrato no-Windows ya fijado arriba
        installSpawn((cmd) => {
            if (cmd[0] === 'tasklist') return { stdout: '"Image Name","PID"\n"nvidia share.exe","123"\n', exitCode: 0 }
            return { stdout: '', exitCode: 0 }
        })
        const custom = await run('shadowplay.instant-replay-save', { hotkey: 'alt+f12' })
        expect(custom.success).toBe(true)
        expect(custom.result.hotkey).toBe('alt+f12')
        const def = await run('shadowplay.toggle-record', {})
        expect(def.success).toBe(true)
        expect(def.result.hotkey).toBe('alt+f9')
    })
})

// ---------- 8. Webcam ----------
describe('E2E Webcam vía ActionRunner', () => {
    it('list-cameras no lanza: devuelve lista', async () => {
        restoreSpawn() // llamada real al sistema, como el plugin-*.test
        const r = await run('webcam.list-cameras', {})
        expect(r.success).toBe(true)
        expect(Array.isArray(r.result.cameras)).toBe(true)
        expect(typeof r.result.count).toBe('number')
    }, 30000)

    it('snapshot sin ffmpeg → error con instrucciones de instalación', async () => {
        installSpawn((cmd) => {
            if (cmd[0] === 'ffmpeg') return { stdout: '', stderr: 'nope', exitCode: 1 }
            return { stdout: '', exitCode: 0 }
        })
        const r = await run('webcam.snapshot', {})
        expect(r.success).toBe(false)
        expect(r.error ?? '').toMatch(/ffmpeg/i)
    })
})

// ---------- 9. OBS contra obs-websocket falso ----------
function obsAuth(password: string, salt: string, challenge: string): string {
    const secret = createHash('sha256').update(password + salt).digest('base64')
    return createHash('sha256').update(secret + challenge).digest('base64')
}

function cannedObs(requestType: string, _data: any): any {
    switch (requestType) {
        case 'GetStudioModeEnabled': return { studioModeEnabled: false }
        case 'SetStudioModeEnabled': return {}
        case 'SetCurrentPreviewScene': return {}
        case 'GetSourceFilter': return { filterEnabled: true }
        case 'SetSourceFilterEnabled': return {}
        case 'SetCurrentSceneTransition': return {}
        case 'SetCurrentSceneTransitionDuration': return {}
        case 'GetCurrentSceneTransition': return { transitionName: 'Fundido', transitionDuration: 300 }
        case 'GetSourceScreenshot': return { imageData: 'data:image/png;base64,iVBORw0KGgo=' }
        case 'GetSceneList': return { scenes: [{ sceneName: 'Escena 1' }, { sceneName: 'Escena 2' }], currentProgramSceneName: 'Escena 1' }
        case 'GetCurrentProgramScene': return { currentProgramSceneName: 'Escena 1' }
        default: return {}
    }
}

async function startFakeObs(opts: { password?: string } = {}) {
    const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(req, srv: any) {
            if (srv.upgrade(req)) return undefined as any
            return new Response('obs-fake')
        },
        websocket: {
            open(ws: any) {
                ws.send(JSON.stringify({
                    op: 0,
                    d: { rpcVersion: 1, ...(opts.password ? { authentication: { challenge: 'chal123', salt: 'salt123' } } : {}) },
                }))
            },
            message(ws: any, raw: any) {
                let msg: any
                try { msg = JSON.parse(String(raw)) } catch { return }
                if (msg.op === 1) {
                    if (opts.password) {
                        if (msg.d?.authentication !== obsAuth(opts.password, 'salt123', 'chal123')) {
                            ws.close(4009, 'auth failed')
                            return
                        }
                    }
                    ws.send(JSON.stringify({ op: 2, d: { rpcVersion: 1 } }))
                    return
                }
                if (msg.op === 6) {
                    const { requestType, requestId, requestData } = msg.d
                    const data = cannedObs(requestType, requestData)
                    ws.send(JSON.stringify({
                        op: 7,
                        d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData: data },
                    }))
                }
            },
        },
    } as any)
    return { server, port: (server as any).port as number }
}

describe('E2E OBS nuevas acciones contra obs-websocket falso', () => {
    it('studio-mode activa ok', async () => {
        const { server, port } = await startFakeObs()
        try {
            const r = await run('obs.studio-mode', { host: '127.0.0.1', port, timeoutMs: 5000, enabled: true })
            expect(r.success).toBe(true)
            expect(r.result.enabled).toBe(true)
        } finally { server.stop(true) }
    })

    it('filter-toggle alterna ok', async () => {
        const { server, port } = await startFakeObs()
        try {
            const r = await run('obs.filter-toggle', { host: '127.0.0.1', port, timeoutMs: 5000, source: 'Mic', filter: 'Ruido' })
            expect(r.success).toBe(true)
            expect(typeof r.result.enabled).toBe('boolean')
        } finally { server.stop(true) }
    })

    it('transition cambia nombre y duración', async () => {
        const { server, port } = await startFakeObs()
        try {
            const r = await run('obs.transition', { host: '127.0.0.1', port, timeoutMs: 5000, transitionName: 'Fundido', durationMs: 300 })
            expect(r.success).toBe(true)
            expect(r.result.transitionName).toBe('Fundido')
            expect(r.result.durationMs).toBe(300)
        } finally { server.stop(true) }
    })

    it('scene-list devuelve escenas', async () => {
        const { server, port } = await startFakeObs()
        try {
            const r = await run('obs.scene-list', { host: '127.0.0.1', port, timeoutMs: 5000 })
            expect(r.success).toBe(true)
            expect(r.result.scenes).toContain('Escena 1')
            expect(r.result.currentProgramSceneName).toBe('Escena 1')
        } finally { server.stop(true) }
    })

    it('screenshot devuelve data URI', async () => {
        const { server, port } = await startFakeObs()
        try {
            const r = await run('obs.screenshot', { host: '127.0.0.1', port, timeoutMs: 5000 })
            expect(r.success).toBe(true)
            expect(r.result.imageData.startsWith('data:')).toBe(true)
        } finally { server.stop(true) }
    })

    it('auth con password errónea → error claro', async () => {
        const { server, port } = await startFakeObs({ password: 'correcta' })
        try {
            const r = await run('obs.scene-list', { host: '127.0.0.1', port, timeoutMs: 5000, password: 'mala' })
            expect(r.success).toBe(false)
            expect(r.error ?? '').toMatch(/contraseña|Autenticación/i)
        } finally { server.stop(true) }
    })
})
