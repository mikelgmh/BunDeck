import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AudioMixerControl from '../components/bundeck/widgets/AudioMixerControl.vue'
import MediaTransportControl from '../components/bundeck/widgets/MediaTransportControl.vue'
import SmartHomeControl from '../components/bundeck/widgets/SmartHomeControl.vue'
import { useI18nStore } from '../composables/useI18n'

const i18n = useI18nStore()
const originalLocale = i18n.currentLocale.value

afterEach(() => {
  i18n.setLocale(originalLocale)
})

describe('widget local copy', () => {
  it('uses Spanish when the active locale starts with es', () => {
    i18n.setLocale('es-MX')
    const audio = mount(AudioMixerControl, {
      props: { action: { type: 'audio-mixer.mic-mute', parameters: {} }, apiBase: '' },
    })
    const media = mount(MediaTransportControl, {
      props: { action: { type: 'multimedia.multimedia', parameters: {} }, apiBase: '' },
    })
    const smartHome = mount(SmartHomeControl, {
      props: { action: { type: 'hue-extra.scene', parameters: { sceneId: 'scene-id' } }, apiBase: '' },
    })

    expect(audio.text()).toContain('Micrófono')
    expect(media.find('button').attributes('aria-label')).toBe('Pista anterior')
    expect(smartHome.text()).toContain('Activar escena')

    audio.unmount()
    media.unmount()
    smartHome.unmount()
  })

  it('uses English for locales other than Spanish', () => {
    i18n.setLocale('en-GB')
    const audio = mount(AudioMixerControl, {
      props: { action: { type: 'audio-mixer.mic-mute', parameters: {} }, apiBase: '' },
    })
    const media = mount(MediaTransportControl, {
      props: { action: { type: 'multimedia.multimedia', parameters: {} }, apiBase: '' },
    })
    const smartHome = mount(SmartHomeControl, {
      props: { action: { type: 'hue-extra.scene', parameters: { sceneId: 'scene-id' } }, apiBase: '' },
    })

    expect(audio.text()).toContain('Microphone')
    expect(media.find('button').attributes('aria-label')).toBe('Previous track')
    expect(smartHome.text()).toContain('Activate scene')

    audio.unmount()
    media.unmount()
    smartHome.unmount()
  })
})
