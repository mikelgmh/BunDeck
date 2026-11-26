/**
 * soundboard.plugin.test.ts — tests del plugin nativo Soundboard.
 * Sin reproducir nada real: manifest, validación y listado en carpeta temporal.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'
import { SoundboardPlugin } from '../plugins/soundboard.plugin'

const noopCtx = { log: (_l: string, _m: string, _meta?: any) => {} }
const plugin = new SoundboardPlugin(noopCtx as any)

const TMP_DIR = join(tmpdir(), `libredeck-test-sounds-${process.pid}`)

afterAll(async () => {
    await rm(TMP_DIR, { recursive: true, force: true })
})

describe('SoundboardPlugin manifest', () => {
    it('expone un manifest válido en español', () => {
        const manifest = plugin.getManifest()
        expect(manifest.id).toBe('soundboard')
        expect(manifest.version).toBe('1.0.1')
        const ids = manifest.actions.map((a: any) => a.id).sort()
        expect(ids).toEqual(['list-sounds', 'play', 'set-output', 'stop'])
    })
})

describe('SoundboardPlugin validación', () => {
    it('play exige file', async () => {
        const handler = plugin.getActionHandlers().get('play')!
        await expect(handler({ soundsDir: TMP_DIR }, {})).rejects.toThrow(/file/)
    })

    it('play con archivo inexistente lo dice claro', async () => {
        const handler = plugin.getActionHandlers().get('play')!
        await expect(handler({ soundsDir: TMP_DIR, file: 'noexiste.wav' }, {})).rejects.toThrow(/No se encontró/)
    })

    it('stop sin reproducción no falla', async () => {
        const handler = plugin.getActionHandlers().get('stop')!
        const res = await handler({}, {})
        expect(res.action).toBe('stop')
        expect(res.stopped).toBe(false)
    })

    it('list-sounds crea la carpeta y lista vacío con aviso', async () => {
        const handler = plugin.getActionHandlers().get('list-sounds')!
        const res = await handler({ soundsDir: TMP_DIR }, {})
        expect(res.action).toBe('list-sounds')
        expect(res.soundsDir).toBe(TMP_DIR)
        expect(res.count).toBe(0)
        expect(res.note).toMatch(/vacía/)
    })
})
