<template>
  <section class="smart-home" :aria-label="label || copy.rootLabel" data-cy="smart-home">
    <header class="control-heading">
      <span class="icon-badge">
        <component :is="headingIcon" :size="19" aria-hidden="true" />
      </span>
      <div>
        <strong>{{ label || heading }}</strong>
        <small>{{ subtitle }}</small>
      </div>
      <button
        v-if="canReadHa"
        class="refresh"
        type="button"
        :aria-label="copy.refreshState"
        :disabled="busy"
        @click="readHomeAssistant"
      >
        <RefreshCw :size="16" aria-hidden="true" />
      </button>
    </header>

    <template v-if="isHa && isSensor">
      <div v-if="hasState" class="reading" aria-live="polite">
        <span>{{ copy.latestReading }}</span>
        <strong>{{ displayedState }}</strong>
      </div>
      <button class="action-button" type="button" :disabled="busy || !entityId" @click="readHomeAssistant">
        <Activity :size="16" aria-hidden="true" /> {{ copy.readSensor }}
      </button>
    </template>

    <template v-else-if="isHa && isClimate">
      <div v-if="hasState" class="reading" aria-live="polite">
        <span>{{ copy.latestHaState }}</span>
        <strong>{{ displayedState }}</strong>
      </div>
      <label class="field">
        <span>{{ copy.hvacMode }}</span>
        <select v-model="climateMode" :disabled="readonly || busy" :aria-label="copy.hvacMode">
          <option value="">{{ copy.keepCurrentMode }}</option>
          <option v-for="mode in hvacModes" :key="mode" :value="mode">{{ modeLabel(mode) }}</option>
        </select>
      </label>
      <label class="field">
        <span>{{ copy.targetTemperature }}</span>
        <input v-model="climateTemperature" type="number" min="5" max="35" step="0.5" :disabled="readonly || busy" :aria-label="copy.targetTemperature" />
      </label>
      <button class="action-button" type="button" :disabled="readonly || busy || (!climateMode && !climateTemperature)" @click="applyClimate">
        <Thermometer :size="16" aria-hidden="true" /> {{ copy.applyClimate }}
      </button>
    </template>

    <template v-else-if="isHa && isCover">
      <div v-if="hasState" class="reading" aria-live="polite">
        <span>{{ copy.latestHaState }}</span>
        <strong>{{ displayedState }}</strong>
      </div>
      <div class="button-row" role="group" :aria-label="copy.coverControls">
        <button type="button" :disabled="readonly || busy" @click="runHaAction('open')"><ArrowUp :size="16" aria-hidden="true" /> {{ copy.open }}</button>
        <button type="button" :disabled="readonly || busy" @click="runHaAction('stop')"><Square :size="14" aria-hidden="true" /> {{ copy.stop }}</button>
        <button type="button" :disabled="readonly || busy" @click="runHaAction('close')"><ArrowDown :size="16" aria-hidden="true" /> {{ copy.close }}</button>
      </div>
      <label class="field">
        <span>{{ copy.targetPosition }} <output>{{ coverPosition }}%</output></span>
        <input v-model.number="coverPosition" type="range" min="0" max="100" step="1" :disabled="readonly || busy" :aria-label="copy.targetPosition" @change="setCoverPosition" />
      </label>
    </template>

    <template v-else-if="isHa && isLight">
      <div v-if="hasState" class="reading" aria-live="polite">
        <span>{{ copy.latestHaState }}</span>
        <strong>{{ displayedState }}</strong>
      </div>
      <div class="button-row" role="group" :aria-label="copy.lightControls">
        <button type="button" :disabled="readonly || busy" @click="runHaAction('on')"><Power :size="16" aria-hidden="true" /> {{ copy.on }}</button>
        <button type="button" :disabled="readonly || busy" @click="runHaAction('off')"><PowerOff :size="16" aria-hidden="true" /> {{ copy.off }}</button>
      </div>
      <label class="field">
        <span>{{ copy.brightnessTarget }} <output>{{ haBrightness }} / 255</output></span>
        <input v-model.number="haBrightness" type="range" min="0" max="255" step="1" :disabled="readonly || busy" :aria-label="copy.targetLightBrightness" @change="setHaBrightness" />
      </label>
    </template>

    <template v-else-if="isHa && (entityDomain === 'scene' || entityDomain === 'script')">
      <p class="supporting-copy">{{ copy.activateHaSceneHint }}</p>
      <button class="action-button" type="button" :disabled="readonly || busy || !entityId" @click="runHaAction('activate')">
        <Sparkles :size="16" aria-hidden="true" /> {{ copy.activateScene }}
      </button>
    </template>

    <template v-else-if="isHa && entityDomain === 'automation'">
      <p class="supporting-copy">{{ copy.triggerHaAutomationHint }}</p>
      <button class="action-button" type="button" :disabled="readonly || busy || !entityId" @click="runHaAction('trigger')">
        <Zap :size="16" aria-hidden="true" /> {{ copy.triggerAutomation }}
      </button>
    </template>

    <template v-else-if="isHa">
      <div v-if="hasState" class="reading" aria-live="polite">
        <span>{{ copy.latestHaState }}</span>
        <strong>{{ displayedState }}</strong>
      </div>
      <div class="button-row" role="group" :aria-label="copy.entityControls">
        <button type="button" :disabled="readonly || busy" @click="runHaAction('on')"><Power :size="16" aria-hidden="true" /> {{ copy.on }}</button>
        <button type="button" :disabled="readonly || busy" @click="runHaAction('off')"><PowerOff :size="16" aria-hidden="true" /> {{ copy.off }}</button>
        <button type="button" :disabled="readonly || busy" @click="runHaAction('toggle')"><RefreshCw :size="15" aria-hidden="true" /> {{ copy.toggle }}</button>
      </div>
    </template>

    <template v-else-if="isLightToggle">
      <div class="button-row" role="group" :aria-label="copy.lightControls">
        <button type="button" :disabled="readonly || busy" @click="sendLightState('on')"><Power :size="16" aria-hidden="true" /> {{ copy.on }}</button>
        <button type="button" :disabled="readonly || busy" @click="sendLightState('off')"><PowerOff :size="16" aria-hidden="true" /> {{ copy.off }}</button>
        <button v-if="isHue" type="button" :disabled="readonly || busy" @click="sendLightState('toggle')"><RefreshCw :size="15" aria-hidden="true" /> {{ copy.toggle }}</button>
      </div>
      <p class="supporting-copy">{{ copy.noLiveDeviceState }}</p>
    </template>

    <template v-else-if="isBrightness">
      <label class="field">
        <span>{{ copy.brightnessTarget }} <output>{{ brightness }}{{ isHue ? ' / 254' : '%' }}</output></span>
        <input v-model.number="brightness" type="range" min="0" :max="isHue ? 254 : 100" step="1" :disabled="readonly || busy" :aria-label="copy.targetLightBrightness" @change="setBrightness" />
      </label>
      <p class="supporting-copy">{{ copy.noLiveBrightness }}</p>
    </template>

    <template v-else-if="isColor">
      <template v-if="isHue">
        <label class="field">
          <span>{{ copy.hueColorValue }} <output>{{ hue }}</output></span>
          <input v-model.number="hue" type="range" min="0" max="65535" step="1" :disabled="readonly || busy" :aria-label="copy.hueColorValue" />
        </label>
        <label class="field">
          <span>{{ copy.saturation }} <output>{{ saturation }}</output></span>
          <input v-model.number="saturation" type="range" min="0" max="254" step="1" :disabled="readonly || busy" :aria-label="copy.colorSaturation" />
        </label>
        <button class="action-button" type="button" :disabled="readonly || busy" @click="setHueColor"><Palette :size="16" aria-hidden="true" /> {{ copy.applyColor }}</button>
      </template>
      <template v-else>
        <label class="field color-field">
          <span>{{ copy.targetColor }}</span>
          <input v-model="goveeColor" type="color" :disabled="readonly || busy" :aria-label="copy.targetLightColor" />
        </label>
        <button class="action-button" type="button" :disabled="readonly || busy" @click="setGoveeColor"><Palette :size="16" aria-hidden="true" /> {{ copy.applyColor }}</button>
      </template>
      <p class="supporting-copy">{{ copy.noLiveColor }}</p>
    </template>

    <template v-else-if="isScene">
      <p v-if="sceneName" class="scene-name">{{ sceneName }}</p>
      <p v-else class="supporting-copy">{{ copy.noScene }}</p>
      <button class="action-button" type="button" :disabled="readonly || busy || !sceneName" @click="activateScene">
        <Sparkles :size="16" aria-hidden="true" /> {{ copy.activateScene }}
      </button>
    </template>

    <p v-if="busy" class="feedback" role="status" aria-live="polite">{{ copy.sending }}</p>
    <p v-else-if="message" class="feedback" role="status" aria-live="polite">{{ message }}</p>
    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <p v-if="readonly" class="readonly-note">{{ copy.readOnly }}</p>
    <p v-if="isHa && !entityId" class="feedback error" role="alert">{{ copy.missingEntity }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Activity, ArrowDown, ArrowUp, House, Lightbulb, Palette, Power, PowerOff,
  RefreshCw, Sparkles, Square, Thermometer, Zap,
} from 'lucide-vue-next'
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
  rootLabel: 'Control de hogar inteligente',
  sensor: 'Sensor',
  climate: 'Climatización',
  cover: 'Persiana',
  light: 'Luz',
  hue: 'Philips Hue',
  govee: 'Luz Govee',
  smartHome: 'Hogar inteligente',
  haEntity: 'Entidad de Home Assistant',
  hueSubtitle: 'Control del puente Hue',
  goveeSubtitle: 'Control de Govee en la nube',
  deviceSubtitle: 'Control del dispositivo',
  refreshState: 'Actualizar estado de Home Assistant',
  latestReading: 'Última lectura',
  latestHaState: 'Último estado de Home Assistant',
  readSensor: 'Leer sensor',
  hvacMode: 'Modo de climatización',
  keepCurrentMode: 'Mantener el modo actual',
  targetTemperature: 'Temperatura objetivo (°C)',
  applyClimate: 'Aplicar ajustes de clima',
  coverControls: 'Controles de persiana',
  open: 'Abrir',
  stop: 'Detener',
  close: 'Cerrar',
  targetPosition: 'Posición objetivo',
  lightControls: 'Controles de luz',
  on: 'Encender',
  off: 'Apagar',
  brightnessTarget: 'Brillo objetivo',
  targetLightBrightness: 'Brillo objetivo de la luz',
  activateHaSceneHint: 'Activa la escena configurada de Home Assistant.',
  activateScene: 'Activar escena',
  triggerHaAutomationHint: 'Dispara la automatización configurada de Home Assistant.',
  triggerAutomation: 'Disparar automatización',
  entityControls: 'Controles de entidad',
  toggle: 'Alternar',
  noLiveDeviceState: 'Se envían comandos al dispositivo configurado; aquí no se muestra su estado en tiempo real.',
  noLiveBrightness: 'Solo es un valor objetivo; esta integración no informa del brillo actual.',
  hueColorValue: 'Valor del tono de color',
  saturation: 'Saturación',
  colorSaturation: 'Saturación del color',
  applyColor: 'Aplicar color',
  targetColor: 'Color objetivo',
  targetLightColor: 'Color objetivo de la luz',
  noLiveColor: 'El color se envía como objetivo; no se consulta el color actual del dispositivo.',
  noScene: 'No hay ninguna escena configurada para esta acción.',
  sending: 'Enviando comando…',
  readOnly: 'Control de solo lectura',
  missingEntity: 'Indica un ID de entidad en los parámetros de la acción.',
  commandAccepted: 'Comando aceptado.',
  brightnessAccepted: 'Se aceptó el comando de brillo.',
  colorAccepted: 'Se aceptó el comando de color.',
  stateRefreshed: 'Estado actualizado.',
  noStateReturned: 'No se devolvió ningún estado.',
  readFailed: 'No se pudo leer el estado de Home Assistant.',
  commandFailed: 'La acción de hogar inteligente falló.',
  modes: { off: 'Apagado', heat: 'Calor', cool: 'Frío', auto: 'Automático', fan_only: 'Solo ventilador', dry: 'Deshumidificar' },
} : {
  rootLabel: 'Smart home control',
  sensor: 'Sensor',
  climate: 'Climate',
  cover: 'Cover',
  light: 'Light',
  hue: 'Philips Hue',
  govee: 'Govee light',
  smartHome: 'Smart home',
  haEntity: 'Home Assistant entity',
  hueSubtitle: 'Hue Bridge control',
  goveeSubtitle: 'Govee cloud control',
  deviceSubtitle: 'Device control',
  refreshState: 'Refresh Home Assistant state',
  latestReading: 'Latest reading',
  latestHaState: 'Latest Home Assistant state',
  readSensor: 'Read sensor',
  hvacMode: 'HVAC mode',
  keepCurrentMode: 'Keep current mode',
  targetTemperature: 'Target temperature (°C)',
  applyClimate: 'Apply climate settings',
  coverControls: 'Cover controls',
  open: 'Open',
  stop: 'Stop',
  close: 'Close',
  targetPosition: 'Target position',
  lightControls: 'Light controls',
  on: 'On',
  off: 'Off',
  brightnessTarget: 'Brightness target',
  targetLightBrightness: 'Target light brightness',
  activateHaSceneHint: 'Activate the configured Home Assistant scene.',
  activateScene: 'Activate scene',
  triggerHaAutomationHint: 'Trigger the configured Home Assistant automation.',
  triggerAutomation: 'Trigger automation',
  entityControls: 'Entity controls',
  toggle: 'Toggle',
  noLiveDeviceState: 'Commands are sent to the configured device; live state is not available here.',
  noLiveBrightness: 'Target value only; this integration does not report current brightness.',
  hueColorValue: 'Hue color value',
  saturation: 'Saturation',
  colorSaturation: 'Color saturation',
  applyColor: 'Apply color',
  targetColor: 'Target color',
  targetLightColor: 'Target light color',
  noLiveColor: 'Color is sent as a target; current device color is not queried.',
  noScene: 'No scene is configured for this action.',
  sending: 'Sending command…',
  readOnly: 'Read-only control',
  missingEntity: 'Set an entity ID in the action parameters.',
  commandAccepted: 'Command accepted.',
  brightnessAccepted: 'Brightness command accepted.',
  colorAccepted: 'Color command accepted.',
  stateRefreshed: 'State refreshed.',
  noStateReturned: 'No state was returned.',
  readFailed: 'Could not read Home Assistant state.',
  commandFailed: 'Smart home command failed.',
  modes: { off: 'Off', heat: 'Heat', cool: 'Cool', auto: 'Auto', fan_only: 'Fan only', dry: 'Dry' },
})
const actionId = computed(() => props.action.type.split('.').at(-1) ?? '')
const pluginId = computed(() => props.action.type.split('.').slice(0, -1).join('.'))
const params = computed(() => props.action.parameters ?? {})
const isHa = computed(() => pluginId.value === 'homeassistant')
const isHue = computed(() => pluginId.value === 'hue-extra')
const isGovee = computed(() => pluginId.value === 'govee')
const isLightToggle = computed(() => (isHue.value || isGovee.value) && actionId.value === 'toggle')
const isBrightness = computed(() => (isHue.value || isGovee.value) && actionId.value === 'brightness')
const isColor = computed(() => (isHue.value || isGovee.value) && actionId.value === 'color')
const isScene = computed(() => (isHue.value || isGovee.value) && actionId.value === 'scene')
const entityId = computed(() => String(params.value.entityId ?? ''))
const entityDomain = computed(() => entityId.value.split('.')[0]?.toLowerCase() ?? '')
const isSensor = computed(() => ['sensor', 'binary_sensor'].includes(entityDomain.value) || ['sensor-value', 'get-state'].includes(actionId.value) || params.value.action === 'read')
const isClimate = computed(() => entityDomain.value === 'climate' || actionId.value === 'climate-set')
const isCover = computed(() => entityDomain.value === 'cover' || actionId.value === 'cover-control')
const isLight = computed(() => entityDomain.value === 'light' || actionId.value === 'light')
const canReadHa = computed(() => isHa.value && actionId.value !== 'climate-set')
const heading = computed(() => isSensor.value ? copy.value.sensor : isClimate.value ? copy.value.climate : isCover.value ? copy.value.cover : isLight.value ? copy.value.light : isHue.value ? copy.value.hue : isGovee.value ? copy.value.govee : copy.value.smartHome)
const subtitle = computed(() => isHa.value ? (entityId.value || copy.value.haEntity) : isHue.value ? copy.value.hueSubtitle : isGovee.value ? copy.value.goveeSubtitle : copy.value.deviceSubtitle)
const headingIcon = computed(() => isHa.value ? (isClimate.value ? Thermometer : isLight.value ? Lightbulb : House) : Lightbulb)
const hvacModes = ['off', 'heat', 'cool', 'auto', 'fan_only', 'dry']
const busy = ref(false)
const error = ref('')
const message = ref('')
const hasState = ref(false)
const displayedState = ref('')
const haBrightness = ref(Number(params.value.brightness ?? 128))
const coverPosition = ref(Number(params.value.position ?? 50))
const climateMode = ref(String(params.value.hvacMode ?? ''))
const climateTemperature = ref(params.value.temperature === undefined ? '' : String(params.value.temperature))
const brightness = ref(Number(params.value.brightness ?? (isHue.value ? 127 : 50)))
const hue = ref(Number(params.value.hue ?? 0))
const saturation = ref(Number(params.value.saturation ?? 254))
const goveeColor = ref(rgbToHex(params.value.red, params.value.green, params.value.blue))
const sceneName = computed(() => String(isHue.value ? params.value.sceneId ?? '' : params.value.scene ?? '').trim())

function rgbToHex(red: unknown, green: unknown, blue: unknown) {
  const channel = (value: unknown) => Math.min(255, Math.max(0, Number(value ?? 255))).toString(16).padStart(2, '0')
  return `#${channel(red)}${channel(green)}${channel(blue)}`
}

function unwrap(response: any) {
  return response?.result ?? response
}

function modeLabel(mode: string) {
  return copy.value.modes[mode as keyof typeof copy.value.modes] ?? mode.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function readStateFromResult(result: any) {
  const full = result?.fullState ?? result?.state
  const value = result?.rawState ?? (typeof full === 'object' ? full?.state : full) ?? result?.state
  if (value === undefined || value === null || typeof value === 'object') return
  const attributes = result?.attributes ?? result?.fullState?.attributes
  const unit = attributes?.unit_of_measurement
  displayedState.value = `${String(value)}${unit ? ` ${unit}` : ''}`
  hasState.value = true
}

async function execute(type = props.action.type, parameters = params.value) {
  return unwrap(await executeWidgetAction(props.apiBase, type, parameters))
}

async function perform(operation: () => Promise<any>, success = copy.value.commandAccepted) {
  if (props.readonly || busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const result = await operation()
    readStateFromResult(result)
    message.value = success
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : copy.value.commandFailed
  } finally {
    busy.value = false
  }
}

async function readHomeAssistant() {
  if (!canReadHa.value || !entityId.value || busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const readParams = { ...params.value, action: 'read' }
    const result = await execute(props.action.type, readParams)
    readStateFromResult(result)
    message.value = hasState.value ? copy.value.stateRefreshed : copy.value.noStateReturned
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : copy.value.readFailed
  } finally {
    busy.value = false
  }
}

function runHaAction(action: string, extra: Record<string, any> = {}) {
  return perform(() => execute(props.action.type, { ...params.value, action, ...extra }))
}

function applyClimate() {
  const update: Record<string, any> = {}
  if (climateMode.value) update.hvacMode = climateMode.value
  if (climateTemperature.value !== '') update.temperature = Number(climateTemperature.value)
  if (props.action.type.endsWith('.entity')) update.action = 'set-climate'
  return perform(() => execute(props.action.type, { ...params.value, ...update }))
}

function setCoverPosition() {
  return runHaAction('set-position', { position: Number(coverPosition.value) })
}

function setHaBrightness() {
  return runHaAction('on', { brightness: Number(haBrightness.value) })
}

function sendLightState(action: 'on' | 'off' | 'toggle') {
  return perform(() => execute(props.action.type, { ...params.value, action }))
}

function setBrightness() {
  const value = Math.round(Number(brightness.value))
  const next = isHue.value ? { ...params.value, brightness: Math.max(1, value) } : { ...params.value, brightness: value }
  return perform(() => execute(props.action.type, next), copy.value.brightnessAccepted)
}

function setHueColor() {
  return perform(() => execute(props.action.type, {
    ...params.value,
    hue: Math.round(Number(hue.value)),
    saturation: Math.round(Number(saturation.value)),
  }), copy.value.colorAccepted)
}

function setGoveeColor() {
  const hex = goveeColor.value.replace('#', '')
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  return perform(() => execute(props.action.type, { ...params.value, red, green, blue }), copy.value.colorAccepted)
}

function activateScene() {
  return perform(() => execute())
}

onMounted(() => {
  if (canReadHa.value && entityId.value) void readHomeAssistant()
})
</script>

<style scoped>
.smart-home {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 11px;
  overflow: auto;
  padding: clamp(10px, 3.5%, 18px);
  color: inherit;
}
.control-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
.control-heading > div { min-width: 0; flex: 1; }
.control-heading strong, .control-heading small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.control-heading strong { font-size: clamp(13px, 3cqi, 16px); }
.control-heading small, .field > span, .supporting-copy, .feedback, .readonly-note { color: var(--bd-mu, #9b9da1); font-size: 12px; }
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
.refresh {
  display: grid;
  width: 36px;
  min-height: 36px;
  flex: none;
  place-items: center;
  border: 1px solid var(--bd-ln, #303237);
  border-radius: 9px;
  color: inherit;
  background: var(--bd-sf, #1a1c1f);
  cursor: pointer;
}
.reading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 11px;
  border: 1px solid var(--bd-ln, #303237);
  border-radius: 10px;
  background: var(--bd-sf, #1a1c1f);
}
.reading span { color: var(--bd-mu, #9b9da1); font-size: 11px; }
.reading strong { font-family: var(--bd-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
.field { display: grid; gap: 5px; min-width: 0; }
.field > span { display: flex; justify-content: space-between; gap: 8px; }
.field output { color: inherit; font-family: var(--bd-mono, ui-monospace, monospace); }
.field input[type="range"] { width: 100%; min-height: 28px; accent-color: var(--bd-ac, #e0a84a); }
.field input[type="number"], .field select {
  box-sizing: border-box;
  width: 100%;
  min-height: 40px;
  padding: 7px 9px;
  border: 1px solid var(--bd-ln, #303237);
  border-radius: 9px;
  color: inherit;
  background: var(--bd-sf, #1a1c1f);
  font: inherit;
}
.field input[type="color"] { width: 100%; height: 42px; padding: 3px; border: 1px solid var(--bd-ln, #303237); border-radius: 9px; background: var(--bd-sf, #1a1c1f); }
.button-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(66px, 1fr)); gap: 7px; }
.button-row button, .action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  min-height: 40px;
  padding: 7px 9px;
  border: 1px solid var(--bd-ln, #303237);
  border-radius: 9px;
  color: inherit;
  background: var(--bd-sf, #1a1c1f);
  font: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.action-button { width: 100%; border-color: color-mix(in srgb, var(--bd-ac, #e0a84a) 55%, var(--bd-ln, #303237)); }
.button-row button:hover:not(:disabled), .action-button:hover:not(:disabled), .refresh:hover:not(:disabled) { border-color: var(--bd-ac, #e0a84a); }
.smart-home button:focus-visible, .smart-home input:focus-visible, .smart-home select:focus-visible {
  outline: 2px solid var(--bd-ac, #e0a84a);
  outline-offset: 2px;
}
.smart-home button:disabled, .smart-home input:disabled, .smart-home select:disabled { cursor: not-allowed; opacity: .55; }
.supporting-copy, .feedback, .readonly-note { margin: 0; }
.scene-name { margin: 0; overflow-wrap: anywhere; font-family: var(--bd-mono, ui-monospace, monospace); }
.error { color: #ff8d86; }
@media (max-width: 260px) { .button-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
