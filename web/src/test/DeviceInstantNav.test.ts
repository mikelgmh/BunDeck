import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import StageBoard from '../components/bundeck/StageBoard.vue'
import { isNavigationForMe, isBroadcastNav } from '../utils/sessionRouting'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
    currentLocale: { value: 'es' },
    setLocale: () => {},
    loadSavedLocale: () => {},
  }),
}))

vi.mock('../composables/useKeyShare', () => ({
  assetUrl: () => '',
  isAssetRef: () => false,
}))

const gridPage = { id: 'g1', profile_id: 'p', name: 'Inicio', order_idx: 0, is_folder: 0, data: {} }
const pageB = { id: 'g2', profile_id: 'p', name: 'Secundaria', order_idx: 1, is_folder: 0, data: {} }

const baseProps = {
  gridCols: 5,
  gridRows: 3,
  selectedButton: null,
  executingButtons: [],
  buttonConfig: {},
  getButton: () => undefined,
  allButtons: [],
  getButtonData: () => null,
  mode: 'edit',
  labelMode: 'a',
  currentPages: [gridPage, pageB],
  currentPage: gridPage,
  navTrail: [],
  profileName: 'Principal',
  busy: false,
} as any

describe('StageBoard: el desplegable solo lista lo online', () => {
  it('muestra online y oculta offline (van a Acceso remoto)', async () => {
    const on = { id: 'm-on', name: 'iPad', kind: 'phone', model: null, cols: null, rows: null, hw_path: null, online: true, source: 'browser' }
    const off = { id: 'm-off', name: 'Móvil apagado', kind: 'phone', model: null, cols: null, rows: null, hw_path: null, online: false, source: 'browser' }
    const wrapper = mount(StageBoard, {
      props: { ...baseProps, devices: [off, on], assignments: {} },
    })
    await wrapper.find('[data-cy=bd-devices-btn]').trigger('click')
    // Solo el online; el offline se gestiona en Acceso remoto.
    expect(wrapper.find('[data-cy=bd-device-row-m-on]').exists()).toBe(true)
    expect(wrapper.find('[data-cy=bd-device-row-m-off]').exists()).toBe(false)
    // El badge cuenta solo lo visible.
    expect(wrapper.find('[data-cy=bd-devices-badge]').text()).toContain('1')
    wrapper.unmount()
  })
})

describe('page.navigate dirigido con profileId (iPad en otro perfil)', () => {
  it('el payload trae profileId y solo aplica al objetivo', () => {
    const payload = { pageId: 'g2', profileId: 'p', targetDeviceId: 'dev-ipad' }
    expect(isNavigationForMe(payload, 'dev-ipad')).toBe(true)
    expect(isNavigationForMe(payload, 'dev-host')).toBe(false)
  })

  it('broadcast sin destino sigue aplicando (compat)', () => {
    expect(isNavigationForMe({ pageId: 'g2', profileId: 'p' }, 'dev-ipad')).toBe(true)
  })
})

describe('isBroadcastNav: solo el broadcast toca el global', () => {
  it('dirigido a un dispositivo no es broadcast (no toca current.*)', () => {
    expect(isBroadcastNav({ pageId: 'g2', targetDeviceId: 'dev-ipad' })).toBe(false)
    expect(isBroadcastNav({ pageId: 'g2', target: 'dev-ipad' })).toBe(false)
    expect(isBroadcastNav({ pageId: 'g2', targets: ['dev-ipad'] })).toBe(false)
  })

  it('broadcast antiguo y all sí tocan el global (compat HW)', () => {
    expect(isBroadcastNav({ pageId: 'g2' })).toBe(true)
    expect(isBroadcastNav({ pageId: 'g2', target: 'all' })).toBe(true)
    expect(isBroadcastNav({ pageId: 'g2', targets: ['all'] })).toBe(true)
    expect(isBroadcastNav({ pageId: 'g2', broadcast: true })).toBe(true)
    expect(isBroadcastNav({ pageId: 'g2', targets: [] })).toBe(true)
  })
})
