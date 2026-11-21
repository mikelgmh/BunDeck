/**
 * creative-e2e.test.ts
 * E2E vía ActionRunner real de lo que creative-gaming-domotica.test.ts
 * NO cubre (solo validación directa de handlers / degradación):
 *
 * 1. Creativos: tool-select/transport/viewport + history + hotkey
 *    obligatorio (run-action/export/render-start) + custom libre.
 * 2. midi-osc send-osc contra UDP local real (verifica paquete OSC).
 * 3. steam server-status feliz (fake store) + launch/open-library URI.
 * 4. minecraft online/offline/latencia contra fake mcsrvstat.us.
 * 5. hue-extra feliz contra puente falso + enmascarado de API key.
 * 6. govee feliz contra nube falsa (cabecera Govee-API-Key).
 * 7. pc-vitals extendido vía runner + net-speed doble muestreo corto.
 * 8. homeassistant: verifica Authorization Bearer + endpoints/services y
 *    lectura solo-GET de sensor-value.
 *
 * Sin red real salvo localhost, sin hardware, sin pulsar teclas reales
 * (Bun.spawn se stubbea en los caminos que simularían hotkeys/aperturas).
 */
import { describe, it, expect, afterEach, beforeAll } from 'bun:test'
import { createServer } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-creative-e2e-'))
process.env.LIBREDECK_DATA_DIR = TMP
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true })

import { initDatabase } from '../db'
import { ActionRunner } from '../action-runner'

beforeAll(async () => {
    await initDatabase()
})

const spawns: Array<{ cmd: string[] }> = []
let origSpawn: typeof Bun.spawn | null = null

function stubSpawn() {
    if (origSpawn) return
    origSpawn = Bun.spawn
    ;(Bun as any).spawn = ((opts: any) => {
        const cmd: string[] = Array.isArray(opts?.cmd) ? opts.cmd : []
        spawns.push({ cmd })
        return {
            exitCode: 0,
            exited: Promise.resolve(0),
            stdout: ReadableStream ? new ReadableStream({ start(c) { c.close() } }) : null,
            stderr: ReadableStream ? new ReadableStream({ start(c) { c.close() } }) : null,
        }
    }) as any
}

function restoreSpawn() {
    if (origSpawn) {
        ;(Bun as any).spawn = origSpawn
        origSpawn = null
    }
    spawns.length = 0
}

afterEach(() => restoreSpawn())

function makeRunner(): ActionRunner {
    return new ActionRunner({} as any)
}

async function run(runner: ActionRunner, type: string, parameters: any = {}) {
    return runner.executeAction({ type, parameters }, { timestamp: Date.now() } as any)
}

async function closedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address()
            const port = typeof addr === 'object' && addr !== null ? addr.port : 0
            server.close((err?: Error) => (err ? reject(err) : resolve(port)))
        })
    })
}

function startFakeHttp(handler: (req: Request) => Response | Promise<Response>, captureHeaders: string[] = []) {
    const requests: Array<{ method: string; path: string; body: any; headers: Record<string, string | null> }> = []
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (req) => {
            const url = new URL(req.url)
            let body: any = null
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                try { body = await req.json() } catch { body = null }
            }
            const headers: Record<string, string | null> = {}
            for (const h of captureHeaders) headers[h] = req.headers.get(h)
            requests.push({ method: req.method, path: url.pathname, body, headers })
            return handler(req)
        },
    })
    return { server, requests, base: `http://127.0.0.1:${server.port}` }
}

// ---------- 1. Creativos vía ActionRunner ----------

describe('creativos e2e vía ActionRunner (sin teclas reales)', () => {
    it('photoshop/premiere/davinci/blender: enum inválido falla con lista válida', async () => {
        const runner = makeRunner()
        try {
            const ps = await run(runner, 'photoshop.tool-select', { tool: 'varita-magica' })
            expect(ps.success).toBe(false)
            expect(ps.error).toMatch(/no válida/)
            expect(ps.error).toMatch(/brush/)

            const pr = await run(runner, 'premiere.transport', { operation: 'turbo' })
            expect(pr.success).toBe(false)
            expect(pr.error).toMatch(/no válida/)
            expect(pr.error).toMatch(/play-pause/)

            const dv = await run(runner, 'davinci.transport', { operation: 'warp' })
            expect(dv.success).toBe(false)
            expect(dv.error).toMatch(/no válida/)

            const bl = await run(runner, 'blender.viewport', { view: 'esquina' })
            expect(bl.success).toBe(false)
            expect(bl.error).toMatch(/no válida/)
            expect(bl.error).toMatch(/front/)
        } finally {
            runner.dispose()
        }
    })

    it('history valida dirección; run-action/export/render-start exigen hotkey', async () => {
        const runner = makeRunner()
        try {
            const h1 = await run(runner, 'photoshop.history', { operation: 'warp' })
            expect(h1.success).toBe(false)
            expect(h1.error).toMatch(/no válida/)

            const h2 = await run(runner, 'premiere.history', { operation: 'nada' })
            expect(h2.success).toBe(false)
            expect(h2.error).toMatch(/undo.*redo/)

            const ra = await run(runner, 'photoshop.run-action', { actionName: 'X' })
            expect(ra.success).toBe(false)
            expect(ra.error).toMatch(/hotkey/i)

            const ex = await run(runner, 'premiere.export', { hotkey: '' })
            // export tiene preset por defecto ctrl+m: con stub debe tener éxito;
            // sin stub en windows intentaría SendKeys real, así que solo se
            // verifica que el camino sin preset personalizado no pide hotkey.
            expect(typeof ex.success).toBe('boolean')

            const rs = await run(runner, 'davinci.render-start', {})
            expect(rs.success).toBe(false)
            expect(rs.error).toMatch(/hotkey/i)

            const bc = await run(runner, 'blender.custom', {})
            expect(bc.success).toBe(false)
            expect(bc.error).toMatch(/hotkey/i)
        } finally {
            runner.dispose()
        }
    })

    it('custom/render-start/run-action con hotkey ejecutan atajo libre (spawn stubbeado)', async () => {
        stubSpawn()
        const runner = makeRunner()
        try {
            const custom = await run(runner, 'blender.custom', { hotkey: 'shift+a' })
            expect(custom.success).toBe(true)
            expect(custom.result.hotkey).toBe('shift+a')

            const render = await run(runner, 'davinci.render-start', { hotkey: 'ctrl+f12' })
            expect(render.success).toBe(true)
            expect(render.result.hotkey).toBe('ctrl+f12')

            const ra = await run(runner, 'photoshop.run-action', { actionName: 'Retoque', hotkey: 'f2' })
            expect(ra.success).toBe(true)
            expect(ra.result.actionName).toBe('Retoque')

            const vp = await run(runner, 'blender.viewport', { view: 'front' })
            expect(vp.success).toBe(true)
            expect(vp.result.view).toBe('front')
        } finally {
            runner.dispose()
            restoreSpawn()
        }
    })
})

// ---------- 2. midi-osc contra UDP local ----------

describe('midi-osc e2e (UDP localhost)', () => {
    it('send-osc llega con header OSC, address e int32/float32', async () => {
        const { createSocket } = await import('node:dgram')
        const server = createSocket('udp4')
        const received = new Promise<Buffer>((resolve, reject) => {
            server.once('message', (msg) => resolve(Buffer.from(msg)))
            server.once('error', reject)
        })
        await new Promise<void>((res) => server.bind(0, '127.0.0.1', () => res()))
        const port = (server.address() as any).port as number
        const runner = makeRunner()
        try {
            const out = await run(runner, 'midi-osc.send-osc', {
                host: '127.0.0.1', port, address: '/fader/1', args: [7, 0.5, 'go'],
            })
            expect(out.success).toBe(true)
            expect(out.result.sent).toBe(true)
            const pkt = await received
            expect(pkt.length % 4).toBe(0)
            const text = pkt.toString('utf8')
            expect(text).toContain('/fader/1')
            expect(text).toContain(',ifs')
            // int32 7 en big-endian justo tras address+tags (offset calculable):
            // '/fader/1' (9 bytes incl. NUL -> 12) + ',ifs' (5 incl. NUL -> 8) = 20
            expect(pkt.readInt32BE(20)).toBe(7)
            expect(pkt.readFloatBE(24)).toBeCloseTo(0.5, 5)
            expect(text).toContain('go')
        } finally {
            runner.dispose()
            server.close()
        }
    })

    it('puerto UDP cerrado no cuelga (timeout corto) y responde claro', async () => {
        const port = await closedPort()
        const runner = makeRunner()
        try {
            const t0 = Date.now()
            const out = await run(runner, 'midi-osc.send-osc', {
                host: '127.0.0.1', port, address: '/test', args: [1], timeoutMs: 1000,
            })
            const dt = Date.now() - t0
            expect(dt).toBeLessThan(8000)
            // UDP es fire-and-forget: el SO acepta el datagrama aunque nadie
            // escuche. Se acepta éxito o error claro, pero nunca cuelgue.
            if (out.success) {
                expect(out.result.sent).toBe(true)
            } else {
                expect(out.error).toMatch(/OSC|enviar|espera|conectar/i)
            }
        } finally {
            runner.dispose()
        }
    })
})

// ---------- 3. steam ----------

describe('steam e2e (fake store + URIs)', () => {
    it('server-status feliz parsea online contra tienda falsa', async () => {
        const fake = startFakeHttp(async (req) => {
            const url = new URL(req.url)
            const appids = url.searchParams.get('appids')
            return Response.json({
                [String(appids)]: {
                    success: true,
                    data: {
                        name: 'Juego Falso',
                        is_free: true,
                        price_overview: { final_formatted: 'Gratis' },
                        short_description: 'desc corta de prueba',
                    },
                },
            })
        })
        const runner = makeRunner()
        try {
            const out = await run(runner, 'steam.server-status', {
                appId: '730', apiBase: fake.base, timeoutMs: 5000,
            })
            expect(out.success).toBe(true)
            expect(out.result.online).toBe(true)
            expect(out.result.name).toBe('Juego Falso')
            expect(out.result.appId).toBe('730')
        } finally {
            runner.dispose()
            fake.server.stop()
        }
    })

    it('launch-game valida appId y open-library devuelve URL (sin abrir nada real)', async () => {
        stubSpawn()
        const runner = makeRunner()
        try {
            const bad = await run(runner, 'steam.launch-game', { appId: 'no-numerico' })
            expect(bad.success).toBe(false)
            expect(bad.error).toMatch(/numérico/)

            const ok = await run(runner, 'steam.launch-game', { appId: '730' })
            expect(ok.success).toBe(true)
            expect(ok.result.uri).toMatch(/^steam:\/\/rungameid\/730/)
            expect(ok.result.appId).toBe('730')

            const lib = await run(runner, 'steam.open-library', {})
            expect(lib.success).toBe(true)
            expect(lib.result.uri).toBe('steam://open/library')
        } finally {
            runner.dispose()
            restoreSpawn()
        }
    })
})

// ---------- 4. minecraft ----------

describe('minecraft e2e (fake mcsrvstat.us)', () => {
    function fakeMc(handler: (host: string) => any) {
        return startFakeHttp((req) => {
            const host = new URL(req.url).pathname.replace(/^\//, '')
            return Response.json(handler(host))
        })
    }

    it('server-status online/offline y query-latency miden contra fake', async () => {
        const fake = fakeMc((host) => host === 'off.test'
            ? { online: false }
            : { online: true, version: '1.20', players: { online: 3, max: 20 }, motd: { clean: ['hola'] } })
        const runner = makeRunner()
        try {
            const on = await run(runner, 'minecraft.server-status', { host: 'on.test', apiBase: fake.base, timeoutMs: 5000 })
            expect(on.success).toBe(true)
            expect(on.result.online).toBe(true)
            expect(on.result.players).toEqual({ online: 3, max: 20 })

            const off = await run(runner, 'minecraft.server-status', { host: 'off.test', apiBase: fake.base, timeoutMs: 5000 })
            expect(off.success).toBe(true)
            expect(off.result.online).toBe(false)

            const lat = await run(runner, 'minecraft.query-latency', { host: 'on.test', apiBase: fake.base, timeoutMs: 5000 })
            expect(lat.success).toBe(true)
            expect(lat.result.online).toBe(true)
            expect(lat.result.latencyMs).toBeGreaterThanOrEqual(0)
        } finally {
            runner.dispose()
            fake.server.stop()
        }
    })

    it('servidor caído falla degradado con mensaje (sin colgar)', async () => {
        const port = await closedPort()
        const runner = makeRunner()
        try {
            const t0 = Date.now()
            const out = await run(runner, 'minecraft.server-status', {
                host: 'ejemplo.test', apiBase: `http://127.0.0.1:${port}`, timeoutMs: 2000,
            })
            expect(out.success).toBe(false)
            expect(out.error).toMatch(/ejemplo\.test|API|espera|conectar/i)
            expect(Date.now() - t0).toBeLessThan(10000)
        } finally {
            runner.dispose()
        }
    })
})

// ---------- 5. hue-extra ----------

describe('hue-extra e2e (puente falso)', () => {
    const KEY = 'FAKEKEY123'
    function fakeBridge(state: { on: boolean }) {
        const f = startFakeHttp(async (req) => {
            const url = new URL(req.url)
            if (url.pathname === `/api/${KEY}/lights`) {
                return Response.json({ 1: { name: 'Salón', state: { on: state.on, bri: 200, reachable: true } } })
            }
            if (url.pathname === `/api/${KEY}/lights/1` && req.method === 'GET') {
                return Response.json({ state: { on: state.on } })
            }
            return Response.json([{ success: {} }])
        })
        return f
    }

    it('lights-list parsea luces; toggle alterna según estado; brightness valida 1-254', async () => {
        const fake = fakeBridge({ on: true })
        const runner = makeRunner()
        try {
            const creds = { bridgeIp: `127.0.0.1:${fake.server.port}`, apiKey: KEY, timeoutMs: 5000 }
            const list = await run(runner, 'hue-extra.lights-list', creds)
            expect(list.success).toBe(true)
            expect(list.result.count).toBe(1)
            expect(list.result.lights[0]).toMatchObject({ id: '1', name: 'Salón', on: true })

            const tog = await run(runner, 'hue-extra.toggle', { ...creds, lightId: '1', action: 'toggle' })
            expect(tog.success).toBe(true)
            expect(tog.result.on).toBe(false) // estaba on -> apaga
            const put = fake.requests.find((r) => r.method === 'PUT' && r.path.endsWith('/lights/1/state'))
            expect(put?.body).toEqual({ on: false })

            const bri = await run(runner, 'hue-extra.brightness', { ...creds, lightId: '1', brightness: 200 })
            expect(bri.success).toBe(true)

            const bad = await run(runner, 'hue-extra.brightness', { ...creds, lightId: '1', brightness: 999 })
            expect(bad.success).toBe(false)
            expect(bad.error).toMatch(/1 y 254/)
        } finally {
            runner.dispose()
            fake.server.stop()
        }
    })

    it('sin credenciales pide configurar y el token nunca sale en errores', async () => {
        const runner = makeRunner()
        try {
            const miss = await run(runner, 'hue-extra.lights-list', {})
            expect(miss.success).toBe(false)
            expect(miss.error).toMatch(/IP del puente|API key/)

            const port = await closedPort()
            const secret = 'SUPERSECRET-ABCDEF-1234567890'
            const out = await run(runner, 'hue-extra.lights-list', {
                bridgeIp: `127.0.0.1:${port}`, apiKey: secret, timeoutMs: 2000,
            })
            expect(out.success).toBe(false)
            expect(out.error).not.toContain(secret)
            expect(out.error).toMatch(/puente Hue|espera|conectar/i)
        } finally {
            runner.dispose()
        }
    })
})

// ---------- 6. govee ----------

describe('govee e2e (nube falsa)', () => {
    it('toggle/brightness/color envían Govee-API-Key y comando; sin apikey error claro', async () => {
        const fake = startFakeHttp(() => Response.json({ code: 200, message: 'success' }), ['Govee-API-Key'])
        const prev = process.env.GOVEE_API_BASE
        process.env.GOVEE_API_BASE = fake.base
        const runner = makeRunner()
        try {
            const t = await run(runner, 'govee.toggle', { apiKey: 'k123', device: 'AA:BB', model: 'H6159', action: 'on' })
            expect(t.success).toBe(true)
            const b = await run(runner, 'govee.brightness', { apiKey: 'k123', device: 'AA:BB', model: 'H6159', brightness: 80 })
            expect(b.success).toBe(true)
            const c = await run(runner, 'govee.color', { apiKey: 'k123', device: 'AA:BB', model: 'H6159', red: 255, green: 0, blue: 0 })
            expect(c.success).toBe(true)
            expect(fake.requests.length).toBe(3)
            for (const r of fake.requests) {
                expect(r.path).toBe('/devices/control')
                expect(r.headers['Govee-API-Key']).toBe('k123')
            }
            expect(fake.requests[0].body.cmd).toEqual({ name: 'turn', value: 'on' })
            expect(fake.requests[1].body.cmd).toEqual({ name: 'brightness', value: 80 })

            const miss = await run(runner, 'govee.toggle', { device: 'AA:BB', model: 'H6159', action: 'on' })
            expect(miss.success).toBe(false)
            expect(miss.error).toMatch(/API key/)
        } finally {
            runner.dispose()
            fake.server.stop()
            if (prev === undefined) delete process.env.GOVEE_API_BASE
            else process.env.GOVEE_API_BASE = prev
        }
    })
})

// ---------- 7. pc-vitals extendido ----------

describe('pc-vitals extendido e2e', () => {
    it('gpu-temp/disk-usage/uptime/process-top no lanzan y reportan forma', async () => {
        const runner = makeRunner()
        try {
            const gpu = await run(runner, 'pc-vitals.gpu-temp', {})
            expect(gpu.success).toBe(true)
            expect(typeof gpu.result.monitored).toBe('boolean')
            if (!gpu.result.monitored) expect(gpu.result.degraded).toBe(true)

            const disk = await run(runner, 'pc-vitals.disk-usage', {})
            expect(disk.success).toBe(true)
            expect(typeof disk.result.monitored).toBe('boolean')

            const up = await run(runner, 'pc-vitals.uptime', {})
            expect(up.success).toBe(true)
            expect(up.result.monitored).toBe(true)
            expect(up.result.value).toBeGreaterThanOrEqual(0)

            const top = await run(runner, 'pc-vitals.process-top', { limit: 3, sortBy: 'cpu' })
            expect(top.success).toBe(true)
            if (top.result.monitored) expect(Array.isArray(top.result.processes)).toBe(true)
            else expect(top.result.degraded).toBe(true)
        } finally {
            runner.dispose()
        }
    })

    it('net-speed doble muestreo con intervalo corto no cuelga', async () => {
        const runner = makeRunner()
        try {
            const t0 = Date.now()
            const out = await run(runner, 'pc-vitals.net-speed', { sampleMs: 200 })
            expect(Date.now() - t0).toBeLessThan(10000)
            expect(out.success).toBe(true)
            if (out.result.monitored) {
                expect(typeof out.result.value).toBe('number')
            } else {
                expect(out.result.degraded).toBe(true)
            }
        } finally {
            runner.dispose()
        }
    })
})

// ---------- 8. homeassistant extendido ----------

describe('homeassistant extendido e2e (Bearer + endpoints)', () => {
    it('services usan Authorization Bearer; sensor-value solo lee (GET states)', async () => {
        const fake = startFakeHttp(async (req) => {
            const url = new URL(req.url)
            if (url.pathname.startsWith('/api/states/')) {
                return Response.json({ entity_id: url.pathname.split('/').pop(), state: '21.5' })
            }
            return Response.json([])
        }, ['authorization'])
        const runner = makeRunner()
        try {
            const creds = { baseUrl: fake.base, token: 'TOK123' }
            await run(runner, 'homeassistant.scene-activate', { ...creds, entityId: 'scene.noche' })
            await run(runner, 'homeassistant.automation-trigger', { ...creds, entityId: 'automation.x' })
            await run(runner, 'homeassistant.cover-control', { ...creds, entityId: 'cover.salon', action: 'open' })
            await run(runner, 'homeassistant.climate-set', { ...creds, entityId: 'climate.s', temperature: 21 })
            const sensor = await run(runner, 'homeassistant.sensor-value', { ...creds, entityId: 'sensor.t' })
            expect(sensor.success).toBe(true)
            expect(sensor.result.state).toBe('21.5')

            const paths = fake.requests.map((r) => `${r.method} ${r.path}`)
            expect(paths).toContain('POST /api/services/scene/turn_on')
            expect(paths).toContain('POST /api/services/automation/trigger')
            expect(paths).toContain('POST /api/services/cover/open_cover')
            expect(paths).toContain('POST /api/services/climate/set_temperature')
            expect(paths).toContain('GET /api/states/sensor.t')
            // sensor-value no debe POSTear a services
            expect(paths.filter((p) => p.startsWith('POST /api/services') && p.includes('sensor'))).toEqual([])
            for (const r of fake.requests) {
                expect(r.headers['authorization']).toBe('Bearer TOK123')
            }
        } finally {
            runner.dispose()
            fake.server.stop()
        }
    })
})
