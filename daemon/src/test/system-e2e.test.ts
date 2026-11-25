/**
 * system-e2e.test.ts — E2E de plugins de sistema vía ActionRunner real.
 * Solo cubre lo que NO está en system-plugins.test.ts (manifiestos, validación
 * pura y cableado básico ya verificados allí): secuencias reales multiactuación,
 * ciclos completos con DB temporal aislada y contratos de degradación.
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-syse2e-test-'))
process.env.LIBREDECK_DATA_DIR = TMP
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true })

import { initDatabase } from '../db'
import { ActionRunner } from '../action-runner'
import { AudioMixerPlugin } from '../plugins/audio-mixer.plugin'
import { WindowManagerPlugin } from '../plugins/window-manager.plugin'
import { resolveMeetingHotkey } from '../plugins/meetings.plugin'

function memContext() {
    return {
        log: (_level: string, _message: string) => {},
        getSetting: (_k: string) => null as string | null,
        setSetting: (_k: string, _v: string) => {},
        deleteSetting: (_k: string) => {},
    }
}

const runners: ActionRunner[] = []
const realFetch = globalThis.fetch
function makeRunner(): ActionRunner {
    const r = new ActionRunner({} as any)
    runners.push(r)
    return r
}
function findPlug(runner: ActionRunner, id: string): any {
    const p = runner.getNativePlugins().find((x: any) => x.getManifest().id === id)
    if (!p) throw new Error(`plugin ${id} no registrado en el runner`)
    return p
}
function dbOf(runner: ActionRunner): any {
    return (runner as any).db
}
const ctx = { timestamp: Date.now() }

beforeAll(async () => {
    await initDatabase()
})

afterEach(async () => {
    // Restaura fetch real de Bun si se mockeó (Bun expone fetch global).
    // Nunca asignar undefined: rompería otros ficheros de test que usan fetch
    // (p. ej. homeassistant.plugin.test.ts con Bun.serve + fetch real).
    globalThis.fetch = realFetch
    delete (globalThis as any).__libredeckWs
    while (runners.length > 0) {
        const r = runners.pop()!
        try { r.dispose() } catch { /* mejor esfuerzo */ }
    }
})

// ---------- fixture ICS: 2 futuros + 1 pasado, desordenados a propósito ----------
const ICS_E2E = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Reunión futura B
DTSTART:20300201T100000Z
URL:https://example.com/b
END:VEVENT
BEGIN:VEVENT
SUMMARY:Evento pasado
DTSTART:20200101T090000Z
END:VEVENT
BEGIN:VEVENT
SUMMARY:Reunión futura A
DTSTART:20300101T090000Z
LOCATION:Sala 3
URL:https://meet.example.com/a
END:VEVENT
END:VCALENDAR`
const ICS_PATH = path.join(TMP, 'cal-e2e.ics')
fs.writeFileSync(ICS_PATH, ICS_E2E)

// ---------- 1. multiaction.run-sequence E2E real ----------

describe('multiaction E2E (ActionRunner real)', () => {
    test('secuencia [delay + timer.status + calendar.countdown] en orden y con resultados', async () => {
        const runner = makeRunner()
        const out = await runner.executeAction(
            {
                type: 'multiaction.run-sequence',
                parameters: {
                    actions: [
                        { pluginId: 'utility', actionId: 'delay', params: { duration: 5 } },
                        { pluginId: 'timer', actionId: 'status' },
                        { pluginId: 'calendar', actionId: 'countdown', params: { index: 0, icsPath: ICS_PATH } },
                    ],
                },
            },
            { ...ctx }
        )
        expect(out.success).toBe(true)
        expect(out.result.total).toBe(3)
        expect(out.result.completed).toBe(3)
        expect(out.result.failedStep).toBeNull()
        const types = out.result.results.map((r: any) => r.type)
        expect(types).toEqual(['utility.delay', 'timer.status', 'calendar.countdown'])
        for (const r of out.result.results) expect(r.success).toBe(true)
        expect(out.result.results[1].result.status).toBeDefined()
        expect(out.result.results[2].result.countdown).toMatch(/en|ahora/)
    })

    test('dryRun devuelve plan sin ejecutar', async () => {
        const runner = makeRunner()
        const out = await runner.executeAction(
            {
                type: 'multiaction.run-sequence',
                parameters: {
                    dryRun: true,
                    actions: [
                        { pluginId: 'utility', actionId: 'delay', params: { duration: 5 }, delayMs: 10 },
                        // Paso que fallaría si se ejecutara: en dry-run no debe fallar
                        { pluginId: 'noexiste', actionId: 'nada' },
                    ],
                },
            },
            { ...ctx }
        )
        expect(out.success).toBe(true)
        expect(out.result.dryRun).toBe(true)
        expect(out.result.total).toBe(2)
        expect(out.result.plan[0]).toMatchObject({ index: 0, type: 'utility.delay', delayMs: 10 })
        expect(out.result.plan[1].type).toBe('noexiste.nada')
    })

    test('delayMs respeta la pausa entre pasos', async () => {
        const runner = makeRunner()
        const t0 = Date.now()
        const out = await runner.executeAction(
            {
                type: 'multiaction.run-sequence',
                parameters: {
                    actions: [
                        { pluginId: 'utility', actionId: 'delay', params: { duration: 1 } },
                        { pluginId: 'utility', actionId: 'delay', params: { duration: 1 }, delayMs: 80 },
                    ],
                },
            },
            { ...ctx }
        )
        const elapsed = Date.now() - t0
        expect(out.success).toBe(true)
        expect(out.result.completed).toBe(2)
        expect(elapsed).toBeGreaterThanOrEqual(70)
    })

    test('continueOnError por paso: el fallo no aborta', async () => {
        const runner = makeRunner()
        const out = await runner.executeAction(
            {
                type: 'multiaction.run-sequence',
                parameters: {
                    actions: [
                        { pluginId: 'utility', actionId: 'delay', params: { duration: 1 } },
                        { pluginId: 'noexiste', actionId: 'nada', continueOnError: true },
                        { pluginId: 'timer', actionId: 'status' },
                    ],
                },
            },
            { ...ctx }
        )
        expect(out.success).toBe(true)
        expect(out.result.total).toBe(3)
        expect(out.result.completed).toBe(2)
        expect(out.result.failedStep).toBe(1)
        expect(out.result.results).toHaveLength(3)
        expect(out.result.results[1].success).toBe(false)
        expect(out.result.results[2].success).toBe(true)
    })

    test('sin continueOnError aborta según stopOnError', async () => {
        const runner = makeRunner()
        const out = await runner.executeAction(
            {
                type: 'multiaction.run-sequence',
                parameters: {
                    actions: [
                        { pluginId: 'utility', actionId: 'delay', params: { duration: 1 } },
                        { pluginId: 'noexiste', actionId: 'nada' },
                        { pluginId: 'timer', actionId: 'status' },
                    ],
                },
            },
            { ...ctx }
        )
        expect(out.success).toBe(true)
        expect(out.result.completed).toBe(1)
        expect(out.result.failedStep).toBe(1)
        expect(out.result.results).toHaveLength(2)
    })

    test('validación E2E: anidadas, macro, >50 pasos y lista vacía', async () => {
        const runner = makeRunner()
        const run = (actions: any) =>
            runner.executeAction({ type: 'multiaction.run-sequence', parameters: { actions } }, { ...ctx })
        let out = await run([{ pluginId: 'multiaction', actionId: 'run-sequence', params: { actions: [] } }])
        expect(out.success).toBe(false)
        expect(out.error).toMatch(/anidadas/)
        out = await run([{ type: 'utility.macro' }])
        expect(out.success).toBe(false)
        expect(out.error).toMatch(/anidadas/)
        out = await run([])
        expect(out.success).toBe(false)
        expect(out.error).toMatch(/entre 1 y 50/)
        const many = Array.from({ length: 51 }, () => ({ pluginId: 'utility', actionId: 'delay', params: { duration: 1 } }))
        out = await run(many)
        expect(out.success).toBe(false)
        expect(out.error).toMatch(/entre 1 y 50/)
    })
})

// ---------- 2. profile-auto E2E con DB temporal ----------

describe('profile-auto E2E (DB temporal aislada)', () => {
    const APP = 'obs-e2e-unico'
    test('ciclo add/list/status/switch/restore', async () => {
        const runner = makeRunner()
        const db = dbOf(runner)
        db.deleteSetting('plugin.profile-auto.rules')
        db.deleteSetting('plugin.profile-auto.previousProfile')
        const plug = findPlug(runner, 'profile-auto')

        const added = await runner.executeAction(
            { type: 'profile-auto.add-rule', parameters: { app: APP, profileId: 'p1' } }, { ...ctx })
        expect(added.success).toBe(true)
        expect(added.result.added).toBe(true)

        const list = await runner.executeAction({ type: 'profile-auto.list-rules', parameters: {} }, { ...ctx })
        expect(list.success).toBe(true)
        expect(list.result.rules.some((r: any) => r.app === APP && r.profileId === 'p1')).toBe(true)

        const st = await runner.executeAction({ type: 'profile-auto.status', parameters: {} }, { ...ctx })
        expect(st.success).toBe(true)
        expect(st.result.rules).toBeGreaterThanOrEqual(1)

        const sw = await runner.executeAction(
            { type: 'profile-auto.switch-profile', parameters: { profileId: 'p9' } }, { ...ctx })
        expect(sw.success).toBe(true)
        expect(sw.result).toMatchObject({ action: 'navigate_to_profile', profileId: 'p9' })

        plug.rememberPrevious('p-prev')
        const restored = await runner.executeAction({ type: 'profile-auto.restore', parameters: {} }, { ...ctx })
        expect(restored.success).toBe(true)
        expect(restored.result).toMatchObject({ profileId: 'p-prev', restored: true })

        await runner.executeAction({ type: 'profile-auto.remove-rule', parameters: { app: APP } }, { ...ctx })
    })

    test('duplicada hace upsert; inválida y inexistente dan error claro', async () => {
        const runner = makeRunner()
        const db = dbOf(runner)
        db.deleteSetting('plugin.profile-auto.rules')
        const run = (p: any) => runner.executeAction({ type: `profile-auto.${p._a}`, parameters: p.params }, { ...ctx })

        await run({ _a: 'add-rule', params: { app: APP, profileId: 'p1' } })
        const dup = await run({ _a: 'add-rule', params: { app: APP.toUpperCase(), profileId: 'p2', op: 'exact' } })
        expect(dup.success).toBe(true)
        expect(dup.result.total).toBe(1) // upsert por app, no duplica
        const list = await run({ _a: 'list-rules', params: {} })
        expect(list.result.rules[0]).toMatchObject({ app: APP.toUpperCase(), profileId: 'p2', op: 'exact' })

        const badOp = await run({ _a: 'add-rule', params: { app: APP, profileId: 'p1', op: 'x' } })
        expect(badOp.success).toBe(false)
        expect(badOp.error).toMatch(/op/)

        const badRegex = await run({ _a: 'add-rule', params: { app: '([', profileId: 'p1', op: 'regex' } })
        expect(badRegex.success).toBe(false)
        expect(badRegex.error).toMatch(/regular/)

        const noRule = await run({ _a: 'remove-rule', params: { app: 'app-que-no-existe-e2e' } })
        expect(noRule.success).toBe(false)
        expect(noRule.error).toMatch(/Ninguna regla|No hay/)

        await run({ _a: 'remove-rule', params: { app: APP } })
    })

    test('restore sin perfil anterior falla degradado', async () => {
        const runner = makeRunner()
        dbOf(runner).deleteSetting('plugin.profile-auto.previousProfile')
        const out = await runner.executeAction({ type: 'profile-auto.restore', parameters: {} }, { ...ctx })
        expect(out.success).toBe(false)
        expect(out.error).toMatch(/anterior/)
    })
})

// ---------- 3. timer E2E ----------

describe('timer E2E (ActionRunner real)', () => {
    test('ciclo start/status/stop con work, break y custom; tick fuerza el fin', async () => {
        const runner = makeRunner()
        const run = (a: string, p: any = {}) =>
            runner.executeAction({ type: `timer.${a}`, parameters: p }, { ...ctx })

        let out = await run('start', { mode: 'work', workMinutes: 25, label: 'foco-e2e' })
        expect(out.success).toBe(true)
        expect(out.result.started).toBe(true)
        let st = await run('status')
        expect(st.result.status).toBe('running')
        expect(st.result.mode).toBe('work')
        out = await run('stop')
        expect(out.success).toBe(true)
        expect(out.result.stopped).toBe(true)
        expect(out.result.status).toBe('paused')

        out = await run('start', { mode: 'break', breakMinutes: 5 })
        expect(out.success).toBe(true)
        expect(out.result.mode).toBe('break')
        await run('stop')

        out = await run('start', { mode: 'custom', minutes: 1 })
        expect(out.success).toBe(true)
        expect(out.result.remaining).toBe('01:00')
        const plug = findPlug(runner, 'timer')
        plug.tick(Date.now() + 61_000)
        st = await run('status')
        expect(st.result.status).toBe('finished')
        expect(st.result.remaining).toBe('00:00')
    })

    test('tick/broadcast sin WS no rompen (best-effort)', async () => {
        const runner = makeRunner()
        delete (globalThis as any).__libredeckWs
        const plug = findPlug(runner, 'timer')
        expect(() => plug.tick(Date.now())).not.toThrow() // idle: no-op
        await runner.executeAction({ type: 'timer.start', parameters: { mode: 'custom', minutes: 1 } }, { ...ctx })
        expect(() => plug.tick(Date.now())).not.toThrow() // emite tick best-effort
        plug.tick(Date.now() + 61_000) // fin best-effort
        const st = await runner.executeAction({ type: 'timer.status', parameters: {} }, { ...ctx })
        expect(st.success).toBe(true)
        expect(st.result.status).toBe('finished')
    })
})

// ---------- 4. clipboard E2E ----------

describe('clipboard E2E (settings aislados)', () => {
    test('save/paste/list roundtrip sin tocar el sistema', async () => {
        const runner = makeRunner()
        const db = dbOf(runner)
        db.deleteSetting('plugin.clipboard.slots')
        db.deleteSetting('plugin.clipboard.history')
        const plug = findPlug(runner, 'clipboard')
        let pasted = ''
        plug.writeSystemClipboard = async (t: string) => { pasted = t }

        const saved = await runner.executeAction(
            { type: 'clipboard.save-slot', parameters: { slot: 'firma-e2e', text: 'Saludos,\nEquipo E2E' } }, { ...ctx })
        expect(saved.success).toBe(true)
        expect(saved.result).toMatchObject({ slot: 'firma-e2e', saved: true, captured: false })

        const list = await runner.executeAction({ type: 'clipboard.list-slots', parameters: {} }, { ...ctx })
        expect(list.success).toBe(true)
        expect(list.result.slots.some((s: any) => s.slot === 'firma-e2e' && s.preview.includes('Saludos'))).toBe(true)

        const p = await runner.executeAction({ type: 'clipboard.paste-slot', parameters: { slot: 'firma-e2e' } }, { ...ctx })
        expect(p.success).toBe(true)
        expect(p.result.pasted).toBe(true)
        expect(pasted).toContain('Equipo E2E')

        const missing = await runner.executeAction({ type: 'clipboard.paste-slot', parameters: { slot: 'vacio-e2e' } }, { ...ctx })
        expect(missing.success).toBe(false)
        expect(missing.error).toMatch(/vacío/)
    })

    test('history acotado a 50', async () => {
        const runner = makeRunner()
        const db = dbOf(runner)
        db.deleteSetting('plugin.clipboard.slots')
        db.deleteSetting('plugin.clipboard.history')
        for (let i = 0; i < 55; i++) {
            await runner.executeAction(
                { type: 'clipboard.save-slot', parameters: { slot: `h-e2e-${i}`, text: `texto ${i}` } }, { ...ctx })
        }
        const hist = await runner.executeAction({ type: 'clipboard.history', parameters: { limit: 50 } }, { ...ctx })
        expect(hist.success).toBe(true)
        expect(hist.result.count).toBe(50)
        const bad = await runner.executeAction({ type: 'clipboard.history', parameters: { limit: 99 } }, { ...ctx })
        expect(bad.success).toBe(false)
        expect(bad.error).toMatch(/limit/)
    })
})

// ---------- 5. calendar E2E ----------

describe('calendar E2E (fixture 2 futuras + 1 pasada)', () => {
    test('next-event devuelve la próxima; countdown en español; open-event abre URL', async () => {
        const runner = makeRunner()
        const db = dbOf(runner)
        db.deleteSetting('plugin.calendar.icsPath')
        const plug = findPlug(runner, 'calendar')
        const opened: string[] = []
        plug.open = async (u: string) => { opened.push(u) }

        const next = await runner.executeAction(
            { type: 'calendar.next-event', parameters: { icsPath: ICS_PATH } }, { ...ctx })
        expect(next.success).toBe(true)
        expect(next.result.found).toBe(true)
        expect(next.result.event.summary).toBe('Reunión futura A')
        expect(next.result.countdown).toMatch(/en|ahora/)

        const cd = await runner.executeAction(
            { type: 'calendar.countdown', parameters: { index: 1, icsPath: ICS_PATH } }, { ...ctx })
        expect(cd.success).toBe(true)
        expect(cd.result.found).toBe(true)
        expect(cd.result.event.summary).toBe('Reunión futura B')
        expect(typeof cd.result.countdown).toBe('string')

        db.setSetting('plugin.calendar.icsPath', ICS_PATH)
        try {
            const openedOut = await runner.executeAction({ type: 'calendar.open-event', parameters: {} }, { ...ctx })
            expect(openedOut.success).toBe(true)
            expect(openedOut.result).toMatchObject({ url: 'https://meet.example.com/a', opened: true })
            expect(opened).toEqual(['https://meet.example.com/a'])
        } finally {
            db.deleteSetting('plugin.calendar.icsPath')
        }
    })

    test('sin fuente pide configuración en español', async () => {
        const runner = makeRunner()
        dbOf(runner).deleteSetting('plugin.calendar.icsPath')
        const out = await runner.executeAction({ type: 'calendar.next-event', parameters: {} }, { ...ctx })
        expect(out.success).toBe(false)
        expect(out.error).toMatch(/Sin fuente/)
    })
})

// ---------- 6. meetings E2E ----------

describe('meetings E2E (ActionRunner real)', () => {
    test('control zoom/teams/meet con presets; explícito > ajuste > preset', async () => {
        const runner = makeRunner()
        const db = dbOf(runner)
        const plug = findPlug(runner, 'meetings')
        const sent: Array<{ key: string; modifiers: string[] }> = []
        plug.sendHotkey = async (key: string, modifiers: string[]) => {
            sent.push({ key, modifiers })
            return { platform: 'test', ok: true }
        }
        db.deleteSetting('plugin.meetings.hotkey.zoom.mute')

        // preset: teams/mute y meet/mute sin ajustes
        let out = await runner.executeAction(
            { type: 'meetings.control', parameters: { app: 'teams', command: 'mute' } }, { ...ctx })
        expect(out.success).toBe(true)
        expect(out.result).toMatchObject({ app: 'teams', hotkey: 'Ctrl+Shift+M', sent: true })

        out = await runner.executeAction(
            { type: 'meetings.control', parameters: { app: 'meet', command: 'mute' } }, { ...ctx })
        expect(out.success).toBe(true)
        expect(out.result.hotkey).toBe('Ctrl+D')

        // ajuste guardado gana al preset de zoom (Alt+A)
        db.setSetting('plugin.meetings.hotkey.zoom.mute', 'Ctrl+Alt+M')
        out = await runner.executeAction(
            { type: 'meetings.control', parameters: { app: 'zoom', command: 'mute' } }, { ...ctx })
        expect(out.success).toBe(true)
        expect(out.result.hotkey).toBe('Ctrl+Alt+M')

        // explícito gana a todo
        out = await runner.executeAction(
            { type: 'meetings.control', parameters: { app: 'zoom', command: 'mute', hotkey: 'F9' } }, { ...ctx })
        expect(out.success).toBe(true)
        expect(out.result.hotkey).toBe('F9')

        // pureza de la resolución: meet/leave sin preset exige explícito
        expect(() => resolveMeetingHotkey('meet', 'leave')).toThrow(/explícito/)
        expect(resolveMeetingHotkey('zoom', 'mute')).toBe('Alt+A')
        db.deleteSetting('plugin.meetings.hotkey.zoom.mute')
        expect(sent.length).toBeGreaterThanOrEqual(4)
    })

    test('join valida la URL y la abre', async () => {
        const runner = makeRunner()
        const plug = findPlug(runner, 'meetings')
        const opened: string[] = []
        plug.open = async (u: string) => { opened.push(u) }

        const bad = await runner.executeAction({ type: 'meetings.join', parameters: {} }, { ...ctx })
        expect(bad.success).toBe(false)
        expect(bad.error).toMatch(/url/)

        const ok = await runner.executeAction(
            { type: 'meetings.join', parameters: { url: 'https://zoom.us/j/123', app: 'zoom' } }, { ...ctx })
        expect(ok.success).toBe(true)
        expect(ok.result).toMatchObject({ url: 'https://zoom.us/j/123', opened: true })
        expect(opened).toEqual(['https://zoom.us/j/123'])
    })
})

// ---------- 7. slack E2E (fetch mockeado) ----------

describe('slack E2E (fetch mockeado)', () => {
    function mockSlack() {
        ;(globalThis as any).fetch = async (url: any) => {
            const u = String(url)
            if (u.includes('conversations.list')) {
                return new Response(JSON.stringify({
                    ok: true,
                    channels: [{ id: 'C1', name: 'general' }, { id: 'C2', name: 'random' }],
                }), { status: 200 })
            }
            if (u.includes('conversations.info')) {
                const ch = new URL(u).searchParams.get('channel')
                const n = ch === 'C1' ? 3 : 5
                return new Response(JSON.stringify({
                    ok: true, channel: { id: ch, name: ch === 'C1' ? 'general' : 'random', unread_count_display: n },
                }), { status: 200 })
            }
            if (u.includes('chat.postMessage')) {
                return new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 })
            }
            return new Response('{}', { status: 404 })
        }
    }

    test('unread-count suma unread_count_display de canales y DMs', async () => {
        const runner = makeRunner()
        mockSlack()
        const out = await runner.executeAction(
            { type: 'slack.unread-count', parameters: { token: 'xoxb-test' } }, { ...ctx })
        expect(out.success).toBe(true)
        expect(out.result.total).toBe(8)
        expect(out.result.checked).toBe(2)
        expect(out.result.conversations).toHaveLength(2)
        expect(out.result.conversations[0].unread).toBe(5)
    })

    test('send-message sin token pide configuración; error de Slack humanizado', async () => {
        const runner = makeRunner()
        dbOf(runner).deleteSetting('plugin.slack.token')
        const noToken = await runner.executeAction(
            { type: 'slack.send-message', parameters: { channel: 'C1', text: 'hola' } }, { ...ctx })
        expect(noToken.success).toBe(false)
        expect(noToken.error).toMatch(/token/i)

        mockSlack()
        const badChannel = await runner.executeAction(
            { type: 'slack.send-message', parameters: { channel: 'CXX', text: 'hola', token: 'xoxb-test' } }, { ...ctx })
        expect(badChannel.success).toBe(false)
        expect(badChannel.error).toMatch(/canal no encontrado/)
    })
})

// ---------- 8. audio-mixer / window-manager: degradación ----------

describe('audio-mixer / window-manager (degradación)', () => {
    test('get-levels no lanza: devuelve niveles o ejemplo simulado', async () => {
        const runner = makeRunner()
        const out = await runner.executeAction({ type: 'audio-mixer.get-levels', parameters: {} }, { ...ctx })
        expect(out.success).toBe(true)
        expect(typeof out.result.master).toBe('number')
        expect(typeof out.result.muted).toBe('boolean')
        if (out.result.simulated) {
            expect(typeof out.result.nota).toBe('string')
            expect(out.result.nota.length).toBeGreaterThan(0)
        }
    })

    test('output-switch valida estructura: hint al listar o error humanizado', async () => {
        const runner = makeRunner()
        const out = await runner.executeAction({ type: 'audio-mixer.output-switch', parameters: {} }, { ...ctx })
        if (out.success) {
            expect(typeof out.result.hint).toBe('string')
        } else {
            expect(out.error).toMatch(/pactl|AudioDevice|salida|macOS|PowerShell/i)
            expect(out.error).not.toMatch(/^spawn .* ENOENT$/)
        }
        const bad = await runner.executeAction(
            { type: 'audio-mixer.output-switch', parameters: { device: '__inexistente-e2e__' } }, { ...ctx })
        if (!bad.success) {
            expect(bad.error).toMatch(/salida|AudioDevice|pactl|macOS|PowerShell/i)
        }
    })

    test('window-action: aplicado o error humanizado con hint (nunca ENOENT crudo)', async () => {
        const runner = makeRunner()
        const plug = findPlug(runner, 'window-manager')
        // Sin tocar el sistema: el handler real minimiza la ventana en
        // primer plano (ShowWindow 6 en Windows). Se intercepta `run` (punto
        // de inyección del plugin) y se verifica el script generado.
        const seen: string[] = []
        const origRun = plug.run.bind(plug)
        plug.run = async (cmd: string[]) => {
            seen.push(cmd.join(' '))
            return { stdout: '', stderr: '', exitCode: 0 }
        }
        try {
            const out = await runner.executeAction(
                { type: 'window-manager.window-action', parameters: { action: 'minimize' } }, { ...ctx })
            expect(out.success).toBe(true)
            expect(out.result.applied).toBe(true)
            expect(seen.join('\n')).toMatch(/ShowWindow\(\$h, 6\)|wmctrl|xdotool|miniaturiz/)
        } finally {
            plug.run = origRun
        }
    })

    test('contrato missing-tool: sin binario se pide instalar en vez de fallar en crudo', async () => {
        class NoBinAudio extends AudioMixerPlugin {
            protected async run(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
                const e: any = new Error('spawn pactl ENOENT')
                e.code = 'COMMAND_NOT_FOUND'
                throw e
            }
        }
        const audio = new NoBinAudio(memContext())
        await expect(audio.getActionHandlers().get('app-volume')!({ volume: 50 }, {}))
            .rejects.toThrow(/nircmd|pactl|osascript|Instala/)
        await expect(audio.getActionHandlers().get('get-levels')!({}, {}))
            .resolves.toMatchObject({ simulated: true })

        const win = new WindowManagerPlugin(memContext())
        ;(win as any).run = async (cmd: string[]) => {
            if (cmd[0] === 'which' || cmd[0] === 'where') return { stdout: '', stderr: '', exitCode: 1 }
            const e: any = new Error(`spawn ${cmd[0]} ENOENT`)
            e.code = 'COMMAND_NOT_FOUND'
            throw e
        }
        await expect((win as any).linuxAction('minimize')).rejects.toThrow(/wmctrl/)
    })
})
