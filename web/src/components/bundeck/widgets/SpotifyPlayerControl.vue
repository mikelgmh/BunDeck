<template>
  <section class="media-card spotify-card" :aria-label="label || copy.playerLabel" data-cy="spotify-player">
    <div class="spotify-art" aria-hidden="true">
      <img v-if="track?.albumArtUrl" :src="track.albumArtUrl" alt="" />
      <Music2 v-else :size="28" :stroke-width="1.6" />
    </div>

    <div class="spotify-info">
      <div class="eyebrow">SPOTIFY <span :class="{ 'is-playing': isPlaying }">{{ isPlaying ? copy.playing : stateLabel }}</span></div>
      <strong class="track-title">{{ track?.name || copy.nothingPlaying }}</strong>
      <span class="track-artist">{{ track?.artists || (track ? copy.unknownArtist : copy.startTrack) }}</span>
      <small v-if="track && device" class="device-name">{{ device }}</small>
      <p v-if="error" class="widget-error" role="alert">{{ error }}</p>
      <p v-else-if="!track && !loading" class="widget-hint">{{ copy.noActiveTrack }}</p>
    </div>

    <div class="spotify-controls" :aria-label="copy.playbackControls">
      <button type="button" :disabled="disabled" :aria-label="copy.previousTrack" :title="copy.previous" @click="playback('previous')">
        <SkipBack :size="17" aria-hidden="true" />
      </button>
      <button class="primary-control" type="button" :disabled="disabled" :aria-label="isPlaying ? copy.pause : copy.play" :title="isPlaying ? copy.pause : copy.play" @click="playback(isPlaying ? 'pause' : 'play')">
        <LoaderCircle v-if="loading || busy" class="spin" :size="18" aria-hidden="true" />
        <Pause v-else-if="isPlaying" :size="19" fill="currentColor" aria-hidden="true" />
        <Play v-else :size="19" fill="currentColor" aria-hidden="true" />
      </button>
      <button type="button" :disabled="disabled" :aria-label="copy.nextTrack" :title="copy.next" @click="playback('next')">
        <SkipForward :size="17" aria-hidden="true" />
      </button>
      <button type="button" :disabled="disabled || !track" :aria-label="copy.likeTrack" :title="copy.likeTrack" @click="likeTrack">
        <Heart :size="16" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="shuffle-control"
        :class="{ 'is-active': shuffleTarget === true }"
        :disabled="disabled"
        :aria-label="shuffleTarget === true ? copy.shuffleOff : copy.shuffleOn"
        :aria-pressed="shuffleTarget === null ? undefined : shuffleTarget"
        :title="shuffleTarget === true ? copy.shuffleOnHint : copy.setShuffleOn"
        @click="setShuffle(shuffleTarget !== true)"
      >
        <Shuffle :size="16" aria-hidden="true" />
      </button>
    </div>
    <span v-if="busy" class="sr-status" role="status">{{ copy.updating }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  Heart, LoaderCircle, Music2, Pause, Play, Shuffle, SkipBack, SkipForward,
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
const spanish = computed(() => currentLocale.value.toLowerCase().startsWith('es'))
const copy = computed(() => spanish.value ? {
  playerLabel: 'Reproductor de Spotify',
  playing: 'REPRODUCIENDO',
  paused: 'EN PAUSA',
  stopped: 'DETENIDO',
  unknown: 'ESTADO DESCONOCIDO',
  nothingPlaying: 'Nada en reproducción',
  unknownArtist: 'Artista desconocido',
  startTrack: 'Inicia una pista en Spotify',
  noActiveTrack: 'No hay ninguna pista activa',
  playbackControls: 'Controles de reproducción',
  previousTrack: 'Pista anterior',
  previous: 'Anterior',
  nextTrack: 'Pista siguiente',
  next: 'Siguiente',
  play: 'Reproducir',
  pause: 'Pausar',
  likeTrack: 'Guardar en Tus me gusta',
  shuffleOn: 'Activar aleatorio',
  shuffleOff: 'Desactivar aleatorio',
  shuffleOnHint: 'Aleatorio activado (pulsa para desactivar)',
  setShuffleOn: 'Activar modo aleatorio',
  updating: 'Actualizando Spotify',
} : {
  playerLabel: 'Spotify player',
  playing: 'PLAYING',
  paused: 'PAUSED',
  stopped: 'STOPPED',
  unknown: 'STATUS UNKNOWN',
  nothingPlaying: 'Nothing playing',
  unknownArtist: 'Unknown artist',
  startTrack: 'Start a track in Spotify',
  noActiveTrack: 'No active track',
  playbackControls: 'Playback controls',
  previousTrack: 'Previous track',
  previous: 'Previous',
  nextTrack: 'Next track',
  next: 'Next',
  play: 'Play',
  pause: 'Pause',
  likeTrack: 'Save current track to liked songs',
  shuffleOn: 'Turn shuffle on',
  shuffleOff: 'Turn shuffle off',
  shuffleOnHint: 'Shuffle on (press to turn off)',
  setShuffleOn: 'Set shuffle on',
  updating: 'Updating Spotify',
})
const params = computed(() => props.action.parameters ?? {})
const track = ref<any>(null)
const device = ref('')
const isPlaying = ref(false)
const playerState = ref<'paused' | 'stopped' | 'unknown'>('unknown')
const stateLabel = computed(() => playerState.value === 'paused' ? copy.value.paused : playerState.value === 'stopped' ? copy.value.stopped : copy.value.unknown)
const shuffleTarget = ref<boolean | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const disabled = computed(() => props.readonly || busy.value)
let pollTimer: ReturnType<typeof setInterval> | undefined
let currentPoll = 0

function unwrap(value: any): any {
  return value?.result ?? value?.data ?? value
}

async function refresh() {
  const pollId = ++currentPoll
  loading.value = true
  try {
    const response = unwrap(await executeWidgetAction(props.apiBase, 'spotify.now-playing', params.value))
    if (pollId !== currentPoll) return
    track.value = response?.track ?? null
    isPlaying.value = response?.isPlaying === true
    device.value = typeof response?.device === 'string' ? response.device : ''
    playerState.value = response?.state === 'stopped' ? 'stopped' : response?.state === 'paused' ? 'paused' : 'unknown'
    error.value = ''
  } catch (err) {
    if (pollId === currentPoll) error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (pollId === currentPoll) loading.value = false
  }
}

async function run(type: string, parameters: Record<string, any>) {
  if (props.readonly || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await executeWidgetAction(props.apiBase, type, { ...params.value, ...parameters })
    return true
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    return false
  } finally {
    busy.value = false
    void refresh()
  }
}

const playback = (action: string) => run('spotify.playback', { action })
const likeTrack = () => run('spotify.like', track.value?.id ? { trackId: track.value.id } : {})
async function setShuffle(state: boolean) {
  if (await run('spotify.shuffle', { state })) shuffleTarget.value = state
}

onMounted(() => {
  void refresh()
  pollTimer = setInterval(() => void refresh(), 10_000)
})
onUnmounted(() => {
  currentPoll++
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<style scoped>
.media-card {
  container-type: size;
  container-name: spotify;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, .9fr) minmax(0, 1.25fr);
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 6px 9px;
  padding: clamp(8px, 4cqi, 14px);
  border: 1px solid color-mix(in srgb, currentColor 13%, transparent);
  border-radius: 12px;
  color: inherit;
  background: color-mix(in srgb, #111 76%, transparent);
  overflow: hidden;
}
.spotify-art {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: color-mix(in srgb, currentColor 60%, transparent);
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.spotify-art img { width: 100%; height: 100%; object-fit: cover; }
.spotify-info {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.eyebrow {
  display: flex;
  gap: 7px;
  align-items: center;
  color: color-mix(in srgb, currentColor 58%, transparent);
  font: 700 9px/1.2 var(--bd-mono, ui-monospace, monospace);
  letter-spacing: .04em;
}
.eyebrow span { font-weight: 500; }
.eyebrow .is-playing { color: #83c994; }
.track-title, .track-artist, .device-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.track-title { font-size: clamp(12px, 4.5cqi, 15px); line-height: 1.2; }
.track-artist, .device-name, .widget-hint { color: color-mix(in srgb, currentColor 66%, transparent); font-size: 11px; }
.device-name { font-size: 9px; }
.widget-hint, .widget-error { margin: 2px 0 0; font-size: 10px; line-height: 1.25; }
.widget-error { color: #e89589; overflow-wrap: anywhere; }
.spotify-controls {
  grid-column: 1 / span 2;
  grid-row: 2;
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  gap: 5px;
}
.spotify-controls button:nth-child(n + 4) { display: none; }
.spotify-controls button, .voice-control {
  display: inline-grid;
  place-items: center;
  min-width: 34px;
  min-height: 34px;
  padding: 0;
  color: inherit;
  border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, currentColor 6%, transparent);
  cursor: pointer;
  touch-action: manipulation;
}
.spotify-controls button:hover:not(:disabled), .spotify-controls button.is-active {
  border-color: color-mix(in srgb, #1ed760 60%, transparent);
  color: #b8f2c8;
  background: color-mix(in srgb, #1ed760 14%, transparent);
}
.spotify-controls .primary-control { color: #101510; background: #1ed760; border-color: #1ed760; }
button:disabled { opacity: .45; cursor: not-allowed; }
button:focus-visible { outline: 2px solid #1ed760; outline-offset: 2px; }
.sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@container spotify (min-aspect-ratio: 13/10) {
  .media-card { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-rows: 1fr; align-items: center; gap: 12px; }
  .spotify-art { grid-column: 1; grid-row: 1; aspect-ratio: 1; height: 100%; }
  .spotify-info { grid-column: 2; grid-row: 1; }
  .spotify-controls { grid-column: 3; grid-row: 1; flex-direction: row; gap: 4px; }
  .spotify-controls button:nth-child(n + 4) { display: inline-grid; }
  .spotify-controls button { min-width: 32px; min-height: 32px; }
}
@container spotify (max-aspect-ratio: 77/100) {
  .media-card { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) auto auto; gap: 6px; }
  .spotify-art { grid-column: 1; grid-row: 1; min-height: 0; }
  .spotify-info { grid-column: 1; grid-row: 2; }
  .spotify-controls { grid-column: 1; grid-row: 3; flex-direction: row; gap: 5px; }
  .spotify-controls button:nth-child(n + 4) { display: none; }
  .spotify-controls button { min-width: 31px; min-height: 31px; }
  .device-name { display: none; }
}
@container spotify (min-width: 165px) {
  .spotify-controls button:nth-child(n + 4) { display: inline-grid; }
}
</style>
