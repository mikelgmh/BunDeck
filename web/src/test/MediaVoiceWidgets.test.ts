import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SpotifyPlayerControl from '../components/bundeck/widgets/SpotifyPlayerControl.vue'
import VoicePanelControl from '../components/bundeck/widgets/VoicePanelControl.vue'
import SoundboardControl from '../components/bundeck/widgets/SoundboardControl.vue'
import { useI18nStore } from '../composables/useI18n'

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const { setLocale } = useI18nStore()

beforeEach(() => setLocale('en'))
afterEach(() => {
  vi.unstubAllGlobals()
  setLocale('es')
})

function mockResponse(result: any = {}) {
  return { ok: true, json: async () => ({ result }) } as any
}

describe('BunDeck media and voice widget surfaces', () => {
  it('renders Spotify track info and sends sibling playback actions', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      calls.push(body.action)
      if (body.action.type === 'spotify.now-playing') {
        return mockResponse({
          state: 'playing',
          isPlaying: true,
          track: { id: 'track-7', name: 'Night Drive', artists: 'The Testers' },
        })
      }
      return mockResponse()
    }))
    const wrapper = mount(SpotifyPlayerControl, {
      props: {
        action: { type: 'spotify.now-playing', parameters: { deviceId: 'dev-1' } },
        apiBase: 'http://localhost:3001',
      },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Night Drive')
    expect(wrapper.text()).toContain('The Testers')
    await wrapper.get('[aria-label="Next track"]').trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({ type: 'spotify.playback', parameters: { deviceId: 'dev-1', action: 'next' } })
    wrapper.unmount()
  })

  it('shows meeting controls as hotkey commands without claiming state', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      expect(body.action.type).toBe('meetings.control')
      return mockResponse({ sent: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(VoicePanelControl, {
      props: {
        action: { type: 'meetings.control', parameters: { app: 'zoom', command: 'mute' } },
        apiBase: '',
      },
    })
    expect(wrapper.text()).toContain('Zoom')
    expect(wrapper.text()).toContain('Meeting state is not reported')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalled()
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).action.parameters).toMatchObject({
      app: 'zoom',
      command: 'mute',
    })
    wrapper.unmount()
  })

  it('uses push-to-talk press and release phases from keyboard input', async () => {
    const actions: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      actions.push(body.action)
      return mockResponse({ status: 'needs-auth', transport: 'none' })
    }))
    const wrapper = mount(VoicePanelControl, {
      props: {
        action: { type: 'discord.toggle-mute', parameters: { hotkey: 'ctrl+shift+m' } },
        apiBase: '',
      },
    })
    await flushPromises()
    const button = wrapper.get('[aria-label="Push to talk; hold pointer or Space or Enter"]')
    await button.trigger('keydown', { key: ' ', repeat: false })
    await button.trigger('keyup', { key: ' ' })
    await flushPromises()
    expect(actions).toContainEqual({
      type: 'discord.push-to-talk',
      parameters: { hotkey: 'ctrl+shift+m', phase: 'press' },
    })
    expect(actions).toContainEqual({
      type: 'discord.push-to-talk',
      parameters: { hotkey: 'ctrl+shift+m', phase: 'release' },
    })
    wrapper.unmount()
  })

  it('loads sounds and invokes play/stop with configured sound folder', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      calls.push(body.action)
      if (body.action.type === 'soundboard.list-sounds') return mockResponse({ sounds: [{ name: 'clap.wav' }] })
      return mockResponse({ stopped: true })
    }))
    const wrapper = mount(SoundboardControl, {
      props: {
        action: { type: 'soundboard.play', parameters: { soundsDir: 'D:/sounds', volume: 70 } },
        apiBase: '',
      },
    })
    await flushPromises()
    expect(wrapper.find('select').element).toBeTruthy()
    await wrapper.get('.m-actions [aria-label="Play selected sound"]').trigger('click')
    await flushPromises()
    await wrapper.get('.m-actions [aria-label="Stop sound"]').trigger('click')
    await flushPromises()
    expect(calls).toContainEqual({
      type: 'soundboard.play',
      parameters: { soundsDir: 'D:/sounds', volume: 70, file: 'clap.wav' },
    })
    expect(calls).toContainEqual({ type: 'soundboard.stop', parameters: {} })
    wrapper.unmount()
  })

  it('defaults to Spanish and reacts to the shared locale changing to English', async () => {
    setLocale('es')
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ sounds: [] })))
    const wrapper = mount(SoundboardControl, {
      props: {
        action: { type: 'soundboard.play', parameters: {} },
        apiBase: '',
      },
    })
    expect(wrapper.text()).toContain('Mesa de sonidos')
    expect(wrapper.text()).toContain('Volumen')
    setLocale('en')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Soundboard')
    expect(wrapper.text()).toContain('Volume')
    wrapper.unmount()

    setLocale('es')
    const voice = mount(VoicePanelControl, {
      props: {
        action: { type: 'meetings.control', parameters: { app: 'meet' } },
        apiBase: '',
      },
    })
    expect(voice.text()).toContain('Controles de reunión')
    expect(voice.text()).toContain('Se envían atajos')
    setLocale('en')
    await voice.vm.$nextTick()
    expect(voice.text()).toContain('Meeting controls')
    expect(voice.text()).toContain('Meeting state is not reported')
    voice.unmount()

    setLocale('es')
    const spotify = mount(SpotifyPlayerControl, {
      props: {
        action: { type: 'spotify.now-playing', parameters: {} },
        apiBase: '',
      },
    })
    await flushPromises()
    expect(spotify.text()).toContain('Nada en reproducción')
    setLocale('en')
    await spotify.vm.$nextTick()
    expect(spotify.text()).toContain('Nothing playing')
    spotify.unmount()
  })

  it('shows NeedsConfig when meetings or soundboard lack required parameters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ sounds: [] })))
    const meetings = mount(VoicePanelControl, {
      props: { action: { type: 'meetings.control', parameters: {} }, apiBase: '' },
    })
    expect(meetings.find('[data-cy="bd-needs-config"]').exists()).toBe(true)
    meetings.unmount()

    const bus = mount(VoicePanelControl, {
      props: { action: { type: 'voicemeeter.bus-mute', parameters: {} }, apiBase: '' },
    })
    expect(bus.find('[data-cy="bd-needs-config"]').exists()).toBe(true)
    bus.unmount()

    const sound = mount(SoundboardControl, {
      props: { action: { type: 'soundboard.play', parameters: {} }, apiBase: '' },
    })
    await flushPromises()
    expect(sound.find('[data-cy="bd-needs-config"]').exists()).toBe(true)
    sound.unmount()
  })

  it('renders the Spotify title with Marquee and meetings XS pages with icon-only buttons', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({
      state: 'playing',
      isPlaying: true,
      track: { id: 'track-7', name: 'Night Drive', artists: 'The Testers' },
    })))
    const spotify = mount(SpotifyPlayerControl, {
      props: { action: { type: 'spotify.now-playing', parameters: {} }, apiBase: '' },
    })
    await flushPromises()
    expect(spotify.find('[data-cy="bd-marquee"]').exists()).toBe(true)
    expect(spotify.find('[data-cy="bd-marquee"]').text()).toContain('Night Drive')
    spotify.unmount()

    const voice = mount(VoicePanelControl, {
      props: {
        action: { type: 'meetings.control', parameters: { app: 'meet', command: 'mute', carouselMs: 0 } },
        apiBase: '',
      },
    })
    expect(voice.find('[data-cy="voice-xs-pages"]').exists()).toBe(true)
    expect(voice.findAll('[data-cy="voice-xs-pages"] button').length).toBe(2)
    expect(voice.findAll('[data-cy="voice-xs-pages"] button')[0].attributes('aria-label')).toBeTruthy()
    voice.unmount()
  })
})
