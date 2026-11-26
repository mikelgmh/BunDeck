import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import StreamStudioControl from '../components/bundeck/widgets/StreamStudioControl.vue'
import CreativeToolsControl from '../components/bundeck/widgets/CreativeToolsControl.vue'
import { useI18nStore } from '../composables/useI18n'

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }))
vi.mock('../composables/useWidgetAction', () => ({ executeWidgetAction: executeMock }))

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const { setLocale } = useI18nStore()

afterEach(() => {
  executeMock.mockReset()
  setLocale('es')
})

describe('StreamStudioControl', () => {
  it('loads OBS state and executes its corresponding stream action', async () => {
    executeMock
      .mockResolvedValueOnce({ success: true, result: { streaming: false, recording: false, options: [{ value: 'Main', label: 'Main' }] } })
      .mockResolvedValueOnce({ success: true, result: { options: [{ value: 'Main', label: 'Main' }], currentProgramSceneName: 'Main' } })
      .mockResolvedValueOnce({ success: true, result: { requested: 'start' } })
    const wrapper = mount(StreamStudioControl, {
      props: { action: { type: 'obs.status', parameters: { host: 'localhost', password: 'secret' } }, apiBase: '' },
    })
    expect(executeMock).not.toHaveBeenCalled()
    await wrapper.get('.stream-icon-btn').trigger('click')
    await flushPromises()
    expect(executeMock).toHaveBeenCalledWith('', 'obs.status', { host: 'localhost', password: 'secret' })
    expect(executeMock).toHaveBeenCalledWith('', 'obs.scene-list', { host: 'localhost', password: 'secret' })
    await wrapper.get('.live-btn').trigger('click')
    expect(executeMock).toHaveBeenLastCalledWith('', 'obs.stream', { host: 'localhost', password: 'secret', action: 'start' })
    wrapper.unmount()
  })

  it('shows API errors accessibly and keeps controls disabled in readonly mode', async () => {
    executeMock.mockRejectedValueOnce(new Error('OBS connection failed'))
    const wrapper = mount(StreamStudioControl, {
      props: { action: { type: 'obs.status', parameters: {} }, apiBase: '', readonly: true },
    })
    expect(executeMock).not.toHaveBeenCalled()
    await wrapper.get('.stream-icon-btn').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('OBS connection failed')
    expect(wrapper.get('.live-btn').attributes('disabled')).toBeDefined()
    expect(executeMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('asks before ending a YouTube broadcast and runs no write action until confirmed', async () => {
    executeMock.mockResolvedValueOnce({ success: true, result: { viewerCount: 12, live: true } })
      .mockResolvedValueOnce({ success: true, result: { status: 'complete' } })
    const wrapper = mount(StreamStudioControl, {
      props: { action: { type: 'youtube.viewer-count', parameters: { videoId: 'video' } }, apiBase: '' },
    })
    expect(executeMock).not.toHaveBeenCalled()
    await wrapper.get('.stream-icon-btn').trigger('click')
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
    await wrapper.get('.stream-icon-btn').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('viewers')
    expect(wrapper.text()).toContain('Current audience')
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
})
