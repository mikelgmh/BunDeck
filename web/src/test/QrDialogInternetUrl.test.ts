import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import QrDialog from '../components/bundeck/QrDialog.vue'

vi.mock('../composables/useI18n', () => ({
  useI18nStore: () => ({
    t: (key: string) => key,
  }),
}))

const UI_URL = 'https://relay.example.test/ui/AbC123xYz'

const mockPending = ref<Array<Record<string, unknown>>>([])
const mockSessions = ref<Array<Record<string, unknown>>>([])
const mockStatus = ref<Record<string, unknown>>({ tunnel: { status: 'connected' } })
const mockAllowPending = vi.fn(async () => 'abcdef12RESTOFTOKEN')
const mockSetSessionDeviceName = vi.fn(async () => {})
const mockDenyPending = vi.fn(async () => {})
const mockRequestUiCode = vi.fn(async () => ({ code: '000000', urlCode: 'NewCode123', url: 'https://relay.example.test/ui/NewCode123', expiresAt: Date.now() + 600000 }))
const mockLoadUiPending = vi.fn(async () => [])
const mockLoadUiSessions = vi.fn(async () => [])

vi.mock('../composables/useRemote', () => ({
  useRemote: () => ({
    uiEnabled: ref(true),
    uiUnsupported: ref(false),
    uiLoading: ref(false),
    uiError: ref(''),
    uiCode: ref({ code: '482913', urlCode: 'AbC123xYz', url: UI_URL, expiresAt: Date.now() + 60000 }),
    uiCodeDataUrl: ref('data:image/png;base64,QR'),
    uiPending: mockPending,
    uiSessions: mockSessions,
    status: mockStatus,
    requestUiCode: mockRequestUiCode,
    loadUiPending: mockLoadUiPending,
    loadUiSessions: mockLoadUiSessions,
    allowPending: mockAllowPending,
    denyPending: mockDenyPending,
    setSessionDeviceName: mockSetSessionDeviceName,
    setUiEnabled: vi.fn(),
    refresh: vi.fn(async () => {}),
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    onRemoteEvent: vi.fn(() => vi.fn()),
  }),
}))

// jsdom no implementa showModal/close de <dialog>: stub. Los espías quedan
// en el elemento (__showModal/__close) para asertar aperturas y cierres.
function stubDialog(el: HTMLDialogElement | null) {
  if (!el) return
  const showModal = vi.fn()
  const close = vi.fn()
  ;(el as any).showModal = showModal
  ;(el as any).close = close
  ;(el as any).__showModal = showModal
  ;(el as any).__close = close
  try {
    Object.defineProperty(el, 'open', { value: true, configurable: true })
  } catch {
    /* noop */
  }
}

function dialogSpies(wrapper: unknown, index = 0) {
  const dialogs = (wrapper as { findAll: (s: string) => Array<{ element: unknown }> }).findAll('dialog')
  const el = dialogs[index]?.element as (HTMLDialogElement & { __showModal?: unknown; __close?: unknown }) | undefined
  return { showModal: el?.__showModal as { mock: { calls: unknown[] } } | undefined, close: el?.__close as ReturnType<typeof vi.fn> | undefined }
}

const realClipboard = navigator.clipboard

beforeEach(() => {
  mockPending.value = []
  mockSessions.value = []
  mockStatus.value = { tunnel: { status: 'connected' } }
  mockAllowPending.mockReset()
  mockAllowPending.mockResolvedValue('abcdef12RESTOFTOKEN')
  mockSetSessionDeviceName.mockClear()
  mockDenyPending.mockReset()
  mockDenyPending.mockResolvedValue(undefined)
  mockRequestUiCode.mockClear()
  mockLoadUiPending.mockReset()
  mockLoadUiPending.mockResolvedValue([])
  mockLoadUiSessions.mockReset()
  mockLoadUiSessions.mockResolvedValue([])
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}) },
    configurable: true,
  })
})

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: realClipboard, configurable: true })
  vi.restoreAllMocks()
})

describe('QrDialog pestaña internet: URL visible sin cámara', () => {
  it('muestra el enlace de acceso en texto además del QR', async () => {
    const wrapper = mount(QrDialog)
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show()
    await flushPromises()

    // Pestaña internet por defecto.
    expect(wrapper.find('[data-cy="qr-tab-internet"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="qr-internet-img"]').exists()).toBe(true)

    const input = wrapper.find('[data-cy="qr-internet-url"]')
    expect(input.exists()).toBe(true)
    // El enlace lleva ?kiosk=1 como el QR (mismo que copia el botón).
    expect((input.element as HTMLInputElement).value).toBe(`${UI_URL}?kiosk=1`)
    wrapper.unmount()
  })

  it('el botón copiar usa la misma URL visible', async () => {
    const wrapper = mount(QrDialog)
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show()
    await flushPromises()

    await wrapper.find('[data-cy="qr-internet-copy"]').trigger('click')
    await flushPromises()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${UI_URL}?kiosk=1`)
    wrapper.unmount()
  })

  it('el diálogo de aprobar anuncia la política de transporte', async () => {
    const wrapper = mount(QrDialog)
    // showModal no existe en jsdom: stub + propiedad open para activar el flujo.
    wrapper.findAll('dialog').forEach((d) => stubDialog(d.element as HTMLDialogElement))
    await (wrapper.vm as any).show()
    await flushPromises()
    // El pendiente llega despues: el watcher lo pone en cola y abre el dialogo.
    mockPending.value = [{ reqId: 'req-9', urlCode: 'AbC123xYz', ua: 'iPad', ip: '9.9.9.9', createdAt: Date.now() }]
    await flushPromises()
    // Al llegar el pendiente se muestra el contenido de aprobación.
    expect(wrapper.find('[data-cy="qr-internet-approval-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-cy="qr-internet-approval-transport"]').text()).toBe(
      'bd.remoteUiTransportNotice'
    )
    wrapper.unmount()
  })

  it('avisa si el túnel no está conectado (el QR caducaría en el móvil)', async () => {
    mockStatus.value = { tunnel: { status: 'disconnected' } }
    const wrapper = mount(QrDialog)
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show()
    await flushPromises()

    expect(wrapper.find('[data-cy="qr-internet-tunnel-down"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('no avisa si el túnel está conectado', async () => {
    const wrapper = mount(QrDialog)
    stubDialog(wrapper.find('dialog').element as HTMLDialogElement)
    await (wrapper.vm as any).show()
    await flushPromises()

    expect(wrapper.find('[data-cy="qr-internet-tunnel-down"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('aprobar muestra la vista de éxito con nombre y Guardar lo persiste', async () => {
    const wrapper = mount(QrDialog)
    wrapper.findAll('dialog').forEach((d) => stubDialog(d.element as HTMLDialogElement))
    await (wrapper.vm as any).show()
    await flushPromises()
    const IPAD_UA =
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    mockPending.value = [{ reqId: 'req-9', urlCode: 'AbC123xYz', ua: IPAD_UA, ip: '9.9.9.9', createdAt: Date.now() }]
    await flushPromises()

    await wrapper.find('[data-cy="qr-internet-approval-allow"]').trigger('click')
    await flushPromises()

    expect(mockAllowPending).toHaveBeenCalledWith('req-9')
    // Vista de éxito: sin vista aprobar/denegar, con input pre-rellenado.
    expect(wrapper.find('[data-cy="qr-internet-approval-allow"]').exists()).toBe(false)
    const input = wrapper.find('[data-cy="remote-ui-device-name"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('iPad Safari')
    const save = wrapper.find('[data-cy="qr-internet-approval-save"]')
    expect(save.exists()).toBe(true)
    expect((save.element as HTMLButtonElement).disabled).toBe(false)

    await save.trigger('click')
    await flushPromises()

    // El mock devuelve sessionToken: el componente deriva prefix slice(0,8).
    expect(mockSetSessionDeviceName).toHaveBeenCalledWith('abcdef12', 'iPad Safari')
    expect(wrapper.emitted('notify')).toBeTruthy()
    wrapper.unmount()
  })

  it('Guardar deshabilitado si el nombre está vacío', async () => {
    const wrapper = mount(QrDialog)
    wrapper.findAll('dialog').forEach((d) => stubDialog(d.element as HTMLDialogElement))
    await (wrapper.vm as any).show()
    await flushPromises()
    mockPending.value = [{ reqId: 'req-10', urlCode: 'AbC123xYz', ua: 'iPad', ip: '9.9.9.9', createdAt: Date.now() }]
    await flushPromises()

    await wrapper.find('[data-cy="qr-internet-approval-allow"]').trigger('click')
    await flushPromises()

    const input = wrapper.find('[data-cy="remote-ui-device-name"]')
    expect(input.exists()).toBe(true)
    await input.setValue('   ')
    await flushPromises()
    expect((wrapper.find('[data-cy="qr-internet-approval-save"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(mockSetSessionDeviceName).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('REGRESIÓN BUG2: el poll durante el allow en vuelo no cierra ni impide la vista de éxito', async () => {
    // Interleaving: click en aprobar → POST allow en vuelo → el poll de 5 s
    // (u otra pestaña) observa la sesión nueva ANTES de que vuelva el token.
    // Sin el guard (approvedSession/approvingReqId) el diálogo se cerraba
    // por detrás y la vista de éxito jamás aparecía.
    let resolveAllow!: (token: string) => void
    mockAllowPending.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveAllow = resolve })
    )
    const wrapper = mount(QrDialog)
    wrapper.findAll('dialog').forEach((d) => stubDialog(d.element as HTMLDialogElement))
    await (wrapper.vm as any).show()
    await flushPromises()
    mockPending.value = [{ reqId: 'req-race', urlCode: 'AbC123xYz', ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', ip: '9.9.9.9', createdAt: Date.now() }]
    await flushPromises()
    await flushPromises()

    const approvalClose = dialogSpies(wrapper, 1).close
    expect(approvalClose).toBeTruthy()

    await wrapper.find('[data-cy="qr-internet-approval-allow"]').trigger('click')
    await flushPromises()
    await flushPromises()

    // El allow sigue en vuelo: el diálogo de aprobación NO se ha cerrado
    // (el watcher de activeApprovalId respeta approvingReqId).
    expect(approvalClose!.mock.calls.length).toBe(0)

    // El poll ve la sesión recién creada en el servidor mientras el POST
    // sigue en vuelo: no debe cerrar ni notificar.
    mockSessions.value = [{ tokenPrefix: 'abcdef12', createdAt: Date.now(), exp: Date.now() + 3600_000, ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', ip: '9.9.9.9', revoked: false }]
    await flushPromises()
    await flushPromises()
    expect(wrapper.emitted('notify')).toBeFalsy()
    expect(approvalClose!.mock.calls.length).toBe(0)
    expect(wrapper.find('[data-cy="remote-ui-device-name"]').exists()).toBe(false)

    // Vuelve el token: aparece la vista de éxito (no un cierre).
    resolveAllow('abcdef12RESTOFTOKEN')
    await flushPromises()
    await flushPromises()
    const input = wrapper.find('[data-cy="remote-ui-device-name"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('iPad Safari')
    expect(approvalClose!.mock.calls.length).toBe(0)
    wrapper.unmount()
  })

  it('REGRESIÓN BUG3: tras aprobar, el contador de pendientes baja a 0', async () => {
    // El componente refresca pendientes al decidir (sin esperar al poll):
    // el servidor ya no lista el reqId y `qr-internet-pending` desaparece.
    mockLoadUiPending.mockImplementation(async () => {
      mockPending.value = []
      return []
    })
    const wrapper = mount(QrDialog)
    wrapper.findAll('dialog').forEach((d) => stubDialog(d.element as HTMLDialogElement))
    await (wrapper.vm as any).show()
    await flushPromises()
    mockPending.value = [{ reqId: 'req-20', urlCode: 'AbC123xYz', ua: 'iPad', ip: '9.9.9.9', createdAt: Date.now() }]
    await flushPromises()
    expect(wrapper.find('[data-cy="qr-internet-pending"]').exists()).toBe(true)

    await wrapper.find('[data-cy="qr-internet-approval-allow"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(mockAllowPending).toHaveBeenCalledWith('req-20')
    expect(mockLoadUiPending).toHaveBeenCalled()
    expect(wrapper.find('[data-cy="qr-internet-pending"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('REGRESIÓN BUG3: tras denegar, el contador de pendientes baja a 0', async () => {
    mockLoadUiPending.mockImplementation(async () => {
      mockPending.value = []
      return []
    })
    const wrapper = mount(QrDialog)
    wrapper.findAll('dialog').forEach((d) => stubDialog(d.element as HTMLDialogElement))
    await (wrapper.vm as any).show()
    await flushPromises()
    mockPending.value = [{ reqId: 'req-21', urlCode: 'AbC123xYz', ua: 'iPad', ip: '9.9.9.9', createdAt: Date.now() }]
    await flushPromises()
    expect(wrapper.find('[data-cy="qr-internet-pending"]').exists()).toBe(true)

    await wrapper.find('[data-cy="qr-internet-approval-deny"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(mockDenyPending).toHaveBeenCalledWith('req-21')
    expect(mockLoadUiPending).toHaveBeenCalled()
    expect(wrapper.find('[data-cy="qr-internet-pending"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('denegar regenera el QR (el denegado ya no vale)', async () => {
    const wrapper = mount(QrDialog)
    wrapper.findAll('dialog').forEach((d) => stubDialog(d.element as HTMLDialogElement))
    await (wrapper.vm as any).show()
    await flushPromises()
    mockPending.value = [{ reqId: 'req-22', urlCode: 'AbC123xYz', ua: 'iPad', ip: '9.9.9.9', createdAt: Date.now() }]
    await flushPromises()

    await wrapper.find('[data-cy="qr-internet-approval-deny"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(mockDenyPending).toHaveBeenCalledWith('req-22')
    expect(mockRequestUiCode).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('aprobar regenera el QR (el aprobado es de un solo uso)', async () => {
    const wrapper = mount(QrDialog)
    wrapper.findAll('dialog').forEach((d) => stubDialog(d.element as HTMLDialogElement))
    await (wrapper.vm as any).show()
    await flushPromises()
    mockPending.value = [{ reqId: 'req-23', urlCode: 'AbC123xYz', ua: 'iPad', ip: '9.9.9.9', createdAt: Date.now() }]
    await flushPromises()

    await wrapper.find('[data-cy="qr-internet-approval-allow"]').trigger('click')
    await flushPromises()
    await flushPromises()

    expect(mockAllowPending).toHaveBeenCalledWith('req-23')
    expect(mockRequestUiCode).toHaveBeenCalled()
    wrapper.unmount()
  })
})
