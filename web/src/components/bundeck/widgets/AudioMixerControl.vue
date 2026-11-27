<template>
  <section class="audio-mixer" :aria-label="label || copy.rootLabel" data-cy="audio-control">
    <!-- Ambas acciones funcionan sin parámetros (mute alterna; output lista),
         así que isConfigured es siempre true; se documenta el contrato. -->
    <NeedsConfig v-if="!isConfigured" :action-type="props.action.type" :position="position" />
    <div class="am-main">
    <template v-if="actionId === 'mic-mute'">
      <div class="control-heading">
        <span class="icon-badge"><Mic :size="19" aria-hidden="true" /></span>
        <div class="heading-text">
          <strong>{{ label || copy.microphone }}</strong>
          <small>{{ copy.microphoneControls }}</small>
        </div>
      </div>
      <div class="mic-actions" role="group" :aria-label="copy.microphoneMuteControls">
        <button type="button" :disabled="readonly || busy" :aria-label="copy.mute" :title="copy.mute" @click="setMicMuted(true)">
          <MicOff :size="17" aria-hidden="true" /><span class="btn-label">{{ copy.mute }}</span>
        </button>
        <button type="button" :disabled="readonly || busy" :aria-label="copy.unmute" :title="copy.unmute" @click="setMicMuted(false)">
          <Mic :size="17" aria-hidden="true" /><span class="btn-label">{{ copy.unmute }}</span>
        </button>
      </div>
    </template>

    <template v-else-if="actionId === 'output-switch'">
      <div class="control-heading">
        <span class="icon-badge"><Headphones :size="19" aria-hidden="true" /></span>
        <div class="heading-text">
          <strong>{{ label || copy.audioOutput }}</strong>
          <small>{{ copy.chooseOutput }}</small>
        </div>
        <button class="refresh" type="button" :aria-label="copy.refreshOutputs" :title="copy.refreshOutputs" :disabled="busy" @click="loadOutputs">
          <RefreshCw :size="16" aria-hidden="true" />
        </button>
      </div>
      <!-- XS: dispositivo actual rotando (Marquee) + aplicar con 1 toque -->
      <div v-if="devices.length" class="xs-hero" data-cy="audio-xs-hero">
        <div class="xs-device" aria-live="polite">
          <Marquee :text="devices[carouselIndex]?.label ?? devices[0]?.label ?? ''" />
        </div>
        <button class="apply xs-apply" type="button" :disabled="readonly || busy" @click="applyCarouselDevice">
          <Check :size="16" aria-hidden="true" /><span class="btn-label">{{ copy.useOutput }}</span>
        </button>
      </div>
      <label class="output-picker">
        <span>{{ copy.availableOutputs }}</span>
        <select v-model="selectedDevice" :disabled="readonly || busy || !devices.length" :aria-label="copy.availableOutputs">
          <option value="" disabled>{{ devices.length ? copy.selectDevice : copy.noOutputDevices }}</option>
          <option v-for="device in devices" :key="device.value" :value="device.value">{{ device.label }}</option>
        </select>
      </label>
      <button class="apply m-apply" type="button" :disabled="readonly || busy || !selectedDevice" @click="applyOutput">
        <Check :size="16" aria-hidden="true" /> {{ copy.useOutput }}
      </button>
    </template>

    <p v-if="busy" class="feedback" role="status" aria-live="polite">{{ copy.working }}</p>
    <p v-else-if="message" class="feedback bd-data-swap" :key="message" role="status" aria-live="polite">{{ message }}</p>
    <p v-if="error" class="feedback error" role="alert" :title="error">
      <TriangleAlert :size="14" aria-hidden="true" /><span class="err-text">{{ error }}</span><span class="sr-only">{{ copy.actionError }}</span>
    </p>
    <p v-if="readonly" class="readonly-note">{{ copy.readOnly }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Check, Headphones, Mic, MicOff, RefreshCw, TriangleAlert } from 'lucide-vue-next'
import { useI18nStore } from '../../../composables/useI18n'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
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
const copy = computed(() => currentLocale.value?.toLowerCase().startsWith('es') ? {
  rootLabel: 'Controles de audio',
  microphone: 'Micrófono',
  microphoneControls: 'Controles del micrófono',
  microphoneMuteControls: 'Controles de silencio del micrófono',
  mute: 'Silenciar',
  unmute: 'Activar',
  audioOutput: 'Salida de audio',
  chooseOutput: 'Elige un dispositivo de salida',
  refreshOutputs: 'Actualizar dispositivos de salida',
  availableOutputs: 'Salidas disponibles',
  selectDevice: 'Selecciona un dispositivo',
  noOutputDevices: 'No se encontraron salidas de audio',
  useOutput: 'Usar esta salida',
  working: 'Procesando…',
  readOnly: 'Control de solo lectura',
  noSelectableOutputs: 'No hay dispositivos de salida disponibles para elegir.',
  loadError: 'No se pudieron cargar las salidas de audio.',
  actionError: 'La acción de audio falló.',
  muteSent: 'Solicitud de silencio enviada.',
  unmuteSent: 'Solicitud para activar el micrófono enviada.',
  outputRequested: 'Se solicitó cambiar la salida.',
} : {
  rootLabel: 'Audio controls',
  microphone: 'Microphone',
  microphoneControls: 'Microphone controls',
  microphoneMuteControls: 'Microphone mute controls',
  mute: 'Mute',
  unmute: 'Unmute',
  audioOutput: 'Audio output',
  chooseOutput: 'Choose an output device',
  refreshOutputs: 'Refresh output devices',
  availableOutputs: 'Available outputs',
  selectDevice: 'Select a device',
  noOutputDevices: 'No output devices found',
  useOutput: 'Use this output',
  working: 'Working…',
  readOnly: 'Read-only control',
  noSelectableOutputs: 'No selectable output devices were returned.',
  loadError: 'Could not load audio outputs.',
  actionError: 'Audio action failed.',
  muteSent: 'Mute command sent.',
  unmuteSent: 'Unmute command sent.',
  outputRequested: 'Output change requested.',
})
const actionId = computed(() => props.action.type.split('.').at(-1) ?? '')
/** Sin parámetros obligatorios: `muted` alterna si se omite y `device`
 *  vacío solo lista. Siempre configurado (NeedsConfig estructural). */
const isConfigured = computed(() => true)
const params = computed(() => props.action.parameters ?? {})
const carouselMs = computed(() => resolveCarouselMs(params.value))
const busy = ref(false)
const error = ref('')
const message = ref('')
const devices = ref<Array<{ value: string; label: string }>>([])
const selectedDevice = ref(String(props.action.parameters?.device ?? ''))

/** Índice del carrusel XS (sigue a la selección manual y viceversa). */
const { index: carouselIndex, goTo } = useAutoCarousel(
  computed(() => devices.value.length),
  { intervalMs: carouselMs },
)
watch(carouselIndex, (i) => {
  const current = devices.value[i]?.value
  if (current && current !== selectedDevice.value) selectedDevice.value = current
})
watch(selectedDevice, (v) => {
  const i = devices.value.findIndex((d) => d.value === v)
  if (i >= 0 && i !== carouselIndex.value) goTo(i)
})

const payload = () => ({ ...(props.action.parameters ?? {}) })
const unwrap = (response: any) => response?.result ?? response

function parseWindowsDevices(raw: string): Array<{ value: string; label: string }> {
  const blocks = raw.split(/(?=^\s*ID\s*:)/im)
  return blocks.flatMap((block) => {
    const id = block.match(/^\s*ID\s*:\s*(.+)\s*$/im)?.[1]?.trim()
    const name = block.match(/^\s*Name\s*:\s*(.+)\s*$/im)?.[1]?.trim()
    const type = block.match(/^\s*Type\s*:\s*(.+)\s*$/im)?.[1]?.trim() ?? ''
    if (!id || !name || /record|capture|input/i.test(type)) return []
    return [{ value: id, label: name }]
  })
}

async function loadOutputs() {
  if (actionId.value !== 'output-switch') return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const p = payload()
    delete p.device
    const result = unwrap(await executeWidgetAction(props.apiBase, props.action.type, p))
    const listed = Array.isArray(result?.devices)
      ? result.devices.map((device: any) => ({
          value: String(device.id ?? device.name ?? ''),
          label: String(device.name ?? device.id ?? 'Audio output'),
        })).filter((device: { value: string }) => device.value)
      : parseWindowsDevices(String(result?.devicesRaw ?? ''))
    devices.value = listed
    if (!selectedDevice.value || !listed.some((device: { value: string }) => device.value === selectedDevice.value)) {
      selectedDevice.value = listed[carouselIndex.value]?.value ?? ''
    }
    if (!listed.length) message.value = copy.value.noSelectableOutputs
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : copy.value.loadError
  } finally {
    busy.value = false
  }
}

async function run(parameters: Record<string, any>, successMessage: string) {
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await executeWidgetAction(props.apiBase, props.action.type, parameters)
    message.value = successMessage
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : copy.value.actionError
  } finally {
    busy.value = false
  }
}

function setMicMuted(muted: boolean) {
  return run({ ...payload(), muted }, muted ? copy.value.muteSent : copy.value.unmuteSent)
}

function applyOutput() {
  if (!selectedDevice.value) return
  return run({ ...payload(), device: selectedDevice.value }, copy.value.outputRequested)
}

function applyCarouselDevice() {
  const current = devices.value[carouselIndex.value]?.value ?? selectedDevice.value
  if (!current) return
  selectedDevice.value = current
  return run({ ...payload(), device: current }, copy.value.outputRequested)
}

onMounted(() => {
  if (actionId.value === 'output-switch') void loadOutputs()
})
</script>

<style scoped>
.audio-mixer {
  container-type: size;
  container-name: audio-mixer;
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
.am-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
  padding: clamp(8px, 4cqi, 16px);
  overflow: hidden;
}
.control-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.heading-text { min-width: 0; flex: 1; }
.control-heading strong, .control-heading small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.control-heading strong { font-size: clamp(13px, 5cqi, 16px); }
.control-heading small, .output-picker > span, .feedback, .readonly-note { color: var(--bd-mu, #9b9da1); font-size: 12px; }
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
.mic-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
/* Héroe XS: carrusel del dispositivo + aplicar (el select vive en M+). */
.xs-hero { display: none; min-width: 0; flex-direction: column; gap: 6px; }
.xs-device { min-width: 0; font-size: clamp(12px, 9cqi, 15px); font-weight: 600; text-align: center; }
.xs-apply { width: 100%; }
.m-apply { width: 100%; }
.audio-mixer button, .audio-mixer select {
  min-height: 42px;
  border: 1px solid var(--bd-ln, #303237);
  border-radius: 10px;
  color: inherit;
  background: var(--bd-sf, #1a1c1f);
  font: inherit;
}
.audio-mixer button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px 12px;
  cursor: pointer;
  touch-action: manipulation;
}
.audio-mixer button:hover:not(:disabled) { border-color: var(--bd-ac, #e0a84a); }
.audio-mixer button:focus-visible, .audio-mixer select:focus-visible {
  outline: 2px solid var(--bd-ac, #e0a84a);
  outline-offset: 2px;
}
.audio-mixer button:disabled, .audio-mixer select:disabled { cursor: not-allowed; opacity: .55; }
.audio-mixer .apply { border-color: color-mix(in srgb, var(--bd-ac, #e0a84a) 55%, var(--bd-ln, #303237)); }
.refresh { width: 38px; flex: none; padding: 0 !important; }
.output-picker { display: grid; gap: 6px; min-width: 0; }
.output-picker select { width: 100%; min-width: 0; padding: 0 10px; overflow: hidden; text-overflow: ellipsis; }
.feedback, .readonly-note { margin: 0; }
.error { display: flex; align-items: center; gap: 6px; color: #ff8d86; }
.error .err-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

/* XS (<200px): solo lo esencial, sin refresh ni textos largos. */
@container audio-mixer (max-width: 199px) {
  .am-main { gap: 6px; justify-content: center; }
  .control-heading small, .output-picker { display: none; }
  .audio-mixer .m-apply { display: none; }
  .xs-hero { display: flex; }
  .btn-label { display: none; }
  .mic-actions button, .xs-apply { min-height: 40px; }
  .audio-mixer .refresh { display: none; }
  .icon-badge { width: 30px; height: 30px; }
  .feedback, .readonly-note {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  .error { position: static; width: auto; height: auto; clip: auto; justify-content: center; }
  .error .err-text { display: none; }
}
/* M (200–339px): dato + acción principal; refresh solo con holgura. */
@container audio-mixer (min-width: 200px) {
  .xs-hero { display: none; }
  .audio-mixer .refresh { display: none; }
}
@container audio-mixer (min-width: 260px) {
  .audio-mixer .refresh { display: inline-flex; }
}
/* Ancha: micrófono en fila con cabecera compacta; salida en fila. */
@container audio-mixer (min-aspect-ratio: 13/10) {
  .am-main { flex-direction: row; align-items: center; }
  .control-heading { flex: 1; min-width: 0; }
  .mic-actions { flex: 1; }
  .output-picker { flex: 1.4; min-width: 0; }
  .m-apply { flex: none; }
}
/* Filas bajas con anchura M+ (p. ej. 2×1/3×1): héroe compacto con carrusel
   (dispositivo actual + aplicar), sin parrilla recortada ni scroll. */
@container audio-mixer (min-width: 200px) and (max-height: 150px) {
  .am-main { flex-direction: column; justify-content: center; }
  .output-picker, .m-apply, .control-heading small, .audio-mixer .refresh,
  .feedback, .readonly-note { display: none; }
  .xs-hero { display: flex; }
}
/* Alta: columna compacta. */
@container audio-mixer (max-aspect-ratio: 77/100) {
  .mic-actions button { min-height: 36px; }
}
</style>
