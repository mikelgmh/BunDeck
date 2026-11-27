import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { useAutoCarousel, type MaybeRefOrGetter } from './useAutoCarousel'

/**
 * useFitPager — paginación por carrusel sin scroll para listas en teclas.
 *
 * PROHIBIDO el scroll en el modo libre: cuando los elementos no caben en el
 * contenedor, se muestran por páginas que rotan con `carouselMs` (mismo
 * contrato que `useAutoCarousel`: ausente=4000, <=0=off) en lugar de abrir
 * scrollbar. Cuando todo cabe, la lista se pinta entera (sin paginador).
 *
 * - El contenedor debe tener altura acotada (`flex: 1; min-height: 0` dentro
 *   de una columna con altura fija) y `overflow: hidden`.
 * - Cada elemento paginable lleva `data-page-item` como hijo directo. El
 *   paginador (dots) vive FUERA del contenedor medido.
 * - Medición sin parpadeo: se muestra todo, se mide con reflow forzado y se
 *   recorta en el mismo tick (sin paint intermedio).
 * - Pausa la rotación en hover/focus (como `AutoCarousel`).
 */
export function useFitPager(
  container: Ref<HTMLElement | null>,
  options: {
    /** Ms entre páginas (número, Ref o getter; 0 = sin rotación). */
    intervalMs?: MaybeRefOrGetter<number>
    /** Separación entre elementos para el cálculo de ajuste. */
    gap?: number
  } = {},
) {
  const total = ref(0)
  const pageSize = ref(1)
  /** Altura reservada para el paginador (se mide cuando existe; 20 por defecto). */
  const pagerReserve = ref(20)
  const numPages = computed(() => Math.max(0, Math.ceil(total.value / Math.max(1, pageSize.value))))
  const paged = computed(() => numPages.value > 1)
  const car = useAutoCarousel(numPages, { intervalMs: options.intervalMs })

  function items(): HTMLElement[] {
    const root = container.value
    if (!root) return []
    return (Array.from(root.querySelectorAll(':scope > [data-page-item]')) as HTMLElement[]).filter(
      // Incluye los ocultos por el propio paginador (marca dataset; su
      // offsetParent pasa a null); excluye los ocultos por container queries
      // (p. ej. grupos only-l fuera de L).
      (el) => el.dataset.pagedHidden === '1' || el.offsetParent !== null,
    )
  }

  function show(el: HTMLElement) {
    el.style.removeProperty('display')
    delete el.dataset.pagedHidden
  }
  function hide(el: HTMLElement) {
    el.style.setProperty('display', 'none', 'important')
    el.dataset.pagedHidden = '1'
  }

  function apply() {
    const list = items()
    total.value = list.length
    let idx = car.index.value
    if (numPages.value <= 1) idx = 0
    else if (idx >= numPages.value) {
      car.goTo(0)
      idx = 0
    }
    const size = Math.max(1, pageSize.value)
    list.forEach((el, i) => {
      if (numPages.value <= 1 || Math.floor(i / size) === idx) show(el)
      else hide(el)
    })
  }

  /** Paginador hermano (clase `fit-pager`): se descuenta su altura al medir. */
  function pagerEl(): HTMLElement | null {
    const root = container.value
    const parent = root?.parentElement
    if (!root || !parent) return null
    return parent.querySelector(':scope > .fit-pager') as HTMLElement | null
  }

  function fitSize(list: HTMLElement[], avail: number): number {
    const gap = options.gap ?? 6
    let used = 0
    let fit = 0
    for (const el of list) {
      const h = el.offsetHeight ?? 0
      if (h <= 0) continue
      const need = fit === 0 ? h : h + gap
      if (fit === 0 || used + need <= avail + 1) {
        used += need
        fit++
      } else break
    }
    return Math.max(1, fit)
  }

  function measure() {
    const root = container.value
    if (!root) return
    const list = items()
    list.forEach(show)
    total.value = list.length
    if (!list.length) {
      pageSize.value = 1
      apply()
      return
    }
    // Punto fijo: el paginador quita espacio solo cuando hay >1 página.
    // Se itera (máx. 4) hasta estabilizar páginas y reserva.
    let size = 1
    let pages = 1
    for (let k = 0; k < 4; k++) {
      const reserve = pages > 1 ? pagerReserve.value : 0
      size = fitSize(list, Math.max(0, root.clientHeight - 4 - reserve))
      const p = Math.max(1, Math.ceil(list.length / Math.max(1, size)))
      const el = pagerEl()
      if (el && el.offsetHeight > 0) pagerReserve.value = el.offsetHeight
      if (p === pages) break
      pages = p
    }
    pageSize.value = Math.max(1, size)
    apply()
    const el = pagerEl()
    if (el && numPages.value > 1 && el.offsetHeight > 0) pagerReserve.value = el.offsetHeight
  }

  const onEnter = () => car.pause()
  const onLeave = () => car.resume()

  let ro: ResizeObserver | null = null
  onMounted(() => {
    measure()
    if (typeof ResizeObserver !== 'undefined' && container.value) {
      ro = new ResizeObserver(() => measure())
      ro.observe(container.value)
    }
    // Las fuentes web cambian las alturas tras el primer pintado.
    try {
      void document.fonts?.ready.then(() => measure())
    } catch {
      /* sin Font Loading API */
    }
    container.value?.addEventListener('mouseenter', onEnter)
    container.value?.addEventListener('mouseleave', onLeave)
    container.value?.addEventListener('focusin', onEnter)
    container.value?.addEventListener('focusout', onLeave)
  })
  onUnmounted(() => {
    ro?.disconnect()
    ro = null
    container.value?.removeEventListener('mouseenter', onEnter)
    container.value?.removeEventListener('mouseleave', onLeave)
    container.value?.removeEventListener('focusin', onEnter)
    container.value?.removeEventListener('focusout', onLeave)
  })
  watch(
    () => car.index.value,
    () => apply(),
  )

  return {
    total,
    pageSize,
    numPages,
    paged,
    index: car.index,
    goTo: car.goTo,
    measure,
    apply,
  }
}
