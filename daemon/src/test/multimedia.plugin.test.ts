import { describe, it, expect, afterEach } from 'bun:test'
import { MultimediaPlugin } from '../plugins/multimedia.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new MultimediaPlugin({
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

describe('MultimediaPlugin', () => {
    it('expone un manifest válido con la acción multimedia', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('multimedia')
        expect(manifest.version).toBe('1.0.0')
        expect(manifest.actions).toHaveLength(1)
        expect(manifest.actions[0].id).toBe('multimedia')
        expect(manifest.actions[0].schema.required).toEqual(['action'])
        expect(manifest.actions[0].schema.properties.action.enum).toContain('playpause')
        expect(manifest.actions[0].schema.properties.action.enum).toContain('mute')
        expect(JSON.parse(JSON.stringify(manifest.actions[0].schema))).toEqual(manifest.actions[0].schema)
    })

    it('registra el handler multimedia', () => {
        const { plugin } = makePlugin()
        expect(plugin.getActionHandlers().has('multimedia')).toBe(true)
    })

    it('ejecuta playpause en la plataforma actual (spawn mockeado)', async () => {
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawnOk(seen)
        const res = await plugin.getActionHandlers().get('multimedia')!({ action: 'playpause' }, {})
        expect(res.executed).toBe(true)
        expect(res.platform).toBeString()
        expect(seen.length).toBe(1)
    })

    it('acepta mayúsculas (normaliza a lowercase)', async () => {
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawnOk(seen)
        const res = await plugin.getActionHandlers().get('multimedia')!({ action: 'NEXT' }, {})
        expect(res.executed).toBe(true)
    })

    it('acción desconocida lanza error', async () => {
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawnOk(seen)
        await expect(
            plugin.getActionHandlers().get('multimedia')!({ action: 'hacer-cafe' }, {})
        ).rejects.toThrow(/Unknown multimedia action/)
    })

    it('dispose no falla', () => {
        const { plugin } = makePlugin()
        expect(() => plugin.dispose()).not.toThrow()
    })
})
