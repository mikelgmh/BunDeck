/**
 * Feedback de pulsación web: sonido de clic (Web Audio, oscilador corto sin
 * assets externos, sin MIDI) y vibración (navigator.vibrate con guard, sobre
 * todo móvil). Respeta los toggles `bdClickSound` / `bdHaptic` de
 * `useBunDeckUi` (persistidos en `bundeck:ui` y sincronizados host ↔ remotos).
 *
 * El HW (Stream Deck físico) no tiene altavoz ni vibración: este feedback es
 * solo web/remotos y se dispara desde StageBoard y MobileDeck en cada
 * pulsación (short/long/double/triple).
 */

import { bdClickSound, bdHaptic } from './useBunDeckUi'

export type FeedbackKind = 'click' | 'double' | 'triple' | 'long'

let ctx: AudioContext | null = null

/** Solo tests: suelta el AudioContext cacheado entre casos. */
export function __resetFeedbackAudio(): void {
  ctx = null
}

function ensureCtx(): AudioContext | null {
  try {
    if (typeof window === 'undefined') return null
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    if (!ctx) ctx = new AC()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return ctx
  } catch {
    return null
  }
}

/** Clic suave: solo suena si el toggle de sonido está activado. */
export function playClick(): void {
  if (!bdClickSound.value) return
  try {
    const ac = ensureCtx()
    if (!ac) return
    const t = ac.currentTime
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1900, t)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07)
    osc.connect(gain)
    gain.connect(ac.destination)
    osc.start(t)
    osc.stop(t + 0.09)
  } catch {
    /* best-effort: el feedback nunca rompe la pulsación */
  }
}

/**
 * Vibración: solo si el toggle háptico está activado Y el navegador la
 * soporta (`'vibrate' in navigator`). Devuelve lo que devuelva el navegador.
 */
export function vibrate(pattern: number | number[] = 12): boolean {
  if (!bdHaptic.value) return false
  try {
    if (typeof navigator === 'undefined') return false
    if (!('vibrate' in navigator)) return false
    return navigator.vibrate(pattern)
  } catch {
    return false
  }
}

const LONG_PATTERN = [25, 40, 60]
const DOUBLE_PATTERN = [15, 30, 25]
const TRIPLE_PATTERN = [15, 25, 15, 25, 30]

/** Feedback completo de una pulsación ya resuelta (short/long/double/triple). */
export function pressFeedback(kind: FeedbackKind = 'click'): void {
  playClick()
  if (kind === 'long') vibrate(LONG_PATTERN)
  else if (kind === 'double') vibrate(DOUBLE_PATTERN)
  else if (kind === 'triple') vibrate(TRIPLE_PATTERN)
  else vibrate(12)
}

/** Azúcar para componentes (misma instancia singleton, sin estado propio). */
export function useFeedback() {
  return { playClick, vibrate, pressFeedback }
}
