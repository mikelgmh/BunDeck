<template>
  <section
    class="stream-studio"
    :data-platform="platform"
    data-cy="widget-stream-studio"
    :aria-label="label || platformName"
    :aria-busy="busy || fetching ? 'true' : 'false'"
  >
    <!-- Sin identificar (credenciales ni en parámetros ni cargadas nunca) → badge de ajustes. -->
    <NeedsConfig
      v-if="!isConfigured"
      :action-type="props.action.type"
      :position="props.position"
    />

    <header class="ss-head">
      <span class="ss-mark" aria-hidden="true"><component :is="platformIcon" :size="16" /></span>
      <div class="ss-heading">
        <Marquee class="ss-title" :text="label || platformName" />
        <span class="ss-caption bd-data-swap" :key="statusText">{{ statusText }}</span>
      </div>
      <span v-if="statusLoaded" class="ss-live-dot" :class="{ on: isLive }" :title="statusText" aria-hidden="true" />
      <button class="stream-icon-btn ss-refresh" type="button" :disabled="fetching || busy" :aria-label="tr('Actualizar estado', 'Refresh status')" :title="tr('Actualizar estado', 'Refresh status')" @click="refresh(true)">
        <LoaderCircle v-if="fetching || busy" class="spin" :size="16" aria-hidden="true" />
        <RefreshCw v-else :size="16" aria-hidden="true" />
      </button>
    </header>

    <p v-if="error" class="stream-error" role="alert" :title="error">{{ error }}</p>

    <!-- ============ OBS ============ -->
    <template v-if="platform === 'obs'">
      <!-- XS (<200px): carrusel directo ↔ grabación (sin botones secundarios ni refresh). -->
      <AutoCarousel class="xs-only ss-hero-carousel" :count="2" :interval-ms="carouselMs" data-cy="bd-obs-carousel" v-slot="{ index }">
        <div class="ss-hero" :aria-live="index === 0 ? 'polite' : 'off'">
          <component :is="index === 0 ? Radio : CircleDot" :size="20" aria-hidden="true" :class="{ 'is-live': index === 0 ? streamState : recording }" />
          <strong>{{ index === 0 ? streamWord : recordWord }}</strong>
          <span>{{ index === 0 ? tr('Emisión', 'Stream') : tr('Grabación', 'Recording') }}</span>
        </div>
      </AutoCarousel>
      <div class="xs-only ss-xs-action">
        <button class="stream-btn live-btn" type="button" :disabled="readonly || busy || fetching || !statusLoaded" @click="streamState ? askConfirmation(tr('Detener la emisión en directo', 'Stop the live stream'), 'stream', { action: 'stop' }) : run('stream', { action: 'start' })">
          <Radio :size="15" aria-hidden="true" />{{ streamState ? tr('Detener', 'Stop') : tr('Directo', 'Go live') }}
        </button>
      </div>

      <!-- M+ (≥200px): píldoras + acciones principales. -->
      <div class="m-plus stream-status-row" aria-live="polite">
        <span class="status-pill" :class="{ active: statusLoaded && streamState }"><Radio :size="13" aria-hidden="true" />{{ streamWord }}</span>
        <span class="status-pill" :class="{ active: statusLoaded && recording }"><CircleDot :size="13" aria-hidden="true" />{{ recordWord }}</span>
      </div>
      <div class="m-plus stream-actions">
        <button class="stream-btn live-btn" type="button" :disabled="readonly || busy || fetching || !statusLoaded" @click="streamState ? askConfirmation(tr('Detener la emisión en directo', 'Stop the live stream'), 'stream', { action: 'stop' }) : run('stream', { action: 'start' })">
          <Radio :size="15" aria-hidden="true" />{{ streamState ? tr('Detener directo', 'Stop stream') : tr('Iniciar directo', 'Start stream') }}
        </button>
        <button class="stream-btn" type="button" :disabled="readonly || busy || fetching || !statusLoaded" @click="recording ? askConfirmation(tr('Detener la grabación', 'Stop the recording'), 'record', { action: 'stop' }) : run('record', { action: 'start' })">
          <CircleDot :size="15" aria-hidden="true" />{{ recording ? tr('Detener grabación', 'Stop recording') : tr('Grabar', 'Record') }}
        </button>
        <button class="stream-btn" type="button" :disabled="readonly || busy || fetching" @click="run('replay')"><History :size="15" aria-hidden="true" />{{ tr('Repetición', 'Replay') }}</button>
      </div>
      <div class="m-plus stream-form-row">
        <label class="stream-field">
          <span>{{ tr('Escena', 'Scene') }}</span>
          <select v-model="scene" :disabled="readonly || busy || fetching || !scenes.length" :aria-label="tr('Escena OBS', 'OBS scene')">
            <option value="" disabled>{{ scenes.length ? tr('Elige una escena', 'Choose a scene') : tr('Sin escenas', 'No scenes') }}</option>
            <option v-for="option in scenes" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <button class="stream-btn compact" type="button" :disabled="readonly || busy || fetching || !scene" @click="run('scene', { scene })"><Layers :size="14" aria-hidden="true" />{{ tr('Cambiar', 'Switch') }}</button>
      </div>
      <!-- L (≥340px): entradas de texto (fuentes) — solo con espacio. -->
      <div class="l-only stream-form-row">
        <label class="stream-field">
          <span>{{ tr('Fuente de audio', 'Audio source') }}</span>
          <input v-model="source" :disabled="readonly || busy || fetching" :placeholder="tr('Nombre de fuente', 'Source name')" :aria-label="tr('Fuente de audio OBS', 'OBS audio source')" />
        </label>
        <button class="stream-btn compact" type="button" :disabled="readonly || busy || fetching || !source.trim()" @click="run('mute', { source: source.trim() })"><MicOff :size="14" aria-hidden="true" />{{ tr('Silenciar', 'Mute') }}</button>
      </div>
      <div class="l-only stream-form-row">
        <label class="stream-field">
          <span>{{ tr('Fuente en escena', 'Scene source') }}</span>
          <input v-model="sceneSource" :disabled="readonly || busy || fetching" :placeholder="tr('Nombre de fuente', 'Source name')" :aria-label="tr('Fuente para mostrar u ocultar', 'Source to show or hide')" />
        </label>
        <button class="stream-btn compact" type="button" :disabled="readonly || busy || fetching || !sceneSource.trim()" @click="run('source', { source: sceneSource.trim() })"><Eye :size="14" aria-hidden="true" />{{ tr('Alternar', 'Toggle') }}</button>
      </div>
    </template>

    <!-- ============ TWITCH ============ -->
    <template v-else-if="platform === 'twitch'">
      <!-- XS: carrusel espectadores ↔ título (sin formularios ni secundarios). -->
      <AutoCarousel class="xs-only ss-hero-carousel" :count="title ? 2 : 1" :interval-ms="carouselMs" data-cy="bd-twitch-carousel" v-slot="{ index }">
        <div v-if="index === 0 || !title" class="ss-hero" aria-live="polite">
          <Users :size="20" aria-hidden="true" />
          <strong class="ss-viewers bd-data-swap" :key="String(viewerCount ?? '')">{{ viewerCount === null ? '—' : viewerCount.toLocaleString() }}</strong>
          <span>{{ tr('espectadores', 'viewers') }}</span>
        </div>
        <div v-else class="ss-hero ss-hero-title">
          <Type :size="18" aria-hidden="true" />
          <Marquee :text="title" />
        </div>
      </AutoCarousel>

      <!-- M+: lectura + acciones sin texto libre. L: formularios. -->
      <div class="m-plus viewer-readout" aria-live="polite">
        <Users :size="18" aria-hidden="true" />
        <strong class="bd-data-swap" :key="String(viewerCount ?? '')">{{ viewerCount === null ? '—' : viewerCount.toLocaleString() }}</strong>
        <span>{{ tr('espectadores', 'viewers') }}</span>
        <span v-if="isLive" class="mini-live">{{ tr('EN DIRECTO', 'LIVE') }}</span>
      </div>
      <div v-if="title" class="m-plus ss-subtitle"><Marquee :text="title" /></div>
      <div class="m-plus stream-actions">
        <button class="stream-btn" type="button" :disabled="readonly || busy || fetching" @click="run('create-marker')"><Flag :size="15" aria-hidden="true" />{{ tr('Marcador', 'Marker') }}</button>
        <button class="stream-btn" type="button" :disabled="readonly || busy || fetching" @click="run('create-clip')"><Scissors :size="15" aria-hidden="true" />{{ tr('Clip', 'Clip') }}</button>
        <button class="stream-btn" type="button" :disabled="readonly || busy || fetching" @click="run('ad-break', { length: 30 })"><Megaphone :size="15" aria-hidden="true" />{{ tr('Anuncio 30 s', '30 s ad') }}</button>
      </div>
      <div class="l-only stream-form-row">
        <label class="stream-field"><span>{{ tr('Título', 'Title') }}</span><input v-model="titleInput" :disabled="readonly || busy || fetching" :placeholder="tr('Nuevo título del directo', 'New stream title')" /></label>
        <button class="stream-btn compact" type="button" :disabled="readonly || busy || fetching || !titleInput.trim()" @click="run('set-title', { title: titleInput.trim() })"><Type :size="14" aria-hidden="true" />{{ tr('Aplicar', 'Apply') }}</button>
      </div>
      <div class="l-only stream-form-row">
        <label class="stream-field"><span>{{ tr('Categoría', 'Category') }}</span><input v-model="gameName" :disabled="readonly || busy || fetching" :placeholder="tr('Nombre de categoría', 'Category name')" /></label>
        <button class="stream-btn compact" type="button" :disabled="readonly || busy || fetching || !gameName.trim()" @click="run('set-category', { gameName: gameName.trim() })"><Gamepad2 :size="14" aria-hidden="true" />{{ tr('Aplicar', 'Apply') }}</button>
      </div>
      <label class="l-only stream-field full-field"><span>{{ tr('Mensaje de chat', 'Chat message') }}</span><input v-model="message" :disabled="readonly || busy || fetching" :placeholder="tr('Escribe un mensaje…', 'Write a message…')" @keydown.enter.prevent="sendChat" /></label>
      <button class="l-only stream-btn primary-btn" type="button" :disabled="readonly || busy || fetching || !message.trim()" @click="sendChat"><Send :size="15" aria-hidden="true" />{{ tr('Enviar al chat', 'Send to chat') }}</button>
    </template>

    <!-- ============ YOUTUBE ============ -->
    <template v-else-if="platform === 'youtube'">
      <AutoCarousel class="xs-only ss-hero-carousel" :count="title ? 2 : 1" :interval-ms="carouselMs" data-cy="bd-youtube-carousel" v-slot="{ index }">
        <div v-if="index === 0 || !title" class="ss-hero" aria-live="polite">
          <Users :size="20" aria-hidden="true" />
          <strong class="ss-viewers bd-data-swap" :key="String(viewerCount ?? '')">{{ viewerCount === null ? '—' : viewerCount.toLocaleString() }}</strong>
          <span>{{ tr('espectadores', 'viewers') }}</span>
        </div>
        <div v-else class="ss-hero ss-hero-title">
          <Type :size="18" aria-hidden="true" />
          <Marquee :text="title" />
        </div>
      </AutoCarousel>

      <div class="m-plus viewer-readout" aria-live="polite">
        <Users :size="18" aria-hidden="true" />
        <strong class="bd-data-swap" :key="String(viewerCount ?? '')">{{ viewerCount === null ? '—' : viewerCount.toLocaleString() }}</strong>
        <span>{{ tr('espectadores', 'viewers') }}</span>
        <span v-if="isLive" class="mini-live">{{ tr('EN DIRECTO', 'LIVE') }}</span>
      </div>
      <div v-if="title" class="m-plus ss-subtitle"><Marquee :text="title" /></div>
      <div class="m-plus stream-actions">
        <button class="stream-btn" type="button" :disabled="readonly || busy || fetching" @click="openDashboard"><LayoutDashboard :size="15" aria-hidden="true" />{{ tr('Abrir panel', 'Open dashboard') }}</button>
      </div>
      <label class="l-only stream-field full-field">
        <span>{{ tr('ID de emisión', 'Broadcast ID') }}</span>
        <input v-model="broadcastId" :disabled="readonly || busy || fetching" :placeholder="tr('ID desde YouTube Studio', 'ID from YouTube Studio')" :aria-label="tr('ID de emisión YouTube', 'YouTube broadcast ID')" />
      </label>
      <div class="l-only stream-actions">
        <button class="stream-btn live-btn" type="button" :disabled="readonly || busy || fetching || !broadcastId.trim()" @click="run('start-broadcast', { broadcastId: broadcastId.trim() })"><Play :size="15" aria-hidden="true" />{{ tr('Iniciar emisión', 'Start broadcast') }}</button>
        <button class="stream-btn danger-btn" type="button" :disabled="readonly || busy || fetching || !broadcastId.trim()" @click="askConfirmation(tr('Terminar esta emisión de YouTube', 'End this YouTube broadcast'), 'stop-broadcast', { broadcastId: broadcastId.trim() })"><Square :size="15" aria-hidden="true" />{{ tr('Terminar emisión', 'End broadcast') }}</button>
      </div>
      <label class="l-only stream-field full-field"><span>{{ tr('Chat en vivo', 'Live chat') }}</span><input v-model="message" :disabled="readonly || busy || fetching" :placeholder="tr('Escribe un mensaje…', 'Write a message…')" @keydown.enter.prevent="sendChat" /></label>
      <button class="l-only stream-btn primary-btn" type="button" :disabled="readonly || busy || fetching || !message.trim()" @click="sendChat"><Send :size="15" aria-hidden="true" />{{ tr('Enviar al chat', 'Send to chat') }}</button>
    </template>

    <!-- ============ SHADOWPLAY ============ -->
    <template v-else>
      <div class="xs-only ss-hero" :aria-live="'polite'">
        <Radio :size="20" aria-hidden="true" :class="{ 'is-live': statusLoaded && shadowplayRunning }" />
        <strong>{{ !statusLoaded ? tr('SIN CONSULTAR', 'NOT CHECKED') : shadowplayRunning ? tr('ACTIVO', 'ACTIVE') : tr('APAGADO', 'OFF') }}</strong>
        <span>{{ tr('NVIDIA Share', 'NVIDIA Share') }}</span>
      </div>
      <div class="xs-only ss-xs-action">
        <button class="stream-btn live-btn" type="button" :disabled="readonly || busy || fetching || !statusLoaded || !shadowplayRunning" @click="askConfirmation(tr('Alternar grabación de NVIDIA', 'Toggle NVIDIA recording'), 'toggle-record')"><CircleDot :size="15" aria-hidden="true" />{{ tr('Grabar', 'Record') }}</button>
      </div>

      <div class="m-plus stream-status-row" aria-live="polite">
        <span class="status-pill" :class="{ active: statusLoaded && shadowplayRunning }"><Radio :size="13" aria-hidden="true" />{{ !statusLoaded ? tr('SIN CONSULTAR', 'NOT CHECKED') : shadowplayRunning ? tr('NVIDIA SHARE ACTIVO', 'NVIDIA SHARE ACTIVE') : tr('NVIDIA SHARE APAGADO', 'NVIDIA SHARE OFF') }}</span>
      </div>
      <div class="m-plus stream-actions">
        <button class="stream-btn live-btn" type="button" :disabled="readonly || busy || fetching || !statusLoaded || !shadowplayRunning" @click="askConfirmation(tr('Alternar grabación de NVIDIA', 'Toggle NVIDIA recording'), 'toggle-record')"><CircleDot :size="15" aria-hidden="true" />{{ tr('Alternar grabación', 'Toggle recording') }}</button>
        <button class="stream-btn" type="button" :disabled="readonly || busy || fetching" @click="run('instant-replay-save')"><History :size="15" aria-hidden="true" />{{ tr('Repetición', 'Save replay') }}</button>
        <button class="stream-btn" type="button" :disabled="readonly || busy || fetching" @click="run('toggle-overlay')"><Layers :size="15" aria-hidden="true" />{{ tr('Overlay', 'Overlay') }}</button>
      </div>
      <p class="l-only stream-note">{{ tr('La grabación y la repetición usan los atajos configurados en NVIDIA App.', 'Recording and replay use the shortcuts configured in NVIDIA App.') }}</p>
    </template>

    <!-- Confirmación en velo (overlay): no consume hueco en teclas pequeñas. -->
    <div v-if="confirmation" class="confirm-veil">
      <div class="stream-confirm" role="alertdialog" aria-modal="false" aria-labelledby="stream-confirm-title" aria-describedby="stream-confirm-description">
        <strong id="stream-confirm-title">{{ confirmation.title }}?</strong>
        <span id="stream-confirm-description">{{ tr('Esto puede detener una salida activa.', 'This may stop an active output.') }}</span>
        <div class="confirm-actions">
          <button class="stream-btn compact" type="button" :disabled="busy" @click="confirmation = null">{{ tr('Cancelar', 'Cancel') }}</button>
          <button class="stream-btn danger-btn compact" type="button" :disabled="busy" @click="confirmAction">{{ tr('Confirmar', 'Confirm') }}</button>
        </div>
      </div>
    </div>

    <span class="sr-status" role="status" aria-live="polite">{{ announcement }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  CircleDot, Eye, Gamepad2, History, Layers, LayoutDashboard, LoaderCircle, Megaphone, MicOff,
  Play, Radio, RefreshCw, Scissors, Send, Square, Type, Users, Flag,
} from 'lucide-vue-next'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import { useI18nStore } from '../../../composables/useI18n'
import { resolveCarouselMs } from '../../../composables/useAutoCarousel'
import Marquee from './shared/Marquee.vue'
import NeedsConfig from './shared/NeedsConfig.vue'
import AutoCarousel from './shared/AutoCarousel.vue'

interface Props {
  action: { type: string; parameters: Record<string, any> }
  apiBase: string
  label?: string
  readonly?: boolean
  /** Posición de la tecla (la reenvía ControlSurface): la usa NeedsConfig. */
  position?: number | null
}

const props = withDefaults(defineProps<Props>(), { label: '', readonly: false, position: null })
const { currentLocale } = useI18nStore()
const tr = (es: string, en: string) => currentLocale.value.toLowerCase().startsWith('en') ? en : es
const platform = computed(() => {
  const prefix = props.action?.type?.split('.')[0]
  return ['obs', 'twitch', 'youtube', 'shadowplay'].includes(prefix) ? prefix : 'obs'
})
const platformIcon = computed(() => platform.value === 'obs' ? Radio : platform.value === 'twitch' ? Users : platform.value === 'youtube' ? Play : Layers)
const platformName = computed(() => tr(
  ({ obs: 'OBS Studio', twitch: 'Twitch', youtube: 'YouTube en directo', shadowplay: 'ShadowPlay' } as Record<string, string>)[platform.value],
  ({ obs: 'OBS Studio', twitch: 'Twitch', youtube: 'YouTube Live', shadowplay: 'ShadowPlay' } as Record<string, string>)[platform.value],
))
const params = computed(() => props.action?.parameters ?? {})
const busy = ref(false)
const fetching = ref(false)
const error = ref('')
const announcement = ref('')
const confirmation = ref<{ title: string; actionId: string; parameters: Record<string, unknown> } | null>(null)
const statusLoaded = ref(false)
const streamState = ref(false)
const recording = ref(false)
const shadowplayRunning = ref(false)
const viewerCount = ref<number | null>(null)
const isLive = ref(false)
const title = ref('')
const scenes = ref<Array<{ value: string; label: string }>>([])
const scene = ref('')
const source = ref(typeof params.value.source === 'string' ? params.value.source : '')
const sceneSource = ref('')
const titleInput = ref('')
const gameName = ref('')
const message = ref('')
const broadcastId = ref(typeof params.value.broadcastId === 'string' ? params.value.broadcastId : '')

/** Rotación en pequeño: `carouselMs` (ausente = 4000, <= 0 = off). Ver useAutoCarousel. */
const carouselMs = computed(() => resolveCarouselMs(params.value))

/**
 * Condición "sin configurar" (ver shared/README §2):
 * - OBS/ShadowPlay funcionan con los valores por defecto (localhost / sin
 *   parámetros) → siempre configurados.
 * - Twitch/YouTube necesitan credenciales: basta con que vengan en los
 *   parámetros de la acción; si solo viven en los ajustes del plugin (no
 *   visibles desde la superficie) el badge se oculta tras la primera carga
 *   con éxito o mientras se está cargando.
 */
const hasIdentityParams = computed(() => {
  const p = params.value
  const has = (k: string) => typeof p[k] === 'string' && p[k].trim().length > 0
  if (platform.value === 'twitch') return has('broadcaster') || has('clientId') || has('token')
  if (platform.value === 'youtube') return has('videoId') || has('apiKey') || has('oauthToken')
  return true
})
const isConfigured = computed(() => hasIdentityParams.value || statusLoaded.value || fetching.value)

const streamWord = computed(() => !statusLoaded.value
  ? tr('SIN CONSULTAR', 'NOT CHECKED')
  : streamState.value ? tr('EN DIRECTO', 'LIVE') : tr('FUERA DE LÍNEA', 'OFFLINE'))
const recordWord = computed(() => !statusLoaded.value
  ? tr('SIN CONSULTAR', 'NOT CHECKED')
  : recording.value ? tr('GRABANDO', 'RECORDING') : tr('DETENIDO', 'STOPPED'))

let pollTimer: ReturnType<typeof setInterval> | undefined

function unwrap(raw: any): any {
  if (raw?.success === false) throw new Error(raw.error || tr('No se pudo completar la acción.', 'Could not complete the action.'))
  return raw?.result ?? raw
}

async function run(actionId: string, overrides: Record<string, unknown> = {}): Promise<any> {
  const canReadInReadonly = actionId === 'status' || actionId === 'viewer-count' || actionId === 'check-status'
  if (busy.value || fetching.value || (props.readonly && !canReadInReadonly)) return null
  busy.value = true
  error.value = ''
  announcement.value = ''
  try {
    const result = unwrap(await executeWidgetAction(props.apiBase, `${platform.value}.${actionId}`, { ...params.value, ...overrides }))
    announcement.value = tr('Acción completada.', 'Action completed.')
    return result
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : tr('No se pudo completar la acción.', 'Could not complete the action.')
    announcement.value = error.value
    return null
  } finally {
    busy.value = false
  }
}

async function refresh(manual = false) {
  if (busy.value || fetching.value) return
  if (props.readonly && manual) {
    // En solo-lectura el refresh manual también es solo lectura: permitido.
  }
  fetching.value = true
  if (manual) error.value = ''
  try {
    if (platform.value === 'obs') {
      const status = await runSilent('status')
      if (status) {
        statusLoaded.value = true
        streamState.value = status.streaming === true
        recording.value = status.recording === true
        scenes.value = Array.isArray(status.options) ? status.options.filter((x: any) => x && typeof x.value === 'string') : []
        if (!scene.value && typeof status.currentScene === 'string') scene.value = status.currentScene
        const sceneList = await runSilent('scene-list')
        if (sceneList) {
          scenes.value = Array.isArray(sceneList.options) ? sceneList.options.filter((x: any) => x && typeof x.value === 'string') : scenes.value
          if (!scene.value && typeof sceneList.currentProgramSceneName === 'string') scene.value = sceneList.currentProgramSceneName
        }
      }
    } else if (platform.value === 'twitch' || platform.value === 'youtube') {
      const status = await runSilent('viewer-count')
      if (status) {
        statusLoaded.value = true
        viewerCount.value = Number.isFinite(Number(status.viewerCount)) ? Number(status.viewerCount) : 0
        isLive.value = status.live === true || status.state === 'live'
        title.value = typeof status.title === 'string' ? status.title : ''
      }
    } else {
      const status = await runSilent('check-status')
      if (status) {
        statusLoaded.value = true
        shadowplayRunning.value = status.running === true
        isLive.value = shadowplayRunning.value
      }
    }
    if (manual) announcement.value = tr('Estado actualizado.', 'Status updated.')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : tr('No se pudo consultar el estado.', 'Could not fetch the status.')
  } finally {
    fetching.value = false
  }
}

/** Lectura silenciosa del poll (no pisa `busy` de las acciones del usuario). */
async function runSilent(actionId: string): Promise<any> {
  const raw = await executeWidgetAction(props.apiBase, `${platform.value}.${actionId}`, { ...params.value })
  return unwrap(raw)
}

async function sendChat() {
  if (!message.value.trim()) return
  const text = message.value.trim()
  const result = await run(platform.value === 'twitch' ? 'chat-message' : 'post-chat', { message: text })
  if (result) message.value = ''
}

async function openDashboard() {
  if (busy.value || fetching.value || props.readonly) return
  await run('open-dashboard')
}

function askConfirmation(titleText: string, actionId: string, parameters: Record<string, unknown> = {}) {
  if (!props.readonly && !busy.value && !fetching.value) confirmation.value = { title: titleText, actionId, parameters }
}

async function confirmAction() {
  const pending = confirmation.value
  if (!pending) return
  confirmation.value = null
  await run(pending.actionId, pending.parameters)
}

const statusText = computed(() => {
  if (!statusLoaded.value) return tr('Estado sin consultar', 'Status not checked')
  if (platform.value === 'obs') return streamState.value ? tr('En directo', 'Live') : tr('Control de emisión', 'Stream controls')
  if (platform.value === 'twitch' || platform.value === 'youtube') return viewerCount.value === null ? tr('Sin datos de espectadores', 'No viewer data') : tr('Audiencia actual', 'Current audience')
  return shadowplayRunning.value ? tr('Overlay disponible', 'Overlay available') : tr('Comprueba NVIDIA App', 'Check NVIDIA App')
})

const pollMs = computed(() => platform.value === 'obs' ? 15_000 : platform.value === 'shadowplay' ? 30_000 : 60_000)

onMounted(() => {
  void refresh()
  pollTimer = setInterval(() => void refresh(), pollMs.value)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<style scoped>
.stream-studio {
  --stream-accent: var(--bd-ac, #e0a84a);
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container-type: size;
  container-name: stream-studio;
  position: relative;
  color: var(--bd-ink, #ece9e2);
  background: var(--bd-sf, #1b1d20);
  border: 1px solid var(--bd-ln, #34373b);
  border-radius: var(--bd-rk, 14px);
  padding: clamp(8px, 2.2cqi, 15px);
  display: flex;
  flex-direction: column;
  gap: clamp(6px, 1.8cqi, 11px);
  font: 500 clamp(10px, 2.4cqi, 13px)/1.3 var(--bd-sans, inherit);
}
.ss-head, .ss-heading { display: flex; min-width: 0; }
.ss-head { align-items: center; gap: 8px; flex: none; }
.ss-mark { display: grid; place-items: center; width: 30px; height: 30px; flex: none; color: var(--stream-accent); background: color-mix(in srgb, var(--stream-accent) 12%, transparent); border-radius: 9px; }
.ss-heading { flex: 1; flex-direction: column; gap: 2px; }
.ss-title { font-size: 1.08em; font-weight: 700; }
.ss-caption { color: var(--bd-mu, #a3a5a8); font-size: .82em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-live-dot { width: 9px; height: 9px; flex: none; border-radius: 50%; background: var(--bd-mu, #6b6d70); }
.ss-live-dot.on { background: #e5484d; box-shadow: 0 0 0 3px color-mix(in srgb, #e5484d 22%, transparent); }
/* Sin refresh manual en XS: el widget ya hace poll silencioso. */
.ss-refresh { display: none; flex: none; }
.ss-refresh { flex: none; }
.stream-icon-btn, .stream-btn {
  border: 1px solid var(--bd-ln, #3b3d40);
  color: var(--bd-ink, #ece9e2);
  background: var(--bd-bg, #242629);
  font: inherit;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
}
.stream-icon-btn { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; flex: none; }
.stream-icon-btn.ss-refresh { display: none; }
.stream-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; min-height: 34px; padding: 6px 10px; border-radius: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stream-btn:hover:not(:disabled), .stream-icon-btn:hover:not(:disabled) { border-color: var(--stream-accent); }
.stream-btn:active:not(:disabled) { transform: translateY(1px); }
.stream-btn:focus-visible, .stream-icon-btn:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--stream-accent); outline-offset: 2px; }
.stream-btn:disabled, .stream-icon-btn:disabled { opacity: .48; cursor: not-allowed; }
.live-btn, .primary-btn { background: color-mix(in srgb, var(--stream-accent) 17%, var(--bd-bg, #242629)); border-color: color-mix(in srgb, var(--stream-accent) 60%, var(--bd-ln, #3b3d40)); }
.danger-btn { color: var(--bd-danger, #ff8b84); }
/* Héroe XS: dato clave grande + carrusel. */
.ss-hero-carousel { flex: 1; min-height: 0; }
.ss-hero { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; width: 100%; height: 100%; min-height: 0; text-align: center; }
.ss-hero strong { font: 600 clamp(15px, 9cqi, 30px)/1.05 var(--bd-sans, inherit); letter-spacing: .01em; }
.ss-hero .ss-viewers { font-family: var(--bd-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
.ss-hero > span { color: var(--bd-mu, #a3a5a8); font-size: clamp(9px, 3cqi, 11px); }
.ss-hero svg.is-live { color: #e5484d; }
.ss-hero-title { gap: 6px; }
.ss-xs-action { flex: none; display: flex; }
.ss-xs-action > .stream-btn { flex: 1; }
.stream-actions, .stream-status-row { display: flex; align-items: center; }
.stream-actions { flex-wrap: wrap; gap: 6px; }
.stream-status-row { flex-wrap: wrap; gap: 6px; }
.status-pill { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; border-radius: 999px; color: var(--bd-mu, #a3a5a8); background: var(--bd-bg, #242629); font-size: .78em; letter-spacing: .02em; }
.status-pill.active { color: var(--bd-ok, #80d49b); }
.mini-live { margin-left: auto; padding: 2px 6px; border-radius: 6px; color: #e5484d; background: color-mix(in srgb, #e5484d 12%, transparent); font-size: .72em; font-weight: 700; }
.viewer-readout { display: flex; align-items: center; gap: 8px; min-height: 36px; color: var(--bd-mu, #a3a5a8); }
.viewer-readout strong { color: var(--bd-ink, #ece9e2); font: 600 clamp(20px, 6cqi, 32px)/1 var(--bd-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
.viewer-readout span { font-size: .85em; }
.ss-subtitle { display: none; color: var(--bd-mu, #a3a5a8); font-size: .86em; }
.stream-form-row { display: flex; gap: 6px; min-width: 0; align-items: end; }
.stream-field { display: grid; gap: 4px; min-width: 0; flex: 1; color: var(--bd-mu, #a3a5a8); font-size: .82em; }
.stream-field input, .stream-field select { box-sizing: border-box; width: 100%; min-width: 0; height: 32px; padding: 0 8px; border: 1px solid var(--bd-ln, #3b3d40); border-radius: 7px; color: var(--bd-ink, #ece9e2); background: var(--bd-bg, #242629); font: inherit; }
.stream-field input::placeholder { color: var(--bd-mu, #a3a5a8); opacity: .72; }
.stream-field select:disabled, .stream-field input:disabled { opacity: .6; }
.compact { min-height: 32px; align-self: end; padding-inline: 9px; }
.full-field { flex: none; }
.stream-note { margin: 0; line-height: 1.45; color: var(--bd-mu, #a3a5a8); font-size: .86em; }
/* En XS el error largo se recorta a una línea (texto completo en `title`). */
.stream-error { margin: 0; flex: none; padding: 7px 9px; border-left: 2px solid var(--bd-danger, #e5484d); color: var(--bd-danger, #ff8b84); background: color-mix(in srgb, var(--bd-danger, #e5484d) 9%, transparent); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: .86em; }
/* Velo de confirmación: overlay absoluto, apto también en teclas 1×1. */
.confirm-veil { position: absolute; inset: 0; z-index: 6; display: grid; place-items: center; padding: 8px; background: color-mix(in srgb, #000 55%, transparent); }
.stream-confirm { display: grid; gap: 5px; width: 100%; padding: 9px; border: 1px solid color-mix(in srgb, var(--bd-danger, #e5484d) 55%, var(--bd-ln, #3b3d40)); border-radius: 9px; background: var(--bd-bg, #242629); }
.stream-confirm > span { color: var(--bd-mu, #a3a5a8); font-size: .86em; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 6px; }
.sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ---- Bandas XS / M / L (§4 README) ---- */
/* XS por defecto: héroe + (como mucho) 1 acción; sin refresh, sin formularios. */
.m-plus, .l-only { display: none !important; }
.ss-caption { display: none; }
/* M+: contenido completo solo si hay alto suficiente (en teclas bajas como
   2×1 o 3×1 se mantiene el héroe XS, que sí cabe). */
@container stream-studio (min-width: 200px) and (min-height: 140px) {
  .stream-actions.m-plus, .stream-status-row.m-plus, .viewer-readout.m-plus, .stream-form-row.m-plus { display: flex !important; }
  .ss-refresh { display: grid !important; }
  .ss-subtitle.m-plus { display: block !important; }
  .xs-only { display: none !important; }
  .ss-caption { display: block; }
  .stream-error { white-space: normal; overflow-wrap: anywhere; }
}
@container stream-studio (min-width: 340px) and (min-height: 140px) {
  .stream-form-row.l-only, .stream-actions.l-only { display: flex !important; }
  label.l-only { display: grid !important; }
  button.l-only { display: inline-flex !important; }
  .stream-note.l-only { display: block !important; }
}
/* Tecla baja (p. ej. 2×1, 3×1): compactar para que quepan píldoras + acciones. */
@container stream-studio (max-height: 150px) {
  .stream-studio { gap: 4px; padding: 7px; }
  .ss-mark { width: 24px; height: 24px; }
  .ss-caption { display: none; }
  .stream-btn { min-height: 30px; padding: 4px 7px; }
  .status-pill { padding: 3px 7px; }
  .viewer-readout { min-height: 30px; }
  .ss-hero strong { font-size: clamp(13px, 7cqi, 20px); }
}
/* Tecla ancha y alta (L): héroe y acción en fila sin wrap. */
@container stream-studio (min-width: 340px) and (min-aspect-ratio: 13/10) {  .stream-actions { flex-wrap: nowrap; }
  .stream-actions > .stream-btn { flex: 1; min-width: 0; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
</style>
