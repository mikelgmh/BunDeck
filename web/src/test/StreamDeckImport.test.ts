import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchDetectedProfiles,
  importDetectedProfiles,
  importStreamDeckFile,
  isStreamDeckProfileFile,
  summarizeImportPlan,
} from '../composables/useStreamDeckImport'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useStreamDeckImport', () => {
  it('isStreamDeckProfileFile acepta .streamDeckProfile y .zip', () => {
    expect(isStreamDeckProfileFile('mi-perfil.streamDeckProfile')).toBe(true)
    expect(isStreamDeckProfileFile('MI-PERFIL.STREAMDECKPROFILE')).toBe(true)
    expect(isStreamDeckProfileFile('backup.zip')).toBe(true)
    expect(isStreamDeckProfileFile('perfil.json')).toBe(false)
    expect(isStreamDeckProfileFile('')).toBe(false)
  })

  it('summarizeImportPlan resume el plan por cubos', () => {
    expect(
      summarizeImportPlan({ counts: { native: 3, bridge: 1, placeholder: 2, buttons: 6 }, warnings: ['w'] }),
    ).toEqual({ total: 6, native: 3, bridge: 1, pending: 2, warnings: 1 })
    expect(summarizeImportPlan({ counts: undefined as any, warnings: [] }).total).toBe(0)
  })

  it('fetchDetectedProfiles devuelve la lista del daemon', async () => {
    const profiles = [{ uuid: 'u1', name: 'Principal', deviceType: 0, source: 'profilesv2', path: '/x', updatedAt: 1 }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ profiles }) }))
    expect(await fetchDetectedProfiles('http://x/api/v1')).toEqual(profiles)
  })

  it('fetchDetectedProfiles lanza con el error del daemon', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }))
    await expect(fetchDetectedProfiles('http://x/api/v1')).rejects.toThrow('boom')
  })

  it('importDetectedProfiles importa uuid por uuid', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: any) => {
        calls.push(JSON.parse(init.body).uuid)
        return { ok: true, json: async () => ({ profileName: 'P (importado)', dryRun: false }) }
      }),
    )
    await importDetectedProfiles('http://x/api/v1', ['a', 'b'])
    expect(calls).toEqual(['a', 'b'])
  })

  it('importStreamDeckFile rechaza lo que no es perfil', async () => {
    const bad = new File(['x'], 'perfil.json', { type: 'application/json' })
    await expect(importStreamDeckFile('http://x/api/v1', bad)).rejects.toThrow('invalid-file')
  })

  it('importStreamDeckFile sube el zip como multipart', async () => {
    let seenForm = false
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: any) => {
        seenForm = init.body instanceof FormData
        return { ok: true, json: async () => ({ profileName: 'P (importado)' }) }
      }),
    )
    const file = new File(['x'], 'perfil.streamDeckProfile')
    const r = await importStreamDeckFile('http://x/api/v1', file)
    expect(seenForm).toBe(true)
    expect(r.profileName).toBe('P (importado)')
  })
})
