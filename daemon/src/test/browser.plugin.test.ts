import { describe, it, expect, afterEach } from 'bun:test'
import { BrowserPlugin } from '../plugins/browser.plugin'

function makePlugin() {
    const logs: Array<{ level: string; message: string; meta?: any }> = []
    const plugin = new BrowserPlugin({
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

describe('BrowserPlugin', () => {
    it('expone un manifest válido con la acción open-url', () => {
        const { plugin } = makePlugin()
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('browser')
        expect(manifest.version).toBe('1.0.0')
        expect(manifest.actions).toHaveLength(1)
        expect(manifest.actions[0].id).toBe('open-url')
        expect(manifest.actions[0].schema.required).toEqual(['url'])
        expect(manifest.actions[0].schema.properties.url.format).toBe('uri')
        expect(JSON.parse(JSON.stringify(manifest.actions[0].schema))).toEqual(manifest.actions[0].schema)
    })

    it('registra el handler open-url', () => {
        const { plugin } = makePlugin()
        expect(plugin.getActionHandlers().has('open-url')).toBe(true)
    })

    it('abre la URL en el navegador del SO (spawn mockeado)', async () => {
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawnOk(seen)
        const res = await plugin.getActionHandlers().get('open-url')!({ url: 'https://example.com' }, {})
        expect(res).toMatchObject({ url: 'https://example.com', opened: true })
        expect(res.platform).toBe(process.platform)
        expect(seen).toHaveLength(1)
        expect(seen[0].cmd.join(' ')).toContain('https://example.com')
    })

    it('en win32 usa cmd /c start', async () => {
        if (process.platform !== 'win32') return
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawnOk(seen)
        await plugin.getActionHandlers().get('open-url')!({ url: 'https://example.com' }, {})
        expect(seen[0].cmd[0]).toBe('cmd.exe')
    })

    it('exige url', async () => {
        const { plugin } = makePlugin()
        const seen: Array<{ cmd: string[] }> = []
        stubSpawnOk(seen)
        await expect(plugin.getActionHandlers().get('open-url')!({}, {})).rejects.toThrow(/URL is required/)
        expect(seen).toHaveLength(0)
    })

    it('dispose no falla', () => {
        const { plugin } = makePlugin()
        expect(() => plugin.dispose()).not.toThrow()
    })
})
