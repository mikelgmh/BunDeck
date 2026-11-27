<template>
  <section class="smart-home" :aria-label="label || copy.rootLabel" data-cy="widget-smart-home">
    <NeedsConfig
      v-if="!isConfigured"
      :action-type="props.action.type"
      :position="props.position"
    />

    <div class="sh-body">
    <header class="control-heading">
      <span class="icon-badge">
        <component :is="headingIcon" :size="19" aria-hidden="true" />
      </span>
      <div class="head-text">
        <strong>{{ label || heading }}</strong>
        <Marquee :text="subtitle" />
      </div>
      <button
        v-if="canReadHa"
        class="refresh only-m-plus"
        type="button"
        :aria-label="copy.refreshState"
        :disabled="busy"
        @click="readHomeAssistant"
      >
        <RefreshCw :size="16" aria-hidden="true" />
      </button>
    </header>

    <!-- Lectura principal (sensores y entidades HA con estado): héroe en XS. -->
    <div v-if="showHeroReading" class="reading" aria-live="polite">
      <span>{{ heroLabel }}</span>
      <strong class="bd-data-swap" :key="displayedState ?? ''">{{ displayedState || '—' }}</strong>
    </div>

    <!-- Hue: lista de luces descubiertas (varios datos → carrusel en pequeño). -->
    <template v-if="isHueList">
      <p v-if="listBusy && !lights.length" class="feedback" role="status">{{ copy.sending }}</p>
      <AutoCarousel
        v-else-if="lights.length"
        :count="lights.length"
        :interval-ms="carouselMs"
        :show-dots="true"
        :dots-label="copy.lightsListLabel"
        class="lights-carousel"
      >
        <template #default="{ index }">
          <div class="light-hero" :aria-label="lightLabel(lights[index])">
            <Lightbulb :size="20" aria-hidden="true" :class="{ 'is-on': lights[index]?.on }" />
            <Marquee :text="lights[index]?.name || copy.unnamedLight(lights[index]?.id)" />
            <small>{{ lightStateLabel(lights[index]) }}</small>
          </div>
        </template>
      </AutoCarousel>
      <p v-else-if="!listBusy" class="supporting-copy only-m-plus">{{ copy.noLights }}</p>
      <p v-else-if="!listBusy" class="empty-xs">{{ copy.noLightsShort }}</p>
    </template>

    <template v-else-if="isHa && isSensor">
      <button class="action-button only-m-plus" type="button" :disabled="busy || !entityId" @click="readHomeAssistant">
        <Activity :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.readSensor }}</span>
      </button>
    </template>

    <template v-else-if="isHa && isClimate">
      <div class="climate-grid">
        <label class="field only-m-plus">
          <span>{{ copy.hvacMode }}</span>
          <select v-model="climateMode" :disabled="readonly || busy" :aria-label="copy.hvacMode">
            <option value="">{{ copy.keepCurrentMode }}</option>
            <option v-for="mode in hvacModes" :key="mode" :value="mode">{{ modeLabel(mode) }}</option>
          </select>
        </label>
        <label class="field only-m-plus">
          <span>{{ copy.targetTemperature }}</span>
          <input v-model="climateTemperature" type="number" min="5" max="35" step="0.5" :disabled="readonly || busy" :aria-label="copy.targetTemperature" />
        </label>
      </div>
      <button class="action-button" type="button" :disabled="readonly || busy || (!climateMode && !climateTemperature)" @click="applyClimate">
        <Thermometer :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.applyClimate }}</span>
      </button>
    </template>

    <template v-else-if="isHa && isCover">
      <div class="button-row" role="group" :aria-label="copy.coverControls">
        <button type="button" :disabled="readonly || busy" @click="runHaAction('open')"><ArrowUp :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.open }}</span></button>
        <button type="button" :disabled="readonly || busy" @click="runHaAction('stop')"><Square :size="14" aria-hidden="true" /> <span class="lbl">{{ copy.stop }}</span></button>
        <button type="button" :disabled="readonly || busy" @click="runHaAction('close')"><ArrowDown :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.close }}</span></button>
      </div>
      <label class="field only-m-plus">
        <span>{{ copy.targetPosition }} <output>{{ coverPosition }}%</output></span>
        <input v-model.number="coverPosition" type="range" min="0" max="100" step="1" :disabled="readonly || busy" :aria-label="copy.targetPosition" @change="setCoverPosition" />
      </label>
    </template>

    <template v-else-if="isHa && isLight">
      <div class="button-row" role="group" :aria-label="copy.lightControls">
        <button type="button" :disabled="readonly || busy" @click="runHaAction('on')"><Power :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.on }}</span></button>
        <button type="button" :disabled="readonly || busy" @click="runHaAction('off')"><PowerOff :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.off }}</span></button>
      </div>
      <label class="field only-m-plus">
        <span>{{ copy.brightnessTarget }} <output>{{ haBrightness }} / 255</output></span>
        <input v-model.number="haBrightness" type="range" min="0" max="255" step="1" :disabled="readonly || busy" :aria-label="copy.targetLightBrightness" @change="setHaBrightness" />
      </label>
    </template>

    <template v-else-if="isHa && (entityDomain === 'scene' || entityDomain === 'script')">
      <p class="supporting-copy only-m-plus">{{ copy.activateHaSceneHint }}</p>
      <button class="action-button" type="button" :disabled="readonly || busy || !entityId" @click="runHaAction('activate')">
        <Sparkles :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.activateScene }}</span>
      </button>
    </template>

    <template v-else-if="isHa && entityDomain === 'automation'">
      <p class="supporting-copy only-m-plus">{{ copy.triggerHaAutomationHint }}</p>
      <button class="action-button" type="button" :disabled="readonly || busy || !entityId" @click="runHaAction('trigger')">
        <Zap :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.triggerAutomation }}</span>
      </button>
    </template>

    <template v-else-if="isHa">
      <div class="button-row" role="group" :aria-label="copy.entityControls">
        <button type="button" :disabled="readonly || busy" @click="runHaAction('on')"><Power :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.on }}</span></button>
        <button type="button" :disabled="readonly || busy" @click="runHaAction('off')"><PowerOff :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.off }}</span></button>
        <button type="button" :disabled="readonly || busy" @click="runHaAction('toggle')"><RefreshCw :size="15" aria-hidden="true" /> <span class="lbl">{{ copy.toggle }}</span></button>
      </div>
    </template>

    <!-- Fuego-ciego (Hue/Govee): sin estado en vivo, 1-2 botones en pequeño. -->
    <template v-else-if="isLightToggle">
      <div class="button-row" role="group" :aria-label="copy.lightControls">
        <button type="button" :disabled="readonly || busy" @click="sendLightState('on')"><Power :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.on }}</span></button>
        <button type="button" :disabled="readonly || busy" @click="sendLightState('off')"><PowerOff :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.off }}</span></button>
        <button v-if="isHue" class="only-m-plus" type="button" :disabled="readonly || busy" @click="sendLightState('toggle')"><RefreshCw :size="15" aria-hidden="true" /> <span class="lbl">{{ copy.toggle }}</span></button>
      </div>
      <p class="supporting-copy only-m-plus">{{ copy.noLiveDeviceState }}</p>
    </template>

    <template v-else-if="isBrightness">
      <label class="field only-m-plus">
        <span>{{ copy.brightnessTarget }} <output>{{ brightness }}{{ isHue ? ' / 254' : '%' }}</output></span>
        <input v-model.number="brightness" type="range" min="0" :max="isHue ? 254 : 100" step="1" :disabled="readonly || busy" :aria-label="copy.targetLightBrightness" @change="setBrightness" />
      </label>
      <button class="action-button" type="button" :disabled="readonly || busy" @click="setBrightness">
        <Sun :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.applyBrightness }}</span>
      </button>
      <p class="supporting-copy only-m-plus">{{ copy.noLiveBrightness }}</p>
    </template>

    <template v-else-if="isColor">
      <template v-if="isHue">
        <label class="field only-m-plus">
          <span>{{ copy.hueColorValue }} <output>{{ hue }}</output></span>
          <input v-model.number="hue" type="range" min="0" max="65535" step="1" :disabled="readonly || busy" :aria-label="copy.hueColorValue" />
        </label>
        <label class="field only-m-plus">
          <span>{{ copy.saturation }} <output>{{ saturation }}</output></span>
          <input v-model.number="saturation" type="range" min="0" max="254" step="1" :disabled="readonly || busy" :aria-label="copy.colorSaturation" />
        </label>
        <button class="action-button" type="button" :disabled="readonly || busy" @click="setHueColor"><Palette :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.applyColor }}</span></button>
      </template>
      <template v-else>
        <label class="field only-m-plus color-field">
          <span>{{ copy.targetColor }}</span>
          <input v-model="goveeColor" type="color" :disabled="readonly || busy" :aria-label="copy.targetLightColor" />
        </label>
        <button class="action-button" type="button" :disabled="readonly || busy" @click="setGoveeColor"><Palette :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.applyColor }}</span></button>
      </template>
      <p class="supporting-copy only-m-plus">{{ copy.noLiveColor }}</p>
    </template>

    <template v-else-if="isScene">
      <p v-if="sceneName" class="scene-name"><Marquee :text="sceneName" /></p>
      <p v-else class="supporting-copy only-m-plus">{{ copy.noScene }}</p>
      <button class="action-button" type="button" :disabled="readonly || busy || !sceneName" @click="activateScene">
        <Sparkles :size="16" aria-hidden="true" /> <span class="lbl">{{ copy.activateScene }}</span>
      </button>
    </template>

    <p v-if="busy" class="feedback" role="status" aria-live="polite">{{ copy.sending }}</p>
    <p v-else-if="message" class="feedback only-m-plus" role="status" aria-live="polite">{{ message }}</p>
    <p v-if="error" class="feedback error" role="alert" :title="error">
      <TriangleAlert :size="14" aria-hidden="true" class="err-icon" />
      <span class="err-text">{{ error }}</span>
      <span class="err-short">{{ copy.commandFailed }}</span>
    </p>
    <p v-if="readonly" class="readonly-note only-m-plus">{{ copy.readOnly }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Activity, ArrowDown, ArrowUp, House, Lightbulb, Palette, Power, PowerOff,
  RefreshCw, Sparkles, Square, Sun, Thermometer, TriangleAlert, Zap,
} from 'lucide-vue-next'
import { useI18nStore } from '../../../composables/useI18n'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import { resolveCarouselMs } from '../../../composables/useAutoCarousel'
import Marquee from './shared/Marquee.vue'
import NeedsConfig from './shared/NeedsConfig.vue'
import AutoCarousel from './shared/AutoCarousel.vue'

interface Props {
  action: { type: string; parameters: Record<string, any> }
  apiBase: string
  label?: string
  readonly?: boolean
  /** Posición de la tecla (la reenvía ControlSurface; la usa NeedsConfig). */
  position?: number | null
}

const props = withDefaults(defineProps<Props>(), { label: '', readonly: false, position: null })
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
  lightsList: 'Luces Hue',
  lightsListLabel: 'Luces del puente Hue',
  haEntity: 'Entidad de Home Assistant',
  hueSubtitle: 'Control del puente Hue',
  goveeSubtitle: 'Control de Govee en la nube',
  deviceSubtitle: 'Control del dispositivo',
  refreshState: 'Actualizar estado de Home Assistant',
  refreshLights: 'Actualizar lista de luces',
  latestReading: 'Última lectura',
  latestHaState: 'Último estado de Home Assistant',
  readSensor: 'Leer sensor',
  hvacMode: 'Modo de climatización',
  keepCurrentMode: 'Mantener el modo actual',
  targetTemperature: 'Temperatura objetivo (°C)',
  applyClimate: 'Aplicar ajustes de clima',
  applyBrightness: 'Aplicar brillo',
  coverControls: 'Controles de persiana',
  open: 'Abrir',
  stop: 'Detener',
  close: 'Cerrar',
  targetPosition: 'Posición objetivo',
  lightControls: 'Controles de luz',
  on: 'Encendido',
  off: 'Apagado',
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
  noLights: 'No se encontraron luces en el puente. Revisa la conexión en los ajustes.',
  noLightsShort: 'Sin luces',
  unnamedLight: (id: unknown) => `Luz ${String(id ?? '?')}`,
  sending: 'Enviando comando…',
  readOnly: 'Control de solo lectura',
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
  lightsList: 'Hue lights',
  lightsListLabel: 'Hue Bridge lights',
  haEntity: 'Home Assistant entity',
  hueSubtitle: 'Hue Bridge control',
  goveeSubtitle: 'Govee cloud control',
  deviceSubtitle: 'Device control',
  refreshState: 'Refresh Home Assistant state',
  refreshLights: 'Refresh light list',
  latestReading: 'Latest reading',
  latestHaState: 'Latest Home Assistant state',
  readSensor: 'Read sensor',
  hvacMode: 'HVAC mode',
  keepCurrentMode: 'Keep current mode',
  targetTemperature: 'Target temperature (°C)',
  applyClimate: 'Apply climate settings',
  applyBrightness: 'Apply brightness',
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
  noLights: 'No lights found on the bridge. Check the connection in settings.',
  noLightsShort: 'No lights',
  unnamedLight: (id: unknown) => `Light ${String(id ?? '?')}`,
  sending: 'Sending command…',
  readOnly: 'Read-only control',
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
const isHueList = computed(() => isHue.value && actionId.value === 'lights-list')
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

/**
 * Condición "sin configurar" por acción (la pinta NeedsConfig):
 * - Home Assistant: exige entityId.
 * - Hue: exige lightId (toggle/brillo/color), sceneId (escena); la lista no
 *   exige nada (usa la conexión del plugin).
 * - Govee: exige device + model (+ scene en escena).
 */
const isConfigured = computed(() => {
  if (isHa.value) return entityId.value.trim().length > 0
  if (isHue.value) {
    if (actionId.value === 'lights-list') return true
    if (actionId.value === 'scene') return sceneName.value.length > 0
    return String(params.value.lightId ?? '').trim().length > 0
  }
  if (isGovee.value) {
    const target = String(params.value.device ?? '').trim().length > 0
      && String(params.value.model ?? '').trim().length > 0
    if (actionId.value === 'scene') return target && sceneName.value.length > 0
    return target
  }
  return true
})

const canReadHa = computed(() => isHa.value && actionId.value !== 'climate-set')
const showHeroReading = computed(() => !isHueList.value && isHa.value && hasState.value)
const heroLabel = computed(() => isSensor.value ? copy.value.latestReading : copy.value.latestHaState)
const heading = computed(() => isHueList.value ? copy.value.lightsList : isSensor.value ? copy.value.sensor : isClimate.value ? copy.value.climate : isCover.value ? copy.value.cover : isLight.value ? copy.value.light : isHue.value ? copy.value.hue : isGovee.value ? copy.value.govee : copy.value.smartHome)
const subtitle = computed(() => {
  if (isHueList.value) return copy.value.hueSubtitle
  if (isHa.value) return entityId.value || copy.value.haEntity
  if (isHue.value || isGovee.value) {
    const target = isHue.value
      ? (actionId.value === 'scene' ? sceneName.value : String(params.value.lightId ?? ''))
      : (actionId.value === 'scene' ? sceneName.value : String(params.value.device ?? ''))
    const base = isHue.value ? copy.value.hueSubtitle : copy.value.goveeSubtitle
    return target ? `${base} · ${target}` : base
  }
  return copy.value.deviceSubtitle
})
const headingIcon = computed(() => isHa.value ? (isClimate.value ? Thermometer : isLight.value ? Lightbulb : House) : Lightbulb)
const hvacModes = ['off', 'heat', 'cool', 'auto', 'fan_only', 'dry']
const busy = ref(false)
const listBusy = ref(false)
const error = ref('')
const message = ref('')
const hasState = ref(false)
const displayedState = ref('')
const lights = ref<Array<{ id: string; name?: string | null; on?: boolean | null; brightness?: number | null; reachable?: boolean | null }>>([])
const carouselMs = computed(() => resolveCarouselMs(params.value))
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
  const modes = (copy.value as any).modes as Record<string, string> | undefined
  return modes?.[mode] ?? mode.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function lightLabel(light: { id: string; name?: string | null }): string {
  return light?.name || copy.value.unnamedLight(light?.id)
}

function lightStateLabel(light: { on?: boolean | null; brightness?: number | null; reachable?: boolean | null }): string {
  if (light?.reachable === false) return '—'
  if (light?.on === true) return typeof light?.brightness === 'number' ? `${copy.value.on} · ${light.brightness}` : String(copy.value.on)
  if (light?.on === false) return String(copy.value.off)
  return '—'
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

async function readHueLights() {
  if (!isHueList.value || listBusy.value) return
  listBusy.value = true
  error.value = ''
  try {
    const result = await execute('hue-extra.lights-list', params.value)
    const found = Array.isArray(result?.lights) ? result.lights : []
    lights.value = found.filter((l: any) => l && l.id !== undefined).map((l: any) => ({
      id: String(l.id),
      name: typeof l.name === 'string' ? l.name : null,
      on: typeof l.on === 'boolean' ? l.on : null,
      brightness: typeof l.brightness === 'number' ? l.brightness : null,
      reachable: typeof l.reachable === 'boolean' ? l.reachable : null,
    }))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : copy.value.commandFailed
  } finally {
    listBusy.value = false
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
  if (isHueList.value) void readHueLights()
})
</script>

<style scoped>
.smart-home {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: inherit;
  container-type: size;
  container-name: smart-home;
  position: relative;
}
.sh-body {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: clamp(6px, 2.5cqi, 11px);
  overflow: hidden;
  padding: clamp(8px, 3.5cqi, 18px);
  color: inherit;
}
.control-heading { display: flex; align-items: center; gap: 10px; min-width: 0; flex: none; }
.head-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
.control-heading strong { display: block; overflow: hidden; font-size: clamp(13px, 3cqi, 16px); text-overflow: ellipsis; white-space: nowrap; }
.head-text .bd-marquee { min-width: 0; font-size: 11px; }
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
  min-width: 0;
}
.reading span { flex: none; color: var(--bd-mu, #9b9da1); font-size: 11px; }
.reading strong {
  min-width: 0;
  overflow: hidden;
  font-family: var(--bd-mono, ui-monospace, monospace);
  font-size: clamp(15px, 9cqi, 26px);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lights-carousel { min-height: 0; flex: 1 1 auto; }
.light-hero {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  text-align: center;
}
.light-hero svg { color: var(--bd-mu, #9b9da1); }
.light-hero svg.is-on { color: var(--bd-ac, #e0a84a); }
.light-hero small { color: var(--bd-mu, #9b9da1); font-size: 11px; }
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
.lbl { overflow: hidden; min-width: 0; text-overflow: ellipsis; white-space: nowrap; }
.climate-grid { display: contents; }
.action-button { width: 100%; border-color: color-mix(in srgb, var(--bd-ac, #e0a84a) 55%, var(--bd-ln, #303237)); }
.button-row button:hover:not(:disabled), .action-button:hover:not(:disabled), .refresh:hover:not(:disabled) { border-color: var(--bd-ac, #e0a84a); }
.smart-home button:focus-visible, .smart-home input:focus-visible, .smart-home select:focus-visible {
  outline: 2px solid var(--bd-ac, #e0a84a);
  outline-offset: 2px;
}
.smart-home button:disabled, .smart-home input:disabled, .smart-home select:disabled { cursor: not-allowed; opacity: .55; }
.supporting-copy, .feedback, .readonly-note { margin: 0; }
.supporting-copy, .readonly-note { color: var(--bd-mu, #9b9da1); font-size: 12px; }
.feedback { font-size: 12px; }
.scene-name { margin: 0; min-width: 0; overflow-wrap: anywhere; font-family: var(--bd-mono, ui-monospace, monospace); }
.error { color: #ff8d86; display: flex; align-items: center; gap: 6px; min-width: 0; }
.err-icon { flex: none; }
.err-text { overflow: hidden; text-overflow: ellipsis; }
.err-short { display: none; }
.empty-xs { display: none; margin: 0; text-align: center; color: var(--bd-mu, #9b9da1); font-size: 12px; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}

/* XS (<200px ≈ 1×1): héroe + 1-2 botones; sin refresh, formularios ni textos largos. */
@container smart-home (max-width: 199px) {
  .sh-body { gap: 3px; padding: 5px; }
  .icon-badge { display: none; }
  .control-heading { gap: 7px; }
  .control-heading strong { font-size: 12px; }
  .head-text .bd-marquee { display: none; }
  .only-m-plus { display: none !important; }
  .supporting-copy { display: none; }
  .button-row { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
  .button-row button:nth-child(n + 3) { display: none; }
  .button-row button { min-height: 38px; padding: 4px 3px; }
  .action-button { min-height: 38px; padding: 5px 6px; gap: 4px; font-size: 11px; }
  .action-button svg { flex: none; width: 15px; height: 15px; }
  .button-row .lbl { display: none; }
  .action-button .lbl { font-size: 11px; }
  .reading { flex-direction: column; align-items: stretch; gap: 0; padding: 5px 7px; }
  .reading span { font-size: 10px; }
  .reading strong { font-size: clamp(15px, 11cqi, 19px); }
  .err-text { display: none; }
  .err-short {
    display: inline;
    position: static; width: auto; height: auto; margin: 0;
    overflow: hidden; clip: auto; white-space: nowrap; text-overflow: ellipsis;
    font-size: 11px;
  }
  .empty-xs { display: block; }
  .lights-carousel :deep(.bd-carousel-dots) { display: none; }
  .scene-name { font-size: 12px; }
}

/* M (≥200px): héroe + acción principal + dots del carrusel. */
@container smart-home (min-width: 200px) {
  .err-short { display: none; }
}

/* Alturas cortas (2×1, 3×1…): compactar; sin sliders cuando no caben. */
@container smart-home (max-height: 270px) {
  .sh-body { gap: 6px; }
  .reading { padding: 6px 9px; }
  .field input[type="number"], .field select { min-height: 34px; padding: 5px 8px; }
  .button-row button, .action-button { min-height: 36px; }
}
@container smart-home (max-height: 200px) {
  .sh-body .field, .sh-body .supporting-copy { display: none; }
}

/* M estrecho (200–339px): botones compactos con texto. */
@container smart-home (max-width: 339px) {
  .button-row button { gap: 4px; padding: 7px 5px; font-size: 11px; }
}

/* L (≥340px): clima en 2 columnas, textos largos. */
@container smart-home (min-width: 340px) {
  .climate-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 7px; }
  .button-row button:nth-child(n + 3) { display: inline-flex; }
  .feedback { font-size: 12px; }
}

/* Alta (≥1×3 apilado): aire vertical. */
@container smart-home (max-aspect-ratio: 77/100) {
  .sh-body { justify-content: center; }
}

/* Ancha (botonera horizontal): héroe a la izquierda, acciones a la derecha. */
@container smart-home (min-aspect-ratio: 13/10) {
  .sh-body { gap: clamp(6px, 2cqi, 10px); }
}

@media (prefers-reduced-motion: reduce) {
  .smart-home * { animation: none; }
}
</style>
