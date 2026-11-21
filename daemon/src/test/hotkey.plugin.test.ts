import { describe, it, expect, afterEach } from 'bun:test'
import { HotkeyPlugin } from '../plugins/hotkey.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new HotkeyPlugin({
        log: (level: string, message: string, meta?: any) => {
            logs.push({ level, message, meta })
        }
    })
    return { plugin, logs }
}

const realSpawn = (Bun as any).spawn

function stubSpawnOk(seen: Array<{ cmd: string[] }>) {
    ;(Bun as any).spawn = (opts: any) => {
        seen.push({ cmd: opts?.cmd })
        return {
            stdout: new Response('').body,
            stderr: new Response('').body,
            exited: Promise.resolve(0),
            get exitCode() { return 0 },
        }
    }
}

afterEach(() => {
    ;(Bun as any).spawn = realSpawn
})

describe('HotkeyPlugin', () => {
    it('expone un manifest válido con la acción hotkey', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('hotkey')
        expect(manifest.version).toBe('1.0.0')
        expect(manifest.actions).toHaveLength(1)
        expect(manifest.actions[0].id).toBe('hotkey')
        expect(manifest.actions[0].schema.required).toEqual(['keys'])
        expect(manifest.actions[0].schema.properties.keys.title).toBeString()
        expect(JSON.parse(JSON.stringify(manifest.actions[0].schema))).toEqual(manifest.actions[0].schema)
    })

    it('registra el handler hotkey', () => {
        const { plugin } = makePlugin()
        expect(plugin.getActionHandlers().has('hotkey')).toBe(true)
    })

    it('exige keys', async () => {
        const { plugin } = makePlugin()
        await expect(plugin.getActionHandlers().get('hotkey')!({}, {})).rejects.toThrow(/Keys are required/)
    })

    it('ejecuta en la plataforma actual (spawn mockeado)', async () => {
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawnOk(seen)
        const res = await plugin.getActionHandlers().get('hotkey')!({ keys: 'c', modifiers: ['ctrl'] }, {})
        expect(res.keys).toBe('c')
        // En win32 usa powershell; en mac osascript; en linux xdotool/ydotool.
        // Con el mock, al menos uno de los comandos conocidos debe haberse invocado.
        expect(seen.length).toBeGreaterThanOrEqual(1)
        const all = seen.map((s) => s.cmd[0]).join(' ')
        expect(all).toMatch(/powershell|osascript|xdotool|ydotool/)
    })

    it('mac: tecla desconocida lanza error claro', async () => {
        if (process.platform !== 'darwin') return
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawnOk(seen)
        await expect(
            plugin.getActionHandlers().get('hotkey')!({ keys: 'tecla-que-no-existe-xyz', modifiers: [] }, {})
        ).rejects.toThrow(/Unknown key/)
    })

    it('dispose no falla', () => {
        const { plugin } = makePlugin()
        expect(() => plugin.dispose()).not.toThrow()
    })
})
