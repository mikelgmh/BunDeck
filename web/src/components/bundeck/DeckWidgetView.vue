<template>
  <div
    class="bd-widget"
    :class="[`bd-widget--${widget.kind}`, { 'bd-widget--sel': selected }]"
    :style="{
      'grid-column': `${widget.x + 1} / span ${widget.w}`,
      'grid-row': `${widget.y + 1} / span ${widget.h}`,
      ...(widget.bg ? { background: widget.bg } : {}),
      ...(widget.color ? { '--bd-g': widget.color } : {})
    }"
    :data-cy="`bd-widget-${widget.kind}`"
    :data-widget-id="widget.id"
    role="group"
    :aria-label="ariaLabel"
  >
    <!-- ACTION BUTTON -->
    <button
      v-if="widget.kind === 'action'"
      class="bd-key"
      :class="{ 'bd-hit': executing }"
      :aria-label="widget.label || t('bd.emptyKey')"
      data-cy="bd-widget-action-btn"
      @click="$emit('action-press', widget)"
    >
      <component
        v-if="iconComp"
        :is="iconComp"
        :size="28"
        :stroke-width="1.75"
        aria-hidden="true"
      />
      <span v-else-if="widget.label" class="bd-widget-label">{{ widget.label }}</span>
      <Plus v-else :size="16" stroke-width="1.75" aria-hidden="true" />
      <small v-if="widget.label && iconComp" class="bd-widget-sub">{{ widget.label }}</small>
    </button>

    <!-- SLIDER → variable -->
    <div v-else-if="widget.kind === 'slider'" class="bd-widget-slider">
      <span class="bd-widget-label">{{ widget.label || widget.varName || t('bd.deckSlider') }}</span>
      <input
        type="range"
        class="range range-primary"
        :min="widget.min ?? 0"
        :max="widget.max ?? 100"
        :step="widget.step ?? 1"
        :value="sliderVal"
        :disabled="readonly"
        :aria-label="widget.varName || widget.label || 'slider'"
        data-cy="bd-widget-slider-input"
        @input="onSlider(($event.target as HTMLInputElement).value)"
      />
      <output class="bd-mono" data-cy="bd-widget-slider-val">{{ sliderVal }}</output>
    </div>

    <!-- CLOCK -->
    <div v-else-if="widget.kind === 'clock'" class="bd-widget-clock" data-cy="bd-widget-clock">
      <component v-if="iconComp" :is="iconComp" :size="20" stroke-width="1.75" aria-hidden="true" />
      <time class="bd-mono" :datetime="isoNow">{{ clockText }}</time>
      <small v-if="widget.label" class="bd-widget-sub">{{ widget.label }}</small>
    </div>

    <!-- TIMER -->
    <div v-else-if="widget.kind === 'timer'" class="bd-widget-timer">
      <span class="bd-mono" data-cy="bd-widget-timer-val">{{ timerText }}</span>
      <div v-if="!readonly" class="bd-widget-timer-btns">
        <button class="bd-btn bd-btn-sm" data-cy="bd-widget-timer-start" @click="timerRunning ? pauseTimer() : startTimer()">
          {{ timerRunning ? t('bd.pause') : t('bd.start') }}
        </button>
        <button class="bd-btn bd-btn-sm" data-cy="bd-widget-timer-reset" @click="resetTimer()">
          {{ t('bd.reset') }}
        </button>
      </div>
      <small v-if="widget.label" class="bd-widget-sub">{{ widget.label }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Plus } from 'lucide-vue-next'
import * as LucideIcons from 'lucide-vue-next'
import type { DeckWidget } from '../../composables/useDeckLayouts'
import { getVar, setVarValue } from '../../composables/useVars'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

interface Props {
  widget: DeckWidget
  selected?: boolean
  readonly?: boolean
  executing?: boolean
  now?: number
}

interface Emits {
  (e: 'action-press', widget: DeckWidget): void
  (e: 'slider-change', varName: string, value: number): void
}

const props = withDefaults(defineProps<Props>(), { selected: false, readonly: false, executing: false, now: 0 })
const emit = defineEmits<Emits>()

const icons = LucideIcons as Record<string, any>
const iconComp = computed(() => {
  const n = props.widget.icon
  return typeof n === 'string' && n ? icons[n] ?? null : null
})

const ariaLabel = computed(() => {
  const w = props.widget
  return w.label || (w.kind === 'slider' ? w.varName : w.kind) || w.kind
})

// --- Slider enlazado a variable ---
const sliderVal = computed(() => {
  const v = props.widget.varName ? getVar(props.widget.varName)?.v : undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : (props.widget.min ?? 0)
})
const onSlider = (raw: string) => {
  if (!props.widget.varName) return
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  setVarValue(props.widget.varName, n)
  emit('slider-change', props.widget.varName, n)
}

// --- Clock ---
const tickNow = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  if (props.widget.kind === 'clock') {
    clockTimer = setInterval(() => { tickNow.value = Date.now() }, 1000)
  }
})
onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
})
const isoNow = computed(() => new Date(props.now || tickNow.value).toISOString())
const clockText = computed(() => {
  const d = new Date(props.now || tickNow.value)
  const pad = (x: number) => String(x).padStart(2, '0')
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return props.widget.clockFormat === 'HH:MM:SS' ? `${base}:${pad(d.getSeconds())}` : base
})

// --- Timer (countdown / stopwatch, estado local) ---
const timerSecs = ref(props.widget.seconds ?? 60)
const timerRunning = ref(false)
let timerHandle: ReturnType<typeof setInterval> | null = null
watch(() => props.widget.seconds, (v) => {
  if (!timerRunning.value && typeof v === 'number') timerSecs.value = v
})
const stopTick = () => {
  if (timerHandle) clearInterval(timerHandle)
  timerHandle = null
}
const startTimer = () => {
  if (timerRunning.value) return
  timerRunning.value = true
  timerHandle = setInterval(() => {
    if (props.widget.timerMode === 'stopwatch') timerSecs.value += 1
    else {
      timerSecs.value = Math.max(0, timerSecs.value - 1)
      if (timerSecs.value <= 0) {
        timerRunning.value = false
        stopTick()
      }
    }
  }, 1000)
}
const pauseTimer = () => {
  timerRunning.value = false
  stopTick()
}
const resetTimer = () => {
  pauseTimer()
  timerSecs.value = props.widget.seconds ?? 60
}
onUnmounted(stopTick)
const timerText = computed(() => {
  const s = Math.max(0, Math.floor(timerSecs.value))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
</script>
