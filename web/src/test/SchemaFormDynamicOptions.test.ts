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

    // Combobox con buscador + lista lazy (acotada a N visibles).
    const input = wrapper.find('input#sf-entityId')
    expect(input.exists()).toBe(true)
    expect(input.attributes('role')).toBe('combobox')
    await input.setValue('')
    await input.trigger('focus')
    const list = wrapper.find('[data-cy="sf-dyn-list"]')
    expect(list.exists()).toBe(true)
    const dataOptions = wrapper.findAll('[data-cy="sf-dyn-opt"]')
    expect(dataOptions.map((o) => o.attributes('data-value'))).toEqual(['light.comedor', 'cover.salon'])
    // Sin paginar con pocas opciones: no hay boton de mostrar mas.
    expect(wrapper.find('[data-cy="sf-dyn-more"]').exists()).toBe(false)

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

describe('SchemaForm selector lazy (muchas entidades)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  function manyList(n: number) {
    const out = []
    for (let i = 0; i < n; i++) {
      out.push({ value: `light.luz_${i}`, label: `Luz ${i} (light.luz_${i})`, domain: 'light', state: 'on', actions: ['toggle', 'on', 'off', 'read'] })
    }
    return out
  }

  it('acota el DOM a N visibles y pagina con Mostrar mas', async () => {
    const options = manyList(120)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, options, count: options.length })
    })))
    const wrapper = mount(SchemaForm, { props: { ...dynProps, modelValue: { entityId: '' } } })
    await flushPromises()
    await wrapper.find('input#sf-entityId').trigger('focus')
    expect(wrapper.findAll('[data-cy="sf-dyn-opt"]')).toHaveLength(50)
    const more = wrapper.find('[data-cy="sf-dyn-more"]')
    expect(more.exists()).toBe(true)
    expect(more.text()).toContain('70 restantes')
    await more.trigger('click')
    expect(wrapper.findAll('[data-cy="sf-dyn-opt"]')).toHaveLength(100)
    wrapper.unmount()
  })

  it('filtra por texto y elige sin recargar la lista', async () => {
    const options = manyList(120)
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, options, count: options.length })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(SchemaForm, { props: { ...dynProps, modelValue: { entityId: '' } } })
    await flushPromises()
    const input = wrapper.find('input#sf-entityId')
    await input.setValue('luz_1')
    await wrapper.setProps({ modelValue: { entityId: 'luz_1' } })
    await flushPromises()
    // luz_1, luz_10-19, luz_100-119 = 31 coincidencias, sin paginar.
    const shown = wrapper.findAll('[data-cy="sf-dyn-opt"]').map((o) => o.attributes('data-value'))
    expect(shown).toHaveLength(31)
    expect(shown).toContain('light.luz_1')
    expect(shown).toContain('light.luz_119')
    expect(wrapper.find('[data-cy="sf-dyn-more"]').exists()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Elegir fija el valor y cierra la lista.
    await wrapper.findAll('[data-cy="sf-dyn-opt"]')[0].trigger('click')
    const emitted = wrapper.emitted('update:modelValue') ?? []
    expect(emitted.at(-1)?.[0]).toMatchObject({ entityId: 'light.luz_1' })
    expect(wrapper.find('[data-cy="sf-dyn-list"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('SchemaForm visibilidad condicional por dominio', () => {
  const haSchema: any = {
    type: 'object',
    properties: {
      entityId: {
        type: 'string',
        title: 'Entidad',
        ui: { component: 'input', type: 'text', placeholder: 'light.salon' }
      },
      action: {
        type: 'string',
        title: 'Accion',
        ui: { component: 'select', options: [{ value: 'toggle', label: 'Alternar' }] }
      },
      brightness: {
        type: 'integer', title: 'Brillo',
        ui: { component: 'input', type: 'number', placeholder: '255' },
        visibleWhen: { field: 'entityId', domains: ['light'] }
      },
      colorTemp: {
        type: 'integer', title: 'Temperatura de color',
        ui: { component: 'input', type: 'number', placeholder: '4000' },
        visibleWhen: { field: 'entityId', domains: ['light'] }
      },
      position: {
        type: 'integer', title: 'Posicion',
        ui: { component: 'input', type: 'number', placeholder: '50' },
        visibleWhen: { field: 'entityId', domains: ['cover'] }
      },
      hvacMode: {
        type: 'string', title: 'Modo',
        ui: { component: 'select', options: [{ value: 'heat', label: 'Calor' }] },
        visibleWhen: { field: 'entityId', domains: ['climate'] }
      },
      temperature: {
        type: 'number', title: 'Temperatura',
        ui: { component: 'input', type: 'number', placeholder: '21' },
        visibleWhen: { field: 'entityId', domains: ['climate'] }
      }
    },
    required: ['entityId']
  }

  const haProps = (entityId: string) => ({
    schema: haSchema,
    modelValue: { entityId },
    pluginId: 'homeassistant',
    actionId: 'entity',
    dynamicOptions: null
  })

  it('muestra solo los campos del dominio (metadata visibleWhen)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    const light = mount(SchemaForm, { props: haProps('light.salon') })
    expect(light.find('input#sf-brightness').exists()).toBe(true)
    expect(light.find('input#sf-colorTemp').exists()).toBe(true)
    expect(light.find('input#sf-position').exists()).toBe(false)
    expect(light.find('select#sf-hvacMode').exists()).toBe(false)
    expect(light.find('input#sf-temperature').exists()).toBe(false)
    light.unmount()

    const cover = mount(SchemaForm, { props: haProps('cover.salon') })
    expect(cover.find('input#sf-position').exists()).toBe(true)
    expect(cover.find('input#sf-brightness').exists()).toBe(false)
    expect(cover.find('select#sf-hvacMode').exists()).toBe(false)
    cover.unmount()

    const climate = mount(SchemaForm, { props: haProps('climate.salon') })
    expect(climate.find('select#sf-hvacMode').exists()).toBe(true)
    expect(climate.find('input#sf-temperature').exists()).toBe(true)
    expect(climate.find('input#sf-brightness').exists()).toBe(false)
    expect(climate.find('input#sf-position').exists()).toBe(false)
    climate.unmount()
  })

  it('fallback: sin entidad o dominio desconocido muestra todo', () => {
    for (const entityId of ['', 'fan.techo', 'sensor.temperatura']) {
      const w = mount(SchemaForm, { props: haProps(entityId) })
      // sensor solo oculta sus propios campos? sensor no tiene campos extra: todo visible salvo nada.
      // Para '' y 'fan.techo' (desconocido): todos los condicionales visibles.
      if (entityId !== 'sensor.temperatura') {
        expect(w.find('input#sf-brightness').exists()).toBe(true)
        expect(w.find('input#sf-position').exists()).toBe(true)
        expect(w.find('select#sf-hvacMode').exists()).toBe(true)
        expect(w.find('input#sf-temperature').exists()).toBe(true)
      } else {
        // Dominio conocido sin campos: ningun condicional visible, pero entidad/accion si.
        expect(w.find('input#sf-brightness').exists()).toBe(false)
        expect(w.find('input#sf-position').exists()).toBe(false)
        expect(w.find('select#sf-hvacMode').exists()).toBe(false)
        expect(w.find('input#sf-entityId').exists()).toBe(true)
      }
      w.unmount()
    }
  })

  it('fallback sin metadata: tabla dominio->campos integrada', () => {
    const noMeta = JSON.parse(JSON.stringify(haSchema))
    for (const k of ['brightness', 'colorTemp', 'position', 'hvacMode', 'temperature']) {
      delete noMeta.properties[k].visibleWhen
    }
    const w = mount(SchemaForm, {
      props: { schema: noMeta, modelValue: { entityId: 'light.salon' }, pluginId: 'homeassistant', actionId: 'entity', dynamicOptions: null }
    })
    expect(w.find('input#sf-brightness').exists()).toBe(true)
    expect(w.find('input#sf-temperature').exists()).toBe(false)
    w.unmount()
  })

  it('reacciona al cambiar de entidad', async () => {
    const w = mount(SchemaForm, { props: haProps('light.salon') })
    expect(w.find('input#sf-brightness').exists()).toBe(true)
    await w.setProps({ modelValue: { entityId: 'cover.salon' } })
    expect(w.find('input#sf-brightness').exists()).toBe(false)
    expect(w.find('input#sf-position').exists()).toBe(true)
    w.unmount()
  })
})

describe('SchemaForm selector rendimiento (3000 entidades)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('DOM acotado y tecla rapida', async () => {
    const options = []
    for (let i = 0; i < 3000; i++) {
      options.push({ value: `light.luz_${i}`, label: `Luz ${i}`, domain: 'light', state: 'on', actions: ['read'] })
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, options, count: options.length })
    })))
    const wrapper = mount(SchemaForm, { props: { ...dynProps, modelValue: { entityId: '' } } })
    await flushPromises()
    await wrapper.find('input#sf-entityId').trigger('focus')
    // ANTES (datalist): 3000 nodos. AHORA: 50 como maximo.
    expect(wrapper.findAll('[data-cy="sf-dyn-opt"]')).toHaveLength(50)
    const t0 = performance.now()
    await wrapper.find('input#sf-entityId').setValue('luz_2999')
    await wrapper.setProps({ modelValue: { entityId: 'luz_2999' } })
    await flushPromises()
    const dt = performance.now() - t0
    console.log(`DESPUES: tecla filtrando 3000 = ${dt.toFixed(1)}ms`)
    expect(wrapper.findAll('[data-cy="sf-dyn-opt"]').map((o) => o.attributes('data-value'))).toEqual(['light.luz_2999'])
    expect(dt).toBeLessThan(1500)
    wrapper.unmount()
  })
})
