<template>
  <section class="media-transport" :aria-label="label || copy.rootLabel" data-cy="media-transport">
    <!-- Sin parámetros obligatorios (la acción se envía por botón);
         siempre configurado (NeedsConfig estructural). -->
    <NeedsConfig v-if="!isConfigured" :action-type="props.action.type" :position="position" />
    <div class="mt-main">
    <div class="transport-heading">
      <span class="icon-badge"><Music2 :size="19" aria-hidden="true" /></span>
      <div class="heading-text">
        <strong>{{ label || copy.media }}</strong>
        <small>{{ copy.playbackControls }}</small>
      </div>
    </div>
    <div class="transport-actions" role="group" :aria-label="copy.playbackControls">
      <button class="xs-hide" type="button" :aria-label="copy.previousTrack" :title="copy.previous" :disabled="readonly || busy" @click="send('previous')">
        <SkipBack :size="19" aria-hidden="true" />
      </button>
      <button class="primary" type="button" :aria-label="copy.playPause" :title="copy.playPause" :disabled="readonly || busy" @click="send('playpause')">
        <Play v-if="!busy" :size="21" aria-hidden="true" />
        <LoaderCircle v-else :size="20" class="spin" aria-hidden="true" />
      </button>
      <button type="button" :aria-label="copy.nextTrack" :title="copy.next" :disabled="readonly || busy" @click="send('next')">
        <SkipForward :size="19" aria-hidden="true" />
      </button>
      <button class="xs-hide" type="button" :aria-label="copy.toggleMute" :title="copy.toggleMute" :disabled="readonly || busy" @click="send('mute')">
        <VolumeX :size="18" aria-hidden="true" />
      </button>
    </div>
    <p v-if="busy" class="feedback" role="status" aria-live="polite">{{ copy.sending }}</p>
    <p v-else-if="message" class="feedback bd-data-swap" :key="message" role="status" aria-live="polite">{{ message }}</p>
    <p v-if="error" class="feedback error" role="alert" :title="error">
      <TriangleAlert :size="14" aria-hidden="true" /><span class="err-text">{{ error }}</span><span class="sr-only">{{ copy.failed }}</span>
    </p>
    <p v-if="readonly" class="readonly-note">{{ copy.readOnly }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { LoaderCircle, Music2, Play, SkipBack, SkipForward, TriangleAlert, VolumeX } from 'lucide-vue-next'
import { useI18nStore } from '../../../composables/useI18n'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import NeedsConfig from './shared/NeedsConfig.vue'

interface Props {
  action: { type: string; parameters: Record<string, any> }
  apiBase: string
  label?: string
  readonly?: boolean
  /** Posición de la tecla (la reenvía ControlSurface) para NeedsConfig. */
  position?: number | null
}

const props = withDefaults(defineProps<Props>(), { label: '', readonly: false, position: null })
const { currentLocale } = useI18nStore()
const copy = computed(() => currentLocale.value?.toLowerCase().startsWith('es') ? {
  rootLabel: 'Controles multimedia',
  media: 'Multimedia',
  playbackControls: 'Controles de reproducción',
  previousTrack: 'Pista anterior',
  previous: 'Anterior',
  playPause: 'Reproducir o pausar',
  nextTrack: 'Pista siguiente',
  next: 'Siguiente',
  toggleMute: 'Alternar silencio',
  sending: 'Enviando comando…',
  readOnly: 'Control de solo lectura',
  sent: 'Comando enviado.',
  failed: 'La acción multimedia falló.',
} : {
  rootLabel: 'Media transport',
  media: 'Media',
  playbackControls: 'Playback controls',
  previousTrack: 'Previous track',
  previous: 'Previous',
  playPause: 'Play or pause',
  nextTrack: 'Next track',
  next: 'Next',
  toggleMute: 'Toggle mute',
  sending: 'Sending command…',
  readOnly: 'Read-only control',
  sent: 'Command sent.',
  failed: 'Media command failed.',
})
/** Sin parámetros obligatorios: cada botón envía su propia acción. */
const isConfigured = computed(() => true)
const busy = ref(false)
const message = ref('')
const error = ref('')

async function send(action: 'previous' | 'playpause' | 'next' | 'mute') {
  if (props.readonly || busy.value) return
  busy.value = true
  message.value = ''
  error.value = ''
  try {
    await executeWidgetAction(props.apiBase, props.action.type, {
      ...(props.action.parameters ?? {}),
      action,
    })
    message.value = copy.value.sent
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : copy.value.failed
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.media-transport {
  container-type: size;
  container-name: media-transport;
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
  color: inherit;
}
/* El layout vive en el hijo: la raíz es el contenedor y no puede
   auto-aplicarse sus propias container queries. */
.mt-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
  padding: clamp(8px, 4cqi, 16px);
  overflow: hidden;
}
.transport-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
.heading-text { min-width: 0; flex: 1; }
.transport-heading strong, .transport-heading small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transport-heading strong { font-size: clamp(13px, 5cqi, 16px); }
.transport-heading small, .feedback, .readonly-note { color: var(--bd-mu, #9b9da1); font-size: 12px; }
.icon-badge {
  display: grid;
  width: 38px;
  height: 38px;
  flex: none;
  place-items: center;
  border: 1px solid var(--bd-ln, #303237);
  border-radius: 12px;
  color: var(--bd-ac, #e0a84a);
  background: var(--bd-sf, #1a1c1f);
}
.transport-actions { display: grid; grid-template-columns: repeat(4, minmax(38px, 1fr)); gap: 8px; }
.transport-actions button {
  display: grid;
  min-width: 38px;
  min-height: 42px;
  place-items: center;
  border: 1px solid var(--bd-ln, #303237);
  border-radius: 10px;
  color: inherit;
  background: var(--bd-sf, #1a1c1f);
  cursor: pointer;
  touch-action: manipulation;
}
.transport-actions button:hover:not(:disabled) { border-color: var(--bd-ac, #e0a84a); }
.transport-actions button.primary { color: var(--bd-ac, #e0a84a); }
.transport-actions button:focus-visible {
  outline: 2px solid var(--bd-ac, #e0a84a);
  outline-offset: 2px;
}
.transport-actions button:disabled { cursor: not-allowed; opacity: .55; }
.feedback, .readonly-note { margin: 0; }
.error { display: flex; align-items: center; gap: 6px; color: #ff8d86; }
.error .err-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.spin { animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2s; } }

/* XS (<200px): 1–2 botones esenciales (play/pausa + siguiente), sin textos. */
@container media-transport (max-width: 199px) {
  .mt-main { gap: 8px; align-items: center; }
  .transport-heading small { display: none; }
  .transport-heading strong { font-size: clamp(11px, 9cqi, 13px); }
  .icon-badge { width: 30px; height: 30px; }
  .transport-actions { grid-template-columns: repeat(2, minmax(44px, 1fr)); width: 100%; max-width: 220px; }
  .transport-actions .xs-hide { display: none; }
  .transport-actions button { min-height: 46px; }
  .feedback, .readonly-note {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  .error { position: static; width: auto; height: auto; clip: auto; }
  .error .err-text { display: none; }
}
/* Ancha: fila compacta cabecera + botones. */
@container media-transport (min-aspect-ratio: 13/10) {
  .mt-main { flex-direction: row; align-items: center; }
  .transport-heading { flex: 1; min-width: 0; }
  .transport-actions { flex: 2; }
}
/* Alta: botones más altos. */
@container media-transport (max-aspect-ratio: 77/100) {
  .transport-actions { grid-template-columns: repeat(2, minmax(40px, 1fr)); }
  .transport-actions button { min-height: 46px; }
}
/* Alta y ancha (≥200px): 4 botones en fila. */
@container media-transport (max-aspect-ratio: 77/100) and (min-width: 200px) {
  .transport-actions { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .transport-actions .xs-hide { display: grid; }
  .transport-actions button { min-height: 40px; }
}
</style>
