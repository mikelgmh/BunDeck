import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import KeyInspector from '../components/bundeck/KeyInspector.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({ t: (key: string) => key }),
}))

const baseConfig = {
  label: 'Test',
  icon: 'Zap',
  backgroundColor: '#374151',
  textColor: '#e8e9eb',
  actions: [{ id: '1', type: 'shell', parameters: {} }],
  rules: [],
  looks: [],
} as any

function mountInspector(buttonConfig: any = baseConfig, extra: any = {}) {
  return mount(KeyInspector as any, {
    props: {
      mode: 'edit',
      row: 0,
      col: 0,
      plugins: [],
      availablePages: [],
      buttonConfig,
      selectedPosition: 0,
      hasButton: true,
      ...extra,
    },
  })
}

async function openAppearance(wrapper: any) {
  await wrapper.find('[data-cy="bd-tab-appearance"]').trigger('click')
}

describe('KeyInspector appearance (regresión pantalla en negro)', () => {
  it('muestra los controles de aspecto al clicar la pestaña', async () => {
    const wrapper = mountInspector()
    await openAppearance(wrapper)
    const html = wrapper.html()
    expect(html).toContain('bd-ibody')
    expect(html).toContain('bd.showTitle')
    expect(html).toContain('bd.iconColor')
    expect(html).toContain('bd.keyBackground')
    expect(html).toContain('bd.looksTitle')
    expect(wrapper.find('[data-cy="bd-add-look"]').exists()).toBe(true)
  })

  it('no revienta con looks corruptos (null / no-objetos)', async () => {
    const wrapper = mountInspector({ ...baseConfig, looks: [null, undefined, 123, 'foo', { cond: 'contador > 1', t: 'Hola', i: '', c: 1, bg: 2 }] })
    await openAppearance(wrapper)
    const html = wrapper.html()
    // Solo el look válido sobrevive
    expect(wrapper.findAll('.bd-rl').length).toBe(1)
    expect(html).toContain('bd-add-look')
  })

  it('no revienta con rules corruptas al pasar por aspecto/reglas', async () => {
    const wrapper = mountInspector({ ...baseConfig, rules: [null, undefined, 42 as any] })
    await wrapper.find('[data-cy="bd-tab-rules"]').trigger('click')
    expect(wrapper.html()).toContain('bd-ibody')
    await wrapper.find('[data-cy="bd-tab-appearance"]').trigger('click')
    expect(wrapper.html()).toContain('bd.looksTitle')
  })

  it('no revienta con colores/icono con tipos inesperados', async () => {
    const wrapper = mountInspector({
      ...baseConfig,
      textColor: 123 as any,
      backgroundColor: { foo: 1 } as any,
      icon: 789 as any,
      looks: [{ cond: '', t: '', i: 123 as any, c: 'x' as any, bg: 'y' as any }],
    })
    await openAppearance(wrapper)
    expect(wrapper.html()).toContain('bd-ibody')
    expect(wrapper.find('[data-cy="bd-add-look"]').exists()).toBe(true)
  })

  it('no revienta si looks/rules no son arrays', async () => {
    const wrapper = mountInspector({ ...baseConfig, looks: {} as any, rules: 'oops' as any })
    await openAppearance(wrapper)
    expect(wrapper.html()).toContain('bd.looksTitle')
    expect(wrapper.findAll('.bd-rl').length).toBe(0)
  })

  it('condición inválida muestra error pero no tumba la pestaña', async () => {
    const wrapper = mountInspector({
      ...baseConfig,
      looks: [{ cond: '((((', t: 'X', i: '', c: null, bg: 0 }],
    })
    await openAppearance(wrapper)
    const html = wrapper.html()
    expect(html).toContain('bd-ibody')
    expect(html).toContain('bd-err')
  })

  it('icono desconocido usa fallback sin reventar', async () => {
    const wrapper = mountInspector({ ...baseConfig, icon: 'IconoQueNoExiste' })
    await openAppearance(wrapper)
    expect(wrapper.html()).toContain('bd-ibody')
    // previewIcon cae a null pero el botón de icono sigue visible
    expect(wrapper.html()).toContain('bd.change')
  })

  it('la vista previa es un botón que abre el selector (hover con icono de foto)', async () => {
    const wrapper = mountInspector()
    const pv = wrapper.find('[data-cy="bd-key-preview"]')
    expect(pv.exists()).toBe(true)
    expect(pv.element.tagName).toBe('BUTTON')
    await pv.trigger('click')
    expect(wrapper.emitted('open-icon-picker')).toBeTruthy()
  })

  it('muestra la imagen personalizada con URL absoluta', async () => {
    const wrapper = mountInspector({ ...baseConfig, iconImage: '/assets/key-7.webp' }, { apiBase: 'http://localhost:3001' })
    const img = wrapper.find('.bd-pvimg')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('http://localhost:3001/assets/key-7.webp')
  })

  it('no pinta <img> con iconImage corrupto o externo', async () => {
    for (const bad of ['../../evil.png', 'https://evil/x.png', 123 as any]) {
      const wrapper = mountInspector({ ...baseConfig, iconImage: bad }, { apiBase: 'http://localhost:3001' })
      expect(wrapper.find('.bd-pvimg').exists()).toBe(false)
    }
  })

  it('sin botón no hay pestañas que parezcan rotas (solo estado vacío)', async () => {
    const wrapper = mountInspector(baseConfig, { hasButton: false })
    expect(wrapper.find('[data-cy="bd-tab-actions"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-tab-rules"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-tab-appearance"]').exists()).toBe(false)
  })

  it('al vaciarse la tecla desaparecen las pestañas (no se quedan “muertas”)', async () => {
    const wrapper = mountInspector()
    await openAppearance(wrapper)
    expect(wrapper.find('[data-cy="bd-tab-appearance"]').attributes('aria-selected')).toBe('true')
    await wrapper.setProps({ hasButton: false })
    expect(wrapper.find('[data-cy="bd-tab-appearance"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-tab-actions"]').exists()).toBe(false)
  })

  it('reglas con then/else corruptos no tumban la pestaña', async () => {
    const wrapper = mountInspector({
      ...baseConfig,
      rules: [{ id: 'r1', on: true, when: 'press', cond: '', then: 'oops', else: 42 }],
    })
    await wrapper.find('[data-cy="bd-tab-rules"]').trigger('click')
    expect(wrapper.html()).toContain('bd-ibody')
    expect(wrapper.findAll('.bd-rl').length).toBe(1)
  })
})
