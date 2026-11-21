import { describe, it, expect, afterEach } from 'bun:test'
import { OpenAppPlugin } from '../plugins/open-app.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new OpenAppPlugin({
        log: (level: string, message: string, meta?: any) => {
            logs.push({ level, message, meta })
        }
    })
    return { plugin, logs }
}

const realSpawn = (Bun as any).spawn

function stubSpawn(seen: Array<{ cmd: string[] }>, stdout = 'ok', exitCode = 0) {
    ;(Bun as any).spawn = (opts: any) => {
        seen.push({ cmd: opts?.cmd })
        return {
            stdout: new Response(stdout).body,
            stderr: new Response('').body,
            exited: Promise.resolve(exitCode),
            get exitCode() { return exitCode },
        }
    }
}

afterEach(() => {
    ;(Bun as any).spawn = realSpawn
})

describe('OpenAppPlugin', () => {
    it('expone un manifest válido con la acción open-app', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('open-app')
        expect(manifest.version).toBe('1.0.0')
        expect(manifest.actions).toHaveLength(1)
        expect(manifest.actions[0].id).toBe('open-app')
        expect(manifest.actions[0].schema.required).toEqual(['path'])
        expect(manifest.actions[0].schema.properties.path.title).toBeString()
        expect(JSON.parse(JSON.stringify(manifest.actions[0].schema))).toEqual(manifest.actions[0].schema)
    })

    it('registra el handler open-app', () => {
        const { plugin } = makePlugin()
        expect(plugin.getActionHandlers().has('open-app')).toBe(true)
    })

    it('abre la ruta y devuelve stdout/exitCode', async () => {
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawn(seen, 'opened', 0)
        const res = await plugin.getActionHandlers().get('open-app')!({ path: 'C:\\App\\app.exe' }, {})
        expect(res.stdout).toBe('opened')
        expect(res.exitCode).toBe(0)
        expect(seen[0].cmd.join(' ')).toContain('C:\\App\\app.exe')
    })

    it('exige path', async () => {
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawn(seen)
        await expect(plugin.getActionHandlers().get('open-app')!({}, {})).rejects.toThrow(/Path is required/)
        expect(seen).toHaveLength(0)
    })

    it('dispose no falla', () => {
        const { plugin } = makePlugin()
        expect(() => plugin.dispose()).not.toThrow()
    })
})
