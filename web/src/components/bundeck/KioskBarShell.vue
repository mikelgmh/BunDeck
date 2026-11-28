<template>
  <div
    :id="barId"
    class="kiosk-bar"
    :class="[{ 'is-collapsed': collapsed }, positionClass]"
    role="toolbar"
    :aria-label="ariaLabel"
  >
    <button
      class="kiosk-btn kiosk-collapse"
      type="button"
      :data-cy="collapseCy"
      :aria-expanded="!collapsed"
      :aria-label="collapsed ? expandLabel : collapseLabel"
      :title="collapsed ? expandLabel : collapseLabel"
      @click="$emit('toggle')"
    >
      <slot name="collapse-icon">
        <ChevronRight v-if="collapsed" :size="16" stroke-width="1.75" aria-hidden="true" />
        <ChevronLeft v-else :size="16" stroke-width="1.75" aria-hidden="true" />
      </slot>
    </button>
    <div class="kiosk-collapsible">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    collapsed: boolean
    position?: 'bottom' | 'top-left'
    barId?: string
    collapseCy?: string
    collapseLabel?: string
    expandLabel?: string
    ariaLabel?: string
  }>(),
  {
    position: 'bottom',
    barId: 'kbar',
    collapseCy: 'bd-kiosk-barcollapse',
    collapseLabel: '',
    expandLabel: '',
    ariaLabel: '',
  }
)

defineEmits<{ toggle: [] }>()

const positionClass = computed(() =>
  props.position === 'top-left' ? 'kiosk-bar--top' : 'kiosk-bar--bottom'
)
</script>
