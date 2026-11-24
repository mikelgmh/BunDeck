import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import {
  ensureNoSleepVideo,
  isWakeLockSupported,
  NO_SLEEP_MP4,
  useKioskWakeLock,
} from '../composables/useKioskWakeLock'

const VIDEO_ID = 'bd-nosleep-video'

function mountWake(initial: boolean) {
  let api: ReturnType<typeof useKioskWakeLock> & { kiosk: ReturnType<typeof ref<boolean>> }
  const Comp = defineComponent({
    setup() {
      const kiosk = ref(initial)
      const wake = useKioskWakeLock(kiosk)
      api = { kiosk, ...wake }
      return () => h('div')
    },
  })
  const wrapper = mount(Comp, { attachTo: document.body })
  // @ts-expect-error asignado en setup
  return { wrapper, api }
}

describe('isWakeLockSupported', () => {
  it('true con wakeLock.request función', () => {
    expect(isWakeLockSupported({ wakeLock: { request: async () => {} } })).toBe(true)
  })
  it('false sin wakeLock o sin request', () => {
    expect(isWakeLockSupported({} as never)).toBe(false)
    expect(isWakeLockSupported({ wakeLock: {} } as never)).toBe(false)
    expect(isWakeLockSupported(undefined)).toBe(false)
  })
})

describe('ensureNoSleepVideo', () => {
  afterEach(() => {
    document.getElementById(VIDEO_ID)?.remove()
  })

  it('crea el vídeo con fuente mp4 y es idempotente', () => {
    const v1 = ensureNoSleepVideo()
    expect(v1).not.toBeNull()
    expect(v1!.id).toBe(VIDEO_ID)
    expect(v1!.querySelector('source')?.getAttribute('src')).toBe(NO_SLEEP_MP4)
    expect(v1!.hasAttribute('playsinline')).toBe(true)
    const v2 = ensureNoSleepVideo()
    expect(v2).toBe(v1)
    expect(document.querySelectorAll(`#${VIDEO_ID}`).length).toBe(1)
  })
})

describe('useKioskWakeLock', () => {
  let playMock: ReturnType<typeof vi.fn>
  let pauseMock: ReturnType<typeof vi.fn>
  let origPlay: unknown
  let origPause: unknown

  beforeEach(() => {
    origPlay = HTMLMediaElement.prototype.play
    origPause = HTMLMediaElement.prototype.pause
    playMock = vi.fn(async () => {})
    pauseMock = vi.fn(() => {})
    HTMLMediaElement.prototype.play = playMock as never
    HTMLMediaElement.prototype.pause = pauseMock as never
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    HTMLMediaElement.prototype.play = origPlay as never
    HTMLMediaElement.prototype.pause = origPause as never
    document.getElementById(VIDEO_ID)?.remove()
  })

  it('vía Wake Lock: pide screen y queda en wake-lock', async () => {
    const release = vi.fn()
    const request = vi.fn(async () => ({
      release,
      addEventListener: vi.fn(),
    }))
    vi.stubGlobal('navigator', { wakeLock: { request } })
    const { wrapper, api } = mountWake(true)
    await flushPromises()
    await flushPromises()
    expect(request).toHaveBeenCalledWith('screen')
    expect(api.wakeStatus.value).toBe('wake-lock')
    // Salir del kiosco libera y apaga.
    api.kiosk.value = false
    await flushPromises()
    expect(release).toHaveBeenCalled()
    expect(api.wakeStatus.value).toBe('off')
    wrapper.unmount()
  })

  it('sin Wake Lock: cae al vídeo (fallback iPads antiguos)', async () => {
    vi.stubGlobal('navigator', {})
    const { wrapper, api } = mountWake(true)
    await flushPromises()
    await flushPromises()
    expect(playMock).toHaveBeenCalled()
    expect(api.wakeStatus.value).toBe('video')
    api.kiosk.value = false
    await flushPromises()
    expect(pauseMock).toHaveBeenCalled()
    expect(api.wakeStatus.value).toBe('off')
    wrapper.unmount()
  })

  it('si el vídeo falla: unsupported sin lanzar', async () => {
    vi.stubGlobal('navigator', {})
    playMock.mockRejectedValueOnce(new Error('denied'))
    const { wrapper, api } = mountWake(true)
    await flushPromises()
    await flushPromises()
    expect(api.wakeStatus.value).toBe('unsupported')
    wrapper.unmount()
  })

  it('fuera de kiosco no pide nada', async () => {
    const request = vi.fn(async () => ({ release: vi.fn(), addEventListener: vi.fn() }))
    vi.stubGlobal('navigator', { wakeLock: { request } })
    const { wrapper, api } = mountWake(false)
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(playMock).not.toHaveBeenCalled()
    expect(api.wakeStatus.value).toBe('off')
    wrapper.unmount()
  })
})
