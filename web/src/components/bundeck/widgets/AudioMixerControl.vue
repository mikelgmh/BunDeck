<template>
  <section class="audio-control" :aria-label="label || copy.rootLabel" data-cy="audio-control">
    <template v-if="actionId === 'mic-mute'">
      <div class="control-heading">
        <span class="icon-badge"><Mic :size="19" aria-hidden="true" /></span>
        <div>
          <strong>{{ label || copy.microphone }}</strong>
          <small>{{ copy.microphoneControls }}</small>
        </div>
      </div>
      <div class="mic-actions" role="group" :aria-label="copy.microphoneMuteControls">
        <button type="button" :disabled="readonly || busy" @click="setMicMuted(true)">
          <MicOff :size="17" aria-hidden="true" /> {{ copy.mute }}
        </button>
        <button type="button" :disabled="readonly || busy" @click="setMicMuted(false)">
          <Mic :size="17" aria-hidden="true" /> {{ copy.unmute }}
        </button>
      </div>
    </template>

    <template v-else-if="actionId === 'output-switch'">
      <div class="control-heading">
        <span class="icon-badge"><Headphones :size="19" aria-hidden="true" /></span>
        <div>
          <strong>{{ label || copy.audioOutput }}</strong>
          <small>{{ copy.chooseOutput }}</small>
        </div>
        <button class="refresh" type="button" :aria-label="copy.refreshOutputs" :disabled="busy" @click="loadOutputs">
          <RefreshCw :size="16" aria-hidden="true" />
        </button>
      </div>
      <label class="output-picker">
        <span>{{ copy.availableOutputs }}</span>
        <select v-model="selectedDevice" :disabled="readonly || busy || !devices.length" :aria-label="copy.availableOutputs">
          <option value="" disabled>{{ devices.length ? copy.selectDevice : copy.noOutputDevices }}</option>
          <option v-for="device in devices" :key="device.value" :value="device.value">{{ device.label }}</option>
        </select>
      </label>
      <button class="apply" type="button" :disabled="readonly || busy || !selectedDevice" @click="applyOutput">
        <Check :size="16" aria-hidden="true" /> {{ copy.useOutput }}
      </button>
    </template>

    <p v-if="busy" class="feedback" role="status" aria-live="polite">{{ copy.working }}</p>
    <p v-else-if="message" class="feedback" role="status" aria-live="polite">{{ message }}</p>
    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <p v-if="readonly" class="readonly-note">{{ copy.readOnly }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Check, Headphones, Mic, MicOff, RefreshCw } from 'lucide-vue-next'
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
const busy = ref(false)
const error = ref('')
const message = ref('')
const devices = ref<Array<{ value: string; label: string }>>([])
const selectedDevice = ref(String(props.action.parameters?.device ?? ''))

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
    const params = payload()
    delete params.device
    const result = unwrap(await executeWidgetAction(props.apiBase, props.action.type, params))
    const listed = Array.isArray(result?.devices)
      ? result.devices.map((device: any) => ({
          value: String(device.id ?? device.name ?? ''),
          label: String(device.name ?? device.id ?? 'Audio output'),
        })).filter((device: { value: string }) => device.value)
      : parseWindowsDevices(String(result?.devicesRaw ?? ''))
    devices.value = listed
    if (!selectedDevice.value || !listed.some((device: { value: string }) => device.value === selectedDevice.value)) {
      selectedDevice.value = ''
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

onMounted(() => {
  if (actionId.value === 'output-switch') void loadOutputs()
})
</script>

<style scoped>
.audio-control {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
  padding: clamp(10px, 3.5%, 18px);
  color: inherit;
}
.control-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.control-heading > div { min-width: 0; flex: 1; }
.control-heading strong, .control-heading small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.control-heading strong { font-size: clamp(13px, 3cqi, 16px); }
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
.audio-control button, .audio-control select {
  min-height: 42px;
  border: 1px solid var(--bd-ln, #303237);
  border-radius: 10px;
  color: inherit;
  background: var(--bd-sf, #1a1c1f);
  font: inherit;
}
.audio-control button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px 12px;
  cursor: pointer;
  touch-action: manipulation;
}
.audio-control button:hover:not(:disabled) { border-color: var(--bd-ac, #e0a84a); }
.audio-control button:focus-visible, .audio-control select:focus-visible {
  outline: 2px solid var(--bd-ac, #e0a84a);
  outline-offset: 2px;
}
.audio-control button:disabled, .audio-control select:disabled { cursor: not-allowed; opacity: .55; }
.audio-control .apply { border-color: color-mix(in srgb, var(--bd-ac, #e0a84a) 55%, var(--bd-ln, #303237)); }
.refresh { width: 38px; flex: none; padding: 0 !important; }
.output-picker { display: grid; gap: 6px; }
.output-picker select { width: 100%; padding: 0 10px; }
.feedback, .readonly-note { margin: 0; }
.error { color: #ff8d86; }
@media (max-width: 300px) {
  .mic-actions { grid-template-columns: 1fr; }
}
</style>
