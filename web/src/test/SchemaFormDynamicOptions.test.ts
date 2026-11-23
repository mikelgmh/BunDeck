import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SchemaForm from '../components/SchemaForm.vue'

const schema: any = {
  type: 'object',
  properties: {
    entityId: {
      type: 'string',
      title: 'Entidad',
      ui: { component: 'input', type: 'text', placeholder: 'light.salon' }
    },
    action: {
      type: 'string',
      title: 'Acción',
      ui: {
        component: 'select',
        options: [
          { value: 'toggle', label: 'Alternar' },
          { value: 'on', label: 'Encender' },
          { value: 'off', label: 'Apagar' },
          { value: 'open', label: 'Abrir (persiana)' },
          { value: 'set-climate', label: 'Ajustar clima' },
          { value: 'read', label: 'Leer estado' }
        ]
      }
    }
  },
  required: ['entityId']
}

const entityOptions = [
  { value: 'light.comedor', label: 'Comedor (light.comedor)', domain: 'light', state: 'on', actions: ['toggle', 'on', 'off', 'read'] },
  { value: 'cover.salon', label: 'Persiana salón (cover.salon)', domain: 'cover', state: 'closed', actions: ['toggle', 'on', 'off', 'open', 'close', 'stop', 'set-position', 'read'] }
]

function mockFetchOk() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, options: entityOptions, count: 2 })
  }))
}

const dynProps = {
  schema,
  modelValue: { entityId: 'light.comedor', action: 'toggle' },
  pluginId: 'homeassistant',
  actionId: 'entity',
  dynamicOptions: { field: 'entityId', sourceAction: 'entity-list', cacheMs: 30000 }
}

describe('SchemaForm opciones dinámicas (optionsFrom)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('carga la lista al montar y muestra estado + acciones de la entidad', async () => {
    const fetchMock = mockFetchOk()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(SchemaForm, { props: { ...dynProps } })
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/v1\/plugins\/action-options$/)
    expect(JSON.parse(String(init.body))).toMatchObject({
      pluginId: 'homeassistant',
      actionId: 'entity',
      field: 'entityId'
    })

    // Combobox con datalist.
    const input = wrapper.find('input#sf-entityId')
    expect(input.exists()).toBe(true)
    expect(input.attributes('list')).toBeTruthy()
    const listId = String(input.attributes('list'))
    const dataOptions = wrapper.find(`datalist#${listId}`).findAll('option')
    expect(dataOptions.map((o) => o.attributes('value'))).toEqual(['light.comedor', 'cover.salon'])

    // Pista con estado y acciones compatibles.
    expect(wrapper.text()).toContain('estado: on')
    expect(wrapper.text()).toContain('Alternar')
    expect(wrapper.text()).toContain('Leer estado')
  })

  it('filtra el select de acción a las compatibles con la entidad', async () => {
    vi.stubGlobal('fetch', mockFetchOk())
    const wrapper = mount(SchemaForm, {
      props: { ...dynProps, modelValue: { entityId: 'cover.salon', action: 'toggle' } }
    })
    await flushPromises()

    const values = wrapper.find('select#sf-action').findAll('option').map((o) => o.attributes('value'))
    // Vacío + compatibles de cover; ni set-climate ni read filtrado (read sí es compatible).
    expect(values).toContain('open')
    expect(values).toContain('toggle')
    expect(values).toContain('read')
    expect(values).not.toContain('set-climate')
  })

  it('avisa si la acción elegida no es compatible con la entidad', async () => {
    vi.stubGlobal('fetch', mockFetchOk())
    const wrapper = mount(SchemaForm, {
      props: { ...dynProps, modelValue: { entityId: 'light.comedor', action: 'open' } }
    })
    await flushPromises()
    expect(wrapper.text()).toContain('no es compatible con light.comedor')
  })

  it('si la lista falla, deja escribir a mano y lo indica', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: false, error: 'Token inválido (401)' })
    })))
    const wrapper = mount(SchemaForm, { props: { ...dynProps } })
    await flushPromises()

    expect(wrapper.text()).toContain('escribir el valor a mano')
    const input = wrapper.find('input#sf-entityId')
    expect(input.exists()).toBe(true)
    await input.setValue('light.manual')
    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
  })

  it('sin dynamicOptions renderiza el input de texto clásico', async () => {
    vi.stubGlobal('fetch', mockFetchOk())
    const wrapper = mount(SchemaForm, { props: { schema, modelValue: {} } })
    await flushPromises()
    expect(fetch).not.toHaveBeenCalled()
    expect(wrapper.find('input#sf-entityId').attributes('list')).toBeUndefined()
  })
})
