import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import McpPane from '../components/bundeck/McpPane.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && typeof params.n !== 'undefined') return `${key}:${params.n}`
      return key
    },
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

const SCOPES = [
  { id: 'profiles.read', group: 'profiles' },
  { id: 'profiles.write', group: 'profiles' },
  { id: 'pages.read', group: 'pages' },
  { id: 'pages.write', group: 'pages' },
  { id: 'buttons.read', group: 'buttons' },
  { id: 'buttons.write', group: 'buttons' },
  { id: 'actions.read', group: 'actions' },
  { id: 'actions.execute', group: 'actions' },
  { id: 'widgets.read', group: 'widgets' },
  { id: 'widgets.write', group: 'widgets' },
  { id: 'flows.read', group: 'flows' },
  { id: 'flows.write', group: 'flows' },
  { id: 'automations.read', group: 'automations' },
  { id: 'automations.write', group: 'automations' },
  { id: 'variables.read', group: 'variables' },
  { id: 'variables.write', group: 'variables' },
  { id: 'plugins.read', group: 'plugins' },
  { id: 'plugins.install', group: 'plugins' },
  { id: 'settings.read', group: 'system' },
  { id: 'batch.write', group: 'system' },
  { id: 'history.read', group: 'system' },
  { id: 'history.write', group: 'system' },
]

const TOKENS = [
  { id: 't1', name: 'admin', prefix: 'ldmcp_abcd…', createdAt: Date.now(), scopes: SCOPES.map((s) => s.id) },
  { id: 't2', name: 'lector', prefix: 'ldmcp_efgh…', createdAt: Date.now(), scopes: ['buttons.read', 'variables.read'] },
]

const baseProps = {
  mcpUrl: 'http://127.0.0.1:3001/api/v1/mcp',
  mcpTokens: TOKENS,
  mcpSecret: null,
  mcpScopes: SCOPES,
}

describe('McpPane', () => {
  it('muestra tokens con sus permisos y el aviso de admin', () => {
    const wrapper = mount(McpPane, { props: baseProps })
    expect(wrapper.find('[data-cy="bd-mcp"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('admin')
    expect(wrapper.text()).toContain('lector')
    expect(wrapper.text()).toContain('bd.mcpAdminWarning')
    // El lector muestra sus 2 permisos como chips
    expect(wrapper.text()).toContain('variables.read')
  })

  it('el catálogo incluye las herramientas nuevas (widgets/flows/autos/vars/batch/undo)', () => {
    const wrapper = mount(McpPane, { props: baseProps })
    const html = wrapper.html()
    for (const tool of [
      'create_widget', 'list_widgets',
      'create_flow', 'execute_flow',
      'create_automation', 'set_automation_enabled',
      'set_variable', 'list_variables',
      'execute_batch', 'get_history', 'undo_last', 'clear_history',
      'create_profile', 'press_button', 'install_plugin',
    ]) {
      expect(html).toContain(tool)
    }
    // Grupos nuevos presentes
    expect(html).toContain('bd.mcpGroupWidgets')
    expect(html).toContain('bd.mcpGroupFlows')
    expect(html).toContain('bd.mcpGroupAutomations')
    expect(html).toContain('bd.mcpGroupVariables')
  })

  it('el filtro del catálogo acota por nombre', async () => {
    const wrapper = mount(McpPane, { props: baseProps })
    const search = wrapper.find('input[type="search"]')
    await search.setValue('undo_last')
    const html = wrapper.html()
    expect(html).toContain('undo_last')
    expect(html).not.toContain('create_widget')
  })

  it('crear token emite nombre + scopes marcados', async () => {
    const wrapper = mount(McpPane, { props: baseProps })
    await wrapper.find('#bd-mcp-tname').setValue('claude')
    await wrapper.find('[data-cy="bd-mcp-generate-copy"]').trigger('click')
    const emitted = wrapper.emitted('create-mcp-token')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('claude')
    // Por defecto todo marcado → incluye los nuevos permisos
    expect(emitted![0][1]).toContain('widgets.write')
    expect(emitted![0][1]).toContain('flows.write')
    expect(emitted![0][1]).toContain('automations.write')
    expect(emitted![0][1]).toContain('variables.write')
    expect(emitted![0][1]).toContain('batch.write')
    expect(emitted![0][1]).toContain('history.write')
  })

  it('editar permisos y guardar emite el patch', async () => {
    const wrapper = mount(McpPane, { props: baseProps })
    const editBtns = wrapper.findAll('button').filter((b) => b.text() === 'bd.mcpEditScopes')
    expect(editBtns.length).toBeGreaterThan(0)
    await editBtns[0].trigger('click')
    await flushPromises()
    const save = wrapper.findAll('button').find((b) => b.text() === 'bd.mcpSave')
    expect(save).toBeTruthy()
    await save!.trigger('click')
    const emitted = wrapper.emitted('update-mcp-token')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('t1')
    expect(emitted![0][1]).toHaveProperty('scopes')
  })

  it('revocar emite el id del token', async () => {
    const wrapper = mount(McpPane, { props: baseProps })
    const revoke = wrapper.findAll('button').find((b) => b.text() === 'bd.remove')
    expect(revoke).toBeTruthy()
    await revoke!.trigger('click')
    expect(wrapper.emitted('revoke-mcp-token')![0]).toEqual(['t1'])
  })

  it('sin tokens muestra el hint de vacío', () => {
    const wrapper = mount(McpPane, { props: { ...baseProps, mcpTokens: [] } })
    expect(wrapper.text()).toContain('bd.mcpNoTokens')
  })
})
