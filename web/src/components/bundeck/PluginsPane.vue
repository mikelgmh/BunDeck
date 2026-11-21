<template>
  <div class="bd-plug" data-cy="bd-plugins">
    <div class="bd-dtabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        role="tab"
        :aria-selected="ptab === tab.id"
        @click="ptab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="bd-plug-body">
      <!-- Instalados (datos reales del daemon) -->
      <template v-if="ptab === 'inst'">
        <div
          class="bd-drop"
          :class="{ 'bd-over': dragOver }"
          @dragover.prevent="dragOver = true"
          @dragleave="dragOver = false"
          @drop.prevent="onDropFile"
        >
          <Upload :size="24" stroke-width="1.75" aria-hidden="true" />
          <b>{{ t('bd.dropTitle') }}</b>
          <span>{{ t('bd.dropHint') }}</span>
          <label class="bd-btn" style="cursor: pointer">
            {{ t('bd.chooseFile') }}
            <input type="file" accept=".plectro,.zip" class="bd-sr" @change="onPickFile" />
          </label>
          <span v-if="fileError" class="bd-err" role="alert">{{ fileError }}</span>
          <span v-if="uploading" class="bd-hint">{{ t('bd.installing') }}</span>
        </div>
        <div v-if="busy">
          <p class="bd-hint">{{ t('bd.installing') }}</p>
        </div>
        <div v-if="props.installProgress" class="bd-prog" :class="{ 'bd-err-box': installFailed }" role="status" aria-live="polite">
          <RefreshCw v-if="!installDone" :size="16" stroke-width="1.75" aria-hidden="true" class="bd-spin" />
          <div class="bd-progcol">
            <div>
              <b>{{ installFailed ? t('bd.installFailed') : t('bd.installing') }} · {{ stageLabel }}</b>
              <p>{{ props.installProgress.message }}</p>
            </div>
            <div class="bd-progbar" :class="{ 'bd-indet': progressIndet }" role="progressbar" :aria-valuenow="progressIndet ? undefined : progressPct" aria-valuemin="0" aria-valuemax="100">
              <i :style="progressIndet ? undefined : { width: progressPct + '%' }"></i>
            </div>
          </div>
          <button v-if="installDone" class="bd-btn" @click="emit('dismiss-install-progress')">{{ t('bd.close') }}</button>
        </div>
        <div v-if="installed.length">
          <div v-for="p in installed" :key="p.id" class="bd-lrow">
            <div class="bd-tile">
              <component :is="p.icon" :size="20" stroke-width="1.75" aria-hidden="true" />
            </div>
            <div style="flex: 1; min-width: 0">
              <b>{{ p.name }} <span v-if="p.privileged" title="Pide acceso amplio al sistema">⚠️</span></b>
              <p>{{ t('bd.actionsCount', { n: p.actions }) }} · v{{ p.version }} · {{ p.by }}</p>
              <p v-if="p.status === 'error'" class="bd-err">{{ p.lastError }}</p>
              <p v-else-if="p.status === 'needs-runtime'" class="bd-hint">⚠️ {{ t('bd.pluginNeedsRuntime') }}</p>
              <p v-else-if="!p.on" class="bd-hint">{{ t('bd.disabled') }}</p>
              <p v-if="p.previousVersion" class="bd-hint">v{{ p.previousVersion }} → v{{ p.version }} · <button class="bd-chip" @click="emit('rollback-plugin', p.id)">{{ t('bd.rollback') }}</button></p>
            </div>
            <button v-if="p.status === 'error' || !p.loaded" class="bd-btn" @click="emit('reload-plugin', p.id)" :disabled="busyId === p.id">
              <RefreshCw v-if="busyId === p.id" :size="14" stroke-width="2" aria-hidden="true" class="bd-spin" />
              {{ t('bd.reload') }}
            </button>
            <button v-if="p.sourceType === 'git' || p.sourceType === 'marketplace'" class="bd-btn" @click="emit('update-plugin', p.id)" :disabled="busyId === p.id">
              <RefreshCw v-if="busyId === p.id" :size="14" stroke-width="2" aria-hidden="true" class="bd-spin" />
              {{ busyId === p.id ? t('bd.installing') : t('bd.update') }}
            </button>
            <RefreshCw v-if="busyId === p.id" :size="16" stroke-width="2" aria-hidden="true" class="bd-spin" />
            <label class="bd-sw">
              <input type="checkbox" :checked="p.on" :aria-label="p.name" :disabled="p.builtin || busyId === p.id" @change="emit('toggle-plugin', p.id, ($event.target as HTMLInputElement).checked)" />
              <span></span>
            </label>
            <button v-if="!p.builtin" class="bd-btn bd-dng" @click="emit('remove-plugin', p.id, p.name)">{{ t('bd.remove') }}</button>
          </div>
        </div>
        <p v-else class="bd-hint">{{ t('bd.noPlugins') }}</p>
      </template>

      <!-- Github (importar desde URL) -->
      <template v-else-if="ptab === 'gh'">
        <div class="bd-mk-tools">
          <div class="bd-mk-url">
            <label class="bd-mk-label" for="bd-url">{{ t('bd.installFromUrl') }}</label>
            <div class="bd-r2">
              <input type="url" id="bd-url" class="bd-inp" :placeholder="t('bd.installFromUrl')" autocomplete="off" spellcheck="false" inputmode="url" v-model="urlDraft" @keydown.enter="installUrl" />
              <button class="bd-btn bd-pri" :disabled="!urlDraft.trim() || installingUrl" @click="installUrl">{{ installingUrl ? t('bd.installing') : t('bd.install') }}</button>
            </div>
          </div>
        </div>
        <div v-if="props.installProgress" class="bd-prog" :class="{ 'bd-err-box': installFailed }" role="status" aria-live="polite">
          <RefreshCw v-if="!installDone" :size="16" stroke-width="1.75" aria-hidden="true" class="bd-spin" />
          <div class="bd-progcol">
            <div>
              <b>{{ installFailed ? t('bd.installFailed') : t('bd.installing') }} · {{ stageLabel }}</b>
              <p>{{ props.installProgress.message }}</p>
            </div>
            <div class="bd-progbar" :class="{ 'bd-indet': progressIndet }" role="progressbar" :aria-valuenow="progressIndet ? undefined : progressPct" aria-valuemin="0" aria-valuemax="100">
              <i :style="progressIndet ? undefined : { width: progressPct + '%' }"></i>
            </div>
          </div>
          <button v-if="installDone" class="bd-btn" @click="emit('dismiss-install-progress')">{{ t('bd.close') }}</button>
        </div>
        <p v-if="urlError" class="bd-err" role="alert">{{ urlError }}</p>
      </template>

      <!-- Crear con IA: acceso directo a la sección MCP de Ajustes -->
      <template v-else>
        <div class="bd-mcp">
          <div class="bd-row2">
            <b>{{ t('bd.mcpTitleSelf') }}</b>
            <span><i class="bd-dot bd-ok"></i>{{ t('bd.connected') }}</span>
          </div>
          <p class="bd-hint">{{ t('bd.mcpHintSelf') }}</p>
          <button class="bd-btn bd-pri" @click="emit('open-mcp-settings')">{{ t('bd.mcpGoTo') }}</button>
        </div>

        <div class="bd-chat">
          <div v-if="!chat.length">
            <p class="bd-hint">{{ t('bd.aiHint') }}</p>
            <div class="bd-chips">
              <button v-for="idea in ideas" :key="idea" class="bd-chip" @click="sendIdea(idea)">{{ idea }}</button>
            </div>
          </div>
          <div v-for="(m, i) in chat" :key="i" class="bd-msg" :class="{ 'bd-me': m.me }">
            {{ m.text }}
          </div>
          <div v-if="typing" class="bd-msg">Escribiendo…</div>
        </div>

        <div class="bd-comp">
          <label class="bd-sr" for="bd-cin">{{ t('bd.aiPlaceholder') }}</label>
          <textarea id="bd-cin" class="bd-inp" rows="2" :placeholder="t('bd.aiPlaceholder')" v-model="draft" @keydown.enter.exact.prevent="send"></textarea>
          <button class="bd-btn bd-pri" @click="send">{{ t('bd.send') }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Upload, RefreshCw, Package } from 'lucide-vue-next'
import * as LucideIcons from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

export type PluginsTab = 'inst' | 'gh' | 'ai'

interface Props {
  plugins?: any[]
  detailed?: any[]
  busyId?: string | null
  uploading?: boolean
  installProgress?: { key: string; stage: string; message: string } | null
}

interface Emits {
  (e: 'toggle-plugin', pluginId: string, on: boolean): void
  (e: 'remove-plugin', pluginId: string, name: string): void
  (e: 'install-file', file: File): void
  (e: 'install-url', url: string): void
  (e: 'update-plugin', pluginId: string): void
  (e: 'rollback-plugin', pluginId: string): void
  (e: 'reload-plugin', pluginId: string): void
  (e: 'open-mcp-settings'): void
  (e: 'dismiss-install-progress'): void
  (e: 'notify', message: string, undo?: () => void): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const ptab = ref<PluginsTab>('inst')

const tabs = computed(() => [
  { id: 'inst' as const, label: t('bd.tabInstalled') },
  { id: 'gh' as const, label: t('bd.tabGithub') },
  { id: 'ai' as const, label: t('bd.tabAi') }
])

const icons = LucideIcons as Record<string, any>

const installed = computed(() =>
  (props.detailed ?? []).map((p: any) => ({
    id: p.id,
    name: p.name ?? p.id,
    version: p.version ?? '?',
    by: p.author ?? '',
    actions: p.actionsCount ?? 0,
    on: !!p.enabled,
    loaded: !!p.loaded,
    status: p.status ?? 'active',
    lastError: p.lastError ?? null,
    builtin: p.sourceType === 'builtin',
    sourceType: p.sourceType ?? null,
    previousVersion: p.previousVersion ?? null,
    privileged: !!p.privileged,
    icon: icons[p.manifest?.icon] ?? Package
  }))
)

const busy = computed(() => !!props.uploading || !!props.busyId)

// Subida real: valida extensión y emite el File al padre
const dragOver = ref(false)
const fileError = ref('')
const takeFile = (f: File | undefined) => {
  if (!f) return
  if (!/\.(plectro|zip)$/i.test(f.name)) {
    fileError.value = t('bd.invalidPlugin', { name: f.name })
    return
  }
  fileError.value = ''
  emit('install-file', f)
}
const onDropFile = (e: DragEvent) => {
  dragOver.value = false
  takeFile(e.dataTransfer?.files?.[0])
}
const onPickFile = (e: Event) => {
  takeFile((e.target as HTMLInputElement).files?.[0])
  ;(e.target as HTMLInputElement).value = ''
}

// Progreso de instalación en vivo (viene por WS desde el daemon)
const installDone = computed(() => ['done', 'error'].includes(props.installProgress?.stage ?? ''))
const installFailed = computed(() => props.installProgress?.stage === 'error')

// Barra de progreso: cada stage del daemon mapea a un % determinista.
// Los stages desconocidos / en curso sin % usan modo indeterminado.
const STAGE_PCT: Record<string, number> = {
  download: 10,
  clone: 20,
  extract: 30,
  detect: 40,
  validate: 55,
  deps: 65,
  activate: 75,
  load: 88,
  done: 100,
  error: 100,
}
const progressPct = computed(() => STAGE_PCT[props.installProgress?.stage ?? ''] ?? 50)
const progressIndet = computed(() => {
  const s = props.installProgress?.stage ?? ''
  return !(s in STAGE_PCT)
})
const stageLabel = computed(() => {
  const s = props.installProgress?.stage ?? ''
  const map: Record<string, string> = {
    download: 'descargando',
    clone: 'clonando',
    extract: 'extrayendo',
    detect: 'detectando',
    validate: 'validando',
    deps: 'dependencias',
    activate: 'activando',
    load: 'arrancando',
    done: 'listo',
    error: 'error',
  }
  return map[s] ?? (s || '…')
})

// Github: importar desde URL (repo git o .zip)
const urlDraft = ref('')
const installingUrl = ref(false)
const urlError = ref('')
const installUrl = () => {
  const url = urlDraft.value.trim()
  if (!url) return
  installingUrl.value = true
  urlError.value = ''
  emit('install-url', url)
}
watch(
  () => props.installProgress,
  (p) => {
    if (p && ['done', 'error'].includes(p.stage)) {
      installingUrl.value = false
      if (p.stage === 'done') urlDraft.value = ''
    }
  }
)

// Servidor MCP propio: la gestión vive en Ajustes → MCP (ver McpPane)
const ideas = [
  'Un botón que alterne la luz de mi escritorio',
  'Publicar un mensaje con el título del directo',
  'Crear una nota rápida en Notion'
]
const chat = ref<Array<{ me: boolean; text: string }>>([])
const draft = ref('')
const typing = ref(false)
const sendIdea = (idea: string) => sendText(idea)
const send = () => {
  const text = draft.value.trim()
  if (!text) return
  draft.value = ''
  sendText(text)
}
const sendText = (text: string) => {
  chat.value.push({ me: true, text })
  typing.value = true
  setTimeout(() => {
    typing.value = false
    chat.value.push({
      me: false,
      text: t('bd.aiProposal'),
    })
  }, 1100)
}

const setTab = (tab: PluginsTab) => {
  ptab.value = tab
}

defineExpose({ setTab })
</script>
