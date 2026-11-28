import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import StageBoard from '../components/bundeck/StageBoard.vue'
import KeyInspector from '../components/bundeck/KeyInspector.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
  }),
}))

const mkButtons = (data: any) => [
  { id: 'a', page_id: 'p', position: 0, data },
] as any

const boardProps = (buttons: any) => ({
  gridCols: 5,
  gridRows: 3,
  keySize: 76,
  layoutMode: 'classic',
  selectedButton: null,
  executingButtons: [],
  buttonConfig: {},
  getButton: (pos: number) => buttons.find((b: any) => b.position === pos),
  allButtons: buttons,
  getButtonData: (pos: number) => buttons.find((b: any) => b.position === pos)?.data ?? null,
  mode: 'use',
  labelMode: 'a',
  currentPages: [],
  currentPage: { id: 'p', name: 'P', data: {} },
  navTrail: [],
  profileName: '',
  busy: false,
  longPressMs: 200,
}) as any

describe('Badge/contador de modo fijo', () => {
  it('la tecla fija muestra el badge sobre el icono', () => {
    const buttons = mkButtons({ label: 'Correo', icon: 'Mail', badge: '5', actions: [] })
    const wrapper = mount(StageBoard, { props: boardProps(buttons) })
    const badge = wrapper.find('.bd-cbadge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('5')
    // El icono sigue ahí: el badge no reemplaza el centro.
    expect(wrapper.find('[data-cy="bd-key"]').html()).toContain('bd-cbadge')
    wrapper.unmount()
  })

  it('sin badge no hay píldora', () => {
    const buttons = mkButtons({ label: 'Correo', icon: 'Mail', actions: [] })
    const wrapper = mount(StageBoard, { props: boardProps(buttons) })
    expect(wrapper.find('.bd-cbadge').exists()).toBe(false)
    wrapper.unmount()
  })

  it('el inspector de aspecto edita el badge', async () => {
    const wrapper = mount(KeyInspector as any, {
      props: {
        mode: 'edit',
        row: 0,
        col: 0,
        plugins: [],
        availablePages: [],
        buttonConfig: { label: 'Correo', icon: 'Mail', badge: '5', actions: [], rules: [], looks: [] },
        selectedPosition: 0,
        hasButton: true,
      },
    })
    await wrapper.find('[data-cy="bd-tab-appearance"]').trigger('click')
    const input = wrapper.find('[data-cy="bd-key-badge"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('5')
    await input.setValue('12')
    expect(wrapper.emitted('update-field')).toContainEqual(['badge', '12'])
    wrapper.unmount()
  })
})
