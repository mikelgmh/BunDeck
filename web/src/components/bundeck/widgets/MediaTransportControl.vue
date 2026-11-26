<template>
  <section class="media-transport" :aria-label="label || copy.rootLabel" data-cy="media-transport">
    <div class="transport-heading">
      <span class="icon-badge"><Music2 :size="19" aria-hidden="true" /></span>
      <div>
          <strong>{{ label || copy.media }}</strong>
          <small>{{ copy.playbackControls }}</small>
        </div>
      </div>
    <div class="transport-actions" role="group" :aria-label="copy.playbackControls">
      <button type="button" :aria-label="copy.previousTrack" :title="copy.previous" :disabled="readonly || busy" @click="send('previous')">
        <SkipBack :size="19" aria-hidden="true" />
      </button>
      <button class="primary" type="button" :aria-label="copy.playPause" :title="copy.playPause" :disabled="readonly || busy" @click="send('playpause')">
        <Play v-if="!busy" :size="21" aria-hidden="true" />
        <LoaderCircle v-else :size="20" class="spin" aria-hidden="true" />
      </button>
      <button type="button" :aria-label="copy.nextTrack" :title="copy.next" :disabled="readonly || busy" @click="send('next')">
        <SkipForward :size="19" aria-hidden="true" />
      </button>
      <button type="button" :aria-label="copy.toggleMute" :title="copy.toggleMute" :disabled="readonly || busy" @click="send('mute')">
        <VolumeX :size="18" aria-hidden="true" />
      </button>
    </div>
    <p v-if="busy" class="feedback" role="status" aria-live="polite">{{ copy.sending }}</p>
    <p v-else-if="message" class="feedback" role="status" aria-live="polite">{{ message }}</p>
    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <p v-if="readonly" class="readonly-note">{{ copy.readOnly }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { LoaderCircle, Music2, Play, SkipBack, SkipForward, VolumeX } from 'lucide-vue-next'
import { useI18nStore } from '../../../composables/useI18n'
import { executeWidgetAction } from '../../../composables/useWidgetAction'

interface Props {
  action: { type: string; parameters: Record<string, any> }
  apiBase: string
  label?: string
  readonly?: boolean
}

const props = withDefaults(defineProps<Props>(), { label: '', readonly: false })
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
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 14px;
  padding: clamp(10px, 3.5%, 18px);
  color: inherit;
}
.transport-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
.transport-heading > div { min-width: 0; }
.transport-heading strong, .transport-heading small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transport-heading strong { font-size: clamp(13px, 3cqi, 16px); }
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
.error { color: #ff8d86; }
.spin { animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2s; } }
</style>
