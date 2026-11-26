import { describe, it, expect, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import KeyInspector from '../components/bundeck/KeyInspector.vue'
import { upsertRemoteVar } from '../composables/useVars'

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

  it('permite volver al degradado predeterminado de la tecla', async () => {
    const wrapper = mountInspector()
    await openAppearance(wrapper)
    const reset = wrapper.find('[data-cy="bd-bg-default"]')
    expect(reset.attributes('aria-pressed')).toBe('false')
    await reset.trigger('click')
    expect(wrapper.emitted('update-field')).toContainEqual(['backgroundColor', ''])
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

  it('color de icono libre (picker) junto a los predefinidos', async () => {
    const wrapper = mountInspector()
    await openAppearance(wrapper)
    const picker = wrapper.find('[data-cy="bd-icon-custom-color"]')
    expect(picker.exists()).toBe(true)
    await picker.setValue('#ff0000')
    expect(wrapper.emitted('update-field')).toContainEqual(['textColor', '#ff0000'])
  })

  it('cada condición tiene color libre de icono y de fondo', async () => {
    const wrapper = mountInspector({
      ...baseConfig,
      looks: [{ cond: 'contador > 1', t: 'Hola', i: '', c: null, bg: 0 }],
    })
    await openAppearance(wrapper)
    const iconPicker = wrapper.find('[data-cy="bd-look-custom-color-0"]')
    const bgPicker = wrapper.find('[data-cy="bd-look-custom-bg-0"]')
    expect(iconPicker.exists()).toBe(true)
    expect(bgPicker.exists()).toBe(true)
    await iconPicker.setValue('#123abc')
    await bgPicker.setValue('#abcdef')
    const emitted = wrapper.emitted('update-field') as Array<[string, any]> | undefined
    const looksEmits = emitted!.filter(([k]) => k === 'looks').map(([, v]) => v)
    expect(looksEmits).toContainEqual(
      expect.arrayContaining([expect.objectContaining({ c: '#123abc' })])
    )
    expect(looksEmits).toContainEqual(
      expect.arrayContaining([expect.objectContaining({ bg: '#abcdef' })])
    )
  })

  it('sin bloque de crear variables ni wizard de toggle', async () => {
    const wrapper = mountInspector({
      ...baseConfig,
      actions: [{ id: 'a1', type: 'local.toggle-var', parameters: { name: 'micSilenciado' } }],
    })
    await openAppearance(wrapper)
    const html = wrapper.html()
    expect(wrapper.find('[data-cy="bd-key-vars"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-toggle-var-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-toggle-apply"]').exists()).toBe(false)
    expect(html).not.toContain('bd-toggle-var-input')
  })

  it('muestra las variables expuestas por las acciones de la tecla', async () => {
    const wrapper = mountInspector({
      ...baseConfig,
      actions: [{ id: 'a1', type: 'discord.toggle-mute', parameters: {} }],
    })
    await openAppearance(wrapper)
    expect(wrapper.find('[data-cy="bd-available-vars"]').exists()).toBe(true)
    const html = wrapper.find('[data-cy="bd-available-vars"]').html()
    expect(html).toContain('discordMuted')
    expect(html).toContain('discord.toggle-mute')
  })

  it('las globales de Ajustes aparecen con su valor en vivo', async () => {
    const wrapper = mountInspector()
    await openAppearance(wrapper)
    const html = wrapper.find('[data-cy="bd-available-vars"]').html()
    expect(html).toContain('contador')
  })

  it('usar una variable disponible añade su condición al aspecto', async () => {
    const wrapper = mountInspector({
      ...baseConfig,
      actions: [{ id: 'a1', type: 'discord.toggle-mute', parameters: {} }],
      looks: [],
    })
    await openAppearance(wrapper)
    await wrapper.find('[data-cy="bd-avail-use-discordMuted"]').trigger('click')
    const emitted = wrapper.emitted('update-field') as Array<[string, any]> | undefined
    const looksEmit = emitted!.find(([k]) => k === 'looks')
    expect(looksEmit?.[1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ cond: 'discordMuted' })])
    )
  })

  it('sin sección de Estados (eliminada: no tenía sentido)', async () => {
    const wrapper = mountInspector({ ...baseConfig, actions: [], looks: [], stateVar: 'estadoTest' })
    await openAppearance(wrapper)
    expect(wrapper.find('[data-cy="bd-states"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-state-add"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-state-var-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-trans-click"]').exists()).toBe(false)
  })

  it('la variable de estados aparece entre las disponibles', async () => {
    const wrapper = mountInspector({ ...baseConfig, stateVar: 'estadoTest3' })
    await openAppearance(wrapper)
    expect(wrapper.find('[data-cy="bd-available-vars"]').html()).toContain('estadoTest3')
  })

  it('presets: discord mute ofrece el par on/off y los añade en orden', async () => {
    const wrapper = mountInspector({
      ...baseConfig,
      actions: [{ id: 'a1', type: 'discord.toggle-mute', parameters: {} }],
      looks: [],
    })
    await openAppearance(wrapper)
    expect(wrapper.find('[data-cy="bd-presets"]').exists()).toBe(true)
    await wrapper.find('[data-cy="bd-preset-discordMuted-on"]').trigger('click')
    let emitted = wrapper.emitted('update-field') as Array<[string, any]> | undefined
    let looksEmit = emitted!.find(([k]) => k === 'looks')
    expect(looksEmit?.[1]).toEqual([
      expect.objectContaining({ cond: 'discordMuted', c: 4, bg: 1 }),
    ])
    // Simula el guardado del padre y añade el off: queda el par en orden.
    await wrapper.setProps({ buttonConfig: { ...baseConfig, actions: [{ id: 'a1', type: 'discord.toggle-mute', parameters: {} }], looks: looksEmit?.[1] } })
    await wrapper.find('[data-cy="bd-preset-discordMuted-off"]').trigger('click')
    emitted = wrapper.emitted('update-field') as Array<[string, any]> | undefined
    const last = emitted!.filter(([k]) => k === 'looks').at(-1)
    expect(last?.[1]).toEqual([
      expect.objectContaining({ cond: 'discordMuted' }),
      expect.objectContaining({ cond: 'discordMuted == falso' }),
    ])
  })

  it('sin acciones con estado no hay presets', async () => {
    const wrapper = mountInspector({ ...baseConfig, actions: [{ id: 'a1', type: 'shell.exec', parameters: {} }] })
    await openAppearance(wrapper)
    expect(wrapper.find('[data-cy="bd-presets"]').exists()).toBe(false)
  })

  it('con icono personalizado el off hereda el icono del botón', async () => {
    const wrapper = mountInspector({
      ...baseConfig,
      icon: 'Mic',
      actions: [{ id: 'a1', type: 'discord.toggle-mute', parameters: {} }],
      looks: [],
    })
    await openAppearance(wrapper)
    await wrapper.find('[data-cy="bd-preset-discordMuted-off"]').trigger('click')
    const emitted = wrapper.emitted('update-field') as Array<[string, any]> | undefined
    const looksEmit = emitted!.find(([k]) => k === 'looks')
    expect(looksEmit?.[1]).toEqual([
      expect.objectContaining({ cond: 'discordMuted == falso', i: 'Mic' }),
    ])
    await wrapper.setProps({ buttonConfig: { ...baseConfig, icon: 'Mic', actions: [{ id: 'a1', type: 'discord.toggle-mute', parameters: {} }], looks: looksEmit?.[1] } })
    await wrapper.find('[data-cy="bd-preset-discordMuted-on"]').trigger('click')
    const emitted2 = wrapper.emitted('update-field') as Array<[string, any]> | undefined
    const last = emitted2!.filter(([k]) => k === 'looks').at(-1)
    expect(last?.[1]).toEqual([
      expect.objectContaining({ cond: 'discordMuted == falso', i: 'Mic' }),
      expect.objectContaining({ cond: 'discordMuted', i: 'MicOff' }),
    ])
  })

  it('condición bool con tipo: matchea en true y vuelve a la base en false', async () => {
    upsertRemoteVar('discordMuted', true, 'bool')
    const wrapper = mountInspector({
      ...baseConfig,
      actions: [{ id: 'a1', type: 'discord.toggle-mute', parameters: {} }],
      looks: [{ cond: 'discordMuted == true', t: 'Muteado', i: '', c: 4, bg: 1 }],
    })
    await openAppearance(wrapper)
    await nextTick()
    let cards = wrapper.findAll('.bd-rl')
    expect(cards.length).toBe(1)
    expect(cards[0].classes()).toContain('is-matched')
    upsertRemoteVar('discordMuted', false, 'bool')
    await nextTick()
    cards = wrapper.findAll('.bd-rl')
    expect(cards[0].classes()).not.toContain('is-matched')
    upsertRemoteVar('discordMuted', true, 'bool')
  })

  it('prioridad: gana la primera condición cierta; sin match, base', async () => {
    upsertRemoteVar('contador', 2, 'num')
    const wrapper = mountInspector({
      ...baseConfig,
      looks: [
        { cond: 'contador > 100', t: 'Grande', i: '', c: null, bg: 0 },
        { cond: 'contador > 1', t: 'Mediano', i: '', c: null, bg: 0 },
      ],
    })
    await openAppearance(wrapper)
    await nextTick()
    let cards = wrapper.findAll('.bd-rl')
    expect(cards[1].classes()).toContain('is-matched')
    expect(cards[0].classes()).not.toContain('is-matched')
    upsertRemoteVar('contador', 0, 'num')
    await nextTick()
    cards = wrapper.findAll('.bd-rl')
    expect(cards[0].classes()).not.toContain('is-matched')
    expect(cards[1].classes()).not.toContain('is-matched')
    upsertRemoteVar('contador', 0, 'num')
  })
})
