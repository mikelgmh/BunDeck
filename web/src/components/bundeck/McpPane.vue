<template>
  <div class="bd-mcp" data-cy="bd-mcp">
    <div class="bd-row2">
      <b>{{ t('bd.mcpTitleSelf') }}</b>
      <span><i class="bd-dot bd-ok"></i>{{ t('bd.connected') }}</span>
    </div>
    <div class="bd-r2">
      <label class="bd-sr" for="bd-mcp-url">{{ t('bd.mcpUrlLabel') }}</label>
      <input type="text" id="bd-mcp-url" class="bd-inp" readonly :value="props.mcpUrl" @focus="($event.target as HTMLInputElement).select()" />
      <button class="bd-btn" @click="copyMcpUrl">{{ t('bd.copy') }}</button>
      <button class="bd-btn" :title="t('bd.mcpCopyConfig')" @click="copyMcpJson">{{ t('bd.mcpCopyConfig') }}</button>
    </div>
    <p class="bd-hint">{{ t('bd.mcpHintSelf') }}</p>

    <div class="bd-warnbox" role="note">
      <ShieldAlert :size="20" stroke-width="1.75" aria-hidden="true" />
      <p>{{ t('bd.mcpAdminWarning') }}</p>
    </div>

    <!-- Secreto recién creado: solo se muestra una vez -->
    <div v-if="newSecret" class="bd-r2">
      <input type="text" class="bd-inp" readonly :value="newSecret" @focus="($event.target as HTMLInputElement).select()" />
      <button class="bd-btn bd-pri" @click="copySecret">{{ t('bd.copy') }}</button>
    </div>
    <p v-if="newSecret" class="bd-err" role="alert">{{ t('bd.mcpTokenOnce') }}</p>

    <!-- Tokens -->
    <div v-if="(props.mcpTokens ?? []).length" class="bd-toks">
      <div v-for="tok in (props.mcpTokens ?? [])" :key="tok.id" class="bd-tok">
        <div class="bd-row2">
          <div style="min-width: 0">
            <b>{{ tok.name }}</b>
            <p class="bd-hint" style="margin: 0">{{ tok.prefix }} · {{ formatDate(tok.createdAt) }}</p>
          </div>
          <span class="bd-chip" v-if="isAdmin(tok)" :title="t('bd.mcpFullAccess')">{{ t('bd.mcpFullAccess') }}</span>
          <span class="bd-chip" v-else>{{ t('bd.mcpScopesCount', { n: (tok.scopes ?? []).length }) }}</span>
        </div>
        <div v-if="!isAdmin(tok)" class="bd-chips">
          <kbd class="bd-kbd" v-for="s in (tok.scopes ?? [])" :key="s">{{ s }}</kbd>
        </div>
        <!-- Editor de permisos -->
        <div v-if="editingId === tok.id" class="bd-scopes">
          <div v-for="g in scopeGroups" :key="g.id" class="bd-scope-group">
            <label class="bd-scope-head">
              <input
                type="checkbox"
                :checked="groupChecked(tok.id, g.id)"
                :indeterminate="groupIndeterminate(tok.id, g.id)"
                @change="toggleGroup(tok.id, g.id, ($event.target as HTMLInputElement).checked)"
              />
              {{ t(`bd.${g.label}`) }}
            </label>
            <div class="bd-scope-grid">
              <label v-for="s in g.scopes" :key="s.id" class="bd-scope" :title="s.id">
                <input
                  type="checkbox"
                  :checked="!!editSel[s.id]"
                  @change="editSel[s.id] = ($event.target as HTMLInputElement).checked"
                />
                <kbd class="bd-kbd">{{ s.id }}</kbd>
              </label>
            </div>
          </div>
          <div class="bd-r2">
            <button class="bd-btn" @click="selectAllEdit">{{ t('bd.mcpSelectAll') }}</button>
            <button class="bd-btn" @click="selectNoneEdit">{{ t('bd.mcpSelectNone') }}</button>
            <span class="bd-sp"></span>
            <button class="bd-btn" @click="cancelEdit">{{ t('bd.mcpCancel') }}</button>
            <button class="bd-btn bd-pri" :disabled="savingEdit" @click="saveEdit(tok.id)">{{ t('bd.mcpSave') }}</button>
          </div>
          <p v-if="editError" class="bd-err" role="alert">{{ editError }}</p>
        </div>
        <div v-else class="bd-r2">
          <button class="bd-btn" @click="startEdit(tok)">{{ t('bd.mcpEditScopes') }}</button>
          <span class="bd-sp"></span>
          <button class="bd-btn bd-dng" @click="emit('revoke-mcp-token', tok.id)">{{ t('bd.remove') }}</button>
        </div>
      </div>
    </div>
    <p v-else class="bd-hint">{{ t('bd.mcpNoTokens') }}</p>

    <!-- Crear token -->
    <div class="bd-mcp-new">
      <b>{{ t('bd.mcpCreateTitle') }}</b>
      <div class="bd-r2">
        <label class="bd-sr" for="bd-mcp-tname">{{ t('bd.mcpTokenName') }}</label>
        <input type="text" id="bd-mcp-tname" class="bd-inp" :placeholder="t('bd.mcpTokenName')" v-model="tokenName" @keydown.enter="createToken" />
      </div>
      <p class="bd-hint">{{ t('bd.mcpScopesTitle') }}</p>
      <div class="bd-scopes">
        <div class="bd-r2" style="margin-bottom: 4px">
          <button class="bd-btn" @click="selectAllNew">{{ t('bd.mcpSelectAll') }}</button>
          <button class="bd-btn" @click="selectNoneNew">{{ t('bd.mcpSelectNone') }}</button>
        </div>
        <div v-for="g in scopeGroups" :key="g.id" class="bd-scope-group">
          <label class="bd-scope-head">
            <input
              type="checkbox"
              :checked="newGroupChecked(g.id)"
              :indeterminate="newGroupIndeterminate(g.id)"
              @change="toggleNewGroup(g.id, ($event.target as HTMLInputElement).checked)"
            />
            {{ t(`bd.${g.label}`) }}
          </label>
          <div class="bd-scope-grid">
            <label v-for="s in g.scopes" :key="s.id" class="bd-scope" :title="s.id">
              <input type="checkbox" v-model="newSel[s.id]" />
              <kbd class="bd-kbd">{{ s.id }}</kbd>
            </label>
          </div>
        </div>
      </div>
      <p v-if="tokenError" class="bd-err" role="alert">{{ tokenError }}</p>
      <button class="bd-btn bd-pri" :disabled="creatingToken || !tokenName.trim()" @click="createToken">
        {{ creatingToken ? t('bd.installing') : t('bd.mcpCreate') }}
      </button>
    </div>

    <!-- Catálogo de herramientas -->
    <div class="bd-mcp-tools">
      <b>{{ t('bd.mcpToolsTitle') }}</b>
      <div class="bd-srch">
        <Search :size="16" stroke-width="1.75" aria-hidden="true" />
        <input type="search" class="bd-inp" :placeholder="t('bd.searchActions')" v-model="toolFilter" :aria-label="t('bd.mcpToolsTitle')" />
      </div>
      <details v-for="g in filteredToolGroups" :key="g.id" class="bd-tgroup" open>
        <summary>{{ t(`bd.${g.label}`) }} · {{ g.tools.length }}</summary>
        <div class="bd-chips">
          <kbd class="bd-kbd" v-for="tool in g.tools" :key="tool">{{ tool }}</kbd>
        </div>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, reactive } from 'vue'
import { ShieldAlert, Search } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

interface Props {
  mcpUrl?: string
  mcpTokens?: any[]
  mcpSecret?: string | null
  mcpScopes?: Array<{ id: string; group: string }>
}

interface Emits {
  (e: 'create-mcp-token', name: string, scopes: string[]): void
  (e: 'update-mcp-token', id: string, patch: { scopes: string[] }): void
  (e: 'revoke-mcp-token', id: string): void
  (e: 'notify', message: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

// Catálogo de herramientas por grupo (refleja daemon/src/mcp/server.ts TOOL_DEFS).
const TOOL_GROUPS = [
  { id: 'profiles', label: 'mcpGroupProfiles', tools: ['list_profiles', 'get_profile', 'create_profile', 'update_profile', 'delete_profile', 'set_current_profile'] },
  { id: 'pages', label: 'mcpGroupPages', tools: ['list_pages', 'get_page', 'create_page', 'update_page', 'delete_page', 'set_current_page'] },
  { id: 'buttons', label: 'mcpGroupButtons', tools: ['list_buttons', 'get_button', 'create_button', 'update_button', 'delete_button', 'move_button', 'reorder_buttons', 'duplicate_button', 'press_button', 'add_button_action', 'update_button_action', 'remove_button_action', 'reorder_button_actions'] },
  { id: 'actions', label: 'mcpGroupActions', tools: ['list_actions', 'execute_action'] },
  { id: 'plugins', label: 'mcpGroupPlugins', tools: ['get_plugin_template', 'validate_manifest', 'install_plugin', 'install_plugin_from_git', 'list_plugins', 'get_plugin', 'enable_plugin', 'disable_plugin', 'reload_plugin', 'rollback_plugin', 'update_plugin', 'uninstall_plugin', 'get_plugin_settings', 'save_plugin_settings'] },
  { id: 'system', label: 'mcpGroupSystem', tools: ['get_state', 'list_settings', 'get_setting', 'set_setting', 'get_logs'] },
]

const GROUP_LABEL: Record<string, string> = {
  profiles: 'mcpGroupProfiles',
  pages: 'mcpGroupPages',
  buttons: 'mcpGroupButtons',
  actions: 'mcpGroupActions',
  plugins: 'mcpGroupPlugins',
  system: 'mcpGroupSystem',
}

const scopeGroups = computed(() => {
  const order = ['profiles', 'pages', 'buttons', 'actions', 'plugins', 'system']
  const byGroup = new Map<string, Array<{ id: string; group: string }>>()
  for (const s of props.mcpScopes ?? []) {
    if (!byGroup.has(s.group)) byGroup.set(s.group, [])
    byGroup.get(s.group)!.push(s)
  }
  return order.filter((g) => byGroup.has(g)).map((g) => ({ id: g, label: GROUP_LABEL[g] ?? g, scopes: byGroup.get(g)! }))
})

const allScopeIds = computed(() => (props.mcpScopes ?? []).map((s) => s.id))

const copyText = async (text: string, doneMsg?: string) => {
  try {
    await navigator.clipboard.writeText(text)
    if (doneMsg) emit('notify', doneMsg)
  } catch { /* portapapeles no disponible */ }
}
const copyMcpUrl = () => { if (props.mcpUrl) void copyText(props.mcpUrl) }
const copySecret = () => { if (newSecret.value) void copyText(newSecret.value) }
const copyMcpJson = () => {
  const snippet = JSON.stringify({ mcpServers: { libredeck: { type: 'streamable-http', url: props.mcpUrl ?? '', headers: { Authorization: 'Bearer <TOKEN>' } } } }, null, 2)
  void copyText(snippet, t('bd.copied'))
}

const formatDate = (ts: number) => {
  try { return new Date(ts).toLocaleDateString() } catch { return '' }
}
const isAdmin = (tok: any) => (tok.scopes ?? []).length >= allScopeIds.value.length && allScopeIds.value.length > 0

// ---- Crear token ----
const tokenName = ref('')
const creatingToken = ref(false)
const tokenError = ref('')
const newSecret = ref('')
const newSel = reactive<Record<string, boolean>>({})
watch(allScopeIds, (ids) => {
  for (const id of ids) if (!(id in newSel)) newSel[id] = true
}, { immediate: true })
const selectAllNew = () => { for (const id of allScopeIds.value) newSel[id] = true }
const selectNoneNew = () => { for (const id of allScopeIds.value) newSel[id] = false }
const newGroupChecked = (group: string) => {
  const ids = (props.mcpScopes ?? []).filter((s) => s.group === group).map((s) => s.id)
  return ids.length > 0 && ids.every((id) => newSel[id])
}
const newGroupIndeterminate = (group: string) => {
  const ids = (props.mcpScopes ?? []).filter((s) => s.group === group).map((s) => s.id)
  const n = ids.filter((id) => newSel[id]).length
  return n > 0 && n < ids.length
}
const toggleNewGroup = (group: string, on: boolean) => {
  for (const s of props.mcpScopes ?? []) if (s.group === group) newSel[s.id] = on
}
const createToken = () => {
  if (!tokenName.value.trim() || creatingToken.value) return
  tokenError.value = ''
  newSecret.value = ''
  creatingToken.value = true
  const scopes = allScopeIds.value.filter((id) => newSel[id])
  emit('create-mcp-token', tokenName.value.trim(), scopes)
}

// ---- Editar permisos de un token ----
const editingId = ref<string | null>(null)
const editSel = reactive<Record<string, boolean>>({})
const editError = ref('')
const savingEdit = ref(false)
const startEdit = (tok: any) => {
  editingId.value = tok.id
  editError.value = ''
  for (const id of allScopeIds.value) editSel[id] = (tok.scopes ?? []).includes(id)
}
const cancelEdit = () => { editingId.value = null; editError.value = ''; savingEdit.value = false }
const selectAllEdit = () => { for (const id of allScopeIds.value) editSel[id] = true }
const selectNoneEdit = () => { for (const id of allScopeIds.value) editSel[id] = false }
const groupChecked = (_tokId: string, group: string) => {
  const ids = (props.mcpScopes ?? []).filter((s) => s.group === group).map((s) => s.id)
  return ids.length > 0 && ids.every((id) => editSel[id])
}
const groupIndeterminate = (_tokId: string, group: string) => {
  const ids = (props.mcpScopes ?? []).filter((s) => s.group === group).map((s) => s.id)
  const n = ids.filter((id) => editSel[id]).length
  return n > 0 && n < ids.length
}
const toggleGroup = (_tokId: string, group: string, on: boolean) => {
  for (const s of props.mcpScopes ?? []) if (s.group === group) editSel[s.id] = on
}
const saveEdit = (id: string) => {
  editError.value = ''
  savingEdit.value = true
  emit('update-mcp-token', id, { scopes: allScopeIds.value.filter((sid) => editSel[sid]) })
}

// El padre entrega el secreto recién creado por prop; también resetea edición al recargar tokens
watch(() => props.mcpSecret, (s) => {
  creatingToken.value = false
  if (s) { newSecret.value = s; tokenName.value = '' }
})
watch(() => props.mcpTokens, () => {
  savingEdit.value = false
  if (editingId.value) editingId.value = null
})

// ---- Catálogo de herramientas con filtro ----
const toolFilter = ref('')
const filteredToolGroups = computed(() => {
  const q = toolFilter.value.trim().toLowerCase()
  if (!q) return TOOL_GROUPS
  return TOOL_GROUPS.map((g) => ({ ...g, tools: g.tools.filter((x) => x.toLowerCase().includes(q)) })).filter((g) => g.tools.length > 0)
})
</script>
