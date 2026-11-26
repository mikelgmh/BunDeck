import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import KeyInspector from '../components/bundeck/KeyInspector.vue'
import { vars, importVar, removeVar, upsertRemoteVar } from '../composables/useVars'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({ t: (key: string) => key }),
}))

const baseConfig = {
  label: 'Discord mute',
  icon: 'MicOff',
  backgroundColor: '',
  textColor: '#e8e9eb',
  actions: [{ id: 'a1', type: 'discord.toggle-mute', parameters: {} }],
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

beforeEach(() => {
  localStorage.clear()
})

describe('KeyInspector variables expuestas (sin creación manual)', () => {
  it('no hay bloque de crear variables ni wizard de toggle', async () => {
    const wrapper = mountInspector()
    await openAppearance(wrapper)
    expect(wrapper.find('[data-cy="bd-key-vars"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-toggle-var-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-toggle-apply"]').exists()).toBe(false)
    expect(wrapper.find('[data-cy="bd-available-vars"]').exists()).toBe(true)
  })

  it('lista la variable expuesta con su valor en vivo', async () => {
    if (!vars.value.some((v) => v.n === 'discordMuted')) {
      importVar({ n: 'discordMuted', t: 'bool', v: true })
    }
    upsertRemoteVar('discordMuted', true, 'bool')
    const wrapper = mountInspector()
    await openAppearance(wrapper)
    const html = wrapper.find('[data-cy="bd-available-vars"]').html()
    expect(html).toContain('discordMuted')
    expect(html).toContain('verdadero')
  })

  it('una variable remota (WS) sin valor previo también aparece', async () => {
    upsertRemoteVar('obsStreaming', false, 'bool')
    const wrapper = mountInspector({
      ...baseConfig,
      actions: [{ id: 'a1', type: 'obs.stream', parameters: { action: 'toggle' } }],
    })
    await openAppearance(wrapper)
    const html = wrapper.find('[data-cy="bd-available-vars"]').html()
    expect(html).toContain('obsStreaming')
    expect(html).toContain('falso')
  })

  it('añadir condición desde la variable y quitarla', async () => {
    const wrapper = mountInspector({ ...baseConfig, looks: [] })
    await openAppearance(wrapper)
    await wrapper.find('[data-cy="bd-avail-use-discordMuted"]').trigger('click')
    const emitted = wrapper.emitted('update-field') as Array<[string, any]>
    const looksEmit = emitted.find(([k]) => k === 'looks')
    expect(looksEmit?.[1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ cond: 'discordMuted' })])
    )

    // Con la condición ya aplicada, quitarla emite looks sin ella.
    const wrapper2 = mountInspector({
      ...baseConfig,
      looks: [{ cond: 'discordMuted', t: 'Mute', i: 'MicOff', c: null, bg: 0 }],
    })
    await openAppearance(wrapper2)
    const delBtn = wrapper2.find('.bd-rl .bd-ah button')
    expect(delBtn.exists()).toBe(true)
    await delBtn.trigger('click')
    const emitted2 = wrapper2.emitted('update-field') as Array<[string, any]>
    expect(emitted2).toContainEqual(['looks', []])
  })

  it('sin acciones con estado solo salen las globales', async () => {
    removeVar('discordMuted')
    removeVar('obsStreaming')
    const wrapper = mountInspector({ ...baseConfig, actions: [{ id: 'a1', type: 'shell.exec', parameters: {} }] })
    await openAppearance(wrapper)
    // Solo quedan las globales de Ajustes: ninguna fila de acción.
    const html = wrapper.find('[data-cy="bd-available-vars"]').html()
    expect(html).not.toContain('discordMuted')
    expect(html).toContain('contador')
  })
})
