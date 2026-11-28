import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  DEVICE_DISPLAY_DEFAULTS,
  clampHwBrightness,
  clampIdleMinutes,
  createWebIdleVeil,
  fetchDeviceDisplay,
  normalizeDeviceDisplay,
  saveDeviceDisplay,
  veilOpacityFor,
  webIdleMinutes,
  VEIL_MAX_OPACITY,
} from '../composables/useDeviceDisplay'
import BdIdleVeil from '../components/bundeck/BdIdleVeil.vue'

describe('pantalla por dispositivo (web)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    webIdleMinutes.value = DEVICE_DISPLAY_DEFAULTS.idleMinutes
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('1. clamp de brillo e idleMinutes', () => {
    expect(clampHwBrightness(1000)).toBe(100)
    expect(clampHwBrightness(-3)).toBe(0)
    expect(clampHwBrightness('abc')).toBe(DEVICE_DISPLAY_DEFAULTS.brightness)
    expect(clampIdleMinutes(0)).toBe(0)
    expect(clampIdleMinutes(-1)).toBe(0)
    expect(clampIdleMinutes(9999)).toBe(1440)
  })

  it('2. normalizeDeviceDisplay valida y defaultea', () => {
    expect(normalizeDeviceDisplay(null)).toEqual(DEVICE_DISPLAY_DEFAULTS)
    expect(normalizeDeviceDisplay({ brightness: 40, idleAction: 'CLOCK' })).toMatchObject({
      brightness: 40,
      idleAction: 'clock',
    })
    expect(normalizeDeviceDisplay({ idleAction: 'fiesta' }).idleAction).toBe(
      DEVICE_DISPLAY_DEFAULTS.idleAction,
    )
  })

  it('3. veilOpacityFor: 0 hasta la mitad, rampa, máximo, 0 = off', () => {
    expect(veilOpacityFor(10, 0)).toBe(0) // 0 minutos = velo desactivado
    expect(veilOpacityFor(-5, 15)).toBe(0)
    const idleMs = 10 * 60_000
    expect(veilOpacityFor(idleMs * 0.49, 10)).toBe(0)
    const mid = veilOpacityFor(idleMs * 0.75, 10)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(VEIL_MAX_OPACITY)
    expect(veilOpacityFor(idleMs, 10)).toBe(VEIL_MAX_OPACITY)
    expect(veilOpacityFor(idleMs * 5, 10)).toBe(VEIL_MAX_OPACITY)
  })

  it('4. el velo sube con la inactividad y poke lo resetea', () => {
    const veil = createWebIdleVeil(() => 10)
    veil.start()
    veil.tick(1_000_000 + 4 * 60_000) // 4 min < mitad de 10
    expect(veil.opacity.value).toBe(0)
    veil.tick(1_000_000 + 10 * 60_000)
    expect(veil.opacity.value).toBe(VEIL_MAX_OPACITY)
    expect(veil.resting.value).toBe(true)
    veil.poke()
    expect(veil.opacity.value).toBe(0)
    expect(veil.resting.value).toBe(false)
    veil.stop()
  })

  it('5. start escucha actividad y stop la retira', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const veil = createWebIdleVeil(() => 10)
    veil.start()
    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function), expect.anything())
    expect(add).toHaveBeenCalledWith('keydown', expect.any(Function))
    // Actividad real resetea: forzar velo y disparar pointerdown.
    veil.tick(1_000_000 + 10 * 60_000)
    expect(veil.opacity.value).toBe(VEIL_MAX_OPACITY)
    window.dispatchEvent(new Event('pointerdown'))
    expect(veil.opacity.value).toBe(0)
    veil.stop()
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function))
  })

  it('6. GET normaliza y propaga errores del daemon', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ brightness: 33 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const s = await fetchDeviceDisplay('http://x/api/v1', 'deck-A')
    expect(s.brightness).toBe(33)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/devices/streamdeck/display?device=deck-A'),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })),
    )
    await expect(fetchDeviceDisplay('http://x/api/v1', 'deck-A')).rejects.toThrow('nope')
  })

  it('7. POST envía device + patch y normaliza la respuesta', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ brightness: 60, idleMinutes: 5 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const s = await saveDeviceDisplay('http://x/api/v1', 'deck-A', { brightness: 60 })
    expect(s.brightness).toBe(60)
    const [, opts] = fetchMock.mock.calls[0] as any[]
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toMatchObject({ device: 'deck-A', brightness: 60 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'brightness debe ser un entero 0-100' }), { status: 400 })),
    )
    await expect(saveDeviceDisplay('http://x/api/v1', 'deck-A', { brightness: 'x' as any })).rejects.toThrow(
      /brightness/,
    )
  })

  it('8. BdIdleVeil aparece tras el reposo y el toque despierta', async () => {
    webIdleMinutes.value = 1
    const wrapper = mount(BdIdleVeil, { attachTo: document.body })
    expect(wrapper.find('[data-cy="bd-idle-veil"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(61_000)
    await wrapper.vm.$nextTick()
    const veil = wrapper.find('[data-cy="bd-idle-veil"]')
    expect(veil.exists()).toBe(true)
    expect(veil.attributes('style')).toContain(`opacity: ${VEIL_MAX_OPACITY}`)
    await veil.trigger('pointerdown')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-cy="bd-idle-veil"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('9. virgen: dim/idle desactivados por defecto (0/0)', () => {
    expect(DEVICE_DISPLAY_DEFAULTS).toMatchObject({
      brightness: 100,
      dimAfterSec: 0,
      idleMinutes: 0,
      idleAction: 'off',
    })
    // beforeEach lo deja en el default → el velo web arranca desactivado.
    expect(webIdleMinutes.value).toBe(0)
    expect(normalizeDeviceDisplay({})).toMatchObject({ dimAfterSec: 0, idleMinutes: 0 })
    expect(normalizeDeviceDisplay(null)).toMatchObject({ dimAfterSec: 0, idleMinutes: 0 })
  })
})
