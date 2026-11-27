<template>
  <div
    ref="box"
    class="bd-marquee"
    :class="{ 'is-static': !scrolls }"
    :style="{ '--bd-marquee-duration': `${duration}s` }"
    role="marquee"
    :aria-label="text"
    data-cy="bd-marquee"
  >
    <div class="bd-marquee-group" data-cy="bd-marquee-text"><span ref="txt" :key="text" class="bd-mq-text">{{ text }}</span></div>
    <div class="bd-marquee-group" aria-hidden="true"><span :key="text" class="bd-mq-text">{{ text }}</span></div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { marqueeOverflows } from '../../../../composables/useKiosk'

/**
 * Marquee reutilizable (mismo patrón que la barra inferior del modo kiosco:
 * `BunDeckApp.vue` + `marqueeOverflows` de `useKiosk.ts` + estilos de
 * `bundeck.css` `.kmarquee`).
 *
 * - Solo anima cuando el texto desborda de verdad (medido con
 *   ResizeObserver: `span.scrollWidth` vs ancho visible; +1px de tolerancia
 *   anti-subpíxel en `marqueeOverflows`). Sin overflow: fijo y centrado.
 * - Velocidad vía CSS: `--bd-marquee-duration` (prop `speed`, segundos por
 *   vuelta completa). Pausa en hover; sin animación con
 *   `prefers-reduced-motion`.
 *
 * Uso: pensado para títulos/textos largos en teclas 1×1 y pequeñas donde no
 * cabe ellipsis + dato a la vez. No usar para el dato principal numérico.
 */

interface Props {
  /** Texto a mostrar (una línea). */
  text: string
  /** Segundos por vuelta completa del bucle. Defecto 22 (igual que kiosco). */
  speed?: number
}

const props = withDefaults(defineProps<Props>(), { speed: 22 })

const box = ref<HTMLElement | null>(null)
const txt = ref<HTMLElement | null>(null)
const scrolls = ref(false)
const duration = ref(props.speed > 0 ? props.speed : 22)

watch(
  () => props.speed,
  (s) => {
    duration.value = Number.isFinite(s) && s > 0 ? s : 22
  },
)

let ro: ResizeObserver | null = null

const measure = () => {
  const el = box.value
  // El texto, no el grupo: su padding-right de separación inflaría scrollWidth
  // (misma trampa que el marquee del kiosco).
  const t = txt.value
  if (!el || !t) return
  scrolls.value = marqueeOverflows(t.scrollWidth, el.clientWidth)
}

watch(
  () => props.text,
  () => nextTick(measure),
)

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && box.value) {
    try {
      ro = new ResizeObserver(() => measure())
      ro.observe(box.value)
    } catch {
      /* sin RO: medida puntual */
    }
  }
  nextTick(measure)
  try {
    void document.fonts?.ready.then(() => measure())
  } catch {
    /* sin Font Loading API */
  }
})

onUnmounted(() => {
  ro?.disconnect()
  ro = null
})
</script>

<style scoped>
.bd-marquee {
  display: flex;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
}
/* Fundidos laterales solo cuando hay marquee real (overflow + animación):
   con texto corto y fijo se ven los bordes limpios. */
.bd-marquee:not(.is-static) {
  mask-image: linear-gradient(to right, transparent, #000 16px, #000 calc(100% - 16px), transparent);
  -webkit-mask-image: linear-gradient(to right, transparent, #000 16px, #000 calc(100% - 16px), transparent);
}
/* Marquee infinito de dos grupos idénticos: cada uno mide al menos el 100%
   y se desplaza su propio ancho (-100%); el bucle es imperceptible. */
.bd-marquee-group {
  flex-shrink: 0;
  min-width: 100%;
  display: flex;
  align-items: center;
  padding-right: 40px;
  animation: bd-marquee-scroll var(--bd-marquee-duration, 22s) linear infinite;
  will-change: transform;
}
@keyframes bd-marquee-scroll {
  from {
    transform: translate3d(0, 0, 0);
  }
  to {
    transform: translate3d(-100%, 0, 0);
  }
}
.bd-marquee:hover .bd-marquee-group {
  animation-play-state: paused;
}
/* Sin desborde no hay movimiento: un solo grupo fijo y centrado. */
.bd-marquee.is-static {
  justify-content: center;
}
.bd-marquee.is-static .bd-marquee-group {
  min-width: 0;
  padding-right: 0;
  animation: none;
}
.bd-marquee.is-static .bd-marquee-group[aria-hidden='true'] {
  display: none;
}
@media (prefers-reduced-motion: reduce) {
  .bd-marquee-group {
    animation: none;
  }
}
</style>
