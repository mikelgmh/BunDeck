<template>
  <section class="voice-panel" :class="`mode-${mode}`" :aria-label="label || panelTitle" data-cy="voice-panel">
    <NeedsConfig v-if="!isConfigured" :action-type="props.action.type" :position="position" />
    <div class="voice-main">
    <header class="voice-head">
      <div>
        <span class="eyebrow">{{ panelKicker }}</span>
        <strong>{{ panelTitle }}</strong>
      </div>
      <button v-if="mode === 'discord' || mode === 'voicemod'" class="icon-button m-refresh" type="button" :aria-label="copy.refreshStatus" :title="copy.refreshStatus" :disabled="busy || readonly" @click="refreshStatus">
        <RefreshCw :size="15" aria-hidden="true" />
      </button>
    </header>

    <template v-if="mode === 'discord'">
      <div class="connection-line" :data-status="discordStatus">
        <span class="status-dot" aria-hidden="true"></span>
        <Marquee :text="discordStatusLabel" />
      </div>
      <div class="control-grid discord-controls">
        <button class="voice-control hero-control" type="button" :disabled="disabled" :aria-label="muteLabel" :aria-pressed="typeof discordMute === 'boolean' ? discordMute : undefined" @click="execute('discord.toggle-mute', params)">
          <component :is="discordMute ? MicOff : Mic" :size="18" aria-hidden="true" />
          <span class="bd-data-swap" :key="muteLabel">{{ muteLabel }}</span>
        </button>
        <button class="voice-control m-extra" type="button" :disabled="disabled" :aria-pressed="typeof discordDeaf === 'boolean' ? discordDeaf : undefined" :aria-label="discordDeaf ? copy.undeafen : copy.deafen" @click="execute('discord.toggle-deafen', params)">
          <Headphones :size="18" aria-hidden="true" />
          <span>{{ discordDeaf ? copy.undeafen : copy.deafen }}</span>
        </button>
        <button
          class="voice-control ptt-control"
          type="button"
          :disabled="readonly"
          :aria-pressed="pttHeld"
          :aria-label="copy.pushToTalkHelp"
          @pointerdown="beginPtt"
          @pointerup="endPtt"
          @pointercancel="endPtt"
          @lostpointercapture="endPtt"
          @keydown="pttKeyDown"
          @keyup="pttKeyUp"
          @blur="endPtt"
        >
          <Radio v-if="!pttHeld" :size="18" aria-hidden="true" />
          <Mic v-else :size="18" aria-hidden="true" />
          <span>{{ pttHeld ? copy.speaking : copy.holdToTalk }}</span>
        </button>
      </div>
      <p v-if="discordStatus === 'hotkey'" class="neutral-note">{{ copy.hotkeyUnknown }}</p>
      <p v-else-if="discordStatus === 'unknown'" class="neutral-note">{{ copy.discordUnknown }}</p>
    </template>

    <template v-else-if="mode === 'meetings'">
      <div class="context-chip"><Video :size="14" aria-hidden="true" /><span class="chip-label">{{ appLabel }}</span></div>
      <!-- XS: 2 comandos por página con carrusel; M+: parrilla completa. -->
      <div class="xs-pages" data-cy="voice-xs-pages">
        <AutoCarousel :count="meetingPages.length" :interval-ms="carouselMs" :show-dots="false" v-slot="{ index }">
          <div class="control-grid meeting-controls xs-grid">
            <button v-for="control in meetingPages[index]" :key="control.command" class="voice-control" type="button" :disabled="disabled || !isConfigured" :aria-label="control.label" :title="control.label" @click="runMeetingCommand(control.command)">
              <component :is="control.icon" :size="17" aria-hidden="true" />
            </button>
          </div>
        </AutoCarousel>
      </div>
      <div ref="meetGridEl" class="control-grid meeting-controls m-grid">
        <button v-for="control in meetingControls" :key="control.command" class="voice-control" type="button" data-page-item :disabled="disabled || !isConfigured" @click="runMeetingCommand(control.command)">
          <component :is="control.icon" :size="17" aria-hidden="true" />
          <span>{{ control.label }}</span>
        </button>
      </div>
      <div v-if="meetPager.numPages.value > 1" class="voice-pager fit-pager" role="tablist" :aria-label="copy.meetingUnknown">
        <button
          v-for="i in meetPager.numPages.value"
          :key="i"
          type="button"
          role="tab"
          class="pager-dot"
          :class="{ 'is-active': meetPager.index.value === i - 1 }"
          :aria-selected="meetPager.index.value === i - 1"
          :aria-label="`${i}/${meetPager.numPages.value}`"
          @click.stop="meetPager.goTo(i - 1)"
        />
        <small>{{ meetPager.index.value + 1 }}/{{ meetPager.numPages.value }}</small>
      </div>
      <p class="neutral-note">{{ copy.meetingUnknown }}</p>
    </template>

    <template v-else-if="mode === 'voicemod'">
      <div class="connection-line" :data-status="voicemodConnected === true ? 'connected' : voicemodConnected === false ? 'offline' : 'unknown'">
        <span class="status-dot" aria-hidden="true"></span>
        <Marquee :text="voicemodConnected === true ? voiceName || copy.voicemodConnected : voicemodConnected === false ? copy.voicemodUnavailable : copy.checkingVoicemod" />
      </div>
      <div class="control-grid voicemod-controls">
        <button class="voice-control hero-control" type="button" :disabled="disabled" :aria-label="voicemodMuted === true ? copy.unmute : copy.mute" :aria-pressed="typeof voicemodMuted === 'boolean' ? voicemodMuted : undefined" @click="execute('voicemod.mute', { ...params, muted: voicemodMuted !== true })">
          <component :is="voicemodMuted ? MicOff : Mic" :size="18" aria-hidden="true" />
          <span class="bd-data-swap" :key="String(voicemodMuted ?? '')">{{ voicemodMuted === true ? copy.unmute : copy.mute }}</span>
        </button>
        <button class="voice-control m-extra" type="button" :disabled="disabled" :aria-label="copy.enableEffect" :title="copy.enableEffect" @click="execute('voicemod.toggle-effect', { ...params, enabled: true })">
          <AudioLines :size="18" aria-hidden="true" />
          <span>{{ copy.enableEffect }}</span>
        </button>
        <button class="voice-control m-extra" type="button" :disabled="disabled" :aria-label="copy.disableEffect" :title="copy.disableEffect" @click="execute('voicemod.toggle-effect', { ...params, enabled: false })">
          <CircleOff :size="18" aria-hidden="true" />
          <span>{{ copy.disableEffect }}</span>
        </button>
      </div>
      <form class="voice-id-form m-form" @submit.prevent="setVoice">
        <input v-model="voiceIdInput" type="text" :aria-label="copy.voiceId" :placeholder="copy.voiceId" :disabled="readonly" />
        <button class="voice-control" type="submit" :disabled="disabled || !voiceIdInput.trim()">
          <WandSparkles :size="16" aria-hidden="true" /><span>{{ copy.setVoice }}</span>
        </button>
      </form>
    </template>

    <template v-else>
      <div class="context-chip"><VolumeX :size="14" aria-hidden="true" /><span class="chip-label">{{ mode === 'voicemeeter-bus' ? (params.bus || copy.outputBus) : `${copy.strip} ${params.strip ?? ''}` }}</span></div>
      <button class="voice-control single-control" type="button" :disabled="disabled" @click="execute(action.type, params)">
        <MicOff :size="19" aria-hidden="true" />
        <span>{{ copy.sendMuteHotkey }}</span>
      </button>
      <p class="neutral-note">{{ copy.voicemeeterUnknown }}</p>
    </template>

    <p v-if="error" class="widget-error" role="alert" :title="error">
      <TriangleAlert :size="13" aria-hidden="true" /><span class="err-text">{{ error }}</span><span class="sr-only">{{ copy.sendFailed }}</span>
    </p>
    <span v-if="busy" class="sr-status" role="status">{{ copy.sending }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  AudioLines, CircleOff, Headphones, Mic, MicOff, Radio, RefreshCw, TriangleAlert, Video, VolumeX, WandSparkles,
  Camera, MessageSquare, MonitorUp, PhoneOff, Hand, CircleDot,
} from 'lucide-vue-next'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import { useI18nStore } from '../../../composables/useI18n'
import { resolveCarouselMs } from '../../../composables/useAutoCarousel'
import { useFitPager } from '../../../composables/useFitPager'
import AutoCarousel from './shared/AutoCarousel.vue'
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
const spanish = computed(() => currentLocale.value.toLowerCase().startsWith('es'))
const copy = computed(() => {
  const en = {
    refreshStatus: 'Refresh voice status', deafen: 'Deafen', undeafen: 'Undeafen',
    pushToTalkHelp: 'Push to talk; hold pointer or Space or Enter', speaking: 'Speaking…', holdToTalk: 'Hold to talk',
    hotkeyUnknown: 'Hotkey mode · current mute state cannot be confirmed.',
    discordUnknown: 'Voice state is unknown until Discord RPC responds.',
    meetingUnknown: 'Commands are sent as hotkeys. Meeting state is not reported.',
    voicemodConnected: 'Voicemod connected', voicemodUnavailable: 'Voicemod unavailable', checkingVoicemod: 'Checking Voicemod…',
    mute: 'Mute', unmute: 'Unmute', enableEffect: 'Enable effect', disableEffect: 'Disable effect',
    voiceId: 'Voice ID', setVoice: 'Set voice', outputBus: 'Output bus', strip: 'Strip',
    sendMuteHotkey: 'Send mute hotkey', voicemeeterUnknown: 'Macro Buttons hotkey · mute state cannot be confirmed.',
    sending: 'Sending voice command', sendFailed: 'Voice command failed.',
    discordKicker: 'DISCORD VOICE', meetingKicker: 'MEETING CONTROLS', voicemodKicker: 'VOICE FX', macroKicker: 'MACRO BUTTONS',
    discordTitle: 'Voice controls', meetingTitle: 'Meeting controls', voicemodTitle: 'Voicemod',
    stripTitle: 'VoiceMeeter strip', busTitle: 'VoiceMeeter bus',
    connected: 'Discord RPC connected', offline: 'Discord not reachable', hotkey: 'Hotkey fallback', unknown: 'Voice state unknown',
    toggleMic: 'Toggle mic', muteMic: 'Mute mic', unmuteMic: 'Unmute mic',
    camera: 'Camera', share: 'Share', raiseHand: 'Raise hand', chat: 'Chat', leave: 'Leave', record: 'Record',
    zoom: 'Zoom', teams: 'Microsoft Teams', meet: 'Google Meet',
  }
  const es = {
    refreshStatus: 'Actualizar estado de voz', deafen: 'Ensordecer', undeafen: 'Dejar de ensordecer',
    pushToTalkHelp: 'Pulsar para hablar; mantén el puntero o usa Espacio o Intro', speaking: 'Hablando…', holdToTalk: 'Mantén para hablar',
    hotkeyUnknown: 'Modo atajos · no se puede confirmar el estado del micrófono.',
    discordUnknown: 'Estado de voz desconocido hasta que responda Discord RPC.',
    meetingUnknown: 'Se envían atajos; la reunión no informa de su estado.',
    voicemodConnected: 'Voicemod conectado', voicemodUnavailable: 'Voicemod no disponible', checkingVoicemod: 'Comprobando Voicemod…',
    mute: 'Silenciar', unmute: 'Activar micro', enableEffect: 'Activar efecto', disableEffect: 'Desactivar efecto',
    voiceId: 'ID de voz', setVoice: 'Aplicar voz', outputBus: 'Bus de salida', strip: 'Strip',
    sendMuteHotkey: 'Enviar atajo de mute', voicemeeterUnknown: 'Atajo de Macro Buttons · no se puede confirmar el estado de mute.',
    sending: 'Enviando comando de voz', sendFailed: 'El comando de voz falló.',
    discordKicker: 'VOZ DE DISCORD', meetingKicker: 'CONTROLES DE REUNIÓN', voicemodKicker: 'EFECTOS DE VOZ', macroKicker: 'ATAJOS DE MACRO',
    discordTitle: 'Controles de voz', meetingTitle: 'Controles de reunión', voicemodTitle: 'Voicemod',
    stripTitle: 'VoiceMeeter · strip', busTitle: 'VoiceMeeter · bus',
    connected: 'Discord RPC conectado', offline: 'Discord no disponible', hotkey: 'Atajos de teclado', unknown: 'Estado de voz desconocido',
    toggleMic: 'Alternar micro', muteMic: 'Silenciar micro', unmuteMic: 'Activar micro',
    camera: 'Cámara', share: 'Compartir', raiseHand: 'Levantar mano', chat: 'Chat', leave: 'Salir', record: 'Grabar',
    zoom: 'Zoom', teams: 'Microsoft Teams', meet: 'Google Meet',
  }
  return spanish.value ? es : en
})
const params = computed(() => props.action.parameters ?? {})
const actionId = computed(() => props.action.type.split('.').pop() ?? '')
const mode = computed(() => {
  if (props.action.type.startsWith('discord.')) return 'discord'
  if (props.action.type.startsWith('meetings.')) return 'meetings'
  if (props.action.type.startsWith('voicemod.')) return 'voicemod'
  return actionId.value === 'bus-mute' ? 'voicemeeter-bus' : 'voicemeeter-strip'
})
/** meetings.control exige app+command; bus-mute exige hotkey (schema).
 *  El resto resuelve por ajustes/RPC y funciona sin parámetros. */
const isConfigured = computed(() => {
  if (mode.value === 'meetings') return !!params.value.app && !!params.value.command
  if (mode.value === 'voicemeeter-bus') return !!params.value.hotkey
  return true
})
const carouselMs = computed(() => resolveCarouselMs(params.value))

/**
 * Parrilla de reuniones sin scroll: cuando no caben, páginas que rotan con
 * `carouselMs`; cuando caben, parrilla entera (ver useFitPager). En alturas
 * bajas con anchura M+ se usa el carrusel de iconos (ver container queries).
 */
const meetGridEl = ref<HTMLElement | null>(null)
const meetPager = useFitPager(meetGridEl, { intervalMs: carouselMs })
const disabled = computed(() => props.readonly || busy.value)
const busy = ref(false)
const error = ref('')
const discordStatus = ref<'unknown' | 'connected' | 'offline' | 'hotkey'>('unknown')
const discordMute = ref<boolean | null>(null)
const discordDeaf = ref<boolean | null>(null)
const voicemodConnected = ref<boolean | null>(null)
const voicemodMuted = ref<boolean | null>(null)
const voiceName = ref('')
const voiceIdInput = ref(typeof params.value.voiceId === 'string' ? params.value.voiceId : '')
const pttHeld = ref(false)
let pttPressPromise: Promise<void> | null = null
let pttReleaseQueued = false
const app = computed(() => ['zoom', 'teams', 'meet'].includes(params.value.app) ? params.value.app : 'meet')
const appLabel = computed(() => ({ zoom: copy.value.zoom, teams: copy.value.teams, meet: copy.value.meet } as Record<string, string>)[app.value] ?? copy.value.meet)
const muteLabel = computed(() => discordMute.value === true ? copy.value.unmuteMic : discordMute.value === false ? copy.value.muteMic : copy.value.toggleMic)
const discordStatusLabel = computed(() => ({
  connected: copy.value.connected,
  offline: copy.value.offline,
  hotkey: copy.value.hotkey,
  unknown: copy.value.unknown,
}[discordStatus.value]))
const panelKicker = computed(() => ({
  discord: copy.value.discordKicker,
  meetings: copy.value.meetingKicker,
  voicemod: copy.value.voicemodKicker,
  'voicemeeter-strip': copy.value.macroKicker,
  'voicemeeter-bus': copy.value.macroKicker,
}[mode.value] ?? copy.value.macroKicker))
const panelTitle = computed(() => ({
  discord: copy.value.discordTitle,
  meetings: copy.value.meetingTitle,
  voicemod: copy.value.voicemodTitle,
  'voicemeeter-strip': copy.value.stripTitle,
  'voicemeeter-bus': copy.value.busTitle,
}[mode.value] ?? copy.value.discordTitle))
const meetingControls = computed(() => [
  { command: 'mute', label: copy.value.muteMic, icon: MicOff },
  { command: 'unmute', label: copy.value.unmuteMic, icon: Mic },
  { command: 'camera', label: copy.value.camera, icon: Camera },
  { command: 'share', label: copy.value.share, icon: MonitorUp },
  { command: 'hand', label: copy.value.raiseHand, icon: Hand },
  { command: 'chat', label: copy.value.chat, icon: MessageSquare },
  { command: 'leave', label: copy.value.leave, icon: PhoneOff },
  { command: 'record', label: copy.value.record, icon: CircleDot },
])
/** Páginas de 2 para el carrusel XS (8 botones → 4 páginas). */
const meetingPages = computed(() => {
  const pages: typeof meetingControls.value[] = []
  for (let i = 0; i < meetingControls.value.length; i += 2) pages.push(meetingControls.value.slice(i, i + 2))
  return pages
})

function unwrap(value: any): any {
  return value?.result ?? value?.data ?? value
}
async function execute(type: string, parameters: Record<string, any>) {
  if (props.readonly || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = unwrap(await executeWidgetAction(props.apiBase, type, parameters))
    if (type === 'discord.toggle-mute' && typeof result?.mute === 'boolean') discordMute.value = result.mute
    if (type === 'discord.toggle-deafen' && typeof result?.deaf === 'boolean') discordDeaf.value = result.deaf
    if (type === 'voicemod.mute' && typeof result?.muted === 'boolean') voicemodMuted.value = result.muted
    if (mode.value === 'discord' && result?.transport === 'hotkey') {
      discordStatus.value = 'hotkey'
      discordMute.value = null
      discordDeaf.value = null
    }
    if (type === 'voicemod.get-status') applyVoicemodStatus(result)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
function applyDiscordStatus(result: any) {
  if (result?.transport === 'rpc' && result?.status === 'connected') discordStatus.value = 'connected'
  else if (result?.status === 'discord-closed') discordStatus.value = 'offline'
  else if (result?.transport === 'none' || result?.status === 'needs-auth') discordStatus.value = 'hotkey'
  else discordStatus.value = 'unknown'
  const voice = result?.voice
  discordMute.value = typeof voice?.mute === 'boolean' ? voice.mute : null
  discordDeaf.value = typeof voice?.deaf === 'boolean' ? voice.deaf : null
}
function applyVoicemodStatus(result: any) {
  voicemodConnected.value = result?.connected === true
  const status = result?.status
  const voice = status?.voice ?? status?.currentVoice ?? status?.voiceChanger
  voiceName.value = typeof voice?.name === 'string' ? voice.name : typeof status?.voiceName === 'string' ? status.voiceName : ''
  const muted = status?.muted ?? status?.mute
  voicemodMuted.value = typeof muted === 'boolean' ? muted : null
}
function runMeetingCommand(command: string) {
  const safeParams = { ...params.value }
  // A configured invitation URL belongs to `meetings.join`, not each
  // unrelated hotkey command from this control panel.
  delete safeParams.url
  return execute('meetings.control', { ...safeParams, app: app.value, command })
}
function setVoice() {
  const voiceId = voiceIdInput.value.trim()
  if (!voiceId) return
  return execute('voicemod.set-voice', { ...params.value, voiceId })
}
async function refreshStatus() {
  if (mode.value === 'discord') {
    busy.value = true
    error.value = ''
    try {
      const result = unwrap(await executeWidgetAction(props.apiBase, 'discord.status', {}))
      applyDiscordStatus(result)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      discordStatus.value = 'unknown'
      discordMute.value = null
      discordDeaf.value = null
    } finally {
      busy.value = false
    }
  } else if (mode.value === 'voicemod') {
    busy.value = true
    error.value = ''
    try {
      const result = unwrap(await executeWidgetAction(props.apiBase, 'voicemod.get-status', params.value))
      applyVoicemodStatus(result)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      voicemodConnected.value = false
    } finally {
      busy.value = false
    }
  }
}
function beginPtt(event: PointerEvent) {
  if (props.readonly || busy.value || pttHeld.value) return
  event.preventDefault()
  if (Number.isInteger(event.pointerId)) {
    ;(event.currentTarget as HTMLElement)?.setPointerCapture?.(event.pointerId)
  }
  startPtt()
}
async function sendPttRelease() {
  pttReleaseQueued = false
  await execute('discord.push-to-talk', { ...params.value, phase: 'release' })
}
function endPtt() {
  if (!pttHeld.value) return
  pttHeld.value = false
  if (pttPressPromise) pttReleaseQueued = true
  else void sendPttRelease()
}
function pttKeyDown(event: KeyboardEvent) {
  if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
    event.preventDefault()
    startPtt()
  }
}
function pttKeyUp(event: KeyboardEvent) {
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault()
    endPtt()
  }
}
function releaseOnBlur() { endPtt() }
function startPtt() {
  if (props.readonly || busy.value || pttHeld.value) return
  pttHeld.value = true
  pttReleaseQueued = false
  pttPressPromise = execute('discord.push-to-talk', { ...params.value, phase: 'press' }).then(() => {
    if (pttReleaseQueued) return sendPttRelease()
  }).finally(() => { pttPressPromise = null })
}

onMounted(() => {
  if (mode.value === 'discord' || mode.value === 'voicemod') void refreshStatus()
  window.addEventListener('blur', releaseOnBlur)
})
onUnmounted(() => {
  window.removeEventListener('blur', releaseOnBlur)
  endPtt()
})
</script>

<style scoped>
.voice-panel {
  container-type: size;
  container-name: voice-panel;
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
.voice-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: clamp(8px, 4cqi, 14px);
  overflow: hidden;
}
.voice-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.voice-head > div { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.voice-head strong { font-size: clamp(12px, 5cqi, 15px); line-height: 1.15; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eyebrow { color: color-mix(in srgb, currentColor 58%, transparent); font: 700 9px/1 var(--bd-mono, ui-monospace, monospace); letter-spacing: .06em; }
.icon-button, .voice-control {
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
.icon-button { width: 34px; min-width: 34px; padding: 0; }
.voice-control { font-size: 11px; font-weight: 600; min-width: 0; }
.voice-control:hover:not(:disabled), .icon-button:hover:not(:disabled) { border-color: color-mix(in srgb, #dda95c 58%, transparent); background: color-mix(in srgb, #dda95c 12%, transparent); }
.voice-control[aria-pressed="true"] { border-color: color-mix(in srgb, #e29a82 60%, transparent); color: #f1b09a; }
button:disabled { opacity: .45; cursor: not-allowed; }
button:focus-visible { outline: 2px solid #dda95c; outline-offset: 2px; }
.connection-line, .context-chip { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 10px; color: color-mix(in srgb, currentColor 72%, transparent); }
.connection-line { min-width: 0; }
.connection-line :deep(.bd-marquee) { flex: 1; min-width: 0; }
.status-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: #999; }
.connection-line[data-status="connected"] .status-dot { background: #79c58a; }
.connection-line[data-status="offline"] .status-dot { background: #dc897a; }
.connection-line[data-status="hotkey"] .status-dot { background: #d8ae69; }
.context-chip { align-self: flex-start; padding: 4px 7px; border-radius: 6px; background: color-mix(in srgb, currentColor 7%, transparent); }
.control-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
/* Páginas XS de reuniones: ocultas fuera de XS. */
.xs-pages { display: none; min-width: 0; }
.xs-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.xs-grid .voice-control { min-height: 44px; }
.voice-id-form { display: flex; gap: 6px; }
.voice-id-form input { flex: 1; min-width: 0; padding: 5px 8px; color: inherit; border: 1px solid color-mix(in srgb, currentColor 17%, transparent); border-radius: 8px; background: color-mix(in srgb, #111 85%, transparent); font: inherit; font-size: 11px; }
.voice-control span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.discord-controls .ptt-control { grid-column: 1 / -1; min-height: 42px; border-color: color-mix(in srgb, #dda95c 42%, transparent); touch-action: none; user-select: none; }
.ptt-control[aria-pressed="true"] { color: #14110b; background: #dda95c; }
.neutral-note { margin: auto 0 0; color: color-mix(in srgb, currentColor 59%, transparent); font-size: 9px; line-height: 1.3; }
.widget-error {
  display: flex; align-items: center; gap: 5px;
  margin: 0; color: #e89589; font-size: 10px; line-height: 1.25; overflow-wrap: anywhere;
}
.widget-error .err-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.single-control { width: 100%; min-height: 42px; }
.sr-only, .sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

/* Parrilla paginada sin scroll (ver useFitPager): acotada y con dots. */
.meeting-controls.m-grid { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: hidden; }
.voice-pager { display: flex; flex: none; align-items: center; justify-content: center; gap: 6px; padding-top: 2px; }
.voice-pager small { font-size: 10px; opacity: .6; font-variant-numeric: tabular-nums; }
.pager-dot { width: 7px; height: 7px; padding: 0; border: 0; border-radius: 999px; background: currentcolor; opacity: .3; cursor: pointer; }
.pager-dot.is-active { width: 16px; opacity: .9; }

/* XS (<200px): 1–2 controles esenciales, sin refresh ni notas largas. */
@container voice-panel (max-width: 199px) {
  .voice-main { gap: 6px; }
  .voice-head strong { font-size: clamp(11px, 9cqi, 13px); }
  .eyebrow { font-size: 8px; }
  .m-refresh { display: none; }
  .voice-control span { display: none; }
  .voice-control { min-height: 40px; padding: 4px; }
  .discord-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .discord-controls .m-extra { display: none; }
  .discord-controls .ptt-control { grid-column: 1 / -1; min-height: 40px; }
  .discord-controls .ptt-control span { display: inline; font-size: 10px; }
  .m-grid { display: none; }
  .xs-pages { display: block; }
  .voicemod-controls .m-extra, .m-form { display: none; }
  .neutral-note { display: none; }
  .widget-error { justify-content: center; }
  .widget-error .err-text { display: none; }
  .context-chip .chip-label { display: none; }
  .single-control span { display: inline; font-size: 10px; }
}
/* M+: parrilla completa, sin páginas XS. */
@container voice-panel (min-width: 200px) {
  .xs-pages { display: none; }
}
/* Baja altura con anchura M+ (p. ej. filas 2×1/3×1): reuniones con carrusel
   de 2 por página, sin parrilla recortada ni scroll. */
@container voice-panel (min-width: 200px) and (max-height: 150px) {
  .m-grid { display: none; }
  .xs-pages { display: block; }
}
/* XS y baja (≤150px): cabe en 1×1 recortando cromo, no controles. */
@container voice-panel (max-width: 199px) and (max-height: 150px) {
  .voice-head .eyebrow, .connection-line { display: none; }
  .voice-main { gap: 4px; }
  .voice-control { min-height: 30px; }
  .discord-controls .ptt-control { min-height: 32px; }
  .single-control { min-height: 36px; }
}
/* Ancha: cabecera + controles en fila. */
@container voice-panel (min-aspect-ratio: 13/10) {
  .voice-main { display: grid; grid-template-columns: minmax(110px, .7fr) minmax(0, 1.5fr); grid-template-rows: auto 1fr auto; align-items: center; gap: 8px 14px; }
  .voice-head { grid-column: 1; grid-row: 1; }
  .connection-line, .context-chip { grid-column: 1; grid-row: 2; align-self: start; }
  .control-grid { grid-column: 2; grid-row: 1 / span 2; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .xs-pages { grid-column: 2; grid-row: 1 / span 2; }
  .neutral-note, .widget-error { grid-column: 1 / -1; }
  .discord-controls .ptt-control { grid-column: auto; }
  /* Reuniones: columnas que garantizan etiqueta legible (sin recorte mudo). */
  .meeting-controls { grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); }
}
/* Alta: columna compacta. */
@container voice-panel (max-aspect-ratio: 77/100) {
  .voice-main { gap: 6px; }
  .control-grid { gap: 5px; }
  .voice-control { min-height: 32px; padding: 4px 6px; gap: 5px; font-size: 10px; }
  .discord-controls .ptt-control { min-height: 36px; }
  .neutral-note { font-size: 8px; }
}
/* Filas bajas y anchas (p. ej. 2×1/3×1): Discord/Voicemod compactos (iconos
   + PTT con etiqueta, sin cromo). En último lugar para imponerse a la
   distribución apaisada. */
@container voice-panel (min-width: 200px) and (max-height: 150px) and (min-aspect-ratio: 13/10) {
  .voice-head, .connection-line, .neutral-note, .widget-error { display: none; }
  .voice-main { display: flex; flex-direction: column; }
  .voice-control span { display: none; }
  .voice-control { min-height: 40px; padding: 4px; }
  .discord-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .discord-controls .ptt-control { grid-column: 1 / -1; min-height: 38px; }
  .discord-controls .ptt-control span { display: inline; font-size: 10px; }
  .voicemod-controls .m-extra, .m-form { display: none; }
  .context-chip .chip-label { display: none; }
}
</style>
