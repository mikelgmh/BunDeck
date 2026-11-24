import { describe, it, expect } from 'vitest'
import {
  safeProfileFilename,
  isProfileBackup,
  cloneBackupAsCopy,
  type ProfileBackupObject,
} from '../composables/useProfileBackup'

const fixture = (): ProfileBackupObject => ({
  format: 'libredeck-backup',
  version: 1,
  data: {
    profiles: [{ id: 'prof-1', name: 'Gaming' }],
    pages: [
      { id: 'page-a', profile_id: 'prof-1', name: 'A' },
      { id: 'page-b', profile_id: 'prof-1', name: 'B' },
    ],
    buttons: [
      {
        id: 'btn-1',
        page_id: 'page-a',
        position: 0,
        data: {
          label: 'salto',
          actions: [{ id: 'x', type: 'page.page', parameters: { pageId: 'page-b' } }],
          rules: [{ id: 'r', then: [{ type: 'page.page', parameters: { pageId: 'page-b' } }], else: [] }],
        },
      },
    ],
  },
})

describe('useProfileBackup', () => {
  it('safeProfileFilename normaliza para descarga', () => {
    expect(safeProfileFilename('Gaming 🎮 2024')).toBe('Gaming-2024')
    expect(safeProfileFilename('---')).toBe('perfil')
  })

  it('isProfileBackup rechaza formas inválidas', () => {
    expect(isProfileBackup(null)).toBe(false)
    expect(isProfileBackup({ format: 'libredeck-backup', version: 1, data: {} })).toBe(false)
    expect(isProfileBackup(fixture())).toBe(true)
  })

  it('cloneBackupAsCopy reasigna ids y reescribe pageId internos', () => {
    const copy = cloneBackupAsCopy(fixture(), { newName: 'Gaming 2' })
    expect(copy.data.profiles).toHaveLength(1)
    expect(copy.data.profiles[0].id).not.toBe('prof-1')
    expect(copy.data.profiles[0].name).toBe('Gaming 2')

    const pages = copy.data.pages!
    expect(pages).toHaveLength(2)
    // Todas las páginas cuelgan del nuevo perfil y tienen ids nuevos.
    const newProfileId = copy.data.profiles[0].id
    for (const pg of pages) {
      expect(pg.profile_id).toBe(newProfileId)
      expect(['page-a', 'page-b']).not.toContain(pg.id)
    }

    const btn = copy.data.buttons![0] as any
    expect(btn.id).not.toBe('btn-1')
    // page_id apunta a una página del clon, no a 'page-a'.
    expect(pages.map((p) => p.id)).toContain(btn.page_id)
    expect(btn.page_id).not.toBe('page-a')
    // Referencias hacia adelante reescritas al id nuevo de B.
    const idB = pages.find((p) => p.name === 'B')!.id
    expect(btn.data.actions[0].parameters.pageId).toBe(idB)
    expect(btn.data.rules[0].then[0].parameters.pageId).toBe(idB)
  })
})
