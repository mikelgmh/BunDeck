<template>
  <div
    class="bd-carousel"
    data-cy="bd-carousel"
    @mouseenter="pause"
    @mouseleave="resume"
    @focusin="pause"
    @focusout="resume"
  >
    <div class="bd-carousel-body">
      <!-- `:key="index"`: cada rotación re-monta la vista y reproduce la
        entrada suave (`.bd-carousel-view` en `widget-data-anim.css`); con
        `prefers-reduced-motion` no hay movimiento. Pausa en hover/focus: no
        roba el foco ni interrumpe la interacción. -->
      <div class="bd-carousel-view" :key="index">
        <slot :index="index" :count="total" :go-to="goTo" />
      </div>
    </div>
    <div v-if="showDots && total > 1" class="bd-carousel-dots" role="tablist" :aria-label="dotsLabel">
      <button
        v-for="i in total"
        :key="i"
        type="button"
        role="tab"
        class="bd-carousel-dot"
        :class="{ 'is-active': index === i - 1 }"
        :aria-selected="index === i - 1"
        :aria-label="`${dotsLabel} ${i}/${total}`"
        data-cy="bd-carousel-dot"
        @click.stop="goTo(i - 1)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAutoCarousel } from '../../../../composables/useAutoCarousel'

/**
 * Carrusel automático presentacional para datos múltiples en teclas
 * pequeñas. Delega la temporización en `useAutoCarousel` (ver su contrato
 * de settings: campo `carouselMs` en `action.parameters`).
 *
 * - El widget pasa `:count` y `:interval-ms` (ya normalizado con
 *   `resolveCarouselMs`) y pinta `items[index]` en el slot por defecto.
 * - Pausa en hover/focus (no roba atención al interactuar).
 * - Dots opcionales (`showDots`): SOLO en tamaños con espacio (el widget los
 *   condiciona por container query o los oculta en XS). Sin dots en 1×1.
 * - `prefers-reduced-motion` / pestaña oculta: sin rotación (ver composable).
 */

interface Props {
  /** Nº de elementos a rotar. */
  count: number
  /** Ms entre cambios (0 = desactivado). Defecto 4000. */
  intervalMs?: number
  /** Mostrar dots de navegación manual. Defecto false. */
  showDots?: boolean
  /** Etiqueta accesible del grupo de dots. */
  dotsLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  intervalMs: 4000,
  showDots: false,
  dotsLabel: 'Elementos',
})

const { index, total, goTo, pause, resume } = useAutoCarousel(
  computed(() => props.count),
  {
    intervalMs: computed(() => props.intervalMs),
  },
)
</script>

<style scoped>
.bd-carousel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
}
.bd-carousel-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.bd-carousel-dots {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  padding-top: 4px;
}
.bd-carousel-dot {
  width: 7px;
  height: 7px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: currentcolor;
  opacity: 0.3;
  cursor: pointer;
}
.bd-carousel-dot.is-active {
  opacity: 0.9;
  /* Pastilla en el activo para que se distinga sin color. */
  width: 16px;
}
.bd-carousel-dot:focus-visible {
  outline: 2px solid var(--bd-ac, #e0a84a);
  outline-offset: 2px;
}
</style>
