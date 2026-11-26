<template>
  <section
    class="workflow-control"
    :data-kind="kind"
    role="group"
    :aria-label="label || heading"
    :aria-busy="busy !== ''"
  >
    <header class="workflow-head">
      <component :is="headingIcon" :size="17" aria-hidden="true" />
      <span class="workflow-title">{{ label || heading }}</span>
      <button
        v-if="supportsRefresh"
        class="icon-button"
        type="button"
        :aria-label="copy.refresh"
        :title="copy.refresh"
        :disabled="readonly || busy !== ''"
        @click="refresh"
      >
        <RefreshCw :size="15" aria-hidden="true" />
      </button>
    </header>

    <p v-if="busy" class="workflow-state" role="status">
      <span class="spinner" aria-hidden="true" /> {{ busyLabel }}
    </p>

    <template v-if="kind === 'clipboard'">
      <div class="workflow-scroll" :aria-label="copy.savedSlots">
        <button
          v-for="slot in slots"
          :key="slot.slot"
          class="workflow-row"
          type="button"
          :disabled="readonly || busy !== ''"
          :aria-label="copy.copySlot(slot.slot)"
          @click="pasteSlot(slot.slot)"
        >
          <span class="row-main"><Clipboard :size="15" aria-hidden="true" /><b>{{ slot.slot }}</b></span>
          <span class="row-detail">{{ slot.preview || copy.characters(slot.length) }}</span>
          <Copy :size="14" aria-hidden="true" />
        </button>
        <p v-if="!slots.length && !busy" class="empty-state">{{ copy.noSlots }}</p>
      </div>
      <form v-if="!readonly" class="workflow-form clipboard-form" @submit.prevent="saveSnippet">
        <input
          v-model="snippetName"
          :aria-label="copy.slotName"
          autocomplete="off"
          maxlength="64"
          :placeholder="copy.name"
        />
        <textarea
          v-model="snippetText"
          :aria-label="copy.snippetText"
          maxlength="100000"
          rows="1"
          :placeholder="copy.newSnippet"
        />
        <button class="primary-button" type="submit" :disabled="busy !== '' || !snippetName.trim() || !snippetText">
          {{ copy.save }}
        </button>
      </form>
      <details v-if="history.length" class="workflow-history">
        <summary><History :size="14" aria-hidden="true" /> {{ copy.recent(history.length) }}</summary>
        <ul>
          <li v-for="(entry, index) in history" :key="`${entry.ts}-${index}`">
            <span>{{ entry.preview }}</span><small>{{ entry.source }}</small>
          </li>
        </ul>
      </details>
    </template>

    <template v-else-if="kind === 'flow'">
      <label class="field-label">
        {{ copy.variable }}
        <input v-model="variableName" :readonly="readonly" maxlength="80" :placeholder="copy.variableName" />
      </label>
      <template v-if="action.type === 'flow.set-var'">
        <label class="field-label">
          {{ copy.value }}
          <input v-model="variableValue" :readonly="readonly" :placeholder="copy.value" @keydown.enter.prevent="setVariable" />
        </label>
        <div class="workflow-actions">
          <label class="type-label">{{ copy.type }}
            <select v-model="variableType" :disabled="readonly">
              <option value="num">{{ copy.number }}</option><option value="bool">{{ copy.boolean }}</option><option value="txt">{{ copy.text }}</option>
            </select>
          </label>
          <button class="primary-button" type="button" :disabled="readonly || busy !== '' || !variableName.trim()" @click="setVariable">
            <Check :size="15" aria-hidden="true" /> {{ copy.set }}
          </button>
        </div>
      </template>
      <template v-else-if="action.type === 'flow.toggle-var'">
        <div class="value-card">
          <span>{{ copy.currentValue }}</span>
          <strong>{{ displayValue(variableValue) }}</strong>
        </div>
        <button class="primary-button" type="button" :disabled="readonly || busy !== '' || !variableName.trim()" @click="toggleVariable">
          <ArrowLeftRight :size="15" aria-hidden="true" /> {{ copy.toggle }}
        </button>
      </template>
      <template v-else>
        <div class="value-card">
          <span>{{ copy.currentValue }}</span>
          <strong>{{ variableValue === '' ? '—' : displayValue(variableValue) }}</strong>
          <small v-if="variableType">{{ copy.type }}: {{ variableType }}</small>
        </div>
        <button class="secondary-button" type="button" :disabled="readonly || busy !== '' || !variableName.trim()" @click="readVariable">
          <Eye :size="15" aria-hidden="true" /> {{ copy.read }}
        </button>
      </template>
    </template>

    <template v-else-if="kind === 'profile'">
      <div class="status-card">
        <span class="status-dot" :class="{ active: profileStatus?.enabled }" aria-hidden="true" />
        <span>{{ profileStatus?.enabled ? copy.autoSwitchOn : copy.autoSwitchOff }}</span>
        <small>{{ copy.rules(profileStatus?.rules ?? '—') }}</small>
      </div>
      <label class="field-label">
        {{ copy.profile }}
        <select v-model="selectedProfile" :disabled="readonly || busy !== '' || !profiles.length">
          <option value="" disabled>{{ copy.selectProfile }}</option>
          <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
        </select>
      </label>
      <div class="workflow-actions">
        <button class="primary-button" type="button" :disabled="readonly || busy !== '' || !selectedProfile" @click="switchProfile">
          <ArrowLeftRight :size="15" aria-hidden="true" /> {{ copy.switch }}
        </button>
        <span v-if="profileStatus?.lastSwitch?.window?.processName" class="muted">
          {{ profileStatus.lastSwitch.window.processName }}
        </span>
      </div>
    </template>

    <template v-else-if="kind === 'page'">
      <label class="field-label">
        {{ copy.page }}
        <select v-model="selectedPage" :disabled="readonly || busy !== '' || !pages.length">
          <option value="" disabled>{{ copy.selectPage }}</option>
          <option v-for="page in pages" :key="page.id" :value="page.id">{{ page.name }}</option>
        </select>
      </label>
      <button class="primary-button" type="button" :disabled="readonly || busy !== '' || !selectedPage" @click="navigatePage">
        <FileText :size="15" aria-hidden="true" /> {{ copy.openPage }}
      </button>
    </template>

    <template v-else-if="kind === 'layout'">
      <div class="workflow-scroll" :aria-label="copy.savedLayouts">
        <button
          v-for="layout in layouts"
          :key="layout.name"
          class="workflow-row"
          type="button"
          :disabled="readonly || busy !== '' || !layout.geometry"
          :aria-label="copy.restoreLayout(layout.name)"
          :title="layout.geometry ? copy.restoreNamedLayout(layout.name) : copy.noGeometry"
          @click="restoreLayout(layout.name)"
        >
          <span class="row-main"><LayoutTemplate :size="15" aria-hidden="true" /><b>{{ layout.name }}</b></span>
          <span class="row-detail">{{ layout.geometry ? (layout.note || copy.readyToRestore) : copy.noPosition }}</span>
          <ArrowRight :size="14" aria-hidden="true" />
        </button>
        <p v-if="!layouts.length && !busy" class="empty-state">{{ copy.noLayouts }}</p>
      </div>
    </template>

    <template v-else-if="kind === 'osc'">
      <div class="osc-address">{{ configuredOsc ? oscAddress : copy.configureOsc }}</div>
      <button
        class="osc-pad"
        type="button"
        :disabled="readonly || busy !== '' || !configuredOsc"
        :aria-label="copy.sendOsc(oscAddress)"
        @click="sendOsc"
      >
        <Radio :size="25" aria-hidden="true" />
        <span>{{ configuredOsc ? copy.send : copy.notConfigured }}</span>
      </button>
    </template>

    <p v-if="feedback && !error" class="workflow-feedback" role="status">{{ feedback }}</p>
    <p v-if="error" class="workflow-error" role="alert">{{ error }}</p>
    <p v-if="readonly" class="readonly-note">{{ copy.readOnly }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  ArrowLeftRight, ArrowRight, Check, Clipboard, Copy, Eye, FileText, History,
  LayoutTemplate, Radio, RefreshCw, UserRound, Variable
} from 'lucide-vue-next'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import { normalizeApiBase } from '../../../composables/useKeyShare'
import { useI18nStore } from '../../../composables/useI18n'

interface Props {
  action: { type: string; parameters: Record<string, any> }
  apiBase: string
  label?: string
  readonly?: boolean
}

const props = withDefaults(defineProps<Props>(), { label: '', readonly: false })
const { currentLocale } = useI18nStore()
const copy = computed(() => {
  const es = String(currentLocale.value).toLowerCase().startsWith('es')
  return es ? {
    refresh: 'Actualizar',
    clipboard: 'Portapapeles',
    savedSlots: 'Slots guardados',
    copySlot: (slot: string) => `Copiar ${slot} al portapapeles`,
    characters: (count: number) => `${count} caracteres`,
    noSlots: 'Todavía no hay slots guardados.',
    slotName: 'Nombre del slot',
    name: 'Nombre',
    snippetText: 'Texto del fragmento',
    newSnippet: 'Nuevo fragmento…',
    save: 'Guardar',
    recent: (count: number) => `Recientes (${count})`,
    variable: 'Variable',
    variableName: 'nombreVariable',
    value: 'Valor',
    type: 'Tipo',
    number: 'Número',
    boolean: 'Booleano',
    text: 'Texto',
    set: 'Fijar',
    currentValue: 'Valor actual',
    toggle: 'Alternar',
    read: 'Leer',
    autoSwitchOn: 'Cambio automático activo',
    autoSwitchOff: 'Cambio automático inactivo',
    rules: (count: number | string) => `${count} reglas`,
    profile: 'Perfil',
    selectProfile: 'Seleccionar perfil…',
    switch: 'Cambiar',
    page: 'Página',
    selectPage: 'Seleccionar página…',
    openPage: 'Abrir página',
    savedLayouts: 'Diseños guardados',
    restoreLayout: (name: string) => `Restaurar diseño ${name}`,
    restoreNamedLayout: (name: string) => `Restaurar ${name}`,
    noGeometry: 'Este diseño no tiene geometría guardada',
    readyToRestore: 'Listo para restaurar',
    noPosition: 'Sin posición guardada',
    noLayouts: 'No hay diseños guardados.',
    configureOsc: 'Configura host, puerto y dirección OSC',
    sendOsc: (address: string) => `Enviar OSC ${address}`,
    send: 'Enviar',
    notConfigured: 'Sin configurar',
    readOnly: 'Solo lectura',
    flowVariable: 'Variable de flujo',
    profiles: 'Perfiles',
    pages: 'Páginas',
    windowLayouts: 'Diseños de ventana',
    oscPad: 'Control OSC',
    workflow: 'Flujo',
    refreshing: 'Actualizando…',
    executing: 'Ejecutando…',
    noAction: 'La acción no se pudo completar.',
    optionsLoadFailed: (status: number) => `No se pudieron cargar las opciones (${status}).`,
    clipboardReady: (slot: string) => `“${slot}” listo para pegar.`,
    snippetSaved: 'Snippet guardado.',
    variableUpdated: 'Variable actualizada.',
    variableToggled: 'Variable alternada.',
    changingProfile: (name: string) => `Cambiando a ${name}.`,
    openingPage: (name: string) => `Abriendo ${name}.`,
    layoutRestored: (name: string) => `Diseño “${name}” restaurado.`,
    oscSent: (address: string) => `Enviado ${address}.`,
    enabled: 'Activado',
    disabled: 'Desactivado',
  } : {
    refresh: 'Refresh',
    clipboard: 'Clipboard',
    savedSlots: 'Saved slots',
    copySlot: (slot: string) => `Copy ${slot} to clipboard`,
    characters: (count: number) => `${count} characters`,
    noSlots: 'No saved slots yet.',
    slotName: 'Slot name',
    name: 'Name',
    snippetText: 'Snippet text',
    newSnippet: 'New snippet…',
    save: 'Save',
    recent: (count: number) => `Recent (${count})`,
    variable: 'Variable',
    variableName: 'variableName',
    value: 'Value',
    type: 'Type',
    number: 'Number',
    boolean: 'Boolean',
    text: 'Text',
    set: 'Set',
    currentValue: 'Current value',
    toggle: 'Toggle',
    read: 'Read',
    autoSwitchOn: 'Automatic switching on',
    autoSwitchOff: 'Automatic switching off',
    rules: (count: number | string) => `${count} rules`,
    profile: 'Profile',
    selectProfile: 'Select profile…',
    switch: 'Switch',
    page: 'Page',
    selectPage: 'Select page…',
    openPage: 'Open page',
    savedLayouts: 'Saved layouts',
    restoreLayout: (name: string) => `Restore layout ${name}`,
    restoreNamedLayout: (name: string) => `Restore ${name}`,
    noGeometry: 'This layout has no saved geometry',
    readyToRestore: 'Ready to restore',
    noPosition: 'No saved position',
    noLayouts: 'No saved layouts.',
    configureOsc: 'Configure OSC host, port, and address',
    sendOsc: (address: string) => `Send OSC ${address}`,
    send: 'Send',
    notConfigured: 'Not configured',
    readOnly: 'Read only',
    flowVariable: 'Flow variable',
    profiles: 'Profiles',
    pages: 'Pages',
    windowLayouts: 'Window layouts',
    oscPad: 'OSC pad',
    workflow: 'Workflow',
    refreshing: 'Refreshing…',
    executing: 'Running…',
    noAction: 'The action could not be completed.',
    optionsLoadFailed: (status: number) => `Could not load options (${status}).`,
    clipboardReady: (slot: string) => `“${slot}” is ready to paste.`,
    snippetSaved: 'Snippet saved.',
    variableUpdated: 'Variable updated.',
    variableToggled: 'Variable toggled.',
    changingProfile: (name: string) => `Switching to ${name}.`,
    openingPage: (name: string) => `Opening ${name}.`,
    layoutRestored: (name: string) => `Layout “${name}” restored.`,
    oscSent: (address: string) => `Sent ${address}.`,
    enabled: 'Enabled',
    disabled: 'Disabled',
  }
})
const kind = computed(() => {
  if (props.action.type.startsWith('clipboard.')) return 'clipboard'
  if (props.action.type.startsWith('flow.')) return 'flow'
  if (props.action.type.startsWith('profile-auto.')) return 'profile'
  if (props.action.type === 'page.page') return 'page'
  if (props.action.type.startsWith('window-manager.layout-')) return 'layout'
  if (props.action.type === 'midi-osc.send-osc') return 'osc'
  return 'unknown'
})
const heading = computed(() => ({
  clipboard: copy.value.clipboard, flow: copy.value.flowVariable, profile: copy.value.profiles, page: copy.value.pages,
  layout: copy.value.windowLayouts, osc: copy.value.oscPad
}[kind.value] ?? copy.value.workflow))
const headingIcon = computed(() => ({
  clipboard: Clipboard, flow: Variable, profile: UserRound, page: FileText,
  layout: LayoutTemplate, osc: Radio
}[kind.value] ?? FileText))
const supportsRefresh = computed(() => ['clipboard', 'profile', 'page', 'layout', 'flow'].includes(kind.value))
const busy = ref('')
const error = ref('')
const feedback = ref('')
const slots = ref<Array<{ slot: string; preview?: string; length: number }>>([])
const history = ref<Array<{ preview: string; source: string; ts: number }>>([])
const snippetName = ref(String(props.action.parameters.slot ?? ''))
const snippetText = ref('')
const variableName = ref(String(props.action.parameters.name ?? ''))
const variableValue = ref(props.action.parameters.value == null ? '' : String(props.action.parameters.value))
const variableType = ref(String(props.action.parameters.type ?? 'num'))
const profileStatus = ref<any>(null)
const profiles = ref<Array<{ id: string; name: string }>>([])
const selectedProfile = ref(String(props.action.parameters.profileId ?? ''))
const pages = ref<Array<{ id: string; name: string }>>([])
const selectedPage = ref(String(props.action.parameters.pageId ?? ''))
const layouts = ref<Array<{ name: string; note?: string; geometry?: any }>>([])

const osc = computed(() => props.action.parameters ?? {})
const configuredOsc = computed(() =>
  typeof osc.value.host === 'string' && !!osc.value.host.trim() &&
  Number.isInteger(Number(osc.value.port)) && Number(osc.value.port) > 0 &&
  Number(osc.value.port) <= 65535 && typeof osc.value.address === 'string' &&
  osc.value.address.startsWith('/')
)
const oscAddress = computed(() => `${osc.value.address ?? ''} → ${osc.value.host ?? ''}:${osc.value.port ?? ''}`)
const busyLabel = computed(() => busy.value === 'refresh' ? copy.value.refreshing : copy.value.executing)

function unwrap(response: any): any {
  if (response?.success === false) throw new Error(response.error || copy.value.noAction)
  return response?.result ?? response
}

async function run(type: string, parameters: Record<string, any> = {}): Promise<any> {
  const response = await executeWidgetAction(props.apiBase, type, parameters)
  return unwrap(response)
}

async function getJson(path: string): Promise<any> {
  const base = normalizeApiBase(props.apiBase) || ''
  const response = await fetch(`${base}/api/v1${path}`)
  if (!response.ok) throw new Error(copy.value.optionsLoadFailed(response.status))
  return response.json()
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

async function refresh(): Promise<void> {
  if (busy.value) return
  busy.value = 'refresh'
  error.value = ''
  feedback.value = ''
  try {
    if (kind.value === 'clipboard') {
      const [slotResult, historyResult] = await Promise.all([
        run('clipboard.list-slots'),
        run('clipboard.history', { limit: 8 })
      ])
      slots.value = Array.isArray(slotResult?.slots) ? slotResult.slots : []
      history.value = Array.isArray(historyResult?.entries) ? historyResult.entries : []
    } else if (kind.value === 'flow') {
      if (variableName.value.trim() && props.action.type !== 'flow.set-var') {
        const result = await run('flow.get-var', { name: variableName.value.trim() })
        variableValue.value = result?.value == null ? '' : String(result.value)
        variableType.value = result?.type ?? variableType.value
      }
    } else if (kind.value === 'profile') {
      const [status, profileList] = await Promise.all([
        run('profile-auto.status'),
        getJson('/profiles')
      ])
      profileStatus.value = status
      profiles.value = Array.isArray(profileList) ? profileList.filter((p: any) => p?.id) : []
      if (!profiles.value.some(p => p.id === selectedProfile.value)) {
        selectedProfile.value = String(props.action.parameters.profileId ?? profiles.value[0]?.id ?? '')
      }
    } else if (kind.value === 'page') {
      const [profileList, current] = await Promise.all([
        getJson('/profiles'),
        getJson('/settings?key=current.profile_id')
      ])
      const currentId = String(current?.value ?? '')
      const profile = Array.isArray(profileList)
        ? profileList.find((p: any) => p?.id === currentId) ?? profileList[0]
        : null
      if (!profile?.id) {
        pages.value = []
      } else {
        const pageList = await getJson(`/pages?profileId=${encodeURIComponent(profile.id)}`)
        pages.value = Array.isArray(pageList)
          ? pageList.filter((p: any) => p?.id && p.is_folder !== 1).map((p: any) => ({ id: p.id, name: p.name || p.id }))
          : []
      }
      if (!pages.value.some(p => p.id === selectedPage.value)) {
        selectedPage.value = String(props.action.parameters.pageId ?? pages.value[0]?.id ?? '')
      }
    } else if (kind.value === 'layout') {
      const result = await run('window-manager.layout-list')
      layouts.value = Array.isArray(result?.layouts) ? result.layouts : []
    }
  } catch (reason) {
    error.value = messageOf(reason)
  } finally {
    busy.value = ''
  }
}

async function act(task: () => Promise<any>, successText: (result: any) => string): Promise<any> {
  if (props.readonly || busy.value) return
  busy.value = 'action'
  error.value = ''
  feedback.value = ''
  try {
    const result = await task()
    feedback.value = successText(result)
    return result
  } catch (reason) {
    error.value = messageOf(reason)
    return null
  } finally {
    busy.value = ''
  }
}

async function pasteSlot(slot: string): Promise<void> {
  await act(() => run('clipboard.paste-slot', { slot }), () => copy.value.clipboardReady(slot))
}

async function saveSnippet(): Promise<void> {
  const name = snippetName.value.trim()
  if (!name || !snippetText.value) return
  const result = await act(
    () => run('clipboard.save-slot', { slot: name, text: snippetText.value }),
    () => copy.value.snippetSaved
  )
  if (result) {
    snippetText.value = ''
    await refresh()
  }
}

async function readVariable(): Promise<void> {
  const result = await act(
    () => run('flow.get-var', { name: variableName.value.trim() }),
    () => copy.value.variableUpdated
  )
  if (result) {
    variableValue.value = result.value == null ? '' : String(result.value)
    variableType.value = result.type ?? variableType.value
  }
}

async function toggleVariable(): Promise<void> {
  const result = await act(
    () => run('flow.toggle-var', { name: variableName.value.trim() }),
    () => copy.value.variableToggled
  )
  if (result) variableValue.value = result.value == null ? '' : String(result.value)
}

async function setVariable(): Promise<void> {
  const result = await act(
    () => run('flow.set-var', {
      name: variableName.value.trim(),
      value: variableValue.value,
      type: variableType.value
    }),
    () => copy.value.variableUpdated
  )
  if (result) variableValue.value = result.value == null ? '' : String(result.value)
}

async function switchProfile(): Promise<void> {
  const profile = profiles.value.find(p => p.id === selectedProfile.value)
  await act(
    () => run('profile-auto.switch-profile', { profileId: selectedProfile.value }),
    () => copy.value.changingProfile(profile?.name ?? selectedProfile.value)
  )
}

async function navigatePage(): Promise<void> {
  const page = pages.value.find(p => p.id === selectedPage.value)
  await act(
    () => run('page.page', { pageId: selectedPage.value, pageName: page?.name }),
    () => copy.value.openingPage(page?.name ?? copy.value.page.toLowerCase())
  )
}

async function restoreLayout(name: string): Promise<void> {
  const result = await act(
    () => run('window-manager.layout-restore', { name }),
    () => copy.value.layoutRestored(name)
  )
  if (result) await refresh()
}

async function sendOsc(): Promise<void> {
  await act(
    () => run('midi-osc.send-osc', { ...osc.value }),
    () => copy.value.oscSent(osc.value.address)
  )
}

function displayValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? copy.value.enabled : copy.value.disabled
  return String(value ?? '—')
}

watch(() => props.action.type, () => void refresh())
onMounted(() => void refresh())
</script>

<style scoped>
.workflow-control {
  container-type: size;
  container-name: workflow;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
  padding: clamp(6px, 4cqi, 12px);
  color: inherit;
  font: inherit;
}

.workflow-head,
.row-main,
.workflow-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.workflow-head { flex: 0 0 auto; }
.workflow-head > svg { flex: none; color: var(--bd-ac, #e0a84a); }
.workflow-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: clamp(11px, 6cqi, 15px);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled, select:disabled { cursor: not-allowed; opacity: .52; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible {
  outline: 2px solid var(--bd-ac, #e0a84a);
  outline-offset: 2px;
}
.icon-button, .primary-button, .secondary-button, .workflow-row, .osc-pad {
  border: 1px solid var(--bd-ln, #34383d);
  border-radius: 8px;
  background: var(--bd-sf, #1a1c1f);
}
.icon-button {
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  place-items: center;
}
.primary-button, .secondary-button {
  display: inline-flex;
  min-width: 40px;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}
.primary-button {
  border-color: color-mix(in srgb, var(--bd-ac, #e0a84a) 45%, var(--bd-ln, #34383d));
  background: color-mix(in srgb, var(--bd-ac, #e0a84a) 13%, var(--bd-sf, #1a1c1f));
}
.secondary-button { align-self: flex-start; }
.workflow-scroll {
  min-height: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
  overflow: auto;
  overscroll-behavior: contain;
}
.workflow-row {
  min-height: 38px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  text-align: left;
}
.workflow-row:hover:not(:disabled), .icon-button:hover:not(:disabled) { border-color: var(--bd-ac, #e0a84a); }
.row-main { overflow: hidden; }
.row-main svg { flex: none; opacity: .8; }
.row-main b, .row-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-main b { font-size: 12px; }
.row-detail { max-width: 38cqi; font-size: 10px; opacity: .68; }
.empty-state, .muted, .readonly-note { margin: auto 0; font-size: 11px; opacity: .68; }

.workflow-form { display: flex; gap: 5px; min-width: 0; flex: 0 0 auto; }
.workflow-form input, .workflow-form textarea, .field-label input, .field-label select, .type-label select {
  min-width: 0;
  min-height: 34px;
  border: 1px solid var(--bd-ln, #34383d);
  border-radius: 7px;
  background: var(--bd-sf, #1a1c1f);
  padding: 6px 8px;
  font-size: 11px;
}
.clipboard-form input { width: 27%; }
.clipboard-form textarea { flex: 1; resize: vertical; }
.clipboard-form .primary-button { min-height: 34px; padding-inline: 8px; }
.workflow-history { flex: 0 1 auto; overflow: auto; font-size: 10px; }
.workflow-history summary { display: flex; align-items: center; gap: 5px; min-height: 30px; cursor: pointer; }
.workflow-history ul { margin: 0; padding: 0 0 0 18px; }
.workflow-history li { display: flex; justify-content: space-between; gap: 6px; padding: 3px 0; }
.workflow-history li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workflow-history small { flex: none; opacity: .6; }

.field-label { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 10px; opacity: .8; }
.field-label input, .field-label select { width: 100%; font-size: 12px; opacity: 1; }
.workflow-actions { justify-content: space-between; flex: 0 0 auto; }
.type-label { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 10px; }
.type-label select { min-height: 32px; padding: 4px; }
.value-card, .status-card {
  display: flex;
  min-height: 36px;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--bd-ln, #34383d);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bd-sf, #1a1c1f) 75%, transparent);
  font-size: 11px;
}
.value-card { flex-wrap: wrap; }
.value-card span { opacity: .68; }
.value-card strong { margin-left: auto; overflow-wrap: anywhere; font-size: 13px; }
.value-card small { width: 100%; opacity: .6; }
.status-card { flex-wrap: wrap; }
.status-card small { margin-left: auto; opacity: .7; }
.status-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: #7b8086; }
.status-dot.active { background: #59c78d; box-shadow: 0 0 0 3px color-mix(in srgb, #59c78d 18%, transparent); }
.workflow-feedback, .workflow-error, .workflow-state {
  margin: 0;
  flex: 0 0 auto;
  font-size: 10px;
  overflow-wrap: anywhere;
}
.workflow-feedback { color: #7ed7a6; }
.workflow-error { color: #ff9995; }
.workflow-state { display: flex; align-items: center; gap: 6px; opacity: .75; }
.spinner { width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
.osc-address { overflow: hidden; font: 10px ui-monospace, monospace; opacity: .7; text-overflow: ellipsis; white-space: nowrap; }
.osc-pad {
  display: flex;
  flex: 1;
  min-height: 42px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border-color: color-mix(in srgb, var(--bd-ac, #e0a84a) 35%, var(--bd-ln, #34383d));
  background: color-mix(in srgb, var(--bd-ac, #e0a84a) 11%, var(--bd-sf, #1a1c1f));
  font-size: 11px;
  font-weight: 700;
  touch-action: manipulation;
}
.readonly-note { margin-top: auto; text-align: right; font-size: 9px; }
@keyframes spin { to { transform: rotate(360deg); } }

@container workflow (min-width: 230px) and (min-height: 135px) {
  .workflow-control[data-kind="page"], .workflow-control[data-kind="profile"] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto 1fr auto;
    align-items: center;
  }
  .workflow-control[data-kind="page"] .workflow-head,
  .workflow-control[data-kind="profile"] .workflow-head { grid-column: 1 / -1; }
  .workflow-control[data-kind="page"] > .primary-button,
  .workflow-control[data-kind="profile"] > .workflow-actions { grid-column: 2; justify-self: end; }
  .workflow-control[data-kind="page"] .field-label,
  .workflow-control[data-kind="profile"] .field-label { grid-column: 1; }
  .workflow-control[data-kind="profile"] .status-card { grid-column: 1 / -1; }
}

@container workflow (max-height: 150px) {
  .workflow-control { gap: 4px; padding: 4px; }
  .field-label { flex-direction: row; align-items: center; gap: 5px; white-space: nowrap; }
  .field-label input, .field-label select { min-height: 28px; padding: 4px 6px; }
  .primary-button, .secondary-button { min-height: 30px; padding: 4px 7px; }
  .value-card, .status-card { min-height: 28px; padding: 4px 6px; }
  .status-card small { font-size: 9px; }
  .workflow-row { min-height: 32px; padding-block: 3px; }
  .clipboard-form input, .clipboard-form textarea { min-height: 29px; padding: 4px 6px; }
  .clipboard-form .primary-button { min-height: 29px; }
}
</style>
