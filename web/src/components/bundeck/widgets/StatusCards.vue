<template>
  <section class="card" :class="`kind-${kind}`" data-cy="widget-status-card">
    <header class="head">
      <span class="title"><component :is="icon" :size="16" aria-hidden="true" />{{ label || title }}</span>
      <button
        v-if="canRefresh"
        class="refresh"
        type="button"
        :aria-label="copy.refresh"
        :disabled="busy || readonly"
        @click="refresh"
      >
        <RefreshCw :size="14" :class="{ spin: busy }" aria-hidden="true" />
      </button>
    </header>

    <div v-if="busy && !loaded" class="state" role="status">
      <LoaderCircle class="spin" :size="18" aria-hidden="true" /> {{ copy.loading }}
    </div>
    <div v-else-if="error && !data" class="state error" role="alert">
      <p>{{ error }}</p>
      <button v-if="canRefresh" class="small-button" type="button" :disabled="busy || readonly" @click="refresh">{{ copy.tryAgain }}</button>
    </div>
    <template v-else>
      <div v-if="kind === 'pc'" class="content">
        <div v-if="data?.monitored === false" class="unavailable">
          <CircleOff :size="19" aria-hidden="true" />
          <span>{{ data?.reason || copy.unavailable }}</span>
        </div>
        <template v-else>
          <div v-if="isSummary" class="metrics">
            <Metric v-for="item in summaryMetrics" :key="item.name" :name="item.name" :value="item.value" :unit="item.unit" />
          </div>
          <div v-else-if="isMonitor" class="hero-metric">
            <strong>{{ display(data?.value, data?.unit) }}</strong><span>{{ data?.component || copy.metric }} {{ data?.metric || '' }}</span>
          </div>
          <div v-else-if="suffix === 'fan-speed'" class="list">
            <div v-for="fan in data?.fans || []" :key="fan.name"><span>{{ fan.name || copy.fan }}</span><b>{{ display(fan.value, fan.unit || 'RPM') }}</b></div>
            <p v-if="!data?.fans?.length" class="muted">{{ copy.noFans }}</p>
          </div>
          <div v-else-if="suffix === 'disk-usage'" class="disk">
            <div class="disk-label"><b>{{ display(data?.value, '%') }}</b><span>{{ data?.path || copy.disk }}</span></div>
            <div class="bar" role="meter" :aria-valuenow="number(data?.value)" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${clampPercent(data?.value)}%` }" /></div>
            <small>{{ data?.usedGB ?? '—' }} / {{ data?.totalGB ?? '—' }} GB {{ copy.used }}</small>
          </div>
          <div v-else-if="suffix === 'net-speed'" class="network">
            <strong>{{ display(data?.value, data?.unit || 'KB/s') }}</strong>
            <span>↓ {{ display(data?.downKBs, 'KB/s') }} &nbsp; ↑ {{ display(data?.upKBs, 'KB/s') }}</span>
          </div>
          <div v-else-if="suffix === 'uptime'" class="hero-metric">
            <strong>{{ data?.human || '—' }}</strong><span>{{ copy.systemUptime }}</span>
          </div>
          <div v-else-if="suffix === 'process-top'" class="list process-list">
            <div v-for="(proc, index) in data?.processes || []" :key="proc.pid || proc.name || index"><span>{{ proc.name || proc.raw || 'Process' }}</span><b>{{ proc.cpu != null ? `${proc.cpu}%` : proc.memory || '—' }}</b></div>
            <p v-if="!data?.processes?.length" class="muted">{{ copy.noProcesses }}</p>
          </div>
        </template>
      </div>

      <div v-else-if="kind === 'weather'" class="content">
        <template v-if="suffix === 'forecast'">
          <p v-if="data?.place" class="subheading">{{ data.place }}</p>
          <div class="forecast">
            <div v-for="day in data?.daysForecast || []" :key="day.date" class="forecast-row">
              <span>{{ formatDay(day.date) }}</span><span>{{ weatherCondition(day.condition) }}</span>
              <b>{{ display(day.max, data?.unit) }} <small>/ {{ display(day.min, data?.unit) }}</small></b>
            </div>
            <p v-if="!data?.daysForecast?.length" class="muted">{{ copy.noForecast }}</p>
          </div>
        </template>
        <template v-else>
          <div class="weather-now">
            <strong>{{ display(data?.temperature, data?.unit) }}</strong>
            <div><b>{{ data?.condition ? weatherCondition(data.condition, data.weatherCode) : copy.noConditions }}</b><span>{{ data?.place || copy.currentConditions }}</span></div>
          </div>
          <div class="weather-meta">
            <span><Droplets :size="13" aria-hidden="true" /> {{ data?.humidity ?? '—' }}%</span>
            <span><Wind :size="13" aria-hidden="true" /> {{ data?.windKmh ?? '—' }} km/h</span>
          </div>
        </template>
      </div>

      <div v-else-if="kind === 'email'" class="content">
        <template v-if="suffix === 'open-inbox'">
          <div class="camera-state"><Inbox :size="22" aria-hidden="true" /><span>{{ copy.openYourInbox }}</span></div>
          <button class="action-button" type="button" :disabled="busy || readonly" @click="openInbox">
            <ExternalLink :size="15" aria-hidden="true" /> {{ copy.openInbox }}
          </button>
        </template>
        <template v-else>
          <div class="count"><strong>{{ data?.count ?? '—' }}</strong><span>{{ copy.unread }}</span></div>
          <button v-if="loaded && !error" class="action-button" type="button" :disabled="busy || readonly" @click="openInbox">
            <Inbox :size="15" aria-hidden="true" /> {{ copy.openInbox }}
          </button>
        </template>
      </div>

      <div v-else-if="kind === 'slack'" class="content">
        <template v-if="suffix === 'open-channel'">
          <p class="channel-name"># {{ parameters.channel || parameters.name || copy.chooseChannel }}</p>
          <button v-if="parameters.channel" class="action-button" type="button" :disabled="busy || readonly" @click="openChannel(parameters.channel)">
            <ExternalLink :size="15" aria-hidden="true" /> {{ copy.openChannel }}
          </button>
        </template>
        <template v-else-if="suffix === 'open-dm'">
          <p class="channel-name">{{ parameters.user || copy.chooseUser }}</p>
          <button v-if="parameters.user" class="action-button" type="button" :disabled="busy || readonly" @click="openDm(parameters.user)">
            <ExternalLink :size="15" aria-hidden="true" /> {{ copy.openDm }}
          </button>
        </template>
        <template v-else>
          <div class="count"><strong>{{ data?.total ?? '—' }}</strong><span>{{ copy.unreadMessages }}</span></div>
          <div v-if="data?.conversations?.length" class="list channel-list">
            <button v-for="channel in data.conversations.slice(0, 3)" :key="channel.id" type="button" :disabled="busy || readonly" @click="openChannel(channel.id)">
              <span># {{ channel.name }}</span><b>{{ channel.unread }}</b>
            </button>
          </div>
        </template>
      </div>

      <div v-else-if="kind === 'minecraft'" class="content">
        <div class="server-state" :class="{ online: data?.online }">
          <i aria-hidden="true" /><strong>{{ data?.online ? copy.online : data?.online === false ? copy.offline : copy.unknown }}</strong>
        </div>
        <template v-if="suffix === 'server-status'">
          <div class="server-meta"><span>{{ data?.host || parameters.host }}</span><b v-if="data?.players">{{ data.players.online ?? 0 }} / {{ data.players.max ?? '?' }} {{ copy.players }}</b></div>
          <p v-if="data?.version" class="muted">Minecraft {{ data.version }}</p>
          <p v-if="data?.motd" class="motd">{{ data.motd }}</p>
        </template>
        <div v-else class="latency"><strong>{{ data?.latencyMs ?? '—' }}</strong><span>{{ copy.apiResponse }}</span></div>
      </div>

      <div v-else-if="kind === 'steam'" class="content">
        <template v-if="suffix === 'presence'">
          <div class="unavailable"><UsersRound :size="20" aria-hidden="true" /><span>{{ copy.presenceUnavailable }}</span></div>
        </template>
        <template v-else>
          <div class="steam-name"><strong>{{ data?.name || copy.steamApp }}</strong><span>{{ data?.price || (data?.isFree ? copy.free : copy.storeListing) }}</span></div>
          <p v-if="data?.shortDescription" class="muted description">{{ data.shortDescription }}</p>
          <button v-if="parameters.appId" class="action-button" type="button" :disabled="busy || readonly" @click="launchGame">
            <Play :size="15" aria-hidden="true" /> {{ copy.openSteam }}
          </button>
        </template>
      </div>

      <div v-else-if="kind === 'webcam'" class="content webcam-content">
        <div class="camera-state"><Camera :size="23" aria-hidden="true" /><span>{{ data?.saved ? copy.snapshotCaptured : copy.cameraSnapshot }}</span></div>
        <p v-if="data?.saved" class="muted">{{ copy.photoSaved }}</p>
        <button class="action-button" type="button" :disabled="busy || readonly" @click="takeSnapshot">
          <Camera :size="15" aria-hidden="true" /> {{ data?.saved ? copy.takeAnother : copy.capturePhoto }}
        </button>
      </div>

      <div v-else class="content unavailable">
        <CircleOff :size="20" aria-hidden="true" /><span>{{ data?.note || copy.noStatus }}</span>
      </div>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, onUnmounted, ref } from 'vue'
import {
  Activity, Bell, Camera, CircleOff, CloudSun, Cpu, Droplets, ExternalLink, Inbox, LoaderCircle,
  Mail, Monitor, Play, RefreshCw, Server, UsersRound, Wind,
} from 'lucide-vue-next'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import { useI18nStore } from '../../../composables/useI18n'

type WidgetAction = { type: string; parameters: Record<string, any> }
const props = defineProps<{
  action: WidgetAction
  apiBase: string
  label?: string
  readonly?: boolean
}>()
const { currentLocale } = useI18nStore()
const spanish = computed(() => String(currentLocale.value || 'es').toLowerCase().startsWith('es'))
const copy = computed(() => spanish.value
  ? {
      refresh: 'Actualizar estado', loading: 'Cargando estado…', tryAgain: 'Reintentar', metric: 'Métrica',
      unavailable: 'Métrica no disponible en este sistema', noFans: 'No se encontraron sensores de ventilador', fan: 'Ventilador',
      used: 'usados', systemUptime: 'Tiempo activo del sistema', noProcesses: 'No hay datos de procesos',
      noForecast: 'No hay datos del pronóstico', noConditions: 'Condiciones no disponibles',
      currentConditions: 'Condiciones actuales', openYourInbox: 'Abrir tu bandeja', openInbox: 'Abrir bandeja',
      unread: 'sin leer', unreadMessages: 'mensajes sin leer', chooseChannel: 'Elige un canal en los ajustes de la acción',
      openChannel: 'Abrir canal', chooseUser: 'Elige un usuario de Slack en los ajustes', openDm: 'Abrir mensaje directo',
      online: 'En línea', offline: 'Sin conexión', unknown: 'Desconocido', players: 'jugadores',
      apiResponse: 'ms de respuesta de API', presenceUnavailable: 'La presencia no está disponible sin credenciales de Steam Web API.',
      steamApp: 'Aplicación de Steam', free: 'Gratis', storeListing: 'Ficha de la tienda', openSteam: 'Abrir en Steam',
      snapshotCaptured: 'Foto capturada', cameraSnapshot: 'Foto de cámara', photoSaved: 'Foto guardada correctamente.',
      takeAnother: 'Tomar otra', capturePhoto: 'Capturar foto', noStatus: 'No hay datos de estado',
      cpu: 'CPU', ram: 'RAM', gpu: 'GPU', disk: 'Disco', uptime: 'Tiempo activo',
    }
  : {
      refresh: 'Refresh status', loading: 'Loading status…', tryAgain: 'Try again', metric: 'Metric',
      unavailable: 'Metric unavailable on this system', noFans: 'No fan sensors found', fan: 'Fan',
      used: 'used', systemUptime: 'System uptime', noProcesses: 'No process data',
      noForecast: 'No forecast data', noConditions: 'Conditions unavailable',
      currentConditions: 'Current conditions', openYourInbox: 'Open your inbox', openInbox: 'Open inbox',
      unread: 'unread', unreadMessages: 'unread messages', chooseChannel: 'Choose a channel in action settings',
      openChannel: 'Open channel', chooseUser: 'Choose a Slack user in action settings', openDm: 'Open direct message',
      online: 'Online', offline: 'Offline', unknown: 'Unknown', players: 'players',
      apiResponse: 'ms API response', presenceUnavailable: 'Presence is not available without Steam Web API credentials.',
      steamApp: 'Steam app', free: 'Free to play', storeListing: 'Store listing', openSteam: 'Open in Steam',
      snapshotCaptured: 'Snapshot captured', cameraSnapshot: 'Camera snapshot', photoSaved: 'Photo saved successfully.',
      takeAnother: 'Take another', capturePhoto: 'Capture photo', noStatus: 'No status data available',
      cpu: 'CPU', ram: 'RAM', gpu: 'GPU', disk: 'Disk', uptime: 'Uptime',
    })

const suffix = computed(() => props.action.type.split('.').pop() || props.action.type)
const plugin = computed(() => props.action.type.split('.')[0] || '')
const parameters = computed(() => props.action.parameters || {})
const busy = ref(false)
const loaded = ref(false)
const data = ref<any>(null)
const error = ref('')
let pollTimer: ReturnType<typeof setInterval> | undefined

const kind = computed(() => {
  if (plugin.value === 'pc-vitals') return 'pc'
  if (plugin.value === 'weather') return 'weather'
  if (plugin.value === 'email') return 'email'
  if (plugin.value === 'slack') return 'slack'
  if (plugin.value === 'minecraft') return 'minecraft'
  if (plugin.value === 'steam') return 'steam'
  if (plugin.value === 'webcam') return 'webcam'
  return 'unknown'
})
const title = computed(() => ({
  pc: spanish.value ? 'Estado del PC' : 'PC status',
  weather: spanish.value ? 'El tiempo' : 'Weather',
  email: spanish.value ? 'Correo' : 'Email',
  slack: 'Slack',
  minecraft: spanish.value ? 'Servidor de Minecraft' : 'Minecraft server',
  steam: 'Steam',
  webcam: spanish.value ? 'Cámara web' : 'Webcam',
  unknown: spanish.value ? 'Estado' : 'Status',
}[kind.value] || (spanish.value ? 'Estado' : 'Status')))
const icon = computed(() => ({
  pc: Cpu, weather: CloudSun, email: Mail, slack: Bell, minecraft: Server,
  steam: Monitor, webcam: Camera, unknown: Activity,
}[kind.value] || Activity))
const isSummary = computed(() => suffix.value === 'summary')
const isMonitor = computed(() => suffix.value === 'monitor')
const sideEffectOnly = computed(() =>
  kind.value === 'webcam' ||
  (kind.value === 'email' && suffix.value === 'open-inbox') ||
  (kind.value === 'slack' && ['open-channel', 'open-dm'].includes(suffix.value)),
)
const canRefresh = computed(() => !sideEffectOnly.value)
const summaryMetrics = computed(() => {
  const d = data.value
  return [
    { name: copy.value.cpu, value: d?.cpu, unit: '%' },
    { name: copy.value.ram, value: d?.ram, unit: '%' },
    { name: copy.value.gpu, value: d?.gpu?.usage, unit: '%' },
    { name: copy.value.disk, value: d?.disk?.value, unit: '%' },
    { name: copy.value.uptime, value: d?.uptime?.human, unit: '' },
  ].filter(item => item.value !== null && item.value !== undefined)
})

// The values match each source action's manifest pollMs where one exists.
const pollMs = computed(() => {
  if (plugin.value === 'calendar') return 60_000
  if (plugin.value === 'pc-vitals') {
    if (suffix.value === 'summary') return 5_000
    if (suffix.value === 'monitor') return Math.max(2_000, Number(parameters.value.updateInterval) || 2_000)
    return suffix.value === 'net-speed' ? 60_000 : 30_000
  }
  if (plugin.value === 'weather') return 600_000
  if (plugin.value === 'email') return 300_000
  if (plugin.value === 'slack') return 120_000
  if (plugin.value === 'minecraft') return 120_000
  if (plugin.value === 'steam') return suffix.value === 'presence' ? 0 : 300_000
  return 0
})

function actionType(name: string) { return `${plugin.value}.${name}` }
function number(value: unknown) { const n = Number(value); return Number.isFinite(n) ? n : 0 }
function clampPercent(value: unknown) { return Math.min(100, Math.max(0, number(value))) }
function display(value: unknown, unit = '') {
  if (value === null || value === undefined || value === '') return '—'
  return `${typeof value === 'number' ? Math.round(value * 10) / 10 : value}${unit}`
}
function formatDay(value: string) {
  const date = new Date(`${value}T12:00:00`)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(spanish.value ? 'es' : 'en', { weekday: 'short' }).format(date)
}
function weatherCondition(value: string, code?: number) {
  if (spanish.value) return value
  const byCode: Record<number, string> = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Light freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain',
    65: 'Heavy rain', 66: 'Light freezing rain', 67: 'Freezing rain', 71: 'Light snow',
    73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers',
    82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm',
    96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
  }
  if (typeof code === 'number' && byCode[code]) return byCode[code]
  const labels: Record<string, string> = {
    Despejado: 'Clear', 'Casi despejado': 'Mostly clear', 'Parcialmente nublado': 'Partly cloudy',
    Cubierto: 'Overcast', Niebla: 'Fog', 'Niebla con escarcha': 'Rime fog',
    'Llovizna ligera': 'Light drizzle', Llovizna: 'Drizzle', 'Llovizna intensa': 'Heavy drizzle',
    'Llovizna helada ligera': 'Light freezing drizzle', 'Llovizna helada': 'Freezing drizzle',
    'Lluvia ligera': 'Light rain', Lluvia: 'Rain', 'Lluvia intensa': 'Heavy rain',
    'Lluvia helada ligera': 'Light freezing rain', 'Lluvia helada': 'Freezing rain',
    'Nieve ligera': 'Light snow', Nieve: 'Snow', 'Nieve intensa': 'Heavy snow',
    'Granizo menudo': 'Snow grains', 'Chubascos ligeros': 'Light showers', Chubascos: 'Showers',
    'Chubascos violentos': 'Heavy showers', 'Chubascos de nieve': 'Snow showers',
    'Chubascos de nieve intensos': 'Heavy snow showers', Tormenta: 'Thunderstorm',
    'Tormenta con granizo': 'Thunderstorm with hail', 'Tormenta fuerte con granizo': 'Severe thunderstorm with hail',
  }
  return labels[value] || value
}
function safeParams(exclude: string[] = []) {
  const omitted = new Set(['token', 'apiKey', 'googleApiKey', ...exclude])
  return Object.fromEntries(Object.entries(parameters.value).filter(([key]) => !omitted.has(key)))
}

function unwrapActionResult(response: any) {
  if (response?.success === false) {
    throw new Error(response.error || (spanish.value ? 'La acción no se pudo completar.' : 'The action could not be completed.'))
  }
  return response?.result ?? response?.data ?? response
}

async function refresh() {
  if (busy.value || !canRefresh.value) return
  busy.value = true
  error.value = ''
  try {
    data.value = unwrapActionResult(
      await executeWidgetAction(props.apiBase, props.action.type, parameters.value),
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : (spanish.value ? 'No se pudo cargar el estado.' : 'Status could not be loaded.')
  } finally {
    loaded.value = true
    busy.value = false
  }
}
async function runAction(type: string, params: Record<string, any> = {}) {
  if (busy.value || props.readonly) return
  busy.value = true
  error.value = ''
  try {
    data.value = unwrapActionResult(await executeWidgetAction(props.apiBase, type, params))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : (spanish.value ? 'No se pudo completar la acción.' : 'Action could not be completed.')
  } finally {
    loaded.value = true
    busy.value = false
  }
}
function openInbox() {
  void runAction(actionType('open-inbox'), { provider: parameters.value.provider, url: parameters.value.inboxUrl })
}
function openChannel(channel: string) {
  void runAction(actionType('open-channel'), { channel })
}
function openDm(user: string) {
  void runAction(actionType('open-dm'), { user })
}
function takeSnapshot() { void runAction(actionType('snapshot'), safeParams()) }
function launchGame() { void runAction(actionType('launch-game'), { appId: parameters.value.appId }) }

const Metric = defineComponent({
  props: { name: String, value: [String, Number], unit: String },
  setup(p) {
    return () => h('div', { class: 'metric' }, [
      h('span', p.name),
      h('b', p.value == null ? '—' : `${typeof p.value === 'number' ? Math.round(p.value) : p.value}${p.unit || ''}`),
    ])
  },
})

onMounted(() => {
  // Commands that would cause a side effect are always explicit.
  if (sideEffectOnly.value) {
    loaded.value = true
    return
  }
  void refresh()
  if (pollMs.value > 0) pollTimer = setInterval(() => void refresh(), pollMs.value)
})
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<style scoped>
.card { box-sizing: border-box; display: flex; flex-direction: column; gap: clamp(8px, 3cqi, 13px); width: 100%; height: 100%; min-width: 0; padding: clamp(11px, 4cqi, 17px); overflow: hidden; color: var(--bd-ink, #ece8df); background: var(--bd-sf, #191a1d); border: 1px solid var(--bd-ln, #34363b); border-radius: var(--bd-rk, 14px); container-type: inline-size; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 20px; }
.title { display: inline-flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; color: var(--bd-mu, #999da5); font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.refresh { display: grid; flex: 0 0 auto; width: 30px; height: 30px; place-items: center; color: var(--bd-mu, #999da5); background: transparent; border: 1px solid transparent; border-radius: 8px; cursor: pointer; }
.refresh:hover:not(:disabled) { color: var(--bd-ink, #ece8df); border-color: var(--bd-ln, #34363b); }
button:focus-visible { outline: 2px solid var(--bd-ac, #e4b85e); outline-offset: 2px; }
button:disabled { opacity: .5; cursor: not-allowed; }
.content { display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 10px; min-height: 0; overflow: hidden; }
.state { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 0; color: var(--bd-mu, #999da5); text-align: center; font-size: 12px; }
.state p { max-width: 100%; margin: 0; overflow-wrap: anywhere; }
.error, .inline-error { color: var(--bd-danger, #e56b6f); }
.small-button, .action-button { display: inline-flex; align-items: center; justify-content: center; align-self: flex-start; gap: 7px; min-height: 32px; padding: 0 11px; color: var(--bd-ink, #ece8df); background: transparent; border: 1px solid var(--bd-ln, #34363b); border-radius: 8px; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
.small-button:hover:not(:disabled), .action-button:hover:not(:disabled) { border-color: var(--bd-ac, #e4b85e); }
.inline-error { margin: 0; overflow: hidden; font-size: 11px; text-overflow: ellipsis; }
.metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.metric { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; padding: 8px; background: color-mix(in srgb, var(--bd-bg, #111214) 55%, transparent); border: 1px solid var(--bd-ln, #34363b); border-radius: 8px; }
.metric span { overflow: hidden; color: var(--bd-mu, #999da5); font-size: 10px; text-overflow: ellipsis; }
.metric b { font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.hero-metric, .network, .latency { display: flex; flex-direction: column; gap: 4px; }
.hero-metric strong, .network strong, .latency strong { font-size: clamp(24px, 12cqi, 42px); line-height: 1; font-variant-numeric: tabular-nums; }
.hero-metric span, .network span, .latency span { color: var(--bd-mu, #999da5); font-size: 11px; }
.list { display: flex; flex-direction: column; gap: 5px; min-height: 0; overflow: auto; }
.list > div, .channel-list button { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; padding: 6px 8px; color: var(--bd-ink, #ece8df); background: color-mix(in srgb, var(--bd-bg, #111214) 55%, transparent); border: 1px solid var(--bd-ln, #34363b); border-radius: 7px; font-size: 11px; text-align: left; }
.list > div span, .channel-list button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channel-list button { cursor: pointer; }
.channel-list button:hover:not(:disabled) { border-color: var(--bd-ac, #e4b85e); }
.muted, .subheading { margin: 0; color: var(--bd-mu, #999da5); font-size: 11px; }
.disk { display: flex; flex-direction: column; gap: 8px; }
.disk-label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.disk-label b { font-size: clamp(24px, 12cqi, 40px); font-variant-numeric: tabular-nums; }
.disk-label span, .disk small { color: var(--bd-mu, #999da5); font-size: 11px; }
.bar { height: 7px; overflow: hidden; background: var(--bd-ln, #34363b); border-radius: 9px; }
.bar i { display: block; height: 100%; background: var(--bd-ac, #e4b85e); border-radius: inherit; }
.network > span { font-variant-numeric: tabular-nums; }
.weather-now { display: flex; align-items: center; gap: 12px; min-width: 0; }
.weather-now > strong { font-size: clamp(30px, 15cqi, 48px); line-height: 1; letter-spacing: -.06em; white-space: nowrap; }
.weather-now > div, .steam-name { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.weather-now b, .steam-name strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.weather-now span, .steam-name span { overflow: hidden; color: var(--bd-mu, #999da5); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.weather-meta { display: flex; gap: 14px; color: var(--bd-mu, #999da5); font-size: 11px; }
.weather-meta span { display: inline-flex; align-items: center; gap: 4px; }
.forecast { display: flex; flex-direction: column; gap: 5px; min-height: 0; overflow: auto; }
.forecast-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 6px 0; border-bottom: 1px solid var(--bd-ln, #34363b); font-size: 10px; }
.forecast-row > span:nth-child(2) { overflow: hidden; color: var(--bd-mu, #999da5); text-overflow: ellipsis; white-space: nowrap; }
.forecast-row b { white-space: nowrap; }
.forecast-row small { color: var(--bd-mu, #999da5); font-size: inherit; font-weight: 500; }
.count { display: flex; align-items: baseline; gap: 8px; }
.count strong { font-size: clamp(30px, 16cqi, 52px); line-height: 1; font-variant-numeric: tabular-nums; }
.count span { color: var(--bd-mu, #999da5); font-size: 12px; }
.channel-name { margin: 0; font-size: 18px; font-weight: 650; }
.server-state { display: flex; align-items: center; gap: 8px; font-size: 17px; }
.server-state i { width: 9px; height: 9px; background: var(--bd-danger, #e56b6f); border-radius: 50%; }
.server-state.online i { background: var(--bd-ok, #69b982); }
.server-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--bd-mu, #999da5); font-size: 11px; }
.server-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.motd { display: -webkit-box; margin: 0; overflow: hidden; font-size: 11px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.unavailable { display: flex; align-items: center; gap: 9px; color: var(--bd-mu, #999da5); font-size: 11px; line-height: 1.4; }
.unavailable span { overflow-wrap: anywhere; }
.description { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.camera-state { display: flex; align-items: center; gap: 10px; color: var(--bd-ac, #e4b85e); font-size: 15px; font-weight: 650; }
.webcam-content .action-button { margin-top: 2px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 360px) { .metrics { gap: 4px; } .metric { padding: 6px; } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
