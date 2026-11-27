import { computed, onMounted, onUnmounted, ref, toValue, watch, type Ref } from 'vue'

/**
 * useAutoCarousel — rotación automática de N elementos para datos múltiples
 * en teclas pequeñas (varios eventos, sensores, escenas, snapshots…).
 *
 * CONTRATO DE SETTING (drawer derecho, ajustes de la acción):
 * - Campo: `carouselMs` dentro de `action.parameters` (número, milisegundos
 *   entre cambios).
 * - Semántica: `> 0` = intervalo; `0`/ausente-inválido = ver §defecto.
 *   Sin límite superior; el mínimo efectivo se satura a `MIN_CAROUSEL_MS`.
 * - Para que el campo aparezca editable en el drawer, el manifiesto del
 *   plugin (daemon) debe exponer `carouselMs` en su `settingsSchema`;
 *   la parte web lo lee igual aunque el schema aún no lo declare.
 * - Cableado por widget:
 *   ```ts
 *   const items = computed(() => [...]) // datos múltiples del widget
 *   const intervalMs = computed(() => resolveCarouselMs(props.action.parameters))
 *   const { index, goTo, pause, resume } = useAutoCarousel(itemsLength, { intervalMs })
 *   ```
 *   y pintar `items[index]` (o usar `AutoCarousel.vue`, que ya lo hace).
 */

export const DEFAULT_CAROUSEL_MS = 4000
export const MIN_CAROUSEL_MS = 1000

/**
 * Normaliza `parameters.carouselMs` a milisegundos efectivos.
 * - `undefined`/`NaN`/no-numérico → `fallback` (defecto 4000).
 * - `<= 0` → `0` (carrusel desactivado: se muestra el primer elemento).
 * - `0 < n < MIN` → `MIN_CAROUSEL_MS` (1000 ms, anti-parpadeo).
 */
export function resolveCarouselMs(
  parameters: Record<string, any> | undefined | null,
  fallback: number = DEFAULT_CAROUSEL_MS,
): number {
  const raw = parameters?.carouselMs
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  if (n <= 0) return 0
  return Math.max(MIN_CAROUSEL_MS, Math.round(n))
}

export interface AutoCarouselOptions {
  /**
   * Intervalo en ms (número, Ref o getter reactivo, p. ej. `() =>
   * resolveCarouselMs(params)`). `0` = sin rotación automática.
   */
  intervalMs?: MaybeRefOrGetter<number>
  /** Apagado maestro (p. ej. `readonly` no lo apaga: solo lectura también rota). */
  enabled?: MaybeRefOrGetter<boolean>
}

/** Acepta valor, Ref o getter (p. ej. `computed`). */
export type MaybeRefOrGetter<T> = T | Ref<T> | (() => T)

/** ¿Pide el usuario no-animación? (SSR-safe). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function useAutoCarousel(
  count: MaybeRefOrGetter<number>,
  options: AutoCarouselOptions = {},
) {
  const total = computed(() => Math.max(0, Math.floor(Number(toValue(count as any)) || 0)))
  const index = ref(0)
  const userPaused = ref(false)
  const reducedMotion = ref(false)

  const interval = computed(() => {
    const n = Number(toValue(options.intervalMs as any ?? DEFAULT_CAROUSEL_MS))
    return Number.isFinite(n) && n > 0 ? Math.max(MIN_CAROUSEL_MS, Math.round(n)) : 0
  })
  const enabled = computed(() => toValue(options.enabled as any ?? true))

  /** Rotación efectiva: ≥2 elementos, habilitada, con intervalo y sin pausa. */
  const running = computed(
    () =>
      enabled.value &&
      !userPaused.value &&
      !reducedMotion.value &&
      interval.value > 0 &&
      total.value > 1,
  )

  let timer: ReturnType<typeof setInterval> | null = null
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  const start = () => {
    stop()
    if (!running.value) return
    if (typeof document !== 'undefined' && document.hidden) return
    timer = setInterval(() => {
      index.value = (index.value + 1) % Math.max(1, total.value)
    }, interval.value)
  }
  const restart = () => {
    if (typeof document !== 'undefined' && document.hidden) {
      stop()
      return
    }
    start()
  }

  watch([running, total], () => {
    if (index.value >= total.value) index.value = 0
    restart()
  })

  const onVisibility = () => restart()

  onMounted(() => {
    reducedMotion.value = prefersReducedMotion()
    restart()
    try {
      document.addEventListener('visibilitychange', onVisibility)
    } catch {
      /* sin document */
    }
  })
  onUnmounted(() => {
    stop()
    try {
      document.removeEventListener('visibilitychange', onVisibility)
    } catch {
      /* sin document */
    }
  })

  const goTo = (i: number) => {
    if (total.value < 1) return
    const n = Math.floor(Number(i))
    if (!Number.isFinite(n)) return
    index.value = ((n % total.value) + total.value) % total.value
  }
  const next = () => goTo(index.value + 1)
  const prev = () => goTo(index.value - 1)
  const pause = () => {
    userPaused.value = true
    stop()
  }
  const resume = () => {
    userPaused.value = false
    restart()
  }

  return { index, total, running, paused: computed(() => userPaused.value), next, prev, goTo, pause, resume }
}
