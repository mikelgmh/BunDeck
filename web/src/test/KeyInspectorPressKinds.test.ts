import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import KeyInspector from '../components/bundeck/KeyInspector.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../components/bundeck/ActionCard.vue', () => ({
  default: {
    name: 'ActionCard',
    props: ['action', 'index'],
    template: '<div class="stub-ac"><button data-cy="stub-remove" @click="$emit(\'remove\', index)" /></div>',
  },
}))

const clickA = { id: 'c1', type: 'shell', parameters: {} }
const d1 = { id: 'd1', type: 'web', parameters: {} }
const d2 = { id: 'd2', type: 'key', parameters: {} }
const l1 = { id: 'l1', type: 'txt', parameters: {} }

const baseProps = {
  mode: 'edit',
  row: 0,
  col: 0,
  plugins: [],
  availablePages: [],
  buttonConfig: {
    label: 'T',
    actions: [{ ...clickA }],
    pressActions: {
      click: [{ ...clickA }],
      double: [{ ...d1 }, { ...d2 }],
      triple: [],
      long: [{ ...l1 }],
    },
    rules: [],
  },
} as any

function mountInspector(overrides: any = {}) {
  return mount(KeyInspector, {
    props: { ...baseProps, selectedPosition: 3, hasButton: true, ...overrides },
  })
}

describe('KeyInspector subtabs por tipo de pulsación', () => {
  it('renderiza los 4 subtabs con sus conteos', () => {
    const wrapper = mountInspector()
    expect(wrapper.find('[data-cy="bd-press-kind-click"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-press-kind-double"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-press-kind-triple"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-press-kind-long"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-press-kind-click"]').text()).toContain('1')
    expect(wrapper.find('[data-cy="bd-press-kind-double"]').text()).toContain('2')
    wrapper.unmount()
  })

  it('cambia de lista al cambiar de subtab', async () => {
    const wrapper = mountInspector()
    expect(wrapper.findAll('[data-cy="bd-action-row"]').length).toBe(1)
    await wrapper.find('[data-cy="bd-press-kind-double"]').trigger('click')
    expect(wrapper.findAll('[data-cy="bd-action-row"]').length).toBe(2)
    await wrapper.find('[data-cy="bd-press-kind-long"]').trigger('click')
    expect(wrapper.findAll('[data-cy="bd-action-row"]').length).toBe(1)
    await wrapper.find('[data-cy="bd-press-kind-triple"]').trigger('click')
    expect(wrapper.findAll('[data-cy="bd-action-row"]').length).toBe(0)
    wrapper.unmount()
  })

  it('quitar en double emite update-field con pressActions (sin tocar click)', async () => {
    const wrapper = mountInspector()
    await wrapper.find('[data-cy="bd-press-kind-double"]').trigger('click')
    await wrapper.find('[data-cy="stub-remove"]').trigger('click')
    const emitted = wrapper.emitted('update-field') as any[][]
    const pa = emitted.find(([k]) => k === 'pressActions')
    expect(pa).toBeTruthy()
    expect(pa[1].double.map((a: any) => a.id)).toEqual(['d2'])
    expect(pa[1].click.map((a: any) => a.id)).toEqual(['c1'])
    // click no se reescribe al tocar double
    expect(emitted.find(([k]) => k === 'actions')).toBeUndefined()
    wrapper.unmount()
  })

  it('quitar en click espeja actions y pressActions', async () => {
    const wrapper = mountInspector()
    await wrapper.find('[data-cy="stub-remove"]').trigger('click')
    const emitted = wrapper.emitted('update-field') as any[][]
    const pa = emitted.find(([k]) => k === 'pressActions')
    const ac = emitted.find(([k]) => k === 'actions')
    expect(pa?.[1].click).toEqual([])
    expect(ac?.[1]).toEqual([])
    wrapper.unmount()
  })

  it('añadir emite open-palette con el tipo activo', async () => {
    const wrapper = mountInspector()
    await wrapper.find('[data-cy="bd-press-kind-triple"]').trigger('click')
    await wrapper.find('[data-cy="bd-add-action"]').trigger('click')
    expect(wrapper.emitted('open-palette')).toEqual([[`press:triple`]])
    wrapper.unmount()
  })

  it('la regla When ofrece double y triple', async () => {
    const wrapper = mountInspector({
      buttonConfig: {
        ...baseProps.buttonConfig,
        rules: [{ id: 'r1', on: true, when: 'press', every: 5, vn: '', cond: '', then: [], else: [] }],
      },
    })
    await wrapper.find('[data-cy="bd-tab-rules"]').trigger('click')
    const html = wrapper.html()
    expect(html).toContain('value="double"')
    expect(html).toContain('value="triple"')
    wrapper.unmount()
  })
})
