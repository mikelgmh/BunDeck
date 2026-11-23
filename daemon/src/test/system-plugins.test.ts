/**
 * system-plugins.test.ts — plugins de sistema + macros + perfiles.
 * Manifiestos, validación, lógica pura y cableado con ActionRunner.
 */
import { describe, test, expect, beforeAll } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-sysplugins-test-'))
process.env.LIBREDECK_DATA_DIR = TMP
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true })

import { initDatabase } from '../db'
import { ActionRunner } from '../action-runner'
import { getNativeManifests } from '../plugins/index'
import { AudioMixerPlugin } from '../plugins/audio-mixer.plugin'
import { WindowManagerPlugin } from '../plugins/window-manager.plugin'
import { MeetingsPlugin, resolveMeetingHotkey, parseCombo, MEETING_PRESETS } from '../plugins/meetings.plugin'
import { SlackPlugin } from '../plugins/slack.plugin'
import { CalendarPlugin, parseIcs, upcomingEvents, humanCountdown } from '../plugins/calendar.plugin'
import { TimerPlugin, formatRemaining, remainingOf } from '../plugins/timer.plugin'
import { ClipboardPlugin } from '../plugins/clipboard.plugin'
import { MultiactionPlugin } from '../plugins/multiaction.plugin'
import { ProfileAutoPlugin } from '../plugins/profile-auto.plugin'
import { isCommandNotFound } from '../plugins/sysrun'

function memContext() {
    const store = new Map<string, string>()
    const logs: Array<{ level: string; message: string }> = []
    return {
        store,
        logs,
        log: (level: string, message: string) => { logs.push({ level, message }) },
        getSetting: (k: string) => store.get(k) ?? null,
        setSetting: (k: string, v: string) => { store.set(k, v) },
        deleteSetting: (k: string) => { store.delete(k) },
    }
}

beforeAll(async () => {
    await initDatabase()
})

// ---------- manifiestos ----------

describe('manifiestos de sistema', () => {
    test('los 9 plugins exponen id + acciones + handlers coherentes', async () => {
        const { UtilityPlugin } = await import('../plugins/utility.plugin')
        const instances = [
            new AudioMixerPlugin(memContext()),
            new WindowManagerPlugin(memContext()),
            new MeetingsPlugin(memContext()),
            new SlackPlugin(memContext()),
            new CalendarPlugin(memContext()),
            new TimerPlugin(memContext()),
            new ClipboardPlugin(memContext()),
            new MultiactionPlugin(memContext()),
            new ProfileAutoPlugin(memContext()),
            new UtilityPlugin(memContext()),
        ]
        const expected: Record<string, string[]> = {
            'audio-mixer': ['app-volume', 'output-switch', 'mic-mute', 'get-levels', 'volume-control'],
            'window-manager': ['window-action', 'layout-save', 'layout-restore', 'layout-list'],
            'meetings': ['control', 'join'],
            'slack': ['open-channel', 'open-dm', 'unread-count', 'send-message'],
            'calendar': ['next-event', 'countdown', 'open-event', 'today-count'],
            'timer': ['start', 'stop', 'status'],
            'clipboard': ['save-slot', 'paste-slot', 'list-slots', 'history'],
            'multiaction': ['run-sequence'],
            'profile-auto': ['add-rule', 'remove-rule', 'list-rules', 'set-enabled', 'status', 'switch-profile', 'restore'],
            'utility': ['delay', 'macro'],
        }
        for (const plugin of instances) {
            const manifest = plugin.getManifest()
            expect(expected[manifest.id]).toBeDefined()
            const ids = manifest.actions.map((a: any) => a.id)
            expect(ids.sort()).toEqual(expected[manifest.id].sort())
            const handlers = plugin.getActionHandlers()
            for (const id of ids) expect(handlers.has(id)).toBe(true)
            expect(manifest.permissions.length).toBeGreaterThan(0)
            if (plugin instanceof TimerPlugin) plugin.dispose()
        }
    })

    test('getNativeManifests incluye los 9 nuevos', () => {
        const ids = getNativeManifests().map((m: any) => m.id)
        for (const id of ['audio-mixer', 'window-manager', 'meetings', 'slack', 'calendar', 'timer', 'clipboard', 'multiaction', 'profile-auto']) {
            expect(ids).toContain(id)
        }
    })
})

// ---------- ActionRunner ----------

describe('cableado con ActionRunner', () => {
    test('registra las acciones y ejecuta multiaction de extremo a extremo', async () => {
        const runner = new ActionRunner({} as any)
        try {
            for (const type of [
                'audio-mixer.app-volume', 'window-manager.window-action', 'meetings.control',
                'slack.send-message', 'calendar.countdown', 'timer.start', 'timer.status',
                'clipboard.save-slot', 'multiaction.run-sequence', 'profile-auto.status',
            ]) {
                expect((runner as any).actionHandlers.has(type)).toBe(true)
            }
            // E2E: multiaction -> utility.delay (usa el ActionRunner existente)
            const out = await runner.executeAction(
                { type: 'multiaction.run-sequence', parameters: { actions: [{ pluginId: 'utility', actionId: 'delay', params: { duration: 5 } }] } },
                { timestamp: Date.now() }
            )
            expect(out.success).toBe(true)
            expect(out.result.completed).toBe(1)
            expect(out.result.results[0].type).toBe('utility.delay')
        } finally {
            runner.dispose()
        }
    })
})

// ---------- audio-mixer ----------

describe('audio-mixer', () => {
    test('valida parámetros antes de tocar el sistema', async () => {
        const h = new AudioMixerPlugin(memContext()).getActionHandlers()
        await expect(h.get('app-volume')!({}, {})).rejects.toThrow(/volume.*mute|mute.*volume/)
        await expect(h.get('app-volume')!({ volume: 150 }, {})).rejects.toThrow(/0.*100/)
        await expect(h.get('app-volume')!({ volume: 50, mute: 'quizas' }, {})).rejects.toThrow(/mute/)
        await expect(h.get('mic-mute')!({ muted: 'si' }, {})).rejects.toThrow(/booleano/)
    })

    test('isCommandNotFound detecta binario ausente', () => {
        expect(isCommandNotFound(new Error('spawn ENOENT'))).toBe(true)
        expect(isCommandNotFound(new Error('todo bien'))).toBe(false)
    })
})

// ---------- window-manager ----------

describe('window-manager', () => {
    test('valida acción y monitor', async () => {
        const h = new WindowManagerPlugin(memContext()).getActionHandlers()
        await expect(h.get('window-action')!({ action: 'volar' }, {})).rejects.toThrow(/no válida/i)
        await expect(h.get('window-action')!({ action: 'move-to-monitor' }, {})).rejects.toThrow(/monitor/)
    })

    test('layouts: save/list/restore sin geometría', async () => {
        const plugin = new WindowManagerPlugin(memContext())
        const h = plugin.getActionHandlers()
        await expect(h.get('layout-save')!({}, {})).rejects.toThrow(/name/)
        const saved = await h.get('layout-save')!({ name: 'stream', note: 'obs' }, {})
        expect(saved.saved).toBe(true)
        const list = await h.get('layout-list')!({}, {})
        expect(list.count).toBe(1)
        expect(list.layouts[0].name).toBe('stream')
        await expect(h.get('layout-restore')!({ name: 'stream' }, {})).rejects.toThrow(/geometría/)
        await expect(h.get('layout-restore')!({ name: 'otro' }, {})).rejects.toThrow(/No existe/)
        const withGeo = await h.get('layout-save')!({ name: 'g', x: 0, y: 0, w: 800, h: 600 }, {})
        expect(withGeo.geometry).toEqual({ x: 0, y: 0, w: 800, h: 600 })
    })
})

// ---------- meetings ----------

describe('meetings', () => {
    test('presets y resolución de hotkeys', () => {
        expect(MEETING_PRESETS.zoom.mute).toBe('Alt+A')
        expect(MEETING_PRESETS.teams.mute).toBe('Ctrl+Shift+M')
        expect(MEETING_PRESETS.meet.mute).toBe('Ctrl+D')
        expect(resolveMeetingHotkey('zoom', 'mute')).toBe('Alt+A')
        expect(resolveMeetingHotkey('meet', 'leave', { explicit: 'Ctrl+W' })).toBe('Ctrl+W')
        const ctx = memContext()
        ctx.setSetting('hotkey.zoom.mute', 'Ctrl+Alt+M')
        expect(resolveMeetingHotkey('zoom', 'mute', { getSetting: ctx.getSetting })).toBe('Ctrl+Alt+M')
        expect(() => resolveMeetingHotkey('meet', 'leave')).toThrow(/hotkey.*explícito/)
        expect(() => resolveMeetingHotkey('skype', 'mute')).toThrow(/App no válida/)
        expect(() => resolveMeetingHotkey('zoom', 'bailar')).toThrow(/Comando no válido/)
    })

    test('parseCombo', () => {
        expect(parseCombo('Ctrl+Shift+M')).toEqual({ key: 'M', modifiers: ['ctrl', 'shift'] })
        expect(() => parseCombo('Foo+M')).toThrow(/Modificador/)
        expect(() => parseCombo('')).toThrow(/vacío|inválido/i)
    })

    test('control usa presets sin ejecutar (stub) y join valida', async () => {
        const plugin = new MeetingsPlugin(memContext())
        ;(plugin as any).sendHotkey = async () => ({ platform: 'test', ok: true })
        const h = plugin.getActionHandlers()
        const out = await h.get('control')!({ app: 'zoom', command: 'mute' }, {})
        expect(out).toMatchObject({ app: 'zoom', command: 'mute', hotkey: 'Alt+A', sent: true })
        await expect(h.get('join')!({}, {})).rejects.toThrow(/url/)
    })
})

// ---------- slack ----------

describe('slack', () => {
    test('sin token pide configuración en español', async () => {
        const h = new SlackPlugin(memContext()).getActionHandlers()
        await expect(h.get('unread-count')!({}, {})).rejects.toThrow(/token/)
        await expect(h.get('send-message')!({ channel: 'C1', text: 'hola' }, {})).rejects.toThrow(/token/)
        await expect(h.get('send-message')!({ text: 'hola' }, {})).rejects.toThrow(/token|channel/)
    })

    test('open-channel/open-dm construyen app_redirect (stub)', async () => {
        const plugin = new SlackPlugin(memContext())
        const opened: string[] = []
        ;(plugin as any).open = async (u: string) => { opened.push(u) }
        const h = plugin.getActionHandlers()
        const c = await h.get('open-channel')!({ channel: 'C012345' }, {})
        expect(c.url).toContain('app_redirect?channel=C012345')
        const d = await h.get('open-dm')!({ user: 'U012345' }, {})
        expect(d.url).toContain('app_redirect?user=U012345')
        expect(opened).toHaveLength(2)
        await expect(h.get('open-dm')!({}, {})).rejects.toThrow(/user/)
    })

    test('send-message usa token de ajustes (fetch stub)', async () => {
        const ctx = memContext()
        ctx.setSetting('token', 'xoxb-test')
        const plugin = new SlackPlugin(ctx)
        const orig = globalThis.fetch
        ;(globalThis as any).fetch = async () => new Response(JSON.stringify({ ok: true, ts: '123.456' }), { status: 200 })
        try {
            const out = await plugin.getActionHandlers().get('send-message')!({ channel: 'C1', text: 'hola' }, {})
            expect(out).toMatchObject({ channel: 'C1', sent: true, ts: '123.456' })
        } finally {
            ;(globalThis as any).fetch = orig
        }
    })
})

// ---------- calendar ----------

describe('calendar', () => {
    const ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Daily de equipo
DTSTART:20300101T090000Z
LOCATION:Sala 3
URL:https://meet.example.com/abc
END:VEVENT
BEGIN:VEVENT
SUMMARY:Evento pasado
DTSTART:20200101T090000Z
END:VEVENT
END:VCALENDAR`

    test('parseIcs + upcomingEvents + humanCountdown', () => {
        const events = parseIcs(ICS)
        expect(events).toHaveLength(2)
        expect(events[0].summary).toBe('Daily de equipo')
        expect(events[0].url).toBe('https://meet.example.com/abc')
        const upcoming = upcomingEvents(events, new Date('2029-01-01T00:00:00Z').getTime())
        expect(upcoming).toHaveLength(1)
        expect(upcoming[0].summary).toBe('Daily de equipo')
        const now = Date.now()
        expect(humanCountdown(now + 30_000, now)).toBe('ahora mismo')
        expect(humanCountdown(now + 15 * 60_000, now)).toBe('en 15 min')
        expect(humanCountdown(now + 2 * 3_600_000 + 15 * 60_000, now)).toBe('en 2 h y 15 min')
        expect(humanCountdown(now + 3 * 86_400_000, now)).toBe('en 3 días')
    })

    test('sin fuente pide configuración', async () => {
        const h = new CalendarPlugin(memContext()).getActionHandlers()
        await expect(h.get('next-event')!({}, {})).rejects.toThrow(/Sin fuente/)
        await expect(h.get('countdown')!({ index: -1 }, {})).rejects.toThrow(/index/)
    })

    test('next-event/countdown desde archivo', async () => {
        const p = path.join(TMP, 'cal.ics')
        fs.writeFileSync(p, ICS)
        const ctx = memContext()
        ctx.setSetting('icsPath', p)
        const plugin = new CalendarPlugin(ctx)
        const h = plugin.getActionHandlers()
        const next = await h.get('next-event')!({}, {})
        expect(next.found).toBe(true)
        expect(next.event.summary).toBe('Daily de equipo')
        expect(next.countdown).toMatch(/en|ahora/)
        const cd = await h.get('countdown')!({ index: 0 }, {})
        expect(cd.found).toBe(true)
        expect(typeof cd.countdown).toBe('string')
        const empty = await h.get('countdown')!({ index: 5 }, {})
        expect(empty.found).toBe(false)
    })
})

// ---------- timer ----------

describe('timer', () => {
    test('formatRemaining y remainingOf', () => {
        expect(formatRemaining(25 * 60_000)).toBe('25:00')
        expect(formatRemaining(65_000)).toBe('01:05')
        expect(remainingOf({ status: 'idle', remainingMs: 123 } as any)).toBe(123)
    })

    test('start/status/stop y fin por tick', async () => {
        const plugin = new TimerPlugin(memContext())
        try {
            const h = plugin.getActionHandlers()
            await expect(h.get('start')!({ mode: 'raro' }, {})).rejects.toThrow(/Modo/)
            await expect(h.get('start')!({ mode: 'custom' }, {})).rejects.toThrow(/minutes/)
            const started = await h.get('start')!({ mode: 'custom', minutes: 1, label: 'foco' }, {})
            expect(started.started).toBe(true)
            expect(started.remaining).toBe('01:00')
            const st = await h.get('status')!({}, {})
            expect(st.status).toBe('running')
            const stopped = await h.get('stop')!({}, {})
            expect(stopped.stopped).toBe(true)
            expect(stopped.status).toBe('paused')
            // Reanuda y fuerza el fin
            await h.get('start')!({ mode: 'custom', minutes: 1 }, {})
            plugin.tick(Date.now() + 61_000)
            const fin = await h.get('status')!({}, {})
            expect(fin.status).toBe('finished')
            expect(fin.remaining).toBe('00:00')
        } finally {
            plugin.dispose()
        }
    })

    test('persiste el estado en ajustes', async () => {
        const ctx = memContext()
        const plugin = new TimerPlugin(ctx)
        try {
            await plugin.getActionHandlers().get('start')!({ mode: 'custom', minutes: 5 }, {})
            expect(ctx.store.get('state')).toMatch(/"status":"running"/)
        } finally {
            plugin.dispose()
        }
    })
})

// ---------- clipboard ----------

describe('clipboard', () => {
    test('save/list/paste/history con texto explícito', async () => {
        const plugin = new ClipboardPlugin(memContext())
        const h = plugin.getActionHandlers()
        await expect(h.get('save-slot')!({}, {})).rejects.toThrow(/slot/)
        const saved = await h.get('save-slot')!({ slot: 'firma', text: 'Saludos,\nEquipo' }, {})
        expect(saved).toMatchObject({ slot: 'firma', saved: true, captured: false })
        const list = await h.get('list-slots')!({}, {})
        expect(list.count).toBe(1)
        expect(list.slots[0].preview).toContain('Saludos')
        // paste con stub (no toca el sistema)
        let pasted = ''
        ;(plugin as any).writeSystemClipboard = async (t: string) => { pasted = t }
        const p = await h.get('paste-slot')!({ slot: 'firma' }, {})
        expect(p.pasted).toBe(true)
        expect(pasted).toContain('Saludos')
        await expect(h.get('paste-slot')!({ slot: 'inexistente' }, {})).rejects.toThrow(/vacío/)
        const hist = await h.get('history')!({}, {})
        expect(hist.count).toBeGreaterThanOrEqual(2)
        await expect(h.get('history')!({ limit: 99 }, {})).rejects.toThrow(/limit/)
    })

    test('save-slot captura el portapapeles si no hay texto (stub)', async () => {
        const plugin = new ClipboardPlugin(memContext())
        ;(plugin as any).readSystemClipboard = async () => 'capturado!'
        const out = await plugin.getActionHandlers().get('save-slot')!({ slot: 1 }, {})
        expect(out).toMatchObject({ captured: true, length: 10 })
    })
})

// ---------- multiaction ----------

describe('multiaction', () => {
    function makePlugin(executor?: (action: any, context: any) => Promise<any>) {
        const plugin = new MultiactionPlugin({ log: () => {} })
        if (executor) plugin.setActionExecutor(executor)
        return plugin
    }

    test('dry-run valida sin ejecutar', async () => {
        let called = 0
        const plugin = makePlugin(async () => { called++; return { success: true, result: {} } })
        const out = await plugin.getActionHandlers().get('run-sequence')!({
            actions: [
                { pluginId: 'utility', actionId: 'delay', params: { duration: 5 }, delayMs: 10 },
                { type: 'obs.scene', params: { scene: 'Principal' } },
            ],
            dryRun: true,
        }, {})
        expect(called).toBe(0)
        expect(out.dryRun).toBe(true)
        expect(out.total).toBe(2)
        expect(out.plan[1].type).toBe('obs.scene')
    })

    test('valida pasos y rechaza anidadas', async () => {
        const plugin = makePlugin(async () => ({ success: true, result: {} }))
        const run = plugin.getActionHandlers().get('run-sequence')!
        await expect(run({}, {})).rejects.toThrow(/array/)
        await expect(run({ actions: [] }, {})).rejects.toThrow(/entre 1 y 50/)
        await expect(run({ actions: [{}] }, {})).rejects.toThrow(/pluginId/)
        await expect(run({ actions: [{ pluginId: 'multiaction', actionId: 'run-sequence' }] }, {})).rejects.toThrow(/anidadas/)
        await expect(run({ actions: [{ type: 'utility.macro' }] }, {})).rejects.toThrow(/anidadas/)
        await expect(run({ actions: [{ pluginId: 'a', actionId: 'b', delayMs: 99999 }] }, {})).rejects.toThrow(/delayMs/)
    })

    test('ejecuta en orden con delayMs y continueOnError', async () => {
        const order: string[] = []
        const plugin = makePlugin(async (action) => {
            order.push(action.type)
            if (action.type === 'b.fail') return { success: false, error: 'boom' }
            return { success: true, result: { ok: action.type } }
        })
        const run = plugin.getActionHandlers().get('run-sequence')!
        const out = await run({
            actions: [
                { pluginId: 'a', actionId: 'ok', delayMs: 5 },
                { pluginId: 'b', actionId: 'fail', continueOnError: true },
                { pluginId: 'c', actionId: 'ok' },
            ],
        }, { buttonId: 'b1' })
        expect(order).toEqual(['a.ok', 'b.fail', 'c.ok'])
        expect(out.completed).toBe(2)
        expect(out.failedStep).toBe(1)
    })

    test('stopOnError aborta salvo continueOnError', async () => {
        const order: string[] = []
        const plugin = makePlugin(async (action) => {
            order.push(action.type)
            if (action.type === 'b.fail') throw new Error('boom')
            return { success: true, result: {} }
        })
        const out = await plugin.getActionHandlers().get('run-sequence')!({
            actions: [{ pluginId: 'a', actionId: 'ok' }, { pluginId: 'b', actionId: 'fail' }, { pluginId: 'c', actionId: 'ok' }],
        }, {})
        expect(order).toEqual(['a.ok', 'b.fail'])
        expect(out.completed).toBe(1)
    })

    test('sin executor falla claro', async () => {
        const plugin = makePlugin()
        await expect(
            plugin.getActionHandlers().get('run-sequence')!({ actions: [{ pluginId: 'a', actionId: 'b' }] }, {})
        ).rejects.toThrow(/executor/)
    })
})

// ---------- profile-auto ----------

describe('profile-auto', () => {
    test('add/list/remove + validación', async () => {
        const plugin = new ProfileAutoPlugin(memContext())
        const h = plugin.getActionHandlers()
        await expect(h.get('add-rule')!({}, {})).rejects.toThrow(/app/)
        await expect(h.get('add-rule')!({ app: 'obs' }, {})).rejects.toThrow(/profileId/)
        await expect(h.get('add-rule')!({ app: 'obs', profileId: 'p1', op: 'x' }, {})).rejects.toThrow(/op/)
        await expect(h.get('add-rule')!({ app: '([', profileId: 'p1', op: 'regex' }, {})).rejects.toThrow(/regular/)
        const added = await h.get('add-rule')!({ app: 'obs', profileId: 'p1' }, {})
        expect(added).toMatchObject({ added: true, total: 1 })
        await h.get('add-rule')!({ app: 'OBS', profileId: 'p2', op: 'exact' }, {})
        const list = await h.get('list-rules')!({}, {})
        expect(list.count).toBe(1) // upsert por app
        expect(list.rules[0]).toMatchObject({ app: 'OBS', profileId: 'p2', op: 'exact' })
        await expect(h.get('remove-rule')!({ app: 'chrome' }, {})).rejects.toThrow(/Ninguna regla|No hay/)
        const removed = await h.get('remove-rule')!({ app: 'obs' }, {})
        expect(removed.removed).toBe(true)
    })

    test('switch-profile devuelve navigate_to_profile; restore sin historial falla', async () => {
        const plugin = new ProfileAutoPlugin(memContext())
        const h = plugin.getActionHandlers()
        await expect(h.get('switch-profile')!({}, {})).rejects.toThrow(/profileId/)
        const sw = await h.get('switch-profile')!({ profileId: 'p9' }, {})
        expect(sw).toMatchObject({ action: 'navigate_to_profile', profileId: 'p9' })
        await expect(h.get('restore')!({}, {})).rejects.toThrow(/anterior/)
        const st = await h.get('status')!({}, {})
        expect(st).toMatchObject({ enabled: false, rules: 0 })
        await expect(h.get('set-enabled')!({}, {})).rejects.toThrow(/enabled/)
    })
})
