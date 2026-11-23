import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ActionsPanel from '../components/bundeck/ActionsPanel.vue'
import ActionCommandPalette from '../components/bundeck/ActionCommandPalette.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
  }),
}))

const plugins = [
  [
    'audio-mixer',
    {
      manifest: { name: 'Mezclador' },
      actions: [
        ['app-volume', { name: 'Volumen de app', icon: 'SlidersHorizontal' }],
        ['volume-control', { name: 'Control de volumen', icon: 'SlidersHorizontal', surface: 'control', component: 'volume-range', freeModeOnly: true }]
      ]
    }
  ],
  [
    'pc-vitals',
    {
      manifest: { name: 'PC' },
      actions: [['monitor', { name: 'Monitor', icon: 'Activity', dynamic: true }]]
    }
  ]
]

describe('Badges de presentación (Control / Dato / Solo libre)', () => {
  it('la biblioteca marca el control con Solo libre y el dato dinámico', () => {
    const wrapper = mount(ActionsPanel, { props: { plugins } })
    const controls = wrapper.findAll('[data-cy="bd-action-badge-control"]')
    expect(controls).toHaveLength(1)
    expect(controls[0].text()).toBe('bd.actControl')
    const frees = wrapper.findAll('[data-cy="bd-action-badge-free"]')
    expect(frees).toHaveLength(1)
    const datas = wrapper.findAll('[data-cy="bd-action-badge-data"]')
    expect(datas).toHaveLength(1)
    // La acción de ejecución no lleva badge.
    const items = wrapper.findAll('[data-cy="bd-action-item"]')
    const appVol = items.find((i) => i.text().includes('Volumen de app'))!
    expect(appVol.find('[data-cy="bd-action-badge-control"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('el palette Ctrl+K marca igual', () => {
    const wrapper = mount(ActionCommandPalette, { props: { plugins } })
    expect(wrapper.findAll('[data-cy="bd-palette-badge-control"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-cy="bd-palette-badge-data"]')).toHaveLength(1)
    wrapper.unmount()
  })
})
