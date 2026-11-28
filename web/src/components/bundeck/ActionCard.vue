<template>
  <div class="bd-ah">
    <slot name="handle">
      <span class="bd-n">{{ index + 1 }}</span>
    </slot>
    <component :is="actionIcon(action.type)" :size="16" stroke-width="1.75" aria-hidden="true" />
    <b :title="actionName(action.type)">{{ actionName(action.type) }}</b>
    <span
      v-if="actionSurface(action.type) === 'control'"
      class="bd-tag bd-tag-ctl"
      :title="t('bd.actControlHint')"
      data-cy="bd-action-badge-control"
    >{{ t('bd.actControl') }}</span>
    <span
      v-else-if="actionSurface(action.type) === 'data'"
      class="bd-tag"
      :title="t('bd.actDataHint')"
      data-cy="bd-action-badge-data"
    >{{ t('bd.actData') }}</span>
    <slot name="extra-buttons"></slot>
    <button :aria-label="'Quitar'" title="Quitar" @click="emit('remove', index)">
      <X :size="16" stroke-width="1.75" aria-hidden="true" />
    </button>
  </div>

  <!-- Acciones locales: controles propios -->
  <template v-if="action.type === 'local.set-var'">
    <div class="bd-fld" style="margin: 8px 4px 0 0">
      <div class="bd-eq">
        <select
          class="bd-inp"
          :value="action.parameters?.name ?? ''"
          aria-label="Variable"
          @change="emit('update-param', index, 'name', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">Variable…</option>
          <option v-for="v in varList" :key="v.n" :value="v.n">{{ v.n }}</option>
        </select>
        <span class="bd-mono">=</span>
        <input
          type="text"
          class="bd-inp bd-mono"
          :value="action.parameters?.expr ?? ''"
          placeholder="contador + 1"
          spellcheck="false"
          aria-label="Expresión"
          @input="emit('update-param', index, 'expr', ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>
  </template>
  <template v-else-if="action.type === 'local.toggle-var'">
    <div class="bd-fld" style="margin: 8px 4px 0 0">
      <label class="bd-sr">Variable</label>
      <select
        class="bd-inp"
        :value="action.parameters?.name ?? ''"
        @change="emit('update-param', index, 'name', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">Variable…</option>
        <option v-for="v in varList" :key="v.n" :value="v.n">{{ v.n }}</option>
      </select>
    </div>
  </template>
  <template v-else-if="action.type === 'local.toast'">
    <div class="bd-fld" style="margin: 8px 4px 0 0">
      <input
        type="text"
        class="bd-inp"
        :value="action.parameters?.text ?? ''"
        :placeholder="t('bd.actionFallback.toastPlaceholder', { vars: '{{variables}}' })"
        @input="emit('update-param', index, 'text', ($event.target as HTMLInputElement).value)"
      />
    </div>
  </template>

  <!-- Parámetros: esquema del plugin si existe, controles nativos si no -->
  <SchemaForm
    v-else-if="hasSchemaFields"
    :schema="actionSchema(action.type)"
    :model-value="action.parameters ?? {}"
    :available-pages="availablePages"
    :plugin-id="actionMeta(action.type).pluginId"
    :action-id="actionMeta(action.type).actionId"
    :dynamic-options="actionMeta(action.type).dynamicOptions"
    @update:model-value="(params: any) => emitParams(params)"
  />
  <div v-else-if="showConfigNotice" class="bd-action-config-note" data-cy="bd-action-config-note">
    <p class="bd-hint">{{ t('bd.actionNoParams') }}</p>
    <p v-if="actionDescription" class="bd-hint">{{ actionDescription }}</p>
    <template v-if="actionMeta(action.type).hasPluginSettings">
      <p class="bd-hint">
        {{ t('bd.actionPluginSettingsHint', { plugin: actionMeta(action.type).pluginName }) }}
      </p>
      <button
        class="bd-btn bd-wide"
        type="button"
        data-cy="bd-open-plugin-settings"
        data-swapy-no-drag
        @click="openPluginSettings(action.type)"
      >
        <Settings :size="15" stroke-width="1.75" aria-hidden="true" />
        {{ t('bd.openPluginSettings') }}
      </button>
    </template>
    <p v-else class="bd-hint">{{ t('bd.actionNoExtraConfig') }}</p>
  </div>
  <div v-else class="bd-fld" style="margin: 8px 4px 0 0">
    <template v-if="paramKind(action.type) === 'text'">
      <input
        type="text"
        class="bd-inp"
        :value="action.parameters?.[paramKey(action.type)] ?? ''"
        @input="emit('update-param', index, paramKey(action.type), ($event.target as HTMLInputElement).value)"
      />
    </template>
    <template v-else-if="paramKind(action.type) === 'http'">
      <input
        type="text"
        class="bd-inp"
        :value="action.parameters?.url ?? ''"
        placeholder="https://"
        @input="emit('update-param', index, 'url', ($event.target as HTMLInputElement).value)"
      />
      <select
        class="bd-inp"
        style="margin-top: 8px"
        :value="action.parameters?.method ?? 'GET'"
        @change="emit('update-param', index, 'method', ($event.target as HTMLSelectElement).value)"
      >
        <option>GET</option>
        <option>POST</option>
        <option>PUT</option>
        <option>DELETE</option>
      </select>
    </template>
    <template v-else-if="paramKind(action.type) === 'multimedia'">
      <select
        class="bd-inp"
        :value="action.parameters?.action ?? 'playpause'"
        @change="emit('update-param', index, 'action', ($event.target as HTMLSelectElement).value)"
      >
        <option value="playpause">playpause</option>
        <option value="next">next</option>
        <option value="prev">prev</option>
        <option value="volup">volup</option>
        <option value="voldow">voldow</option>
        <option value="mute">mute</option>
      </select>
    </template>
    <template v-else-if="paramKind(action.type) === 'page'">
      <label class="bd-lb" :for="`bd-pg-${index}`">{{ t('bd.addPage') }}</label>
      <select
        :id="`bd-pg-${index}`"
        class="bd-inp"
        :value="action.parameters?.pageId ?? ''"
        @change="emit('update-param', index, 'pageId', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">{{ t('bd.addPage') }}</option>
        <option v-for="p in availablePages" :key="p.id" :value="p.id" :disabled="p.disabled" :title="p.disabledReason ?? p.name">{{ p.name }}{{ p.disabledReason ? ` (${p.disabledReason})` : '' }}</option>
      </select>
    </template>
    <template v-else>
      <div v-for="([k, v], pi) in Object.entries(action.parameters ?? {})" :key="pi" style="margin-top: 8px">
        <label class="bd-lb">{{ k }}</label>
        <input
          :type="typeof v === 'number' ? 'number' : 'text'"
          class="bd-inp"
          :value="v as any"
          @input="emit('update-param', index, k, coerce(($event.target as HTMLInputElement).value, v))"
        />
      </div>
    </template>
  </div>

  <label v-if="showWait" class="bd-dl2">
    {{ t('bd.waitAfter') }}
    <input
      type="number"
      class="bd-inp"
      :value="action.waitMs ?? 0"
      min="0"
      step="100"
      aria-label="Espera en milisegundos"
      @input="emit('update-action', index, { waitMs: +($event.target as HTMLInputElement).value || 0 })"
    />
    ms
  </label>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { X, Settings, Variable, ToggleLeft, MessageSquare } from 'lucide-vue-next'
import { dynamicIcon } from '../../composables/useDynamicIcon'
import SchemaForm from '../SchemaForm.vue'
import { useI18nStore } from '../../composables/useI18n'
import { usePluginLocale } from '../../composables/usePluginLocale'
import { actionSurfaceKind } from '../../composables/useActionPresentation'
import { vars } from '../../composables/useVars'

const { t } = useI18nStore()
const { currentLocale, localizeActionField } = usePluginLocale()

interface Props {
  action: any
  index: number
  showWait: boolean
  plugins: any[]
  availablePages: Array<{ id: string; name: string; disabled?: boolean; disabledReason?: string }>
}

interface Emits {
  (e: 'update-action', index: number, patch: Record<string, any>): void
  (e: 'update-param', index: number, paramKey: string, value: any): void
  (e: 'remove', index: number): void
  (e: 'open-plugin-settings', pluginId: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const varList = computed(() => vars.value)
/** Locales: sincrónicos (tree-shaken). Plugins: diferidos por nombre. */
const localActionIcons: Record<string, any> = {
  'local.set-var': Variable,
  'local.toggle-var': ToggleLeft,
  'local.toast': MessageSquare,
}

function findPluginAction(type: string): any | null {
  for (const entry of props.plugins ?? []) {
    const [pid, pdata] = entry
    for (const [aid, adata] of pdata?.actions ?? []) {
      if (`${pid}.${aid}` === type) return adata
    }
  }
  return null
}
const actionName = (type: string) => {
  if (type === 'local.set-var') return t('bd.varSet')
  if (type === 'local.toggle-var') return t('bd.varToggle')
  if (type === 'local.toast') return t('bd.varToast')
  const found = findPluginAction(type)
  if (found) return localizeActionField(found, 'name', currentLocale.value, type)
  const base = type.includes('.') ? type.split('.')[1] : type
  const names: Record<string, string> = {
    shell: t('bd.actionFallback.shell'),
    http: t('bd.actionFallback.http'),
    hotkey: t('bd.actionFallback.hotkey'),
    type: t('bd.actionFallback.type'),
    multimedia: t('bd.actionFallback.multimedia'),
    page: t('bd.actionFallback.page'),
    'open-app': t('bd.actionFallback.openApp'),
    'open-url': t('bd.actionFallback.openUrl'),
    delay: t('bd.actionFallback.delay')
  }
  return names[base] ?? base.toUpperCase()
}
const actionIcon = (type: string) => {
  if (localActionIcons[type]) return localActionIcons[type]
  const found = findPluginAction(type)
  const name = found?.icon ?? 'Settings'
  return dynamicIcon(name) ?? Settings
}
const actionSchema = (type: string) => findPluginAction(type)?.schema ?? null
/** pluginId/actionId + optionsFrom para listas remotas en SchemaForm. */
const actionMeta = (type: string) => {
  const found = findPluginAction(type)
  if (!type.includes('.')) return {
    pluginId: null,
    actionId: null,
    dynamicOptions: null,
    pluginName: '',
    hasPluginSettings: false,
    description: '',
  }
  const [pid, ...rest] = type.split('.')
  const pluginData = (props.plugins ?? []).find((entry: any) => entry?.[0] === pid)?.[1]
  const settingsProperties = pluginData?.manifest?.settingsSchema?.properties
  return {
    pluginId: pid,
    actionId: rest.join('.'),
    dynamicOptions: found?.optionsFrom ?? null,
    pluginName: pluginData?.manifest?.name ?? pluginData?.name ?? pid,
    hasPluginSettings: !!settingsProperties && Object.keys(settingsProperties).length > 0,
    description: found ? localizeActionField(found, 'description', currentLocale.value, '') : '',
  }
}
const hasSchemaFields = computed(() => {
  const schema = actionSchema(props.action.type)
  return Object.entries(schema?.properties ?? {}).some(([, property]: [string, any]) =>
    property?.ui?.component !== 'hidden'
  )
})
const hasSchema = computed(() => !!actionSchema(props.action.type))
const hasFallbackFields = computed(() =>
  !hasSchema.value && Object.keys(props.action.parameters ?? {}).length > 0
)
const showConfigNotice = computed(() =>
  !hasSchemaFields.value && !hasFallbackFields.value && !!actionMeta(props.action.type).pluginId
)
const actionDescription = computed(() => actionMeta(props.action.type).description)
const openPluginSettings = (type: string) => {
  const pluginId = actionMeta(type).pluginId
  if (pluginId) emit('open-plugin-settings', pluginId)
}
/** Clase de presentación (ejecución | dato | control) para el badge. */
const actionSurface = (type: string) => actionSurfaceKind(findPluginAction(type))

function actionParts(type: string): [string, string] {
  const parts = type.split('.')
  if (parts.length > 1) return [parts[0], parts.slice(1).join('.')]
  return [type, type]
}
function paramKind(type: string): string {
  const [pid, aid] = actionParts(type)
  if (pid === 'page' || aid === 'page') return 'page'
  if (pid === 'multimedia' || aid === 'multimedia') return 'multimedia'
  const base = aid
  if (['shell', 'open-app', 'type'].includes(base)) return 'text'
  if (base === 'http') return 'http'
  if (base === 'hotkey') return 'text'
  if (base === 'open-url') return 'text'
  return 'generic'
}
function paramKey(type: string): string {
  const [, aid] = actionParts(type)
  if (aid === 'open-url') return 'url'
  if (aid === 'hotkey') return 'keys'
  if (aid === 'type') return 'text'
  return 'command'
}
const coerce = (raw: string, prev: any) => (typeof prev === 'number' ? +raw || 0 : raw)

const emitParams = (params: Record<string, any>) => {
  for (const [k, v] of Object.entries(params)) emit('update-param', props.index, k, v)
}
</script>

<style scoped>
.bd-eq {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bd-eq select {
  flex: 1;
  min-width: 120px;
}
.bd-eq .bd-mono {
  flex: none;
}
.bd-eq input {
  flex: 1;
}
.bd-action-config-note {
  display: grid;
  gap: 8px;
  margin: 8px 4px 0 0;
  padding: 12px;
  border: 1px solid var(--bd-ln, #303237);
  border-radius: 12px;
  background: var(--bd-sf, #1a1c1f);
}
.bd-action-config-note p {
  margin: 0;
}
</style>
