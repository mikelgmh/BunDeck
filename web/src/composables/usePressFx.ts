/**
 * Efectos visuales de pulsación (Fase A) — port fiel del prototipo con
 * prefijo `bd-` bajo el ámbito `.bundeck`.
 *
 * - fxLayer/playFx/clear + tapState (ventana 340 ms, máx 3) + hold timer.
 * - Respeta `data-anim` (vía `animationsEnabled()`) y
 *   `prefers-reduced-motion` como ya hace el proyecto.
 * - No toca `.bd-hit`: ese estado lo sigue poniendo el engine (executing).
 * - Limpiar con `destroy()` al desmontar (nodos kfx + timers).
 */

import { TAP_WINDOW_MS, TAP_MAX, type PressKind } from './usePressActions'

export type PressFxKind = PressKind | 'press'

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

function fxLayer(el: HTMLElement): HTMLElement | null {
  let f = el.querySelector<HTMLElement>(':scope > .bd-kfx')
  if (!f) {
    f = document.createElement('span')
    f.className = 'bd-kfx'
    el.appendChild(f)
  }
  return f
}

export function playPressFx(
  el: HTMLElement | null | undefined,
  kind: PressFxKind,
  opts: { animations?: boolean; point?: { x: number; y: number } | null } = {},
): void {
  if (!el || opts.animations === false || reducedMotion()) return
  clearHoldFx(el)
  el.classList.remove('bd-fx-click', 'bd-fx-dbl', 'bd-fx-tpl', 'bd-fx-long')
  // Reinicia la animación aunque se pulse seguido.
  void el.offsetWidth
  const f = fxLayer(el)
  if (!f) return
  const rect = el.getBoundingClientRect()
  const px = opts.point ? opts.point.x - rect.left : rect.width / 2
  const py = opts.point ? opts.point.y - rect.top : rect.height / 2
  const fx = kind === 'long' ? 'long' : kind === 'double' ? 'dbl' : kind === 'triple' ? 'tpl' : 'click'
  if (fx === 'click') {
    el.classList.add('bd-fx-click')
    const s = document.createElement('i')
    s.className = 'bd-kfx-rip'
    s.style.left = `${px}px`
    s.style.top = `${py}px`
    f.appendChild(s)
    setTimeout(() => s.remove(), 520)
  } else if (fx === 'dbl') {
    el.classList.add('bd-fx-dbl')
    f.insertAdjacentHTML('beforeend', '<i class="bd-kfx-ring"></i><i class="bd-kfx-ring bd-r2"></i>')
    setTimeout(() => f.querySelectorAll('.bd-kfx-ring').forEach((n) => n.remove()), 650)
  } else if (fx === 'tpl') {
    el.classList.add('bd-fx-tpl')
    for (let i = 0; i < 10; i++) {
      const ang = (Math.PI * 2 * i) / 10
      const dist = 34 + (i % 2) * 14
      const sp = document.createElement('i')
      sp.className = 'bd-kfx-sp'
      sp.style.setProperty('--tx', `${Math.cos(ang) * dist}px`)
      sp.style.setProperty('--ty', `${Math.sin(ang) * dist}px`)
      f.appendChild(sp)
      setTimeout(() => sp.remove(), 580)
    }
  } else {
    el.classList.add('bd-fx-long')
    const s = document.createElement('i')
    s.className = 'bd-kfx-rip'
    s.style.left = '50%'
    s.style.top = '50%'
    f.appendChild(s)
    setTimeout(() => s.remove(), 520)
  }
  const prev = (el as any)._bdFxt
  if (prev) clearTimeout(prev)
  ;(el as any)._bdFxt = setTimeout(
    () => el.classList.remove('bd-fx-click', 'bd-fx-dbl', 'bd-fx-tpl', 'bd-fx-long'),
    680,
  )
}

export function clearHoldFx(el: HTMLElement | null | undefined): void {
  if (!el) return
  el.classList.remove('bd-fx-holding')
  el.querySelector('.bd-kfx-hold')?.remove()
}

export function startHoldFx(
  el: HTMLElement | null | undefined,
  ms: number,
  opts: { animations?: boolean } = {},
): void {
  if (!el || opts.animations === false || reducedMotion()) return
  clearHoldFx(el)
  el.classList.add('bd-fx-holding')
  const f = fxLayer(el)
  if (!f) return
  f.insertAdjacentHTML(
    'beforeend',
    `<svg class="bd-kfx-hold" viewBox="0 0 80 80" style="--bd-hd:${ms}ms"><circle cx="40" cy="40" r="35"/></svg>`,
  )
}

export interface PressFxController {
  /** Estado multi-tap por tecla (id → { n, t }). */
  tapState: { id: unknown; n: number; t: number }
  onPressDown(el: HTMLElement | null, id: unknown, longMs: number, animations: boolean): void
  onPressUp(id: unknown): PressFxKind | null
  cancel(id?: unknown): void
  destroy(): void
}

/**
 * Controlador con estado: cuenta taps en la ventana de 340 ms (máx 3) y
 * devuelve el tipo de fx a reproducir al soltar. El hold visual lo pone
 * `onPressDown`; el timer de long lo gestiona quien lo usa (StageBoard).
 */
export function createPressFx(): PressFxController {
  const c: PressFxController = {
    tapState: { id: null, n: 0, t: 0 },
    onPressDown(el, _id, longMs, animations) {
      if (el) startHoldFx(el, longMs, { animations })
    },
    onPressUp(id) {
      const now = Date.now()
      const same = c.tapState.id === id && now - c.tapState.t < TAP_WINDOW_MS
      c.tapState = { id, n: same ? Math.min(TAP_MAX, c.tapState.n + 1) : 1, t: now }
      return c.tapState.n >= 3 ? 'triple' : c.tapState.n === 2 ? 'double' : 'click'
    },
    cancel(_id) {
      c.tapState = { id: null, n: 0, t: 0 }
    },
    destroy() {
      c.tapState = { id: null, n: 0, t: 0 }
    },
  }
  return c
}
