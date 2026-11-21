import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import KeyInspector from '../components/bundeck/KeyInspector.vue'

// Mock the i18n composable
vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
  }),
}))

// Stub SchemaForm to avoid heavy rendering
vi.mock('../components/SchemaForm.vue', () => ({
  default: { name: 'SchemaForm', template: '<div class="schema-stub" />' },
}))

const baseProps = {
  mode: 'edit',
  row: 0,
  col: 0,
  plugins: [],
  availablePages: [],
  buttonConfig: {
    label: '',
    textTop: '',
    textBottom: '',
    fontSize: 14,
    icon: '',
    emoji: '',
    backgroundColor: '#374151',
    textColor: '#f1f5f9',
    actions: [],
  },
}

describe('KeyInspector', () => {
  it('renders editor for an empty key (hasButton=false)', () => {
    const wrapper = mount(KeyInspector, {
      props: { ...baseProps, selectedPosition: 3, hasButton: false },
    })
    console.log('EMPTY HTML:', wrapper.html().slice(0, 2000))
    expect(wrapper.text()).toContain('bd.emptyKey')
    // Editor must still render so actions can be added: tabs + footer
    expect(wrapper.html()).toContain('bd-itabs')
    expect(wrapper.html()).toContain('bd-ifoot')
  })

  it('renders editor for an existing key (hasButton=true)', () => {
    const wrapper = mount(KeyInspector, {
      props: { ...baseProps, selectedPosition: 3, hasButton: true },
    })
    console.log('FULL HTML:', wrapper.html().slice(0, 2000))
    expect(wrapper.html()).toContain('bd-itabs')
    expect(wrapper.html()).toContain('bd-ifoot')
  })

  it('shows export/import actions and tabs', async () => {
    const wrapper = mount(KeyInspector, {
      props: {
        ...baseProps,
        selectedPosition: 3,
        hasButton: true,
        buttonConfig: { ...baseProps.buttonConfig, actions: [{ id: '1', type: 'shell', parameters: {} }] },
      },
    })
    expect(wrapper.find('[data-cy="bd-tab-actions"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-add-action"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="bd-test-key"]').exists()).toBe(true)
    await wrapper.find('[data-cy="bd-tab-actions"]').trigger('click')
    expect(wrapper.emitted()).toBeTruthy()
  })
})
