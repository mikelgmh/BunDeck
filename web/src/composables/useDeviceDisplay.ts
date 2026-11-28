import { ref } from 'vue'

/**
 * useDeviceDisplay — Brillo HW por dispositivo + dim + idle.
 *
 * Espejo web de `daemon/src/hw-driver/device-display.ts`: los ajustes viven
 * en el daemon (`devices.<id>.*`, por dispositivo) y aquí solo se leen
 * (GET) y guardan (POST). El brillo de la interfaz (`bdBrightness`, CSS
 * `--bd-br`) NO se toca: es local de cada pantalla.
 *
 * Además expone el velo de inactividad para web/remotos: overlay fullscreen
 * cuya opacidad crece con la inactividad y se resetea con
 * pointerdown/keydown (`createWebIdleVeil`, probado con timers fake).
 */

export type DeviceIdleAction = 'off' | 'dim' | 'clock'
export const DEVICE_IDLE_ACTIONS: DeviceIdleAction[] = ['off', 'dim', 'clock']

export interface DeviceDisplay {
  /** 0-100. Brillo HW base del dispositivo. */
  brightness: number
  /** Segundos sin pulsar antes de atenuar. 0 = nunca. */
  dimAfterSec: number
  /** Minutos sin pulsar antes de la acción de reposo. 0 = nunca. */
  idleMinutes: number
  /** Qué hace el HW en reposo. */
  idleAction: DeviceIdleAction
}

export const DEVICE_DISPLAY_DEFAULTS: DeviceDisplay = {
  brightness: 100,
  dimAfterSec: 0,
  idleMinutes: 0,
  idleAction: 'off',
}

const clampInt = (v: unknown, min: number, max: number, fb: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n)) return fb
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Brillo 0-100 para el slider HW. */
export function clampHwBrightness(v: unknown): number {
  return clampInt(v, 0, 100, DEVICE_DISPLAY_DEFAULTS.brightness)
}

/** Minutos de idle del input numérico (0 = nunca, tope 24 h). */
export function clampIdleMinutes(v: unknown): number {
  return clampInt(v, 0, 1440, DEVICE_DISPLAY_DEFAULTS.idleMinutes)
}

/** Normaliza lo que venga del daemon (GET) a un DeviceDisplay válido. */
export function normalizeDeviceDisplay(raw: any): DeviceDisplay {
  const r = raw && typeof raw === 'object' ? raw : {}
  const action = String(r.idleAction ?? '').toLowerCase()
  return {
    brightness: clampHwBrightness(r.brightness),
    dimAfterSec: clampInt(r.dimAfterSec, 0, 86400, DEVICE_DISPLAY_DEFAULTS.dimAfterSec),
    idleMinutes: clampIdleMinutes(r.idleMinutes),
    idleAction: (DEVICE_IDLE_ACTIONS as string[]).includes(action)
      ? (action as DeviceIdleAction)
      : DEVICE_DISPLAY_DEFAULTS.idleAction,
  }
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** GET /devices/streamdeck/display?device=… (lanza si el daemon responde error). */
export async function fetchDeviceDisplay(apiBase: string, device: string): Promise<DeviceDisplay> {
  const res = await fetch(
    `${apiBase}/devices/streamdeck/display?device=${encodeURIComponent(device)}`,
  )
  if (!res.ok) {
    const body = await readJson(res)
    throw new Error(body?.error || `HTTP ${res.status}`)
  }
  return normalizeDeviceDisplay(await readJson(res))
}

/** POST /devices/streamdeck/display (lanza si valida mal → el caller toastea). */
export async function saveDeviceDisplay(
  apiBase: string,
  device: string,
  patch: Partial<DeviceDisplay>,
): Promise<DeviceDisplay> {
  const res = await fetch(`${apiBase}/devices/streamdeck/display`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device, ...patch }),
  })
  if (!res.ok) {
    const body = await readJson(res)
    throw new Error(body?.error || `HTTP ${res.status}`)
  }
  return normalizeDeviceDisplay(await readJson(res))
}

// ---- Velo de inactividad (web/remotos) ----

/**
 * Minutos de idle que sigue el velo de ESTA pantalla. Lo sincroniza el
 * diálogo de ajustes al cargar/guardar la pantalla del dispositivo; por
 * defecto 0 (desactivado, igual que el daemon).
 */
export const webIdleMinutes = ref<number>(DEVICE_DISPLAY_DEFAULTS.idleMinutes)

/** Opacidad máxima del velo una vez cumplido el tiempo de reposo. */
export const VEIL_MAX_OPACITY = 0.85

/**
 * Opacidad del velo según inactividad: 0 hasta la mitad del tiempo, rampa
 * lineal hasta el máximo al cumplirse, máximo a partir de ahí. 0 minutos =
 * velo desactivado (siempre 0).
 */
export function veilOpacityFor(elapsedMs: number, idleMinutes: number): number {
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) return 0
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  const idleMs = idleMinutes * 60_000
  const start = idleMs / 2
  if (elapsedMs < start) return 0
  if (elapsedMs >= idleMs) return VEIL_MAX_OPACITY
  const f = (elapsedMs - start) / (idleMs - start)
  return Math.round(f * VEIL_MAX_OPACITY * 100) / 100
}

export interface WebIdleVeil {
  opacity: ReturnType<typeof ref<number>>
  resting: ReturnType<typeof ref<boolean>>
  poke: () => void
  tick: (now?: number) => void
  start: () => void
  stop: () => void
}

/**
 * Estado del velo sin depender del ciclo de vida de Vue (el componente
 * llama a start/stop en onMounted/onUnmounted; los tests llaman a
 * poke/tick con reloj manual). `getIdleMinutes` se lee en cada tick para
 * seguir cambios de ajustes sin recrear nada.
 */
export function createWebIdleVeil(getIdleMinutes: () => number = () => webIdleMinutes.value): WebIdleVeil {
  const opacity = ref(0)
  const resting = ref(false)
  let lastActivity = Date.now()
  let timer: ReturnType<typeof setInterval> | null = null

  const poke = () => {
    lastActivity = Date.now()
    opacity.value = 0
    resting.value = false
  }
  const tick = (now: number = Date.now()) => {
    const o = veilOpacityFor(now - lastActivity, getIdleMinutes())
    opacity.value = o
    resting.value = o >= VEIL_MAX_OPACITY
  }
  const onActivity = () => poke()
  const start = () => {
    if (timer !== null || typeof window === 'undefined') return
    lastActivity = Date.now()
    window.addEventListener('pointerdown', onActivity, { passive: true })
    window.addEventListener('keydown', onActivity)
    window.addEventListener('wheel', onActivity, { passive: true })
    timer = setInterval(() => tick(), 1000)
  }
  const stop = () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('wheel', onActivity)
    }
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  return { opacity, resting, poke, tick, start, stop }
}
