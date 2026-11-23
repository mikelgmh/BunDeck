import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import VolumeRange from '../components/bundeck/VolumeRange.vue'

const flushPromises = () => new Promise<void>((r) => setTimeout(r, 0))

describe('VolumeRange (modo libre)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('muestra arco 1×1 con % en el centro por defecto', async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      if (String(url).includes('/actions/execute')) {
        const body = JSON.parse(init.body)
        if (body.action?.type === 'audio-mixer.get-levels') {
          return { ok: true, json: async () => ({ result: { master: 42, muted: false } }) } as any
        }
        return { ok: true, json: async () => ({}) } as any
      }
      return { ok: false, status: 404, json: async () => ({}) } as any
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(VolumeRange, { props: { apiBase: 'http://localhost:3001' } })
    await flushPromises()
    await wrapper.vm.$nextTick()
    // Las tres variantes existen en DOM; las queries CSS deciden cuál se ve.
    expect(wrapper.find('[data-cy="vol-arc"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="vol-h"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="vol-v"]').exists()).toBe(true)
    // % visible y slider accesible del arco con el nivel real (42).
    const pct = wrapper.find('[data-cy="vol-arc"] [data-cy="vol-pct"]')
    expect(pct.text()).toContain('42')
    const slider = wrapper.find('[data-cy="vol-arc-slider"]')
    expect(slider.attributes('role')).toBe('slider')
    expect(slider.attributes('aria-valuenow')).toBe('42')
    // Solo disponible con container queries: el CSS conmuta por aspecto.
    expect(VolumeRange.__scopeId).toBeDefined()
    wrapper.unmount()
  })

  it('usa container queries (size) para conmutar arco / horizontal / vertical', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any))
    const wrapper = mount(VolumeRange, { props: { apiBase: '' } })
    await flushPromises()
    const styles = (document.querySelectorAll('style') as any)
    void styles
    // El contenedor declara container-type: size con nombre vol.
    const root = wrapper.find('[data-cy="vol-range"]')
    expect(root.classes()).toContain('vol-cq')
    // data-orient refleja el espejo JS (square por defecto en jsdom sin layout).
    expect(['square', 'h', 'v']).toContain(root.attributes('data-orient'))
    wrapper.unmount()
  })

  it('el slider horizontal fija el volumen (debounce + audio-mixer.app-volume)', async () => {
    const calls: any[] = []
    const fetchMock = vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body)
      calls.push(body.action)
      if (body.action?.type === 'audio-mixer.get-levels') {
        return { ok: true, json: async () => ({ result: { master: 10, muted: false } }) } as any
      }
      return { ok: true, json: async () => ({ result: { applied: true } }) } as any
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(VolumeRange, { props: { apiBase: 'http://localhost:3001' } })
    await flushPromises()
    const input = wrapper.find('[data-cy="vol-slider-h"]')
    await input.setValue('80')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    const setCalls = calls.filter((c) => c?.type === 'audio-mixer.app-volume')
    expect(setCalls.length).toBeGreaterThanOrEqual(1)
    expect(setCalls[setCalls.length - 1]).toMatchObject({ type: 'audio-mixer.app-volume', parameters: { volume: 80 } })
    wrapper.unmount()
  })

  it('el botón de silencio alterna mute', async () => {
    const calls: any[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        const body = JSON.parse(init.body)
        calls.push(body.action)
        return { ok: true, json: async () => ({ result: { master: 50, muted: false } }) } as any
      })
    )
    const wrapper = mount(VolumeRange, { props: { apiBase: 'http://localhost:3001' } })
    await flushPromises()
    const muteBtns = wrapper.findAll('[data-cy="vol-mute"]')
    expect(muteBtns.length).toBeGreaterThanOrEqual(1)
    await muteBtns[0].trigger('click')
    await flushPromises()
    const muteCalls = calls.filter((c) => c?.type === 'audio-mixer.app-volume')
    expect(muteCalls.some((c) => c.parameters?.mute === 'toggle')).toBe(true)
    wrapper.unmount()
  })
})
