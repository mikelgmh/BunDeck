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
const mockStatus = ref<Record<string, unknown>>({ tunnel: { status: 'connected' } })

vi.mock('../composables/useRemote', () => ({
  useRemote: () => ({
    uiEnabled: ref(true),
    uiUnsupported: ref(false),
    uiLoading: ref(false),
    uiError: ref(''),
    uiCode: ref({ code: '482913', urlCode: 'AbC123xYz', url: UI_URL, expiresAt: Date.now() + 60000 }),
    uiCodeDataUrl: ref('data:image/png;base64,QR'),
    uiPending: mockPending,
    uiSessions: ref([]),
    status: mockStatus,
    requestUiCode: vi.fn(),
    loadUiPending: vi.fn(async () => []),
    loadUiSessions: vi.fn(async () => []),
    allowPending: vi.fn(),
    denyPending: vi.fn(),
    setUiEnabled: vi.fn(),
    refresh: vi.fn(async () => {}),
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    onRemoteEvent: vi.fn(() => vi.fn()),
  }),
}))

// jsdom no implementa showModal/close de <dialog>: stub.
function stubDialog(el: HTMLDialogElement | null) {
  if (!el) return
  ;(el as any).showModal = vi.fn()
  ;(el as any).close = vi.fn()
  try {
    Object.defineProperty(el, 'open', { value: true, configurable: true })
  } catch {
    /* noop */
  }
}

const realClipboard = navigator.clipboard

beforeEach(() => {
  mockPending.value = []
  mockStatus.value = { tunnel: { status: 'connected' } }
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
})
