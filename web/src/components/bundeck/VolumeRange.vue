<template>
  <div
    ref="root"
    class="vol-cq"
    :data-orient="orient"
    data-cy="vol-range"
    role="group"
    :aria-label="ariaLabel"
  >
    <!-- 1×1 (cuadrado): arco con % en el centro -->
    <div class="vol-arc" data-cy="vol-arc">
      <svg
        ref="arcSvg"
        class="vol-svg"
        viewBox="0 0 120 120"
        role="slider"
        tabindex="0"
        :aria-label="ariaLabel"
        :aria-valuemin="0"
        :aria-valuemax="100"
        :aria-valuenow="shown"
        :aria-valuetext="`${shown}%`"
        data-cy="vol-arc-slider"
        @pointerdown="onArcPointer"
        @keydown="onArcKey"
      >
        <circle cx="60" cy="60" :r="R" class="vol-track" />
        <circle
          cx="60"
          cy="60"
          :r="R"
          class="vol-fill"
          :stroke-dasharray="`${arcLen} ${circ}`"
          :stroke-dashoffset="arcOffset"
          transform="rotate(135 60 60)"
        />
      </svg>
      <div class="vol-center" aria-hidden="true">
        <output class="vol-pct bd-data-swap" :key="shown" data-cy="vol-pct">{{ shown }}%</output>
      </div>
      <button
        v-if="!readonly"
        type="button"
        class="vol-mute vol-mute--corner"
        :aria-pressed="muted"
        :aria-label="muted ? t('bd.volUnmute') : t('bd.volMute')"
        :title="muted ? t('bd.volUnmute') : t('bd.volMute')"
        data-cy="vol-mute"
        @click.stop="toggleMute"
      >
        <VolumeX v-if="muted" :size="14" stroke-width="2" aria-hidden="true" />
        <Volume2 v-else :size="14" stroke-width="2" aria-hidden="true" />
      </button>
      <span v-if="muted" class="vol-muted-tag" data-cy="vol-muted"><VolumeX :size="12" stroke-width="2" aria-hidden="true" /></span>
    </div>

    <!-- Ancha (w > h): slider horizontal -->
    <div class="vol-h" data-cy="vol-h">
      <VolumeX
        :size="18"
        stroke-width="1.75"
        aria-hidden="true"
        class="vol-ico"
      />
      <input
        type="range"
        class="vol-range-h"
        min="0"
        max="100"
        step="1"
        :value="shown"
        :disabled="readonly"
        :aria-label="ariaLabel"
        data-cy="vol-slider-h"
        @input="onSlider(($event.target as HTMLInputElement).value)"
        @change="flush()"
      />
      <Volume2
        :size="18"
        stroke-width="1.75"
        aria-hidden="true"
        class="vol-ico"
      />
      <output class="vol-pct vol-pct--side bd-data-swap" :key="shown" data-cy="vol-pct">{{ shown }}%</output>
      <button
        v-if="!readonly"
        type="button"
        class="vol-mute"
        :aria-pressed="muted"
        :aria-label="muted ? t('bd.volUnmute') : t('bd.volMute')"
        :title="muted ? t('bd.volUnmute') : t('bd.volMute')"
        data-cy="vol-mute"
        @click.stop="toggleMute"
      >
        <VolumeX v-if="muted" :size="14" stroke-width="2" aria-hidden="true" />
        <Volume2 v-else :size="14" stroke-width="2" aria-hidden="true" />
      </button>
    </div>

    <!-- Alta (h > w): slider vertical -->
    <div class="vol-v" data-cy="vol-v">
      <output class="vol-pct bd-data-swap" :key="shown" data-cy="vol-pct">{{ shown }}%</output>
      <input
        type="range"
        class="vol-range-v"
        min="0"
        max="100"
        step="1"
        :value="shown"
        :disabled="readonly"
        :aria-label="ariaLabel"
        data-cy="vol-slider-v"
        @input="onSlider(($event.target as HTMLInputElement).value)"
        @change="flush()"
      />
      <button
        v-if="!readonly"
        type="button"
        class="vol-mute"
        :aria-pressed="muted"
        :aria-label="muted ? t('bd.volUnmute') : t('bd.volMute')"
        :title="muted ? t('bd.volUnmute') : t('bd.volMute')"
        data-cy="vol-mute"
        @click.stop="toggleMute"
      >
        <VolumeX v-if="muted" :size="14" stroke-width="2" aria-hidden="true" />
        <Volume2 v-else :size="14" stroke-width="2" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Volume2, VolumeX } from 'lucide-vue-next'
import { normalizeApiBase } from '../../composables/useKeyShare'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

interface Props {
  /** Base de la API (origen o con /api/v1, como API_BASE). */
  apiBase?: string
  /** App objetivo (ej. spotify.exe). Vacío = volumen maestro. */
  app?: string | null
  /** Solo lectura: muestra el nivel sin permitir cambios. */
  readonly?: boolean
  /** Etiqueta accesible. */
  label?: string
}

const props = withDefaults(defineProps<Props>(), {
  apiBase: '',
  app: null,
  readonly: false,
  label: ''
})

const volume = ref(50)
const muted = ref(false)
const pending = ref<number | null>(null)
const root = ref<HTMLElement | null>(null)
const arcSvg = ref<SVGSVGElement | null>(null)
/** Espejo JS de la orientación (las queries CSS mandan en el layout;
 *  esto solo expone data-orient para tests/ARIA). */
const orient = ref<'square' | 'h' | 'v'>('square')
let ro: ResizeObserver | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let setTimer: ReturnType<typeof setTimeout> | null = null
/** Evita que el poll pise un ajuste en curso (respuestas viejas). */
let applying = false

const shown = computed(() => {
  const v = pending.value ?? volume.value
  return Math.min(100, Math.max(0, Math.round(v)))
})
const ariaLabel = computed(() => props.label || 'Volumen')

// --- Arco 270° (de 135° a 405°): 1×1 con % en el centro ---
const R = 48
const circ = 2 * Math.PI * R
const arcLen = (circ * 270) / 360
const arcOffset = computed(() => arcLen * (1 - shown.value / 100))

const execUrl = () => `${normalizeApiBase(props.apiBase) || ''}/api/v1/actions/execute`

const runAction = async (type: string, parameters: Record<string, any> = {}) => {
  const res = await fetch(execUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: { type, parameters },
      context: { quiet: true, source: 'volume-range' }
    })
  })
  if (!res.ok) throw new Error(`volume action ${type}: ${res.status}`)
  return res.json()
}

const refresh = async () => {
  // No pisar lo que el usuario está arrastrando ni una escritura en curso:
  // ya se sincroniza al soltar (flush).
  if (applying || pending.value !== null) return
  try {
    const r = await runAction('audio-mixer.get-levels', {})
    const lv = r?.result?.master ?? r?.master
    const n = Number(lv)
    if (Number.isFinite(n)) volume.value = Math.min(100, Math.max(0, Math.round(n)))
    const m = r?.result?.muted ?? r?.muted
    if (typeof m === 'boolean') muted.value = m
  } catch {
    /* sin daemon o sin herramienta: se conserva el último valor optimista */
  }
}

const applyVolume = async (v: number) => {
  const body: Record<string, any> = { volume: Math.min(100, Math.max(0, Math.round(v))) }
  if (props.app) body.app = props.app
  await runAction('audio-mixer.app-volume', body)
}

const onSlider = (raw: string) => {
  if (props.readonly) return
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  pending.value = Math.min(100, Math.max(0, Math.round(n)))
  muted.value = false
  if (setTimer) clearTimeout(setTimer)
  setTimer = setTimeout(() => void flush(), 160)
}

const flush = async () => {
  if (props.readonly || pending.value === null || applying) return
  const v = pending.value
  pending.value = null
  applying = true
  try {
    await applyVolume(v)
    // Solo se consolida si el sistema lo aplicó: si falla, refresh revierte.
    volume.value = v
    muted.value = false
  } catch {
    /* se reintentará en el siguiente poll */
  } finally {
    applying = false
    void refresh()
  }
}

const toggleMute = async () => {
  if (props.readonly || applying) return
  const body: Record<string, any> = { mute: 'toggle' }
  if (props.app) body.app = props.app
  applying = true
  try {
    await runAction('audio-mixer.app-volume', body)
  } finally {
    applying = false
    void refresh()
  }
}

// Arco interactivo: el ángulo del puntero (barrido 270°) fija el nivel.
const arcValueFromEvent = (e: PointerEvent): number | null => {
  const svg = arcSvg.value
  if (!svg) return null
  const rect = svg.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const dx = e.clientX - cx
  const dy = e.clientY - cy
  if (Math.hypot(dx, dy) < 8) return null
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI // -180..180, 0 = este
  deg = (deg + 360) % 360 // 0..360
  // Barrido de 135° a 405° (=45°): 135°→0%, 45°→100%.
  const rel = (deg - 135 + 360) % 360
  if (rel > 270) return null // zona muerta inferior
  return Math.round((rel / 270) * 100)
}

const onArcPointer = (e: PointerEvent) => {
  if (props.readonly) return
  const v = arcValueFromEvent(e)
  if (v === null) return
  e.preventDefault()
  ;(e.target as Element)?.setPointerCapture?.(e.pointerId)
  onSlider(String(v))
  const move = (ev: PointerEvent) => {
    const nv = arcValueFromEvent(ev)
    if (nv !== null) onSlider(String(nv))
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    void flush()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

const onArcKey = (e: KeyboardEvent) => {
  if (props.readonly) return
  const cur = shown.value
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
    e.preventDefault()
    onSlider(String(Math.min(100, cur + (e.shiftKey ? 10 : 1))))
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
    e.preventDefault()
    onSlider(String(Math.max(0, cur - (e.shiftKey ? 10 : 1))))
  } else if (e.key === 'Home') {
    e.preventDefault()
    onSlider('0')
  } else if (e.key === 'End') {
    e.preventDefault()
    onSlider('100')
  } else if (e.key === 'm' || e.key === 'M') {
    e.preventDefault()
    void toggleMute()
  }
}

const updateOrient = () => {
  const el = root.value
  if (!el) return
  const w = el.clientWidth || el.getBoundingClientRect().width
  const h = el.clientHeight || el.getBoundingClientRect().height
  if (!w || !h) return
  const ratio = w / h
  orient.value = ratio >= 1.3 ? 'h' : ratio <= 0.77 ? 'v' : 'square'
}

watch(() => props.app, () => void refresh())

onMounted(() => {
  void refresh()
  pollTimer = setInterval(() => void refresh(), 5000)
  updateOrient()
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    ro = new ResizeObserver(() => updateOrient())
    ro.observe(root.value)
  }
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (setTimer) clearTimeout(setTimer)
  ro?.disconnect()
})
</script>

<style scoped>
/* Contenedor con nombre: las variantes hijas se conmutan por aspecto.
   `container-type: size` exige tamaño propio: ocupa el 100% de la tecla. */
.vol-cq {
  container-type: size;
  container-name: vol;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: grid;
  place-items: stretch;
  position: relative;
  color: inherit;
}

/* Por defecto (cuadrado 1×1): arco. */
.vol-arc {
  display: grid;
  place-items: center;
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 6px;
}
.vol-h,
.vol-v {
  display: none;
  min-width: 0;
  min-height: 0;
}

/* Ancha (paisaje): slider horizontal. */
@container vol (min-aspect-ratio: 13/10) {
  .vol-arc {
    display: none;
  }
  .vol-h {
    display: flex;
  }
  .vol-v {
    display: none;
  }
}

/* Alta (retrato): slider vertical. */
@container vol (max-aspect-ratio: 77/100) {
  .vol-arc {
    display: none;
  }
  .vol-h {
    display: none;
  }
  .vol-v {
    display: flex;
  }
}

.vol-svg {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  cursor: pointer;
  touch-action: none;
}
.vol-svg:focus-visible {
  outline: 2px solid var(--bd-ac, #e0a84a);
  outline-offset: 2px;
  border-radius: 8px;
}
.vol-track {
  fill: none;
  stroke: currentcolor;
  opacity: 0.22;
  stroke-width: 10;
  stroke-linecap: round;
  stroke-dasharray: 226.2 301.6;
}
.vol-fill {
  fill: none;
  stroke: var(--bd-ac, #e0a84a);
  stroke-width: 10;
  stroke-linecap: round;
  transition: stroke-dashoffset 120ms linear;
}
.vol-center {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}
.vol-pct {
  font-family: var(--bd-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
  font-size: clamp(14px, 28cqi, 30px);
  font-weight: 700;
  line-height: 1.15;
}
.vol-pct--side {
  font-size: 13px;
  min-width: 44px;
  text-align: right;
}
.vol-mute {
  border: 1px solid var(--bd-ln, #2a2d31);
  border-radius: 8px;
  background: var(--bd-sf, #1a1c1f);
  min-width: 30px;
  min-height: 30px;
  display: inline-grid;
  place-items: center;
  font-size: 14px;
}
.vol-mute:hover {
  border-color: var(--bd-mu, #8c9096);
}
.vol-mute--corner {
  position: absolute;
  right: 2px;
  bottom: 2px;
  min-width: 26px;
  min-height: 26px;
  border-radius: 7px;
  opacity: 0.9;
}
.vol-muted-tag {
  position: absolute;
  left: 4px;
  top: 2px;
  font-size: 12px;
}

.vol-h {
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 8px 10px;
}
.vol-ico {
  flex: none;
  opacity: 0.8;
}
.vol-range-h {
  flex: 1;
  min-width: 0;
  accent-color: var(--bd-ac, #e0a84a);
  height: 28px;
}

.vol-v {
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 8px 6px;
}
.vol-v .vol-pct {
  font-size: clamp(12px, 18cqi, 20px);
}
.vol-range-v {
  flex: 1;
  min-height: 0;
  accent-color: var(--bd-ac, #e0a84a);
  writing-mode: vertical-lr;
  direction: rtl;
  width: 28px;
}
@media (prefers-reduced-motion: reduce) {
  .vol-fill {
    transition: none;
  }
}
</style>
