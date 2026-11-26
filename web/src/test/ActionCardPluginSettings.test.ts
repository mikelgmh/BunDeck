import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ActionCard from '../components/bundeck/ActionCard.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({ t: (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key }),
}))

const plugin = (
  id: string,
  actionId: string,
  action: Record<string, any>,
  settingsSchema?: Record<string, any>,
) => [[id, {
  manifest: {
    id,
    name: id === 'weather' ? 'Weather' : id,
    ...(settingsSchema ? { settingsSchema } : {}),
  },
  actions: [[actionId, action]],
}]]

const mountCard = (plugins: any[], type: string, parameters: Record<string, any> = {}) =>
  mount(ActionCard, {
    props: {
      action: { type, parameters },
      index: 0,
      showWait: false,
      plugins,
      availablePages: [],
    },
  })

describe('ActionCard plugin settings empty state', () => {
  afterEach(() => vi.clearAllMocks())

  it('explains that options live in plugin settings and opens the right plugin', async () => {
    const wrapper = mountCard(
      plugin('weather', 'now', {
        name: 'Current weather',
        description: 'Fetches current conditions.',
        schema: { type: 'object', properties: {} },
      }, {
        type: 'object',
        properties: { place: { type: 'string' } },
      }),
      'weather.now',
    )

    expect(wrapper.find('[data-cy="bd-action-config-note"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('actionPluginSettingsHint:Weather')
    expect(wrapper.text()).toContain('Fetches current conditions.')
    await wrapper.get('[data-cy="bd-open-plugin-settings"]').trigger('click')
    expect(wrapper.emitted('open-plugin-settings')).toEqual([['weather']])
    wrapper.unmount()
  })

  it('shows a helpful no-extra-configuration message when the plugin has no settings', () => {
    const wrapper = mountCard(
      plugin('pc-vitals', 'summary', {
        name: 'System summary',
        schema: { type: 'object', properties: {} },
      }),
      'pc-vitals.summary',
    )

    expect(wrapper.text()).toContain('actionNoExtraConfig')
    expect(wrapper.find('[data-cy="bd-open-plugin-settings"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the schema form for actions that have configurable parameters', async () => {
    const wrapper = mountCard(
      plugin('weather', 'now', {
        name: 'Current weather',
        schema: {
          type: 'object',
          properties: {
            place: { type: 'string', title: 'Location', ui: { component: 'input', type: 'text' } },
          },
        },
      }, {
        type: 'object',
        properties: { place: { type: 'string' } },
      }),
      'weather.now',
    )
    await flushPromises()

    expect(wrapper.find('.bd-schema').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-action-config-note"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
