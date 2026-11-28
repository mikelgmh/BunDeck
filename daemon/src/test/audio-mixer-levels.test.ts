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

describe('audio-mixer get-levels', () => {    test('devuelve forma {master, muted, simulated} sin romper', async () => {
        const plugin = new FakeMixer(() => ({ stdout: '42', stderr: '', exitCode: 0 }))
        const h = plugin.getActionHandlers()
        const out = (await h.get('get-levels')!({}, {})) as any
        expect(out).toHaveProperty('master')
        expect(out).toHaveProperty('muted')
        expect(out).toHaveProperty('simulated')
    })

    test('windows: parsea el volumen y el mute de Core Audio', async () => {
        if (process.platform !== 'win32') return // rama win32 solo en Windows
        const plugin = new FakeMixer((cmd) => {
            expect(cmd[0]).toBe('powershell.exe')
            return { stdout: '73\nmute:0', stderr: '', exitCode: 0 }
        })
        const h = plugin.getActionHandlers()
        const out = (await h.get('get-levels')!({}, {})) as any
        expect(out.master).toBe(73)
        expect(out.muted).toBe(false)
        expect(out.simulated).toBe(false)
        expect(out.source).toBe('coreaudio')
    })

    test('windows: lee mute:1 como silenciado', async () => {
        if (process.platform !== 'win32') return
        const plugin = new FakeMixer(() => ({ stdout: '30\nmute:1', stderr: '', exitCode: 0 }))
        const h = plugin.getActionHandlers()
        const out = (await h.get('get-levels')!({}, {})) as any
        expect(out.master).toBe(30)
        expect(out.muted).toBe(true)
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

    test('volume-control: declara superficie e informa niveles al pulsar', async () => {
        const plugin = new FakeMixer(() => ({ stdout: '61', stderr: '', exitCode: 0 }))
        const manifest = plugin.getManifest()
        const def = (manifest.actions as any[]).find((a) => a.id === 'volume-control')
        expect(def).toMatchObject({ surface: 'control', component: 'volume-range' })
        expect(def.freeModeOnly).toBeUndefined()
        const h = plugin.getActionHandlers()
        expect(h.has('volume-control')).toBe(true)
        const out = (await h.get('volume-control')!({}, {})) as any
        expect(out.control).toBe('volume-range')
        expect(out).toHaveProperty('master')
    })
})
