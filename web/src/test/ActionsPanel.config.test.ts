import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ActionsPanel from '../components/bundeck/ActionsPanel.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
  }),
}))

const plugins = [
  [
    'spotify',
    {
      manifest: { name: 'Spotify' },
      actions: [['playback', { name: 'Reproducir', icon: 'Play' }]],
    },
  ],
  [
    'page',
    {
      manifest: { name: 'Page Navigation' },
      actions: [['page', { name: 'Navigate', icon: 'FileText' }]],
    },
  ],
]

const detailed = [
  { id: 'spotify', requiresConfiguration: true, configured: false, missing: ['token'] },
  { id: 'page', requiresConfiguration: false, configured: true, missing: [] },
]

describe('ActionsPanel gating (plugins sin configurar)', () => {
  it('muestra el warning a la izquierda del grupo sin configurar', () => {
    const wrapper = mount(ActionsPanel, { props: { plugins, detailed } })
    const warns = wrapper.findAll('[data-cy="bd-plugin-unconfigured"]')
    expect(warns).toHaveLength(1)
  })

  it('click en el warning abre la modal de configuración', async () => {
    const wrapper = mount(ActionsPanel, { props: { plugins, detailed } })
    await wrapper.find('[data-cy="bd-plugin-unconfigured"]').trigger('click')
    expect(wrapper.emitted('open-plugin-settings')).toBeTruthy()
    expect(wrapper.emitted('open-plugin-settings')![0]).toEqual(['spotify'])
  })

  it('la acción sin configurar no es draggable y no emite action-pick', async () => {
    const wrapper = mount(ActionsPanel, { props: { plugins, detailed } })
    const items = wrapper.findAll('[data-cy="bd-action-item"]')
    // 3 acciones locales (Lógica) + 2 de plugins
    expect(items).toHaveLength(5)
    const spotifyBtn = items[3]
    expect(spotifyBtn.attributes('draggable')).toBe('false')
    expect(spotifyBtn.attributes('aria-disabled')).toBe('true')
    await spotifyBtn.trigger('click')
    expect(wrapper.emitted('action-pick')).toBeFalsy()
    // En su lugar abre ajustes.
    expect(wrapper.emitted('open-plugin-settings')![0]).toEqual(['spotify'])
  })

  it('la acción configurada sigue funcionando', async () => {
    const wrapper = mount(ActionsPanel, { props: { plugins, detailed } })
    const items = wrapper.findAll('[data-cy="bd-action-item"]')
    const pageBtn = items[4]
    expect(pageBtn.attributes('draggable')).toBe('true')
    await pageBtn.trigger('click')
    expect(wrapper.emitted('action-pick')![0]).toEqual(['page.page'])
  })

  it('el grupo Lógica siempre está disponible', async () => {
    const wrapper = mount(ActionsPanel, { props: { plugins, detailed } })
    const items = wrapper.findAll('[data-cy="bd-action-item"]')
    await items[0].trigger('click')
    expect(wrapper.emitted('action-pick')![0]).toEqual(['local.set-var'])
  })

  it('sin detailed no bloquea nada (compat con daemon viejo)', () => {
    const wrapper = mount(ActionsPanel, { props: { plugins } })
    expect(wrapper.findAll('[data-cy="bd-plugin-unconfigured"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-cy="bd-action-item"]')).toHaveLength(5)
  })
})
