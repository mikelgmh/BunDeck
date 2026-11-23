import { describe, test, expect } from 'bun:test'
import { AudioMixerPlugin } from '../plugins/audio-mixer.plugin'

const ctx = () => ({ log: () => {} }) as any

class FakeMixer extends AudioMixerPlugin {
    constructor(private script: (cmd: string[]) => { stdout: string; stderr: string; exitCode: number }) {
        super(ctx())
    }
    protected async run(cmd: string[]) {
        return this.script(cmd)
    }
}

describe('audio-mixer get-levels', () => {
    test('devuelve forma {master, muted, simulated} sin romper', async () => {
        const plugin = new FakeMixer(() => ({ stdout: '42', stderr: '', exitCode: 0 }))
        const h = plugin.getActionHandlers()
        const out = (await h.get('get-levels')!({}, {})) as any
        expect(out).toHaveProperty('master')
        expect(out).toHaveProperty('muted')
        expect(out).toHaveProperty('simulated')
    })

    test('windows: parsea el entero de winmm (último token)', async () => {
        if (process.platform !== 'win32') return // rama win32 solo en Windows
        const plugin = new FakeMixer((cmd) => {
            expect(cmd[0]).toBe('powershell.exe')
            return { stdout: '73', stderr: '', exitCode: 0 }
        })
        const h = plugin.getActionHandlers()
        const out = (await h.get('get-levels')!({}, {})) as any
        expect(out.master).toBe(73)
        expect(out.simulated).toBe(false)
        expect(out.source).toBe('winmm')
    })

    test('windows: fallo de powershell degrada a simulado', async () => {
        if (process.platform !== 'win32') return
        const plugin = new FakeMixer(() => {
            throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })
        })
        const h = plugin.getActionHandlers()
        const out = (await h.get('get-levels')!({}, {})) as any
        expect(out.simulated).toBe(true)
        expect(out.master).toBe(50)
    })
})
