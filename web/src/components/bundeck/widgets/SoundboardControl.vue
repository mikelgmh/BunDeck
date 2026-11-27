<template>
  <section class="soundboard" :aria-label="label || copy.title" data-cy="soundboard">
    <!-- play exige `file`: sin él se pide configurar en vez de fallar. -->
    <NeedsConfig v-if="!isConfigured" :action-type="props.action.type" :position="position" />
    <div class="sb-main">
    <header class="sound-head">
      <div>
        <span class="eyebrow">{{ copy.kicker }}</span>
        <strong>{{ label || copy.title }}</strong>
      </div>
      <button class="icon-button m-refresh" type="button" :disabled="readonly || listing" :aria-label="copy.refresh" :title="copy.refresh" @click="loadSounds">
        <RefreshCw :size="15" :class="{ spin: listing }" aria-hidden="true" />
      </button>
    </header>

    <!-- XS: sonido actual rotando + reproducir/detener (2 botones). -->
    <div v-if="sounds.length" class="xs-hero" data-cy="soundboard-xs-hero" aria-live="polite">
      <Marquee :text="currentSoundName" />
      <div class="sound-actions xs-actions">
        <button class="play-button" type="button" :disabled="readonly || busyPlay" :aria-label="copy.playSelected" :title="playTitle" @click="play">
          <LoaderCircle v-if="busyPlay" class="spin" :size="18" aria-hidden="true" />
          <Play v-else :size="18" fill="currentColor" aria-hidden="true" />
        </button>
        <button class="stop-button" type="button" :disabled="readonly || busyStop" :aria-label="copy.stop" :title="copy.stop" @click="stop">
          <Square :size="16" fill="currentColor" aria-hidden="true" />
        </button>
      </div>
    </div>

    <label class="sound-select-label m-select" for="soundboard-file">{{ copy.sound }}</label>
    <select id="soundboard-file" v-model="selectedFile" class="m-select" :disabled="readonly || sounds.length === 0" :aria-label="copy.chooseSound" data-cy="soundboard-select" @change="syncCarouselToSelection">
      <option v-if="sounds.length === 0" value="">{{ listing ? copy.loading : copy.noSounds }}</option>
      <option v-for="sound in sounds" :key="sound.name" :value="sound.name">{{ sound.name }}</option>
    </select>

    <div class="sound-actions m-actions">
      <button class="play-button" type="button" :disabled="readonly || busyPlay || !selectedFile" :aria-label="copy.playSelected" @click="play">
        <LoaderCircle v-if="busyPlay" class="spin" :size="18" aria-hidden="true" />
        <Play v-else :size="18" fill="currentColor" aria-hidden="true" />
        <span>{{ busyPlay ? copy.playing : copy.playSound }}</span>
      </button>
      <button class="stop-button" type="button" :disabled="readonly || busyStop" :aria-label="copy.stop" :title="copy.stop" @click="stop">
        <Square :size="16" fill="currentColor" aria-hidden="true" />
      </button>
    </div>

    <label class="volume-line m-volume">
      <Volume2 :size="15" aria-hidden="true" />
      <span>{{ copy.volume }}</span>
      <input v-model.number="volume" type="range" min="0" max="100" step="1" :disabled="readonly" :aria-label="copy.soundVolume" />
      <output class="bd-data-swap" :key="volume">{{ volume }}%</output>
    </label>

    <p v-if="error" class="widget-error" role="alert" :title="error">
      <TriangleAlert :size="13" aria-hidden="true" /><span class="err-text">{{ error }}</span><span class="sr-only">{{ copy.loadFailed }}</span>
    </p>
    <p v-else-if="!listing && sounds.length === 0" class="empty-note"><span class="empty-icon" aria-hidden="true">♪</span><span class="empty-full">{{ copy.emptyHelp }}</span><span class="empty-short">{{ copy.noSounds }}</span></p>
    <p v-else class="sound-count">{{ sounds.length }} {{ sounds.length === 1 ? copy.soundSingular : copy.soundPlural }} {{ copy.available }}</p>
    <span v-if="busyPlay || busyStop" class="sr-status" role="status">{{ busyPlay ? copy.playingSelected : copy.stopping }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { LoaderCircle, Play, RefreshCw, Square, TriangleAlert, Volume2 } from 'lucide-vue-next'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import { useI18nStore } from '../../../composables/useI18n'
import { resolveCarouselMs, useAutoCarousel } from '../../../composables/useAutoCarousel'
import Marquee from './shared/Marquee.vue'
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
const copy = computed(() => currentLocale.value.toLowerCase().startsWith('es') ? {
  title: 'Mesa de sonidos',
  kicker: 'AUDIO LOCAL',
  refresh: 'Actualizar lista de sonidos',
  sound: 'Sonido',
  chooseSound: 'Elegir un sonido',
  loading: 'Cargando sonidos…',
  noSounds: 'No hay sonidos',
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
  loadFailed: 'No se pudo cargar la mesa de sonidos.',
} : {
  title: 'Soundboard',
  kicker: 'LOCAL AUDIO',
  refresh: 'Refresh sound list',
  sound: 'Sound',
  chooseSound: 'Choose a sound',
  loading: 'Loading sounds…',
  noSounds: 'No sounds',
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
  loadFailed: 'Soundboard could not be loaded.',
})
const params = computed(() => props.action.parameters ?? {})
/** `play` exige `file`: sin él la tecla pide configuración. */
const isConfigured = computed(() => typeof params.value.file === 'string' && params.value.file.trim().length > 0)
const carouselMs = computed(() => resolveCarouselMs(params.value))
const sounds = ref<Array<{ name: string; size?: number }>>([])
const selectedFile = ref(typeof params.value.file === 'string' ? params.value.file : '')
const volume = ref(typeof params.value.volume === 'number' ? Math.max(0, Math.min(100, params.value.volume)) : 100)
const busyPlay = ref(false)
const busyStop = ref(false)
const listing = ref(false)
const error = ref('')

/** Carrusel XS: rota el sonido actual cuando hay varios. */
const { index: carouselIndex, goTo } = useAutoCarousel(
  computed(() => sounds.value.length),
  { intervalMs: carouselMs },
)
const currentSoundName = computed(() => sounds.value[carouselIndex.value]?.name ?? selectedFile.value)
function syncCarouselToSelection() {
  const i = sounds.value.findIndex((s) => s.name === selectedFile.value)
  if (i >= 0) goTo(i)
}
watch(carouselIndex, (i) => {
  const name = sounds.value[i]?.name
  if (name && name !== selectedFile.value) selectedFile.value = name
})
const playTitle = computed(() => `${copy.value.playSelected}: ${currentSoundName.value}`)

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
      selectedFile.value = sounds.value[carouselIndex.value]?.name ?? sounds.value[0]?.name ?? ''
    }
    syncCarouselToSelection()
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
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
  color: inherit;
  border: 1px solid color-mix(in srgb, currentColor 13%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, #111 76%, transparent);
}
/* El layout vive en el hijo: la raíz es el contenedor y no puede
   auto-aplicarse sus propias container queries. */
.sb-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  padding: clamp(8px, 4cqi, 14px);
  overflow: hidden;
}
.sound-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sound-head > div { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.sound-head strong { font-size: clamp(12px, 5cqi, 15px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
/* Héroe XS: oculto fuera de XS. */
.xs-hero { display: none; min-width: 0; flex-direction: column; gap: 6px; font-size: clamp(12px, 9cqi, 15px); font-weight: 600; text-align: center; }
.xs-actions { display: flex; gap: 6px; }
.xs-actions .play-button { flex: 1; min-height: 44px; color: #17140f; border-color: #dda95c; background: #dda95c; }
.xs-actions .stop-button { min-height: 44px; }
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
  overflow: hidden;
  text-overflow: ellipsis;
}
.sound-actions { display: flex; gap: 6px; }
.play-button { flex: 1; min-width: 0; color: #17140f; border-color: #dda95c; background: #dda95c; font-size: 11px; font-weight: 700; }
.play-button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stop-button:hover:not(:disabled), .icon-button:hover:not(:disabled) { border-color: color-mix(in srgb, #dda95c 58%, transparent); }
.volume-line { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 10px; color: color-mix(in srgb, currentColor 76%, transparent); }
.volume-line input { flex: 1; min-width: 0; accent-color: #dda95c; }
.volume-line output { min-width: 34px; text-align: right; font: 10px var(--bd-mono, ui-monospace, monospace); }
button:disabled, select:disabled, input:disabled { opacity: .45; cursor: not-allowed; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #dda95c; outline-offset: 2px; }
.empty-note, .sound-count, .widget-error { margin: auto 0 0; font-size: 9px; line-height: 1.3; }
.empty-icon { display: none; }
.empty-short { display: none; }
.empty-note, .sound-count { color: color-mix(in srgb, currentColor 58%, transparent); }
.widget-error {
  display: flex; align-items: center; gap: 5px;
  color: #e89589; overflow-wrap: anywhere;
}
.widget-error .err-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-only, .sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
/* XS (<200px): héroe + 2 iconos; sin select, volumen, refresh ni textos. */
@container soundboard (max-width: 199px) {
  .sb-main { gap: 6px; justify-content: center; }
  .sound-head strong { font-size: clamp(11px, 9cqi, 13px); }
  .m-refresh, .m-select, .m-actions, .m-volume, .sound-count { display: none; }
  .xs-hero { display: flex; }
  .widget-error { justify-content: center; margin: 0; }
  .widget-error .err-text, .empty-full { display: none; }
  .empty-icon { display: inline; font-size: 16px; }
  .empty-short { display: inline; font-size: 10px; }
}
/* XS y baja (≤150px): cabe en 1×1 recortando cromo. */
@container soundboard (max-width: 199px) and (max-height: 150px) {
  .sound-head .eyebrow { display: none; }
  .sb-main { gap: 4px; }
}
/* M (200–339px): select + acciones; refresh solo con holgura. */
@container soundboard (min-width: 200px) {
  .xs-hero, .empty-icon, .empty-short { display: none; }
  .m-refresh { display: none; }
}
@container soundboard (min-width: 260px) {
  .m-refresh { display: inline-flex; }
}
/* Ancha: cabecera + select + acciones en fila. */
@container soundboard (min-aspect-ratio: 13/10) {
  .sb-main { display: grid; grid-template-columns: minmax(130px, 1fr) minmax(0, 1.5fr) auto; grid-template-rows: auto auto 1fr auto; align-items: center; gap: 7px 12px; }
  .sound-head { grid-column: 1; grid-row: 1 / span 2; align-self: start; }
  .sound-select-label { grid-column: 2; grid-row: 1; }
  select { grid-column: 2; grid-row: 2; }
  .sound-actions { grid-column: 3; grid-row: 1 / span 2; }
  .volume-line { grid-column: 1 / -1; grid-row: 3; }
  .empty-note, .sound-count, .widget-error { grid-column: 1 / -1; grid-row: 4; }
}
/* Alta: columna compacta. */
@container soundboard (max-aspect-ratio: 77/100) {
  .sb-main { gap: 6px; }
  .sound-actions button { min-height: 32px; }
}
</style>
