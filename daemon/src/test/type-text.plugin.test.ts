import { describe, it, expect, afterEach } from 'bun:test'
import { TypeTextPlugin } from '../plugins/type-text.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new TypeTextPlugin({
        log: (level: string, message: string, meta?: any) => {
            logs.push({ level, message, meta })
        }
    })
    return { plugin, logs }
}

const realSpawn = (Bun as any).spawn

function stubSpawnOk(seen: Array<{ cmd: string[] }>, exitCode = 0, stderr = '') {
    ;(Bun as any).spawn = (opts: any) => {
        seen.push({ cmd: opts?.cmd })
        return {
            stdout: new Response('').body,
            stderr: new Response(stderr).body,
            exited: Promise.resolve(exitCode),
            get exitCode() { return exitCode },
        }
    }
}

afterEach(() => {
    ;(Bun as any).spawn = realSpawn
})

describe('TypeTextPlugin', () => {
    it('expone un manifest válido con la acción type', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('type-text')
        expect(manifest.version).toBe('1.0.0')
        expect(manifest.actions).toHaveLength(1)
        expect(manifest.actions[0].id).toBe('type')
        expect(manifest.actions[0].schema.required).toEqual(['text'])
        expect(manifest.actions[0].schema.properties.text.title).toBeString()
        expect(JSON.parse(JSON.stringify(manifest.actions[0].schema))).toEqual(manifest.actions[0].schema)
    })

    it('registra el handler type', () => {
        const { plugin } = makePlugin()
        expect(plugin.getActionHandlers().has('type')).toBe(true)
    })

    it('exige text', async () => {
        const { plugin } = makePlugin()
        await expect(plugin.getActionHandlers().get('type')!({}, {})).rejects.toThrow(/Text is required/)
    })

    it('escribe en la plataforma actual (spawn mockeado)', async () => {
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawnOk(seen)
        const res = await plugin.getActionHandlers().get('type')!({ text: 'hola' }, {})
        expect(res.textLength).toBe(4)
        expect(res.simulated).toBe(true)
        expect(res.platform).toBeString()
        expect(seen.length).toBeGreaterThanOrEqual(1)
    })

    it('propaga el fallo del backend nativo', async () => {
        if (process.platform === 'linux') return // linux intenta ydotool como fallback
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawnOk(seen, 1, 'boom')
        await expect(plugin.getActionHandlers().get('type')!({ text: 'hola' }, {})).rejects.toThrow()
    })

    it('dispose no falla', () => {
        const { plugin } = makePlugin()
        expect(() => plugin.dispose()).not.toThrow()
    })
})
