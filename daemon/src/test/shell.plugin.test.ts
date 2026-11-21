import { describe, it, expect, afterEach } from 'bun:test'
import { ShellPlugin } from '../plugins/shell.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new ShellPlugin({
        log: (level: string, message: string, meta?: any) => {
            logs.push({ level, message, meta })
        }
    })
    return { plugin, logs }
}

const realSpawn = (Bun as any).spawn

function streamOf(text: string): any {
    return new Response(text).body
}

function stubSpawn(opts: { stdout?: string; stderr?: string; exitCode?: number; fail?: unknown } = {}) {
    const seen: Array<{ cmd: string[]; cwd?: string }> = []
    ;(Bun as any).spawn = (spawnOpts: any) => {
        seen.push({ cmd: spawnOpts?.cmd, cwd: spawnOpts?.cwd })
        if (opts.fail) throw opts.fail
        return {
            stdout: streamOf(opts.stdout ?? 'hello-out'),
            stderr: streamOf(opts.stderr ?? ''),
            exited: Promise.resolve(opts.exitCode ?? 0),
            get exitCode() { return opts.exitCode ?? 0 },
        }
    }
    return seen
}

afterEach(() => {
    ;(Bun as any).spawn = realSpawn
})

describe('ShellPlugin', () => {
    it('expone un manifest válido con la acción shell', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('shell')
        expect(manifest.name).toBe('Shell Commands')
        expect(manifest.version).toBe('1.0.0')
        expect(manifest.author).toBe('LibreDeck')
        expect(manifest.actions).toHaveLength(1)
        expect(manifest.actions[0].id).toBe('shell')
        expect(manifest.actions[0].schema.type).toBe('object')
        expect(manifest.actions[0].schema.required).toEqual(['command'])
        expect(JSON.parse(JSON.stringify(manifest.actions[0].schema))).toEqual(manifest.actions[0].schema)
    })

    it('registra el handler shell', () => {
        const { plugin } = makePlugin()
        expect(plugin.getActionHandlers().has('shell')).toBe(true)
    })

    it('ejecuta el comando y devuelve stdout/stderr/exitCode', async () => {
        const { plugin } = makePlugin()
        const seen = stubSpawn({ stdout: 'out-1', stderr: '', exitCode: 0 })
        const res = await plugin.getActionHandlers().get('shell')!({ command: 'echo', args: ['hi'] }, {})
        expect(res).toMatchObject({ stdout: 'out-1', exitCode: 0 })
        expect(seen).toHaveLength(1)
        expect(seen[0].cmd).toEqual(['echo', 'hi'])
    })

    it('propaga args y cwd', async () => {
        const { plugin } = makePlugin()
        const seen = stubSpawn({ stdout: '', exitCode: 0 })
        await plugin.getActionHandlers().get('shell')!({ command: 'ls', args: ['-la'], cwd: '/tmp' }, {})
        expect(seen[0].cmd).toEqual(['ls', '-la'])
        expect(seen[0].cwd).toBe('/tmp')
    })

    it('exige command', async () => {
        const { plugin } = makePlugin()
        stubSpawn()
        await expect(plugin.getActionHandlers().get('shell')!({}, {})).rejects.toThrow(/command/i)
    })

    it('falla con mensaje legible si el spawn lanza', async () => {
        const { plugin } = makePlugin()
        stubSpawn({ fail: new Error('no such binary') })
        await expect(plugin.getActionHandlers().get('shell')!({ command: 'nope' }, {})).rejects.toThrow(/Shell execution failed/)
    })

    it('dispose no falla', () => {
        const { plugin } = makePlugin()
        expect(() => plugin.dispose()).not.toThrow()
    })
})
