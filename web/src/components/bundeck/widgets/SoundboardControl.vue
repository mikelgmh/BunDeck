<template>
  <section class="soundboard" :aria-label="label || copy.title" data-cy="soundboard">
    <header class="sound-head">
      <div>
        <span class="eyebrow">{{ copy.kicker }}</span>
        <strong>{{ copy.title }}</strong>
      </div>
      <button class="icon-button" type="button" :disabled="readonly || listing" :aria-label="copy.refresh" :title="copy.refresh" @click="loadSounds">
        <RefreshCw :size="15" :class="{ spin: listing }" aria-hidden="true" />
      </button>
    </header>

    <label class="sound-select-label" for="soundboard-file">{{ copy.sound }}</label>
    <select id="soundboard-file" v-model="selectedFile" :disabled="readonly || sounds.length === 0" :aria-label="copy.chooseSound" data-cy="soundboard-select">
      <option v-if="sounds.length === 0" value="">{{ listing ? copy.loading : copy.noSounds }}</option>
      <option v-for="sound in sounds" :key="sound.name" :value="sound.name">{{ sound.name }}</option>
    </select>

    <div class="sound-actions">
      <button class="play-button" type="button" :disabled="readonly || busyPlay || !selectedFile" :aria-label="copy.playSelected" @click="play">
        <LoaderCircle v-if="busyPlay" class="spin" :size="18" aria-hidden="true" />
        <Play v-else :size="18" fill="currentColor" aria-hidden="true" />
        <span>{{ busyPlay ? copy.playing : copy.playSound }}</span>
      </button>
      <button class="stop-button" type="button" :disabled="readonly || busyStop" :aria-label="copy.stop" :title="copy.stop" @click="stop">
        <Square :size="16" fill="currentColor" aria-hidden="true" />
      </button>
    </div>

    <label class="volume-line">
      <Volume2 :size="15" aria-hidden="true" />
      <span>{{ copy.volume }}</span>
      <input v-model.number="volume" type="range" min="0" max="100" step="1" :disabled="readonly" :aria-label="copy.soundVolume" />
      <output>{{ volume }}%</output>
    </label>

    <p v-if="error" class="widget-error" role="alert">{{ error }}</p>
    <p v-else-if="!listing && sounds.length === 0" class="empty-note">{{ copy.emptyHelp }}</p>
    <p v-else class="sound-count">{{ sounds.length }} {{ sounds.length === 1 ? copy.soundSingular : copy.soundPlural }} {{ copy.available }}</p>
    <span v-if="busyPlay || busyStop" class="sr-status" role="status">{{ busyPlay ? copy.playingSelected : copy.stopping }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { LoaderCircle, Play, RefreshCw, Square, Volume2 } from 'lucide-vue-next'
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
const copy = computed(() => currentLocale.value.toLowerCase().startsWith('es') ? {
  title: 'Mesa de sonidos',
  kicker: 'AUDIO LOCAL',
  refresh: 'Actualizar lista de sonidos',
  sound: 'Sonido',
  chooseSound: 'Elegir un sonido',
  loading: 'Cargando sonidos…',
  noSounds: 'No hay sonidos disponibles',
  playSelected: 'Reproducir sonido seleccionado',
  playing: 'Reproduciendo…',
  playSound: 'Reproducir sonido',
  stop: 'Detener sonido',
  volume: 'Volumen',
  soundVolume: 'Volumen del sonido',
  emptyHelp: 'Añade archivos WAV o MP3 a tu carpeta de sonidos.',
  soundSingular: 'sonido',
  soundPlural: 'sonidos',
  available: 'disponibles',
  playingSelected: 'Reproduciendo el sonido seleccionado',
  stopping: 'Deteniendo el sonido',
} : {
  title: 'Soundboard',
  kicker: 'LOCAL AUDIO',
  refresh: 'Refresh sound list',
  sound: 'Sound',
  chooseSound: 'Choose a sound',
  loading: 'Loading sounds…',
  noSounds: 'No sounds available',
  playSelected: 'Play selected sound',
  playing: 'Playing…',
  playSound: 'Play sound',
  stop: 'Stop sound',
  volume: 'Volume',
  soundVolume: 'Sound volume',
  emptyHelp: 'Add WAV or MP3 files to your sound folder.',
  soundSingular: 'sound',
  soundPlural: 'sounds',
  available: 'available',
  playingSelected: 'Playing selected sound',
  stopping: 'Stopping sound',
})
const params = computed(() => props.action.parameters ?? {})
const sounds = ref<Array<{ name: string; size?: number }>>([])
const selectedFile = ref(typeof params.value.file === 'string' ? params.value.file : '')
const volume = ref(typeof params.value.volume === 'number' ? Math.max(0, Math.min(100, params.value.volume)) : 100)
const busyPlay = ref(false)
const busyStop = ref(false)
const listing = ref(false)
const error = ref('')

function unwrap(value: any): any {
  return value?.result ?? value?.data ?? value
}
async function loadSounds() {
  listing.value = true
  error.value = ''
  try {
    const result = unwrap(await executeWidgetAction(props.apiBase, 'soundboard.list-sounds', {
      ...(params.value.soundsDir ? { soundsDir: params.value.soundsDir } : {}),
    }))
    sounds.value = Array.isArray(result?.sounds) ? result.sounds : []
    if (!selectedFile.value || !sounds.value.some((sound) => sound.name === selectedFile.value)) {
      selectedFile.value = sounds.value[0]?.name ?? ''
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    listing.value = false
  }
}
async function play() {
  if (props.readonly || busyPlay.value || !selectedFile.value) return
  busyPlay.value = true
  error.value = ''
  try {
    await executeWidgetAction(props.apiBase, 'soundboard.play', {
      ...params.value,
      file: selectedFile.value,
      volume: volume.value,
    })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busyPlay.value = false
  }
}
async function stop() {
  if (props.readonly || busyStop.value) return
  busyStop.value = true
  error.value = ''
  try {
    await executeWidgetAction(props.apiBase, 'soundboard.stop', {})
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busyStop.value = false
  }
}
onMounted(() => { void loadSounds() })
</script>

<style scoped>
.soundboard {
  container-type: size;
  container-name: soundboard;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: clamp(8px, 4cqi, 14px);
  overflow: auto;
  color: inherit;
  border: 1px solid color-mix(in srgb, currentColor 13%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, #111 76%, transparent);
}
.sound-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sound-head > div { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.sound-head strong { font-size: clamp(12px, 4cqi, 15px); }
.eyebrow { color: color-mix(in srgb, currentColor 58%, transparent); font: 700 9px/1 var(--bd-mono, ui-monospace, monospace); letter-spacing: .06em; }
.icon-button, .play-button, .stop-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 36px;
  padding: 6px 9px;
  color: inherit;
  border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, currentColor 6%, transparent);
  cursor: pointer;
  touch-action: manipulation;
}
.icon-button, .stop-button { width: 36px; min-width: 36px; padding: 0; }
.sound-select-label { margin-bottom: -5px; color: color-mix(in srgb, currentColor 62%, transparent); font-size: 10px; }
select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 5px 8px;
  color: inherit;
  border: 1px solid color-mix(in srgb, currentColor 17%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, #111 85%, transparent);
  font: inherit;
  font-size: 11px;
}
.sound-actions { display: flex; gap: 6px; }
.play-button { flex: 1; min-width: 0; color: #17140f; border-color: #dda95c; background: #dda95c; font-size: 11px; font-weight: 700; }
.stop-button:hover:not(:disabled), .icon-button:hover:not(:disabled) { border-color: color-mix(in srgb, #dda95c 58%, transparent); }
.volume-line { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 10px; color: color-mix(in srgb, currentColor 76%, transparent); }
.volume-line input { flex: 1; min-width: 0; accent-color: #dda95c; }
.volume-line output { min-width: 34px; text-align: right; font: 10px var(--bd-mono, ui-monospace, monospace); }
button:disabled, select:disabled, input:disabled { opacity: .45; cursor: not-allowed; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #dda95c; outline-offset: 2px; }
.empty-note, .sound-count, .widget-error { margin: auto 0 0; font-size: 9px; line-height: 1.3; }
.empty-note, .sound-count { color: color-mix(in srgb, currentColor 58%, transparent); }
.widget-error { color: #e89589; overflow-wrap: anywhere; }
.sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@container soundboard (min-aspect-ratio: 13/10) {
  .soundboard { display: grid; grid-template-columns: minmax(130px, 1fr) minmax(0, 1.5fr) auto; grid-template-rows: auto auto 1fr auto; align-items: center; gap: 7px 12px; }
  .sound-head { grid-column: 1; grid-row: 1 / span 2; align-self: start; }
  .sound-select-label { grid-column: 2; grid-row: 1; }
  select { grid-column: 2; grid-row: 2; }
  .sound-actions { grid-column: 3; grid-row: 1 / span 2; }
  .volume-line { grid-column: 1 / -1; grid-row: 3; }
  .empty-note, .sound-count, .widget-error { grid-column: 1 / -1; grid-row: 4; }
}
@container soundboard (max-aspect-ratio: 77/100) {
  .soundboard { gap: 6px; }
  .sound-actions button { min-height: 32px; }
}
</style>
