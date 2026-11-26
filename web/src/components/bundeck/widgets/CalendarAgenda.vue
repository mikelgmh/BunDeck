<template>
  <section class="agenda" :aria-label="copy.ariaLabel" data-cy="widget-calendar-agenda">
    <header class="head">
      <span class="eyebrow"><CalendarDays :size="15" aria-hidden="true" />{{ label || copy.agenda }}</span>
      <span v-if="event?.start" class="date">{{ formatDate(event.start) }}</span>
    </header>

    <div v-if="busy && !loaded" class="state" role="status">
      <LoaderCircle class="spin" :size="18" aria-hidden="true" /> {{ copy.checking }}
    </div>
    <div v-else-if="error && !event" class="state error" role="alert">
      <p>{{ error }}</p>
      <button class="quiet" type="button" :disabled="busy || readonly" @click="load">{{ copy.tryAgain }}</button>
    </div>
    <div v-else-if="!event" class="state empty">
      <CalendarCheck :size="22" aria-hidden="true" />
      <span>{{ copy.noEvents }}</span>
    </div>
    <div v-else class="event">
      <h2>{{ event.summary || copy.untitled }}</h2>
      <p v-if="event.location" class="location"><MapPin :size="13" aria-hidden="true" />{{ event.location }}</p>
      <div class="countdown" aria-live="off">
        <Clock3 :size="16" aria-hidden="true" />
        <span>{{ countdown }}</span>
      </div>
      <button
        v-if="event.url"
        class="open"
        type="button"
        :disabled="busy || readonly"
        @click="openEvent"
      >
        <ExternalLink :size="15" aria-hidden="true" /> {{ copy.openEvent }}
      </button>
    </div>

    <p v-if="error && loaded && event" class="inline-error" role="alert">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { CalendarCheck, CalendarDays, Clock3, ExternalLink, LoaderCircle, MapPin } from 'lucide-vue-next'
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
  ? { agenda: 'AGENDA', checking: 'Consultando calendario…', tryAgain: 'Reintentar', noEvents: 'No hay próximos eventos', untitled: 'Evento sin título', timeUnavailable: 'Hora no disponible', now: 'Empieza ahora', openEvent: 'Abrir evento', ariaLabel: 'Próximo evento del calendario', day: 'd', hour: 'h', minute: 'min' }
  : { agenda: 'AGENDA', checking: 'Checking calendar…', tryAgain: 'Try again', noEvents: 'No upcoming events', untitled: 'Untitled event', timeUnavailable: 'Time unavailable', now: 'Starting now', openEvent: 'Open event', ariaLabel: 'Upcoming calendar event', day: 'd', hour: 'h', minute: 'm' })

const event = ref<any>(null)
const busy = ref(false)
const loaded = ref(false)
const error = ref('')
const now = ref(Date.now())
let pollTimer: ReturnType<typeof setInterval> | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined

const countdown = computed(() => {
  const target = event.value?.start ? new Date(event.value.start).getTime() : NaN
  if (!Number.isFinite(target)) return event.value?.startLocal ?? copy.value.timeUnavailable
  const minutes = Math.max(0, Math.ceil((target - now.value) / 60_000))
  if (minutes < 1) return copy.value.now
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days) return spanish.value ? `En ${days}${copy.value.day}${hours ? ` ${hours}${copy.value.hour}` : ''}` : `In ${days}${copy.value.day}${hours ? ` ${hours}${copy.value.hour}` : ''}`
  if (hours) return spanish.value ? `En ${hours}${copy.value.hour}${rest ? ` ${rest}${copy.value.minute}` : ''}` : `In ${hours}${copy.value.hour}${rest ? ` ${rest}${copy.value.minute}` : ''}`
  return spanish.value ? `En ${minutes} ${copy.value.minute}` : `In ${minutes}${copy.value.minute}`
})

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(spanish.value ? 'es' : 'en', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

async function load() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const data = await executeWidgetAction(props.apiBase, 'calendar.next-event', props.action.parameters)
    event.value = data?.found === true && data?.event ? data.event : null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : (spanish.value ? 'No se pudo consultar el calendario.' : 'Calendar could not be checked.')
  } finally {
    loaded.value = true
    busy.value = false
  }
}

async function openEvent() {
  if (busy.value || props.readonly || !event.value?.url) return
  busy.value = true
  error.value = ''
  try {
    await executeWidgetAction(props.apiBase, 'calendar.open-event', { ...props.action.parameters, url: event.value.url })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : (spanish.value ? 'No se pudo abrir este evento.' : 'Could not open this event.')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void load()
  pollTimer = setInterval(() => void load(), 60_000)
  clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (clockTimer) clearInterval(clockTimer)
})
</script>

<style scoped>
.agenda {
  box-sizing: border-box; display: flex; flex-direction: column; gap: clamp(8px, 3cqi, 14px);
  width: 100%; height: 100%; min-width: 0; padding: clamp(12px, 5cqi, 20px);
  overflow: hidden; color: var(--bd-ink, #ece8df); background: var(--bd-sf, #191a1d);
  border: 1px solid var(--bd-ln, #34363b); border-radius: var(--bd-rk, 14px);
  container-type: inline-size;
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--bd-mu, #999da5); }
.eyebrow { display: inline-flex; align-items: center; gap: 7px; color: var(--bd-ac, #e4b85e); font-size: 11px; font-weight: 700; letter-spacing: .08em; }
.date { overflow: hidden; font-size: clamp(10px, 3cqi, 12px); text-overflow: ellipsis; white-space: nowrap; }
.event { display: flex; flex: 1; flex-direction: column; align-items: flex-start; justify-content: center; gap: 8px; min-height: 0; }
h2 { display: -webkit-box; max-width: 100%; margin: 0; overflow: hidden; font-size: clamp(17px, 7cqi, 25px); font-weight: 650; line-height: 1.12; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.location { display: flex; align-items: center; gap: 5px; max-width: 100%; margin: 0; overflow: hidden; color: var(--bd-mu, #999da5); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.countdown { display: flex; align-items: center; gap: 7px; color: var(--bd-ac, #e4b85e); font-size: clamp(13px, 4.5cqi, 16px); font-weight: 600; }
.open, .quiet { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 0 12px; color: var(--bd-ink, #ece8df); background: transparent; border: 1px solid var(--bd-ln, #34363b); border-radius: 9px; font: inherit; cursor: pointer; }
.open { margin-top: 2px; }
.open:hover:not(:disabled), .quiet:hover:not(:disabled) { border-color: var(--bd-ac, #e4b85e); }
button:focus-visible { outline: 2px solid var(--bd-ac, #e4b85e); outline-offset: 2px; }
button:disabled { opacity: .55; cursor: not-allowed; }
.state { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 9px; min-height: 0; color: var(--bd-mu, #999da5); text-align: center; font-size: 13px; }
.state p { margin: 0; overflow-wrap: anywhere; }
.empty { color: var(--bd-mu, #999da5); }
.error, .inline-error { color: var(--bd-danger, #e56b6f); }
.inline-error { margin: 0; overflow: hidden; font-size: 11px; text-overflow: ellipsis; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
