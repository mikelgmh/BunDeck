import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import IconPickerDialog from '../components/bundeck/IconPickerDialog.vue'
import StageBoard from '../components/bundeck/StageBoard.vue'
import { assetUrl, isAssetRef, cleanKey, normalizeApiBase } from '../composables/useKeyShare'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({ t: (key: string) => key }),
}))

const realFetch = global.fetch

afterEach(() => {
  global.fetch = realFetch
  vi.restoreAllMocks()
})

function mountDialog(props: any = {}) {
  return mount(IconPickerDialog as any, {
    props: { current: '', currentImage: '', apiBase: 'http://localhost:3001', ...props },
  })
}

describe('assetUrl / isAssetRef', () => {
  it('resuelve /assets contra la API y deja pasar absolutos', () => {
    expect(assetUrl('http://localhost:3001', '/assets/key-1.png')).toBe('http://localhost:3001/assets/key-1.png')
    expect(assetUrl('http://localhost:3001/', '/assets/a.gif')).toBe('http://localhost:3001/assets/a.gif')
    expect(assetUrl('', '/assets/a.png')).toBe('/assets/a.png')
    expect(assetUrl('http://x', 'https://cdn/y.png')).toBe('https://cdn/y.png')
    expect(assetUrl('http://x', '')).toBe('')
  })
  it('normalizeApiBase acepta origen o base con /api/v1', () => {
    expect(normalizeApiBase('http://localhost:3001')).toBe('http://localhost:3001')
    expect(normalizeApiBase('http://localhost:3001/')).toBe('http://localhost:3001')
    expect(normalizeApiBase('http://localhost:3001/api/v1')).toBe('http://localhost:3001')
    expect(normalizeApiBase('http://localhost:3001/api/v1/')).toBe('http://localhost:3001')
    expect(normalizeApiBase('https://relay.example/t/abc123/api/v1')).toBe('https://relay.example/t/abc123')
    expect(assetUrl('http://localhost:3001/api/v1', '/assets/key-1.png')).toBe('http://localhost:3001/assets/key-1.png')
  })
  it('solo acepta ficheros de imagen dentro de /assets', () => {
    expect(isAssetRef('/assets/key-1.png')).toBe(true)
    expect(isAssetRef('/assets/a.GIF')).toBe(true)
    expect(isAssetRef('/assets/../evil.png')).toBe(false)
    expect(isAssetRef('https://evil/x.png')).toBe(false)
    expect(isAssetRef('/assets/x.exe')).toBe(false)
    expect(isAssetRef('')).toBe(false)
    expect(isAssetRef(null)).toBe(false)
  })
  it('cleanKey conserva iconImage válido y limpia el resto', () => {
    const k = cleanKey({ label: 'a', actions: [], iconImage: '/assets/key-1.webp' })
    expect(k.iconImage).toBe('/assets/key-1.webp')
    const bad = cleanKey({ label: 'a', actions: [], iconImage: 'https://evil/x.png' })
    expect(bad.iconImage).toBe('')
  })
})

describe('IconPickerDialog pestaña imagen', () => {
  it('muestra las pestañas Iconos/Imagen y el dropzone', async () => {
    const w = mountDialog()
    expect(w.find('[data-cy="bd-icon-tab-image"]').exists()).toBe(true)
    expect(w.find('[data-cy="bd-image-drop"]').exists()).toBe(false)
    await w.find('[data-cy="bd-icon-tab-image"]').trigger('click')
    expect(w.find('[data-cy="bd-image-drop"]').exists()).toBe(true)
    expect(w.text()).toContain('bd.imageHint')
  })

  it('muestra la imagen actual y permite quitarla', async () => {
    const w = mountDialog({ currentImage: '/assets/key-9.gif' })
    await w.find('[data-cy="bd-icon-tab-image"]').trigger('click')
    const img = w.find('.bd-imgprev')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('http://localhost:3001/assets/key-9.gif')
  })

  it('sube el fichero y emite pick-image', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: '/assets/key-1.png' }),
    })) as any
    const w = mountDialog()
    await w.find('[data-cy="bd-icon-tab-image"]').trigger('click')
    const input = w.find('input[type="file"]')
    const file = new File(['img'], 'foto.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')
    await nextTick()
    await nextTick()
    expect(global.fetch).toHaveBeenCalled()
    const url = (global.fetch as any).mock.calls[0][0]
    expect(url).toBe('http://localhost:3001/api/v1/assets')
    expect(w.emitted('pick-image')).toBeTruthy()
    expect((w.emitted('pick-image') as any)[0][0]).toBe('/assets/key-1.png')
  })

  it('sube contra /api/v1/assets aunque apiBase ya traiga el prefijo (BunDeckApp)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: '/assets/key-2.png' }),
    })) as any
    const w = mountDialog({ apiBase: 'http://localhost:3001/api/v1' })
    await w.find('[data-cy="bd-icon-tab-image"]').trigger('click')
    const input = w.find('input[type="file"]')
    const file = new File(['img'], 'foto.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')
    await nextTick()
    await nextTick()
    const url = (global.fetch as any).mock.calls[0][0]
    expect(url).toBe('http://localhost:3001/api/v1/assets')
    expect((w.emitted('pick-image') as any)[0][0]).toBe('/assets/key-2.png')
  })

  it('muestra error si el daemon rechaza', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'Formato no válido' }),
    })) as any
    const w = mountDialog()
    await w.find('[data-cy="bd-icon-tab-image"]').trigger('click')
    const input = w.find('input[type="file"]')
    const file = new File(['x'], 'a.exe', { type: 'application/octet-stream' })
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')
    await nextTick()
    await nextTick()
    expect(w.find('.bd-err').exists()).toBe(true)
    expect(w.emitted('pick-image')).toBeFalsy()
  })
})

describe('StageBoard imagen de tecla', () => {
  function mountBoard(iconImage: any) {
    const getButton = (position: number) =>
      position === 0 ? ({ id: 'A', position: 0, data: {} } as any) : undefined
    const getButtonData = (position: number) =>
      position === 0
        ? { label: 'Foto', iconImage, textColor: '#fff', actions: [{ type: 'shell.shell' }] }
        : { label: '', actions: [] }
    return mount(StageBoard as any, {
      props: {
        gridCols: 2,
        gridRows: 1,
        selectedButton: 0,
        executingButtons: [],
        buttonConfig: {},
        getButton,
        getButtonData,
        mode: 'edit',
        labelMode: 'a',
        currentPages: [],
        currentPage: null,
        navTrail: [],
        profileName: 'Test',
        busy: false,
        apiBase: 'http://localhost:3001',
      },
      global: { stubs: { ContextMenu: true } },
    })
  }

  it('pinta <img> con URL absoluta y los GIF animan solos', () => {
    const w = mountBoard('/assets/anim.gif')
    const img = w.find('img.bd-kimg')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('http://localhost:3001/assets/anim.gif')
  })

  it('ignora iconImage corrupto o externo', () => {
    for (const bad of ['../../evil.png', 'https://evil/x.png', 123, '']) {
      const w = mountBoard(bad)
      expect(w.find('img.bd-kimg').exists()).toBe(false)
    }
  })
})
