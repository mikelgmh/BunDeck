<template>
  <div class="bd-deck-grid" data-cy="bd-deck-grid">
    <div class="bd-tool">
      <div class="bd-step">
        <span>{{ t('bd.columns') }}</span>
        <button :aria-label="t('bd.decreaseCol')" :disabled="layout.cols <= 1" data-cy="bd-deck-cols-dec" @click="$emit('resize-layout', layout.cols - 1, layout.rows)">−</button>
        <output>{{ layout.cols }}</output>
        <button :aria-label="t('bd.increaseCol')" :disabled="layout.cols >= 12" data-cy="bd-deck-cols-inc" @click="$emit('resize-layout', layout.cols + 1, layout.rows)">+</button>
      </div>
      <div class="bd-step">
        <span>{{ t('bd.rows') }}</span>
        <button :aria-label="t('bd.decreaseRow')" :disabled="layout.rows <= 1" data-cy="bd-deck-rows-dec" @click="$emit('resize-layout', layout.cols, layout.rows - 1)">−</button>
        <output>{{ layout.rows }}</output>
        <button :aria-label="t('bd.increaseRow')" :disabled="layout.rows >= 12" data-cy="bd-deck-rows-inc" @click="$emit('resize-layout', layout.cols, layout.rows + 1)">+</button>
      </div>
      <span class="bd-hint">{{ t('bd.deckGridHint') }}</span>
    </div>

    <div
      ref="container"
      data-swapy-container
      class="bd-deck-plate"
      :style="{ '--bd-c': layout.cols, '--bd-r': layout.rows }"
      data-cy="bd-deck-plate"
      @keydown="onKeyNav"
    >
      <!-- Widgets como hijos directos del grid para que w/h hagan span real. -->
      <DeckWidgetView
        v-for="w in layout.widgets"
        :key="w.id"
        :widget="w"
        :selected="w.id === selectedWidgetId"
        :readonly="readonly"
        :data-swapy-item="`item-${w.id}`"
        :data-swapy-slot="`slot-${w.id}`"
        @action-press="(ww) => $emit('widget-press', ww)"
        @click="onWidgetClick(w)"
      />
      <!-- Celdas libres como objetivos de drop (solo lectura visual del hueco). -->
      <div
        v-for="cell in freeCells"
        :key="`free-${cell}`"
        class="bd-deck-cell is-free"
        :data-swapy-slot="`slot-free-${cell}`"
        :data-cell="cell"
        @dragover.prevent="onDragOver($event)"
        @drop.prevent="onDrop($event, cell)"
      />
    </div>

    <div v-if="!readonly && selectedWidget" class="bd-deck-sel" data-cy="bd-deck-selected">
      <b>{{ selectedWidget.label || selectedWidget.kind }} · {{ selectedWidget.w }}×{{ selectedWidget.h }}</b>
      <div class="bd-step">
        <button :disabled="selectedWidget.w <= 1" :aria-label="t('bd.deckNarrower')" data-cy="bd-widget-w-dec" @click="$emit('resize-widget', selectedWidget.id, selectedWidget.w - 1, selectedWidget.h)">−W</button>
        <button :disabled="selectedWidget.w >= layout.cols" :aria-label="t('bd.deckWider')" data-cy="bd-widget-w-inc" @click="$emit('resize-widget', selectedWidget.id, selectedWidget.w + 1, selectedWidget.h)">+W</button>
        <button :disabled="selectedWidget.h <= 1" :aria-label="t('bd.deckShorter')" data-cy="bd-widget-h-dec" @click="$emit('resize-widget', selectedWidget.id, selectedWidget.w, selectedWidget.h - 1)">−H</button>
        <button :disabled="selectedWidget.h >= layout.rows" :aria-label="t('bd.deckTaller')" data-cy="bd-widget-h-inc" @click="$emit('resize-widget', selectedWidget.id, selectedWidget.w, selectedWidget.h + 1)">+H</button>
        <button class="bd-btn bd-dng" data-cy="bd-widget-delete" @click="$emit('remove-widget', selectedWidget.id)">
          {{ t('bd.delete') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { createSwapy, type Swapy } from 'swapy'
import DeckWidgetView from './DeckWidgetView.vue'
import type { DeckLayout, DeckWidget } from '../../composables/useDeckLayouts'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

interface Props {
  layout: DeckLayout
  selectedWidgetId?: string | null
  readonly?: boolean
}

interface Emits {
  (e: 'widget-press', widget: DeckWidget): void
  (e: 'widget-select', id: string | null): void
  (e: 'widget-move', widgetId: string, x: number, y: number): void
  (e: 'resize-widget', widgetId: string, w: number, h: number): void
  (e: 'remove-widget', widgetId: string): void
  (e: 'resize-layout', cols: number, rows: number): void
  (e: 'widget-drop-new', kind: string, cell: number): void
}

const props = withDefaults(defineProps<Props>(), { selectedWidgetId: null, readonly: false })
const emit = defineEmits<Emits>()

const container = ref<HTMLElement | null>(null)
const swapy = ref<Swapy | null>(null)

const byCell = computed(() => {
  const map = new Map<number, DeckWidget>()
  for (const w of props.layout.widgets) {
    for (let dy = 0; dy < w.h; dy++) {
      for (let dx = 0; dx < w.w; dx++) {
        map.set((w.y + dy) * props.layout.cols + (w.x + dx), w)
      }
    }
  }
  return map
})
const freeCells = computed(() => {
  const total = props.layout.cols * props.layout.rows
  const out: number[] = []
  for (let cell = 0; cell < total; cell++) {
    if (!byCell.value.has(cell)) out.push(cell)
  }
  return out
})
const widgetAt = (cell: number): DeckWidget | undefined => byCell.value.get(cell)
const selectedWidget = computed(() =>
  props.layout.widgets.find((w) => w.id === props.selectedWidgetId) ?? null
)

const onWidgetClick = (w: DeckWidget) => {
  if (props.readonly) {
    emit('widget-press', w)
    return
  }
  emit('widget-select', w.id)
}

const cellToXY = (cell: number) => ({
  x: cell % props.layout.cols,
  y: Math.floor(cell / props.layout.cols)
})

const onDragOver = (e: DragEvent) => {
  if (props.readonly) return
  if (!e.dataTransfer?.types.includes('application/json')) return
  ;(e.currentTarget as HTMLElement).classList.add('bd-over')
  e.preventDefault()
}
const onDrop = (e: DragEvent, cell: number) => {
  ;(e.currentTarget as HTMLElement).classList.remove('bd-over')
  if (props.readonly) return
  try {
    const raw = e.dataTransfer?.getData('application/json')
    if (!raw) return
    const data = JSON.parse(raw)
    if (data?.deckKind) emit('widget-drop-new', String(data.deckKind), cell)
  } catch { /* noop */ }
}

const onKeyNav = (e: KeyboardEvent) => {
  if (props.readonly || !props.selectedWidgetId) return
  const w = selectedWidget.value
  if (!w) return
  const d: Record<string, [number, number]> = {
    ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1]
  }[e.key] as any
  if (!d) return
  e.preventDefault()
  emit('widget-move', w.id, w.x + d[0], w.y + d[1])
}

// Swapy desactivado en layouts: los widgets hacen span real (grid-column/row)
// y el HTML5 drop + teclado + botones ±W/±H ya cubren mover/redimensionar
// sin duplicar widgets en cada celda. Se conserva el import por si se
// reactiva con soporte de spanning.
const initSwapy = () => {
  return
}
const destroySwapy = () => {
  swapy.value?.destroy()
  swapy.value = null
}

const sig = computed(() => [
  props.layout.cols, props.layout.rows,
  ...props.layout.widgets.map((w) => `${w.id}:${w.x},${w.y},${w.w}x${w.h}`)
].join('|'))
watch(sig, () => {
  if (props.readonly) return
  destroySwapy()
  void nextTick().then(initSwapy)
})
watch(() => props.readonly, (ro) => {
  if (ro) destroySwapy()
  else void nextTick().then(initSwapy)
})

onMounted(() => initSwapy())
onUnmounted(destroySwapy)
</script>
