<template>
  <!-- Vista limpia de USO: sin paneles de edición, sin inspector, sin chrome de escritorio. -->
  <main class="bd-deck-use" data-cy="bd-deck-use" :data-layout="layout.id">
    <header class="bd-deck-use-head">
      <h1>{{ layout.name }}</h1>
      <span class="bd-hint">{{ layout.widgets.length }} widgets</span>
    </header>
    <div
      class="bd-deck-plate bd-deck-plate--use"
      :style="{ '--bd-c': layout.cols, '--bd-r': layout.rows }"
      data-cy="bd-deck-use-plate"
    >
      <DeckWidgetView
        v-for="w in layout.widgets"
        :key="w.id"
        :widget="w"
        :readonly="true"
        @action-press="(widget) => $emit('widget-press', widget)"
      />
    </div>
  </main>
</template>

<script setup lang="ts">
import DeckWidgetView from './DeckWidgetView.vue'
import type { DeckLayout, DeckWidget } from '../../composables/useDeckLayouts'

interface Props {
  layout: DeckLayout
}

interface Emits {
  (e: 'widget-press', widget: DeckWidget): void
}

defineProps<Props>()
defineEmits<Emits>()
</script>
