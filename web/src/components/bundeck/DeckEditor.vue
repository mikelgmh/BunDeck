<template>
  <section class="bd-deck-editor" data-cy="bd-deck-editor">
    <div class="bd-deck-side">
      <h2 class="bd-ttl">{{ t('bd.deckLayouts') }}</h2>
      <div class="bd-form">
        <label class="bd-sr" for="bd-deck-name">{{ t('bd.deckNew') }}</label>
        <input
          id="bd-deck-name"
          v-model="newName"
          class="bd-inp"
          :placeholder="t('bd.deckNew')"
          data-cy="bd-deck-new-name"
          @keydown.enter="onCreate"
        />
        <button class="bd-btn bd-pri" data-cy="bd-deck-create" @click="onCreate">
          <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.deckCreate') }}
        </button>
      </div>
      <ul class="bd-deck-list">
        <li v-for="l in layouts" :key="l.id" :class="{ 'is-active': l.id === activeId }">
          <button
            class="bd-chip"
            :aria-pressed="l.id === activeId"
            :data-cy="`bd-deck-layout-${l.id}`"
            @click="$emit('select-layout', l.id)"
          >
            <LayoutGrid :size="14" stroke-width="1.75" aria-hidden="true" />{{ l.name }}
          </button>
          <button
            class="bd-ibtn"
            :aria-label="`${t('bd.duplicate')}: ${l.name}`"
            :title="t('bd.duplicate')"
            :data-cy="`bd-deck-duplicate-${l.id}`"
            @click="$emit('duplicate-layout', l.id)"
          >
            <Copy :size="14" stroke-width="1.75" aria-hidden="true" />
          </button>
          <button
            class="bd-ibtn"
            :aria-label="`${t('bd.delete')}: ${l.name}`"
            :title="t('bd.delete')"
            :disabled="layouts.length < 2"
            :data-cy="`bd-deck-delete-${l.id}`"
            @click="$emit('delete-layout', l.id)"
          >
            <Trash2 :size="14" stroke-width="1.75" aria-hidden="true" />
          </button>
        </li>
      </ul>

      <h3 class="bd-sh">{{ t('bd.deckAddWidget') }}</h3>
      <p class="bd-hint">{{ t('bd.deckAddHint') }}</p>
      <div class="bd-deck-palette">
        <button
          v-for="k in kinds"
          :key="k.kind"
          class="bd-act"
          draggable="true"
          :data-cy="`bd-deck-kind-${k.kind}`"
          @dragstart="onDragStart($event, k.kind)"
          @click="$emit('add-widget', k.kind)"
        >
          <component :is="k.icon" :size="18" stroke-width="1.75" aria-hidden="true" />
          <span>{{ t(k.label) }}</span>
        </button>
      </div>

      <div v-if="selected" class="bd-deck-inspector" data-cy="bd-deck-inspector">
        <h3 class="bd-sh">{{ t('bd.deckWidgetSettings') }}</h3>
        <div class="bd-fld">
          <label class="bd-lb" :for="`bd-dw-label`">{{ t('bd.keyTitle') }}</label>
          <input
            id="bd-dw-label"
            class="bd-inp"
            :value="selected.label ?? ''"
            data-cy="bd-deck-widget-label"
            @input="$emit('update-widget', selected.id, { label: ($event.target as HTMLInputElement).value })"
          />
        </div>
        <div v-if="selected.kind === 'action'" class="bd-fld">
          <label class="bd-lb" for="bd-dw-pos">{{ t('bd.deckLinkedKey') }}</label>
          <input
            id="bd-dw-pos"
            type="number"
            class="bd-inp"
            min="0"
            :value="selected.buttonPosition ?? ''"
            :placeholder="t('bd.deckLinkedKeyPh')"
            data-cy="bd-deck-widget-pos"
            @input="$emit('update-widget', selected.id, { buttonPosition: ($event.target as HTMLInputElement).value === '' ? null : +($event.target as HTMLInputElement).value })"
          />
        </div>
        <div v-if="selected.kind === 'slider'" class="bd-fld">
          <label class="bd-lb" for="bd-dw-var">{{ t('bd.varName') }}</label>
          <input
            id="bd-dw-var"
            class="bd-inp bd-mono"
            :value="selected.varName ?? ''"
            data-cy="bd-deck-widget-var"
            @input="$emit('update-widget', selected.id, { varName: ($event.target as HTMLInputElement).value })"
          />
          <div class="bd-r2">
            <input
              type="number"
              class="bd-inp"
              :value="selected.min ?? 0"
              aria-label="min"
              data-cy="bd-deck-widget-min"
              @input="$emit('update-widget', selected.id, { min: +($event.target as HTMLInputElement).value })"
            />
            <input
              type="number"
              class="bd-inp"
              :value="selected.max ?? 100"
              aria-label="max"
              data-cy="bd-deck-widget-max"
              @input="$emit('update-widget', selected.id, { max: +($event.target as HTMLInputElement).value })"
            />
          </div>
        </div>
        <div v-if="selected.kind === 'timer'" class="bd-fld">
          <label class="bd-lb" for="bd-dw-secs">{{ t('bd.seconds') }}</label>
          <input
            id="bd-dw-secs"
            type="number"
            class="bd-inp"
            min="1"
            max="86400"
            :value="selected.seconds ?? 60"
            data-cy="bd-deck-widget-secs"
            @input="$emit('update-widget', selected.id, { seconds: Math.max(1, +($event.target as HTMLInputElement).value || 1) })"
          />
        </div>
      </div>
    </div>

    <div class="bd-deck-canvas">
      <DeckLayoutGrid
        v-if="active"
        :layout="active"
        :selected-widget-id="selectedWidgetId"
        @widget-press="(w) => $emit('widget-press', w)"
        @widget-select="(id) => $emit('widget-select', id)"
        @widget-move="(id, x, y) => $emit('widget-move', id, x, y)"
        @resize-widget="(id, w, h) => $emit('resize-widget', id, w, h)"
        @remove-widget="(id) => $emit('remove-widget', id)"
        @resize-layout="(c, r) => $emit('resize-layout', c, r)"
        @widget-drop-new="(kind, cell) => $emit('widget-drop-new', kind, cell)"
      />
      <p v-else class="bd-hint">{{ t('bd.deckEmpty') }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Plus, LayoutGrid, Copy, Trash2, MousePointerClick, SlidersHorizontal, Clock, Timer } from 'lucide-vue-next'
import DeckLayoutGrid from './DeckLayoutGrid.vue'
import type { DeckLayout, DeckWidget, DeckWidgetKind } from '../../composables/useDeckLayouts'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

interface Props {
  layouts: DeckLayout[]
  activeId: string | null
  selectedWidgetId?: string | null
}

interface Emits {
  (e: 'select-layout', id: string): void
  (e: 'create-layout', name: string): void
  (e: 'duplicate-layout', id: string): void
  (e: 'delete-layout', id: string): void
  (e: 'add-widget', kind: DeckWidgetKind): void
  (e: 'update-widget', id: string, patch: Partial<DeckWidget>): void
  (e: 'widget-press', widget: DeckWidget): void
  (e: 'widget-select', id: string | null): void
  (e: 'widget-move', id: string, x: number, y: number): void
  (e: 'resize-widget', id: string, w: number, h: number): void
  (e: 'remove-widget', id: string): void
  (e: 'resize-layout', cols: number, rows: number): void
  (e: 'widget-drop-new', kind: string, cell: number): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const newName = ref('')
const kinds = [
  { kind: 'action' as DeckWidgetKind, icon: MousePointerClick, label: 'bd.deckKindAction' },
  { kind: 'slider' as DeckWidgetKind, icon: SlidersHorizontal, label: 'bd.deckKindSlider' },
  { kind: 'clock' as DeckWidgetKind, icon: Clock, label: 'bd.deckKindClock' },
  { kind: 'timer' as DeckWidgetKind, icon: Timer, label: 'bd.deckKindTimer' }
]

const active = computed(() => props.layouts.find((l) => l.id === props.activeId) ?? null)
const selected = computed(() =>
  active.value?.widgets.find((w) => w.id === props.selectedWidgetId) ?? null
)

const onCreate = () => {
  emit('create-layout', newName.value.trim() || 'Layout')
  newName.value = ''
}

const onDragStart = (e: DragEvent, kind: DeckWidgetKind) => {
  e.dataTransfer?.setData('application/json', JSON.stringify({ deckKind: kind }))
  e.dataTransfer!.effectAllowed = 'copy'
}
</script>
