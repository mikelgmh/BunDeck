import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import StreamStudioControl from '../components/bundeck/widgets/StreamStudioControl.vue'
import CreativeToolsControl from '../components/bundeck/widgets/CreativeToolsControl.vue'
import { useI18nStore } from '../composables/useI18n'

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }))
vi.mock('../composables/useWidgetAction', () => ({ executeWidgetAction: executeMock }))

const { setLocale } = useI18nStore()

afterEach(() => {
  executeMock.mockReset()
  setLocale('es')
})

describe('StreamStudioControl', () => {
  it('polls OBS state on mount and executes its corresponding stream action', async () => {
    executeMock
      .mockResolvedValueOnce({ success: true, result: { streaming: false, recording: false, options: [{ value: 'Main', label: 'Main' }] } })
      .mockResolvedValueOnce({ success: true, result: { options: [{ value: 'Main', label: 'Main' }], currentProgramSceneName: 'Main' } })
      .mockResolvedValueOnce({ success: true, result: { streaming: false, recording: false, options: [{ value: 'Main', label: 'Main' }] } })
      .mockResolvedValueOnce({ success: true, result: { options: [{ value: 'Main', label: 'Main' }], currentProgramSceneName: 'Main' } })
      .mockResolvedValueOnce({ success: true, result: { requested: 'start' } })
    const wrapper = mount(StreamStudioControl, {
      props: { action: { type: 'obs.status', parameters: { host: 'localhost', password: 'secret' } }, apiBase: '' },
    })
    await flushPromises()
    // Poll silencioso al montar: status + scene-list.
    expect(executeMock).toHaveBeenCalledWith('', 'obs.status', { host: 'localhost', password: 'secret' })
    expect(executeMock).toHaveBeenCalledWith('', 'obs.scene-list', { host: 'localhost', password: 'secret' })
    await wrapper.get('.stream-icon-btn').trigger('click')
    await flushPromises()
    expect(executeMock).toHaveBeenCalledTimes(4)
    await wrapper.get('.live-btn').trigger('click')
    expect(executeMock).toHaveBeenLastCalledWith('', 'obs.stream', { host: 'localhost', password: 'secret', action: 'start' })
    wrapper.unmount()
  })

  it('shows API errors accessibly and keeps controls disabled in readonly mode', async () => {
    executeMock.mockRejectedValue(new Error('OBS connection failed'))
    const wrapper = mount(StreamStudioControl, {
      props: { action: { type: 'obs.status', parameters: {} }, apiBase: '', readonly: true },
    })
    // El poll de solo-lectura también falla: el error queda en role="alert".
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('OBS connection failed')
    expect(wrapper.get('.live-btn').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('asks before ending a YouTube broadcast and runs no write action until confirmed', async () => {
    executeMock.mockResolvedValueOnce({ success: true, result: { viewerCount: 12, live: true } })
      .mockResolvedValueOnce({ success: true, result: { status: 'complete' } })
    const wrapper = mount(StreamStudioControl, {
      props: { action: { type: 'youtube.viewer-count', parameters: { videoId: 'video' } }, apiBase: '' },
    })
    await flushPromises()
    expect(executeMock).toHaveBeenCalledTimes(1)
    expect(executeMock).toHaveBeenLastCalledWith('', 'youtube.viewer-count', { videoId: 'video' })
    await wrapper.get('[aria-label="ID de emisión YouTube"]').setValue('broadcast')
    await wrapper.get('.danger-btn').trigger('click')
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Terminar esta emisión de YouTube')
    expect(executeMock).toHaveBeenCalledTimes(1)
    await wrapper.get('[role="alertdialog"] .danger-btn').trigger('click')
    expect(executeMock).toHaveBeenLastCalledWith('', 'youtube.stop-broadcast', { videoId: 'video', broadcastId: 'broadcast' })
    wrapper.unmount()
  })

  it('uses English copy when the app locale starts with en', async () => {
    setLocale('en-US')
    executeMock.mockResolvedValueOnce({ success: true, result: { viewerCount: 4, live: true } })
    const wrapper = mount(StreamStudioControl, {
      props: { action: { type: 'twitch.viewer-count', parameters: {} }, apiBase: '' },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('viewers')
    expect(wrapper.text()).toContain('Current audience')
    wrapper.unmount()
  })

  it('shows NeedsConfig on Twitch without identity params, and hides it once identified', async () => {
    executeMock.mockResolvedValue({ success: true, result: { viewerCount: 1, live: false } })
    const bare = mount(StreamStudioControl, {
      props: { action: { type: 'twitch.viewer-count', parameters: {} }, apiBase: '' },
    })
    await flushPromises()
    // Sin credenciales ni carga con éxito: badge visible.
    executeMock.mockRejectedValueOnce(new Error('Twitch rechazó la petición (401)'))
    const failing = mount(StreamStudioControl, {
      props: { action: { type: 'twitch.viewer-count', parameters: {} }, apiBase: '' },
    })
    await flushPromises()
    expect(failing.find('[data-cy="bd-needs-config"]').exists()).toBe(true)
    failing.unmount()
    // Con broadcaster en parámetros: configurado aunque falle la red.
    const identified = mount(StreamStudioControl, {
      props: { action: { type: 'twitch.viewer-count', parameters: { broadcaster: 'someone' } }, apiBase: '' },
    })
    await flushPromises()
    expect(identified.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
    identified.unmount()
    bare.unmount()
  })

  it('rotates OBS stream/recording states through the carousel contract', async () => {
    executeMock
      .mockResolvedValueOnce({ success: true, result: { streaming: true, recording: false, options: [] } })
      .mockResolvedValueOnce({ success: true, result: { options: [], currentProgramSceneName: null } })
    const wrapper = mount(StreamStudioControl, {
      props: { action: { type: 'obs.status', parameters: { carouselMs: 0 } }, apiBase: '' },
    })
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-obs-carousel"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-obs-carousel"] [data-cy="bd-carousel-dot"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('EN DIRECTO')
    wrapper.unmount()
  })

  it('always has OBS configured (localhost defaults) and never shows NeedsConfig', async () => {
    executeMock.mockRejectedValue(new Error('unreachable'))
    const wrapper = mount(StreamStudioControl, {
      props: { action: { type: 'obs.status', parameters: {} }, apiBase: '' },
    })
    await flushPromises()
    expect(wrapper.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('unreachable')
    wrapper.unmount()
  })
})

describe('CreativeToolsControl', () => {
  it('routes editing controls to the matching Premiere action with operation parameters', async () => {
    executeMock.mockResolvedValueOnce({ success: true, result: { action: 'transport' } })
    const wrapper = mount(CreativeToolsControl, {
      props: { action: { type: 'premiere.transport', parameters: { operation: 'forward' } }, apiBase: '' },
    })
    expect(executeMock).not.toHaveBeenCalled()
    await wrapper.get('[aria-label="Reproducir o pausar"]').trigger('click')
    expect(executeMock).toHaveBeenCalledWith('', 'premiere.transport', { operation: 'play-pause' })
    wrapper.unmount()
  })

  it('renders disabled creative controls in readonly mode', async () => {
    const wrapper = mount(CreativeToolsControl, {
      props: { action: { type: 'photoshop.brush-size', parameters: {} }, apiBase: '', readonly: true },
    })
    const increase = wrapper.get('[aria-label="Aumentar tamaño del pincel"]')
    expect(increase.attributes('disabled')).toBeDefined()
    await increase.trigger('click')
    expect(executeMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('uses English controls when the app locale starts with en', async () => {
    setLocale('en')
    const wrapper = mount(CreativeToolsControl, {
      props: { action: { type: 'premiere.transport', parameters: {} }, apiBase: '' },
    })
    expect(wrapper.get('[aria-label="Play or pause"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('MARKS & MARKERS')
    wrapper.unmount()
  })

  it('renders four essential buttons per editor for 1x1 keys without config badges', async () => {
    for (const type of ['premiere.transport', 'davinci.transport', 'photoshop.brush-size', 'blender.render'] as const) {
      const wrapper = mount(CreativeToolsControl, {
        props: { action: { type, parameters: {} }, apiBase: '' },
      })
      expect(wrapper.find('[data-cy="bd-needs-config"]').exists()).toBe(false)
      expect(wrapper.find('.xs-essentials').exists()).toBe(true)
      expect(wrapper.findAll('.xs-essentials .tool-btn')).toHaveLength(4)
      wrapper.unmount()
    }
  })
})
