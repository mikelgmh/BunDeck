<template>
  <section class="stream-control stream-cq" :data-cy="`stream-studio-${platform}`" :aria-label="label || platformName">
    <header class="stream-head">
      <div class="stream-brand">
        <span class="stream-mark" aria-hidden="true"><Radio :size="16" /></span>
        <div class="stream-heading">
          <strong>{{ label || platformName }}</strong>
          <span class="stream-caption">{{ statusText }}</span>
        </div>
      </div>
      <button class="stream-icon-btn" type="button" :disabled="busy" :aria-label="tr('Actualizar estado', 'Refresh status')" @click="refresh">
        <LoaderCircle v-if="busy" class="spin" :size="16" aria-hidden="true" />
        <RefreshCw v-else :size="16" aria-hidden="true" />
      </button>
    </header>

    <p v-if="error" class="stream-error" role="alert">{{ error }}</p>

    <template v-if="platform === 'obs'">
      <div class="stream-status-row">
        <span class="status-pill" :class="{ active: statusLoaded && streamState }"><Radio :size="13" />{{ !statusLoaded ? tr('SIN CONSULTAR', 'NOT CHECKED') : streamState ? tr('EN DIRECTO', 'LIVE') : tr('FUERA DE LÍNEA', 'OFFLINE') }}</span>
        <span class="status-pill" :class="{ active: statusLoaded && recording }"><CircleDot :size="13" />{{ !statusLoaded ? tr('SIN CONSULTAR', 'NOT CHECKED') : recording ? tr('GRABANDO', 'RECORDING') : tr('DETENIDO', 'STOPPED') }}</span>
      </div>
      <div class="stream-actions">
        <button class="stream-btn live-btn" :disabled="readonly || busy || !statusLoaded" @click="streamState ? askConfirmation(tr('Detener la emisión en directo', 'Stop the live stream'), 'stream', { action: 'stop' }) : run('stream', { action: 'start' })">
          <Radio :size="15" />{{ streamState ? tr('Detener directo', 'Stop stream') : tr('Iniciar directo', 'Start stream') }}
        </button>
        <button class="stream-btn" :disabled="readonly || busy || !statusLoaded" @click="recording ? askConfirmation(tr('Detener la grabación', 'Stop the recording'), 'record', { action: 'stop' }) : run('record', { action: 'start' })">
          <CircleDot :size="15" />{{ recording ? tr('Detener grabación', 'Stop recording') : tr('Grabar', 'Record') }}
        </button>
        <button class="stream-btn" :disabled="readonly || busy" @click="run('replay')"><History :size="15" />{{ tr('Guardar repetición', 'Save replay') }}</button>
      </div>
      <div class="stream-form-row">
        <label class="stream-field">
          <span>{{ tr('Escena', 'Scene') }}</span>
          <select v-model="scene" :disabled="readonly || busy || !scenes.length" :aria-label="tr('Escena OBS', 'OBS scene')">
            <option value="" disabled>{{ scenes.length ? tr('Elige una escena', 'Choose a scene') : tr('Sin escenas disponibles', 'No scenes available') }}</option>
            <option v-for="option in scenes" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <button class="stream-btn compact" :disabled="readonly || busy || !scene" @click="run('scene', { scene })"><Layers :size="14" />{{ tr('Cambiar', 'Switch') }}</button>
      </div>
      <div class="stream-form-row">
        <label class="stream-field">
          <span>{{ tr('Fuente de audio', 'Audio source') }}</span>
          <input v-model="source" :disabled="readonly || busy" :placeholder="tr('Nombre de fuente', 'Source name')" :aria-label="tr('Fuente de audio OBS', 'OBS audio source')" />
        </label>
        <button class="stream-btn compact" :disabled="readonly || busy || !source.trim()" @click="run('mute', { source: source.trim() })"><MicOff :size="14" />{{ tr('Alternar silencio', 'Toggle mute') }}</button>
      </div>
      <div class="stream-form-row">
        <label class="stream-field">
          <span>{{ tr('Fuente en escena', 'Scene source') }}</span>
          <input v-model="sceneSource" :disabled="readonly || busy" :placeholder="tr('Nombre de fuente', 'Source name')" :aria-label="tr('Fuente para mostrar u ocultar', 'Source to show or hide')" />
        </label>
        <button class="stream-btn compact" :disabled="readonly || busy || !sceneSource.trim()" @click="run('source', { source: sceneSource.trim() })"><Eye :size="14" />{{ tr('Alternar', 'Toggle') }}</button>
      </div>
    </template>

    <template v-else-if="platform === 'twitch'">
      <div class="viewer-readout">
        <Users :size="18" aria-hidden="true" />
        <strong>{{ viewerCount === null ? '—' : viewerCount.toLocaleString() }}</strong>
        <span>{{ tr('espectadores', 'viewers') }}</span>
      </div>
      <div class="stream-form-row">
        <label class="stream-field"><span>{{ tr('Título', 'Title') }}</span><input v-model="title" :disabled="readonly || busy" :placeholder="tr('Nuevo título del directo', 'New stream title')" /></label>
        <button class="stream-btn compact" :disabled="readonly || busy || !title.trim()" @click="run('set-title', { title: title.trim() })"><Type :size="14" />{{ tr('Aplicar', 'Apply') }}</button>
      </div>
      <div class="stream-form-row">
        <label class="stream-field"><span>{{ tr('Categoría', 'Category') }}</span><input v-model="gameName" :disabled="readonly || busy" :placeholder="tr('Nombre de categoría', 'Category name')" /></label>
        <button class="stream-btn compact" :disabled="readonly || busy || !gameName.trim()" @click="run('set-category', { gameName: gameName.trim() })"><Gamepad2 :size="14" />{{ tr('Aplicar', 'Apply') }}</button>
      </div>
      <label class="stream-field full-field"><span>{{ tr('Mensaje de chat', 'Chat message') }}</span><input v-model="message" :disabled="readonly || busy" :placeholder="tr('Escribe un mensaje…', 'Write a message…')" @keydown.enter.prevent="sendChat" /></label>
      <div class="stream-actions">
        <button class="stream-btn primary-btn" :disabled="readonly || busy || !message.trim()" @click="sendChat"><Send :size="15" />{{ tr('Enviar al chat', 'Send to chat') }}</button>
        <button class="stream-btn" :disabled="readonly || busy" @click="run('create-marker')"><Flag :size="15" />{{ tr('Marcador', 'Marker') }}</button>
        <button class="stream-btn" :disabled="readonly || busy" @click="run('create-clip')"><Scissors :size="15" />{{ tr('Crear clip', 'Create clip') }}</button>
        <button class="stream-btn" :disabled="readonly || busy" @click="run('ad-break', { length: 30 })"><Megaphone :size="15" />{{ tr('Anuncio 30 s', '30 s ad') }}</button>
      </div>
    </template>

    <template v-else-if="platform === 'youtube'">
      <div class="viewer-readout">
        <Users :size="18" aria-hidden="true" />
        <strong>{{ viewerCount === null ? '—' : viewerCount.toLocaleString() }}</strong>
        <span>{{ tr('espectadores', 'viewers') }}</span>
      </div>
      <label class="stream-field full-field">
        <span>{{ tr('ID de emisión', 'Broadcast ID') }}</span>
        <input v-model="broadcastId" :disabled="readonly || busy" :placeholder="tr('ID desde YouTube Studio', 'ID from YouTube Studio')" :aria-label="tr('ID de emisión YouTube', 'YouTube broadcast ID')" />
      </label>
      <div class="stream-actions">
        <button class="stream-btn live-btn" :disabled="readonly || busy || !broadcastId.trim()" @click="run('start-broadcast', { broadcastId: broadcastId.trim() })"><Play :size="15" />{{ tr('Iniciar emisión', 'Start broadcast') }}</button>
        <button class="stream-btn danger-btn" :disabled="readonly || busy || !broadcastId.trim()" @click="askConfirmation(tr('Terminar esta emisión de YouTube', 'End this YouTube broadcast'), 'stop-broadcast', { broadcastId: broadcastId.trim() })"><Square :size="15" />{{ tr('Terminar emisión', 'End broadcast') }}</button>
      </div>
      <label class="stream-field full-field"><span>{{ tr('Chat en vivo', 'Live chat') }}</span><input v-model="message" :disabled="readonly || busy" :placeholder="tr('Escribe un mensaje…', 'Write a message…')" @keydown.enter.prevent="sendChat" /></label>
      <button class="stream-btn primary-btn" :disabled="readonly || busy || !message.trim()" @click="sendChat"><Send :size="15" />{{ tr('Enviar al chat', 'Send to chat') }}</button>
    </template>

    <template v-else>
      <div class="stream-status-row">
        <span class="status-pill" :class="{ active: statusLoaded && shadowplayRunning }"><Radio :size="13" />{{ !statusLoaded ? tr('SIN CONSULTAR', 'NOT CHECKED') : shadowplayRunning ? tr('NVIDIA SHARE ACTIVO', 'NVIDIA SHARE ACTIVE') : tr('NVIDIA SHARE NO DETECTADO', 'NVIDIA SHARE NOT DETECTED') }}</span>
      </div>
      <div class="stream-actions">
        <button class="stream-btn live-btn" :disabled="readonly || busy || !statusLoaded || !shadowplayRunning" @click="askConfirmation(tr('Alternar grabación de NVIDIA', 'Toggle NVIDIA recording'), 'toggle-record')"><CircleDot :size="15" />{{ tr('Alternar grabación', 'Toggle recording') }}</button>
        <button class="stream-btn" :disabled="readonly || busy" @click="run('instant-replay-save')"><History :size="15" />{{ tr('Guardar repetición', 'Save replay') }}</button>
      </div>
      <p class="stream-note">{{ tr('La grabación y la repetición se controlan mediante los atajos configurados en NVIDIA App.', 'Recording and replay use the shortcuts configured in NVIDIA App.') }}</p>
    </template>

    <div v-if="confirmation" class="stream-confirm" role="alertdialog" aria-modal="false" aria-labelledby="stream-confirm-title" aria-describedby="stream-confirm-description">
      <strong id="stream-confirm-title">{{ confirmation.title }}?</strong>
      <span id="stream-confirm-description">{{ tr('Esto puede detener una salida activa.', 'This may stop an active output.') }}</span>
      <div class="confirm-actions">
        <button class="stream-btn compact" :disabled="busy" @click="confirmation = null">{{ tr('Cancelar', 'Cancel') }}</button>
        <button class="stream-btn danger-btn compact" :disabled="busy" @click="confirmAction">{{ tr('Confirmar', 'Confirm') }}</button>
      </div>
    </div>

    <span class="sr-status" role="status" aria-live="polite">{{ announcement }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  CircleDot, Eye, Gamepad2, History, Layers, LoaderCircle, Megaphone, MicOff,
  Play, Radio, RefreshCw, Scissors, Send, Square, Type, Users, Flag,
} from 'lucide-vue-next'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import { useI18nStore } from '../../../composables/useI18n'

interface Props {
  action: { type: string; parameters: Record<string, any> }
  apiBase: string
  label?: string
  readonly?: boolean
}

const props = withDefaults(defineProps<Props>(), { label: '', readonly: false })
const { currentLocale } = useI18nStore()
const tr = (es: string, en: string) => currentLocale.value.toLowerCase().startsWith('en') ? en : es
const platform = computed(() => {
  const prefix = props.action?.type?.split('.')[0]
  return ['obs', 'twitch', 'youtube', 'shadowplay'].includes(prefix) ? prefix : 'obs'
})
const platformName = computed(() => tr(
  ({ obs: 'OBS Studio', twitch: 'Twitch', youtube: 'YouTube en directo', shadowplay: 'ShadowPlay' } as Record<string, string>)[platform.value],
  ({ obs: 'OBS Studio', twitch: 'Twitch', youtube: 'YouTube Live', shadowplay: 'ShadowPlay' } as Record<string, string>)[platform.value],
))
const params = computed(() => props.action?.parameters ?? {})
const busy = ref(false)
const error = ref('')
const announcement = ref('')
const confirmation = ref<{ title: string; actionId: string; parameters: Record<string, unknown> } | null>(null)
const statusLoaded = ref(false)
const streamState = ref(false)
const recording = ref(false)
const shadowplayRunning = ref(false)
const viewerCount = ref<number | null>(null)
const scenes = ref<Array<{ value: string; label: string }>>([])
const scene = ref('')
const source = ref(typeof params.value.source === 'string' ? params.value.source : '')
const sceneSource = ref('')
const title = ref('')
const gameName = ref('')
const message = ref('')
const broadcastId = ref(typeof params.value.broadcastId === 'string' ? params.value.broadcastId : '')

function unwrap(raw: any): any {
  if (raw?.success === false) throw new Error(raw.error || tr('No se pudo completar la acción.', 'Could not complete the action.'))
  return raw?.result ?? raw
}

async function run(actionId: string, overrides: Record<string, unknown> = {}): Promise<any> {
  const canReadInReadonly = actionId === 'status' || actionId === 'viewer-count' || actionId === 'check-status'
  if (busy.value || (props.readonly && !canReadInReadonly)) return null
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

async function refresh() {
  if (busy.value) return
  if (platform.value === 'obs') {
    const status = await run('status')
    if (status) {
      statusLoaded.value = true
      streamState.value = status.streaming === true
      recording.value = status.recording === true
      scenes.value = Array.isArray(status.options) ? status.options.filter((x: any) => x && typeof x.value === 'string') : []
      if (!scene.value && typeof status.currentScene === 'string') scene.value = status.currentScene
      const sceneList = await run('scene-list')
      if (sceneList) {
        scenes.value = Array.isArray(sceneList.options) ? sceneList.options.filter((x: any) => x && typeof x.value === 'string') : scenes.value
        if (!scene.value && typeof sceneList.currentProgramSceneName === 'string') scene.value = sceneList.currentProgramSceneName
      }
    }
  } else if (platform.value === 'twitch' || platform.value === 'youtube') {
    const status = await run('viewer-count')
    if (status) {
      statusLoaded.value = true
      viewerCount.value = Number.isFinite(Number(status.viewerCount)) ? Number(status.viewerCount) : 0
    }
  } else {
    const status = await run('check-status')
    if (status) {
      statusLoaded.value = true
      shadowplayRunning.value = status.running === true
    }
  }
}

async function sendChat() {
  if (!message.value.trim()) return
  const text = message.value.trim()
  const result = await run(platform.value === 'twitch' ? 'chat-message' : 'post-chat', { message: text })
  if (result) message.value = ''
}

function askConfirmation(title: string, actionId: string, parameters: Record<string, unknown> = {}) {
  if (!props.readonly && !busy.value) confirmation.value = { title, actionId, parameters }
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

</script>

<style scoped>
.stream-control {
  --stream-accent: var(--bd-ac, #e0a84a);
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  container-type: size;
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
.stream-head, .stream-brand, .stream-actions, .stream-status-row, .stream-form-row, .viewer-readout {
  display: flex;
  align-items: center;
}
.stream-head { justify-content: space-between; gap: 8px; flex: none; }
.stream-brand { gap: 9px; min-width: 0; }
.stream-mark { display: grid; place-items: center; width: 30px; height: 30px; flex: none; color: var(--stream-accent); background: color-mix(in srgb, var(--stream-accent) 12%, transparent); border-radius: 9px; }
.stream-heading { display: grid; gap: 2px; min-width: 0; }
.stream-heading strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1.08em; }
.stream-caption, .stream-note { color: var(--bd-mu, #a3a5a8); font-size: .88em; }
.stream-icon-btn, .stream-btn {
  border: 1px solid var(--bd-ln, #3b3d40);
  color: var(--bd-ink, #ece9e2);
  background: var(--bd-bg, #242629);
  font: inherit;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
}
.stream-icon-btn { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; flex: none; }
.stream-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 6px 10px; border-radius: 9px; white-space: nowrap; }
.stream-btn:hover:not(:disabled), .stream-icon-btn:hover:not(:disabled) { border-color: var(--stream-accent); }
.stream-btn:active:not(:disabled) { transform: translateY(1px); }
.stream-btn:focus-visible, .stream-icon-btn:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--stream-accent); outline-offset: 2px; }
.stream-btn:disabled, .stream-icon-btn:disabled { opacity: .48; cursor: not-allowed; }
.live-btn, .primary-btn { background: color-mix(in srgb, var(--stream-accent) 17%, var(--bd-bg, #242629)); border-color: color-mix(in srgb, var(--stream-accent) 60%, var(--bd-ln, #3b3d40)); }
.danger-btn { color: var(--bd-danger, #ff8b84); }
.stream-actions { flex-wrap: wrap; gap: 6px; }
.stream-status-row { flex-wrap: wrap; gap: 6px; }
.status-pill { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; border-radius: 999px; color: var(--bd-mu, #a3a5a8); background: var(--bd-bg, #242629); font-size: .78em; letter-spacing: .02em; }
.status-pill.active { color: var(--bd-ok, #80d49b); }
.stream-form-row { gap: 6px; min-width: 0; }
.stream-field { display: grid; gap: 4px; min-width: 0; flex: 1; color: var(--bd-mu, #a3a5a8); font-size: .82em; }
.stream-field input, .stream-field select { box-sizing: border-box; width: 100%; min-width: 0; height: 32px; padding: 0 8px; border: 1px solid var(--bd-ln, #3b3d40); border-radius: 7px; color: var(--bd-ink, #ece9e2); background: var(--bd-bg, #242629); font: inherit; }
.stream-field input::placeholder { color: var(--bd-mu, #a3a5a8); opacity: .72; }
.stream-field select:disabled, .stream-field input:disabled { opacity: .6; }
.compact { min-height: 32px; align-self: end; padding-inline: 9px; }
.full-field { flex: none; }
.viewer-readout { gap: 8px; min-height: 36px; color: var(--bd-mu, #a3a5a8); }
.viewer-readout strong { color: var(--bd-ink, #ece9e2); font: 600 clamp(20px, 6cqi, 32px)/1 var(--bd-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
.viewer-readout span { font-size: .85em; }
.stream-error { margin: 0; padding: 7px 9px; border-left: 2px solid var(--bd-danger, #e5484d); color: var(--bd-danger, #ff8b84); background: color-mix(in srgb, var(--bd-danger, #e5484d) 9%, transparent); overflow-wrap: anywhere; }
.stream-note { margin: 0; line-height: 1.45; }
.stream-confirm { display: grid; gap: 5px; padding: 9px; border: 1px solid color-mix(in srgb, var(--bd-danger, #e5484d) 55%, var(--bd-ln, #3b3d40)); border-radius: 9px; background: color-mix(in srgb, var(--bd-danger, #e5484d) 8%, var(--bd-bg, #242629)); }
.stream-confirm > span { color: var(--bd-mu, #a3a5a8); font-size: .86em; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 6px; }
.sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@container (max-width: 230px) {
  .stream-control { gap: 5px; padding: 7px; }
  .stream-mark { width: 25px; height: 25px; }
  .stream-btn { min-height: 30px; padding: 5px 7px; }
  .stream-form-row { align-items: end; }
  .stream-caption { display: none; }
}
@container (min-aspect-ratio: 1.35) {
  .stream-actions { flex-wrap: nowrap; }
  .stream-actions > .stream-btn { flex: 1; min-width: 0; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
</style>
