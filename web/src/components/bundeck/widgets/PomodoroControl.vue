<template>
  <section class="pomodoro" aria-label="Pomodoro timer" data-cy="widget-pomodoro">
    <header>
      <span class="eyebrow"><Timer :size="15" aria-hidden="true" /> {{ copy.heading }}</span>
      <span class="mode">{{ modeLabel }}</span>
    </header>

    <div v-if="fetching && !loaded" class="state" role="status">
      <LoaderCircle class="spin" :size="18" aria-hidden="true" /> {{ copy.loading }}
    </div>
    <div v-else-if="error && !hasData" class="state error" role="alert">{{ error }}</div>
    <template v-else>
      <div class="dial" :class="`is-${status}`" :aria-label="`${formatted}, ${statusLabel}`">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="track" cx="60" cy="60" r="51" />
          <circle class="progress" cx="60" cy="60" r="51" :style="{ strokeDashoffset: String(320.44 * (1 - progress)) }" />
        </svg>
        <div class="time">
          <strong>{{ formatted }}</strong>
          <span>{{ props.label || label || statusLabel }}</span>
        </div>
      </div>
      <p v-if="error" class="error note" role="alert">{{ error }}</p>
      <div class="controls">
        <button type="button" class="start" :disabled="busy || fetching || readonly || status === 'running'" @click="start('work')">
          <Play :size="15" aria-hidden="true" /> {{ copy.focus }}
        </button>
        <button type="button" class="break" :disabled="busy || fetching || readonly || status === 'running'" @click="start('break')">
          <Coffee :size="15" aria-hidden="true" /> {{ copy.break }}
        </button>
        <button type="button" class="stop" :disabled="busy || fetching || readonly || (status !== 'running' && status !== 'paused')" :aria-label="copy.stop" @click="stop">
          <Square :size="14" aria-hidden="true" />
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Coffee, LoaderCircle, Play, Square, Timer } from 'lucide-vue-next'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import { useI18nStore } from '../../../composables/useI18n'

type WidgetAction = { type: string; parameters: Record<string, any> }
const props = defineProps<{
  action: WidgetAction
  apiBase: string
  label?: string
  readonly?: boolean
}>()
const { currentLocale } = useI18nStore()
const spanish = computed(() => String(currentLocale.value || 'es').toLowerCase().startsWith('es'))
const copy = computed(() => spanish.value
  ? { heading: 'TEMPORIZADOR', loading: 'Cargando temporizador…', focus: 'Enfoque', break: 'Descanso', stop: 'Detener temporizador', work: 'Trabajo', custom: 'Personalizado', running: 'En marcha', paused: 'En pausa', complete: 'Completado', ready: 'Listo' }
  : { heading: 'FOCUS TIMER', loading: 'Loading timer…', focus: 'Focus', break: 'Break', stop: 'Stop timer', work: 'Work', custom: 'Custom', running: 'In progress', paused: 'Paused', complete: 'Complete', ready: 'Ready' })

const status = ref('idle')
const mode = ref('work')
const label = ref('')
const remainingMs = ref(0)
const totalMs = ref(25 * 60_000)
const now = ref(Date.now())
const busy = ref(false)
const fetching = ref(false)
const loaded = ref(false)
const hasData = ref(false)
const error = ref('')
let pollTimer: ReturnType<typeof setInterval> | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined

const formatted = computed(() => {
  const seconds = Math.max(0, Math.ceil((status.value === 'running' ? Math.max(0, remainingMs.value - (now.value - lastUpdate.value)) : remainingMs.value) / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
})
const lastUpdate = ref(Date.now())
const progress = computed(() => totalMs.value > 0 ? Math.min(1, Math.max(0, (Number(formatted.value.split(':')[0]) * 60_000 + Number(formatted.value.split(':')[1]) * 1000) / totalMs.value)) : 0)
const modeLabel = computed(() => mode.value === 'break' ? copy.value.break : mode.value === 'custom' ? copy.value.custom : copy.value.work)
const statusLabel = computed(() => status.value === 'running' ? copy.value.running : status.value === 'paused' ? copy.value.paused : status.value === 'finished' ? copy.value.complete : copy.value.ready)

function actionType(name: string) {
  return `${props.action.type.split('.')[0] || 'timer'}.${name}`
}

async function refresh(force = false) {
  if ((busy.value || fetching.value) && !force) return
  fetching.value = true
  try {
    const data = await executeWidgetAction(props.apiBase, actionType('status'), {})
    status.value = data?.status ?? 'idle'
    mode.value = data?.mode ?? 'work'
    label.value = data?.label ?? ''
    remainingMs.value = Number(data?.remainingMs) || 0
    totalMs.value = Number(data?.totalMs) || (mode.value === 'break' ? 5 : 25) * 60_000
    lastUpdate.value = Date.now()
    error.value = ''
    hasData.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : (spanish.value ? 'No se pudo consultar el temporizador.' : 'Timer status is unavailable.')
  } finally {
    loaded.value = true
    fetching.value = false
  }
}

async function start(nextMode: 'work' | 'break') {
  if (busy.value || props.readonly) return
  busy.value = true
  error.value = ''
  try {
    await executeWidgetAction(props.apiBase, actionType('start'), { ...props.action.parameters, mode: nextMode })
    await refresh(true)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : (spanish.value ? 'No se pudo iniciar el temporizador.' : 'Timer could not be started.')
  } finally {
    busy.value = false
  }
}

async function stop() {
  if (busy.value || props.readonly) return
  busy.value = true
  error.value = ''
  try {
    await executeWidgetAction(props.apiBase, actionType('stop'), {})
    await refresh(true)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : (spanish.value ? 'No se pudo detener el temporizador.' : 'Timer could not be stopped.')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void refresh()
  pollTimer = setInterval(() => void refresh(), 5000)
  clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (clockTimer) clearInterval(clockTimer)
})
</script>

<style scoped>
.pomodoro { box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: space-between; gap: 8px; width: 100%; height: 100%; min-width: 0; padding: clamp(10px, 4cqi, 18px); overflow: hidden; color: var(--bd-ink, #ece8df); background: var(--bd-sf, #191a1d); border: 1px solid var(--bd-ln, #34363b); border-radius: var(--bd-rk, 14px); container-type: inline-size; }
header { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 8px; }
.eyebrow { display: inline-flex; align-items: center; gap: 6px; color: var(--bd-ac, #e4b85e); font-size: 10px; font-weight: 700; letter-spacing: .08em; }
.mode { color: var(--bd-mu, #999da5); font-size: 11px; }
.dial { position: relative; display: grid; flex: 1; place-items: center; width: min(100%, 210px); min-height: 0; aspect-ratio: 1; }
svg { position: absolute; width: 100%; height: 100%; transform: rotate(-90deg); }
circle { fill: none; stroke-width: 4; }
.track { stroke: var(--bd-ln, #34363b); }
.progress { stroke: var(--bd-ac, #e4b85e); stroke-linecap: round; stroke-dasharray: 320.44; transition: stroke-dashoffset .4s ease; }
.is-break .progress { stroke: var(--bd-ok, #69b982); }
.time { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0; text-align: center; }
.time strong { font-family: var(--bd-mono, ui-monospace, monospace); font-size: clamp(28px, 14cqi, 46px); font-weight: 600; letter-spacing: -.06em; font-variant-numeric: tabular-nums; }
.time span { max-width: 90%; overflow: hidden; color: var(--bd-mu, #999da5); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.controls { display: flex; justify-content: center; gap: 7px; width: 100%; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 34px; min-height: 34px; padding: 0 11px; color: var(--bd-ink, #ece8df); background: transparent; border: 1px solid var(--bd-ln, #34363b); border-radius: 9px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.start { color: var(--bd-bg-ink, #171819); background: var(--bd-ac, #e4b85e); border-color: var(--bd-ac, #e4b85e); }
.break:hover:not(:disabled), .stop:hover:not(:disabled) { border-color: var(--bd-ac, #e4b85e); }
button:focus-visible { outline: 2px solid var(--bd-ac, #e4b85e); outline-offset: 2px; }
button:disabled { opacity: .45; cursor: not-allowed; }
.state { display: flex; flex: 1; align-items: center; justify-content: center; gap: 8px; min-height: 0; color: var(--bd-mu, #999da5); font-size: 13px; }
.error { color: var(--bd-danger, #e56b6f); }
.note { flex: 0 0 auto; margin: 0; overflow: hidden; max-width: 100%; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } .progress { transition: none; } }
</style>
