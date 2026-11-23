import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createPressFx,
  playPressFx,
  startHoldFx,
  clearHoldFx,
} from '../composables/usePressFx'
import { TAP_WINDOW_MS } from '../composables/usePressActions'

describe('usePressFx', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('expone la ventana multi-tap de 340 ms', () => {
    expect(TAP_WINDOW_MS).toBe(340)
  })

  it('cuenta taps 1→2→3 y se queda en 3 (máx)', () => {
    const fx = createPressFx()
    expect(fx.onPressUp('a')).toBe('click')
    expect(fx.onPressUp('a')).toBe('double')
    expect(fx.onPressUp('a')).toBe('triple')
    expect(fx.onPressUp('a')).toBe('triple')
    fx.destroy()
  })

  it('resetea al cambiar de tecla y al expirar la ventana', () => {
    const fx = createPressFx()
    expect(fx.onPressUp('a')).toBe('click')
    // Otra tecla: vuelve a empezar en click.
    expect(fx.onPressUp('b')).toBe('click')
    expect(fx.onPressUp('b')).toBe('double')
    // Ventana expirada: resetea.
    vi.advanceTimersByTime(TAP_WINDOW_MS + 50)
    expect(fx.onPressUp('b')).toBe('click')
    fx.destroy()
  })

  it('cancel() resetea el conteo', () => {
    const fx = createPressFx()
    expect(fx.onPressUp('a')).toBe('click')
    fx.cancel()
    expect(fx.onPressUp('a')).toBe('click')
    fx.destroy()
  })

  it('playPressFx pinta ripple en click y lo limpia', () => {
    const el = document.createElement('button')
    playPressFx(el, 'click', { animations: true, point: { x: 10, y: 10 } })
    expect(el.classList.contains('bd-fx-click')).toBe(true)
    expect(el.querySelector('.bd-kfx-rip')).not.toBeNull()
    vi.advanceTimersByTime(700)
    expect(el.classList.contains('bd-fx-click')).toBe(false)
  })

  it('playPressFx pinta doble anillo en double y chispas en triple', () => {
    const el = document.createElement('button')
    playPressFx(el, 'double', { animations: true })
    expect(el.classList.contains('bd-fx-dbl')).toBe(true)
    expect(el.querySelectorAll('.bd-kfx-ring').length).toBe(2)
    const el2 = document.createElement('button')
    playPressFx(el2, 'triple', { animations: true })
    expect(el2.querySelectorAll('.bd-kfx-sp').length).toBe(10)
  })

  it('playPressFx respeta animations:false y no revienta sin elemento', () => {
    const el = document.createElement('button')
    playPressFx(el, 'click', { animations: false })
    expect(el.querySelector('.bd-kfx')).toBeNull()
    expect(() => playPressFx(null, 'click', { animations: true })).not.toThrow()
  })

  it('startHoldFx/clearHoldFx gestionan el progreso de hold', () => {
    const el = document.createElement('button')
    startHoldFx(el, 500, { animations: true })
    expect(el.classList.contains('bd-fx-holding')).toBe(true)
    expect(el.querySelector('.bd-kfx-hold')).not.toBeNull()
    clearHoldFx(el)
    expect(el.classList.contains('bd-fx-holding')).toBe(false)
    expect(el.querySelector('.bd-kfx-hold')).toBeNull()
    expect(() => clearHoldFx(null)).not.toThrow()
  })
})
