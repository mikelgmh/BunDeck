<template>
  <div
    class="bundeck"
    :data-bd-pal="bdResolvedPalette"
    :data-anim="bdAnimations ? 1 : 0"
    :class="{ 'bd-dragging': false }"
    :style="{
      '--bd-ks': bdKeySize + 'px',
      '--bd-rk': bdRadius + 'px',
      '--bd-br': (0.5 + 0.5 * bdBrightness / 100).toFixed(2),
      '--bd-lw': bdShowLeft ? '264px' : '52px',
      '--bd-rw': bdShowRight ? '400px' : '52px'
    }"
  >
    <TitleBar />
    <header class="bd-top">
      <div class="bd-brand">
        <svg class="bd-mark" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="bdg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4d9a8"/><stop offset=".6" stop-color="#e3b77a"/><stop offset="1" stop-color="#c98f52"/></linearGradient></defs><ellipse cx="32" cy="55" rx="21" ry="4" opacity=".2"/><path d="M7 40c0-18 10-29 25-29s25 11 25 29c0 9-7 14-25 14S7 49 7 40" fill="url(#bdg)"/><path d="M14 27c3-8 9-12 16-13" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="3" stroke-linecap="round"/><ellipse cx="19" cy="42" rx="3.5" ry="2.5" fill="#e0806a" opacity=".5"/><ellipse cx="45" cy="42" rx="3.5" ry="2.5" fill="#e0806a" opacity=".5"/><circle cx="24" cy="37" r="2.6" fill="#33200f"/><circle cx="40" cy="37" r="2.6" fill="#33200f"/><path d="M28 42c2 3 6 3 8 0" fill="none" stroke="#33200f" stroke-width="2" stroke-linecap="round"/></svg>
        <span>{{ t('bd.brand') }}</span>
      </div>
      <span
        class="bd-status"
        :class="{ 'bd-on': isConnected }"
        role="status"
        :title="isConnected ? t('bd.connected') : t('bd.disconnected')"
        :aria-label="isConnected ? t('bd.connected') : t('bd.disconnected')"
        data-cy="bd-connection-status"
      ><i aria-hidden="true"></i></span>
      <div class="bd-tabs" role="tablist" :aria-label="t('bd.secProfiles')">
        <button
          v-for="profile in profiles"
          :key="profile.id"
          role="tab"
          class="bd-tab"
          :aria-selected="profile.id === selectedProfile"
          @click="handleProfileChange(profile.id)"
          data-cy="bd-profile-tab"
        >
          {{ profile.name }}
        </button>
        <button
          role="tab"
          class="bd-tab"
          :aria-selected="false"
          :title="t('bd.newProfile')"
          :aria-label="t('bd.newProfile')"
          @click="handleProfileCreate()"
          data-cy="bd-profile-add"
        >
          <Plus :size="16" stroke-width="1.75" aria-hidden="true" />
        </button>
      </div>
      <button class="bd-ibtn" :title="t('bd.plugins')" :aria-label="t('bd.plugins')" @click="settingsDialog?.show('plugins')" data-cy="bd-open-plugins">
        <Puzzle :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
      <button
        class="bd-ibtn"
        :title="t('bd.secDevice')"
        :aria-label="t('bd.secDevice')"
        @click="settingsDialog?.show('device')"
        data-cy="bd-open-device"
        style="position: relative"
      >
        <Monitor :size="20" stroke-width="1.75" aria-hidden="true" />
        <i class="bd-dot" :class="{ 'bd-ok': deviceConnected }" style="position: absolute; top: 4px; right: 4px" aria-hidden="true"></i>
      </button>
      <button
        v-if="!isIPhone"
        class="bd-ibtn"
        :title="isFullscreen ? t('bd.exitFullscreen') : t('bd.fullscreen')"
        :aria-label="isFullscreen ? t('bd.exitFullscreen') : t('bd.fullscreen')"
        @click="toggleFullscreen"
        data-cy="bd-fullscreen"
      >
        <Minimize2 v-if="isFullscreen" :size="20" stroke-width="1.75" aria-hidden="true" />
        <Maximize2 v-else :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
      <button class="bd-ibtn" :title="t('bd.openOnMobile')" :aria-label="t('bd.openOnMobile')" @click="qrDialog?.show()" data-cy="bd-open-qr">
        <QrCode :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
      <div style="position: relative">
        <button
          ref="headerMenuBtn"
          class="bd-ibtn"
          :title="t('bd.moreOptions')"
          :aria-label="t('bd.moreOptions')"
          aria-haspopup="menu"
          :aria-expanded="headerMenuOpen"
          @click="headerMenuOpen = !headerMenuOpen"
          @keydown="onHeaderMenuBtnKey"
          data-cy="bd-open-key-menu"
        >
          <Ellipsis :size="20" stroke-width="1.75" aria-hidden="true" />
        </button>
        <div v-if="headerMenuOpen" class="bd-menu" role="menu" style="right: 0; left: auto; top: calc(100% + 4px)" @keydown="onHeaderMenuKey">
          <button role="menuitem" :disabled="!canExportSelected" @click="onHeaderMenuAction('export')">
            <FileUp :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.exportKey') }}</span>
          </button>
          <button role="menuitem" @click="onHeaderMenuAction('import')">
            <FileDown :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.importKey') }}</span>
          </button>
        </div>
      </div>
      <button class="bd-ibtn" :title="t('bd.settings')" :aria-label="t('bd.settings')" @click="settingsDialog?.show()" data-cy="bd-open-settings">
        <Settings :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
    </header>

    <main class="bd-main">
      <aside id="bd-drw" class="bd-side" :class="{ 'bd-collapsed': !bdShowLeft }" :aria-label="t('bd.libraryLabel')">
        <div>
          <template v-if="bdShowLeft">
            <div class="bd-panelbar">
              <button
                class="bd-ibtn"
                @click="bdSetPanels(false, bdShowRight)"
                :title="t('bd.collapseRight')"
                :aria-label="t('bd.collapseRight')"
                data-cy="bd-collapse-left"
              >
                <PanelLeftClose :size="20" stroke-width="1.75" aria-hidden="true" />
              </button>
            </div>
            <ActionsPanel
              ref="actionsPanel"
              :plugins="plugins"
              :detailed="pluginsDetailed"
              @action-pick="onActionPick"
              @open-plugin-settings="(id) => openPluginSettings(id, 'settings')"
              @open-plugin-instructions="(id) => openPluginSettings(id, 'instructions')"
            />
          </template>
          <div v-else class="bd-rail">
            <button
              class="bd-ibtn"
              @click="bdSetPanels(true, bdShowRight)"
              :title="t('bd.expandRight')"
              :aria-label="t('bd.expandRight')"
              data-cy="bd-expand-left"
            >
              <PanelLeftOpen :size="20" stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>

      <StageBoard
        :grid-cols="gridCols"
        :grid-rows="gridRows"
        :selected-button="selectedButton"
        :executing-buttons="executingButtons"
        :button-config="buttonConfig"
        :get-button="getButton"
        :get-button-data="getButtonData"
        :display-data="(pos: number) => engine.resolveDisplay(pos)"
        :mode="mode"
        :label-mode="bdLabelMode"
        :current-pages="currentPages"
        :current-page="currentPage"
        :nav-trail="navTrail"
        :profile-name="currentProfile?.name ?? ''"
        :busy="pageBusy"
        @button-click="(pos) => selectButton(pos)"
        @button-execute="(pos) => onExecute(pos)"
        @button-long-press="(pos) => engine.execKey(pos, 'long')"
        @button-delete="(pos) => onDeleteButton(pos)"
        @swap="handleSwap"
        @grid-size-change="(dx, dy) => changeGridSize(dx, dy)"
        @mode-change="(m) => setMode(m)"
        @page-select="onPageSelect"
        @page-create="onPageCreate"
        @page-delete="onPageDelete"
        @page-rename="onPageRename"
        @nav-back="onNavBack"
        @action-drop="onActionDrop"
        @button-export="(pos) => openExport(pos)"
        @button-import="(pos) => openImport(pos)"
      />

      <aside id="bd-ins" class="bd-side" :class="{ 'bd-collapsed': !bdShowRight }" :aria-label="t('bd.inspectorLabel')">
        <div>
          <template v-if="bdShowRight">
            <div class="bd-panelbar">
              <button
                class="bd-ibtn"
                @click="bdSetPanels(bdShowLeft, false)"
                :title="t('bd.collapseLeft')"
                :aria-label="t('bd.collapseLeft')"
                data-cy="bd-collapse-right"
              >
                <PanelRightClose :size="20" stroke-width="1.75" aria-hidden="true" />
              </button>
            </div>
            <KeyInspector
              :mode="mode"
              :selected-position="selectedButton"
              :has-button="!!(selectedButton !== null && getButton(selectedButton))"
              :row="selectedButton !== null ? Math.floor(selectedButton / gridCols) : 0"
              :col="selectedButton !== null ? selectedButton % gridCols : 0"
              :button-config="buttonConfig"
              :plugins="plugins"
              :available-pages="availablePages"
              :profile-name="currentProfile?.name ?? ''"
              :page-name="currentPage?.name ?? ''"
              @update-field="onUpdateField"
              @update-action="onUpdateAction"
              @update-action-param="(i, k, v) => updateActionParameter(i, k, v)"
              @move-action="onMoveAction"
              @remove-action="removeAction"
              @reorder-actions="(actions) => reorderActions(actions)"
              @focus-library="focusLibrary"
              @open-palette="(path) => openPalette(path)"
              @test="onTest"
              @clear="onClearKey"
              @export-key="openExport(selectedButton ?? undefined)"
              @import-key="openImport(selectedButton ?? undefined)"
              @open-icon-picker="openIconPicker"
              @open-look-icon="(i) => openLookIconPicker(i)"
              @action-drop-selected="onActionDropSelected"
            />
          </template>
          <div v-else class="bd-rail">
            <button
              class="bd-ibtn"
              @click="bdSetPanels(bdShowLeft, true)"
              :title="t('bd.expandLeft')"
              :aria-label="t('bd.expandLeft')"
              data-cy="bd-expand-right"
            >
              <PanelRightOpen :size="20" stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>
    </main>

    <SettingsDialog
      ref="settingsDialog"
      :current-locale="currentLocale"
      :show-updates="hasElectrobunUpdater"
      :profiles="profiles"
      :plugins="plugins"
      :detailed="pluginsDetailed"
      :busy-id="pluginBusyId"
      :uploading="pluginUploading"
      :mcp-url="mcpServerUrl"
      :mcp-tokens="mcpTokens"
      :mcp-secret="mcpNewSecret"
      :mcp-scopes="mcpScopes"
      :install-progress="installProgress"
      @language-changed="switchLanguage"
      @streamdeck-connected="onSdConnected"
      @streamdeck-disconnected="onSdDisconnected"
      @check-updates="showUpdateModal"
      @profile-updated="(id, updates) => handleProfileUpdate(id, updates)"
      @profile-deleted="(id) => handleProfileDeleted(id)"
      @profile-created="() => handleProfileCreate()"
      @profile-duplicated="(id) => handleProfileDuplicate(id)"
      @activate-profile="(id) => handleAutoActivate(id)"
      @toggle-plugin="onTogglePlugin"
      @remove-plugin="(id, name) => onRemovePlugin(id, name)"
      @install-file="onInstallFile"
      @install-url="onInstallUrl"
      @update-plugin="onUpdatePlugin"
      @rollback-plugin="onRollbackPlugin"
      @reload-plugin="onReloadPlugin"
      @create-mcp-token="onCreateMcpToken"
      @update-mcp-token="onUpdateMcpToken"
      @revoke-mcp-token="onRevokeMcpToken"
      @dismiss-install-progress="clearInstallProgress"
      @notify="(msg) => bdShowToast(msg)"
    />

    <PluginSettingsDialog
      ref="pluginSettingsDialog"
      :api-base="`${API_BASE}`"
      @saved="loadPlugins"
      @notify="(msg) => bdShowToast(msg)"
    />

    <IconPickerDialog
      ref="iconPickerDialog"
      :current="buttonConfig.icon ?? ''"
      @pick="(name) => onIconPick(name)"
    />

    <QrDialog ref="qrDialog" @notify="(msg) => bdShowToast(msg)" />

    <ActionCommandPalette
      ref="palette"
      :plugins="plugins"
      :detailed="pluginsDetailed"
      @pick="onPalettePick"
      @open-plugin-settings="(id) => openPluginSettings(id, 'settings')"
      @close="palettePath = 'acts'"
    />

    <KeyIoDialog
      ref="ioDialog"
      :mode="ioMode"
      :export-text="ioExportText"
      :export-intro="ioExportIntro"
      :needs-plugins="ioExportNeeds"
      :import-text="ioImportText"
      :import-intro="ioImportIntro"
      :parse-error="ioParseError"
      :summary="ioParsed"
      :plugin-rows="ioPluginRows"
      :vars-info="ioVarsInfo"
      :missing-count="ioMissing.length"
      :can-place="ioTargetPos !== null"
      :will-replace="ioWillReplace"
      :can-import="ioCanImport"
      :target-label="ioTargetLabel"
      @copy="onIoCopy"
      @update:text="(txt) => onIoText(txt)"
      @file="(f) => onIoFile(f)"
      @install-plugin="(id) => onIoInstallPlugin(id)"
      @install-all="onIoInstallAll"
      @confirm="onIoConfirm"
    />

    <UpdateModal
      v-if="hasElectrobunUpdater"
      ref="updateModal"
      :currentVersion="currentVersion"
      :latestVersion="latestVersion"
      :updateInfo="updateInfo"
      :isChecking="isCheckingUpdate"
      :isUpdating="isUpdating"
      :updateResult="updateResult"
      @check-for-updates="checkForUpdates"
      @start-update="startUpdate"
    />

    <IosWarningDialog />

    <div v-if="bdToast" class="bd-toast bd-on" role="status" aria-live="polite">
      <span>{{ bdToast.message }}</span>
      <button v-if="bdToast.undo" @click="doUndo">{{ t('bd.undo') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { Plus, Puzzle, Maximize2, Minimize2, QrCode, Settings, Monitor, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Ellipsis, FileUp, FileDown } from 'lucide-vue-next'
import { useStreamDeck } from '../../composables/useStreamDeck'
import { useI18nStore } from '../../composables/useI18n'
import {
  bdResolvedPalette, bdLabelMode, bdKeySize, bdRadius, bdBrightness, bdAnimations,
  bdShowLeft, bdShowRight, bdSetPanels, bdToast, bdShowToast, bdHideToast
} from '../../composables/useBunDeckUi'
import { cleanKey, collectPageIds, parseSharedDoc, firstFreePosition, type SharedDoc } from '../../composables/useKeyShare'
import { createKeyEngine, keyUsedVars } from '../../composables/useKeyEngine'
import { vars, onVarChange, getVar, importVar, removeVar } from '../../composables/useVars'
import StageBoard from './StageBoard.vue'
import TitleBar from './TitleBar.vue'
import KeyInspector from './KeyInspector.vue'
import ActionsPanel from './ActionsPanel.vue'
import ActionCommandPalette from './ActionCommandPalette.vue'
import KeyIoDialog from './KeyIoDialog.vue'
import PluginSettingsDialog from './PluginSettingsDialog.vue'
import SettingsDialog from './SettingsDialog.vue'
import IconPickerDialog from './IconPickerDialog.vue'
import QrDialog from './QrDialog.vue'
import IosWarningDialog from './IosWarningDialog.vue'
import UpdateModal from '../UpdateModal.vue'
import type { PageData } from '../../types/streamdeck'

const { t, currentLocale, setLocale, loadSavedLocale } = useI18nStore()
loadSavedLocale()

const switchLanguage = (newLocale: string) => setLocale(newLocale)

const mode = ref<'edit' | 'use'>('edit')
const setMode = (m: 'edit' | 'use') => {
  mode.value = m
  selectedButton.value = null
}

const settingsDialog = ref<InstanceType<typeof SettingsDialog> | null>(null)
const iconPickerDialog = ref<InstanceType<typeof IconPickerDialog> | null>(null)
const qrDialog = ref<InstanceType<typeof QrDialog> | null>(null)
const actionsPanel = ref<InstanceType<typeof ActionsPanel> | null>(null)
const updateModal = ref<InstanceType<typeof UpdateModal> | null>(null)
const pluginSettingsDialog = ref<InstanceType<typeof PluginSettingsDialog> | null>(null)

const openPluginSettings = (pluginId: string, tab: 'settings' | 'instructions') => {
  pluginSettingsDialog.value?.show(pluginId, tab)
}

const {
  connectionStatus, connectionText, profiles, selectedProfile, currentProfile,
  currentPage, currentPages, currentButtons, plugins, gridCols, gridRows,
  selectedButton, executingButtons, buttonConfig, API_BASE,
  getButtonData, getButton, selectProfile, loadProfiles, loadProfile,
  selectButton, executeButton, deleteButton, saveButtonConfig, addAction, createAction, executeSingleAction,
  removeAction, reorderActions, updateActionParameter, createProfile, updateProfile, deleteProfile,
  selectPage, createPage, deletePage, updatePage, changeGridSize, handleSwap,
  debouncedSave, cleanup, updateStreamDeckButtons, connectWebSocket,
  isChangingButton, isSaving, loadPlugins,
  pluginsDetailed, marketplace, pluginsLoading, loadMarketplace,
  setPluginEnabled, removePlugin, reloadPlugin, rollbackPlugin, updatePlugin,
  uploadPluginFile, installPluginFromUrl,
  mcpTokens, mcpScopes, loadMcpTokens, loadMcpScopes, createMcpToken, updateMcpToken, revokeMcpToken,
  installProgress, clearInstallProgress
} = useStreamDeck()

const pluginBusyId = ref<string | null>(null)
const pluginUploading = ref(false)

const palette = ref<InstanceType<typeof ActionCommandPalette> | null>(null)
const ioDialog = ref<InstanceType<typeof KeyIoDialog> | null>(null)
const palettePath = ref('acts')
const lookIconTarget = ref<number | null>(null)
const headerMenuBtn = ref<HTMLElement | null>(null)
const headerMenuOpen = ref(false)
let ruleTimer: ReturnType<typeof setInterval> | null = null
let unsubVar: (() => void) | null = null

const canExportSelected = computed(() => {
  if (selectedButton.value === null) return false
  const b = getButton(selectedButton.value)
  return !!(b?.data?.actions?.length)
})

const openPalette = (path = 'acts') => {
  if (mode.value === 'use') {
    bdShowToast(t('bd.switchToEdit'))
    return
  }
  if (selectedButton.value === null) {
    bdShowToast(t('bd.selectKeyFirst'))
    return
  }
  palettePath.value = path
  palette.value?.show()
}

const onPalettePick = async (type: string) => {
  if (!ensureEditableTarget()) return
  try {
    const path = palettePath.value
    palettePath.value = 'acts'
    if (!path || path === 'acts') {
      addAction(type)
    } else {
      const m = /^r(\d+)\.(then|else)$/.exec(path)
      const rules = [...(buttonConfig.value.rules ?? [])]
      const ri = m ? +m[1] : -1
      if (!m || !rules[ri]) {
        addAction(type)
      } else {
        const side = m[2] as 'then' | 'else'
        rules[ri] = { ...rules[ri], [side]: [...(rules[ri][side] ?? []), createAction(type)] }
        buttonConfig.value = { ...buttonConfig.value, rules }
      }
    }
    await saveButtonConfig()
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}

const openIconPicker = () => {
  lookIconTarget.value = null
  iconPickerDialog.value?.show()
}
const openLookIconPicker = (i: number) => {
  lookIconTarget.value = i
  iconPickerDialog.value?.show()
}
const onIconPick = async (name: string) => {
  try {
    if (lookIconTarget.value !== null) {
      const looks = [...(buttonConfig.value.looks ?? [])]
      const li = lookIconTarget.value
      lookIconTarget.value = null
      if (looks[li]) {
        looks[li] = { ...looks[li], i: name }
        buttonConfig.value = { ...buttonConfig.value, looks }
        await saveButtonConfig()
        return
      }
    }
    onUpdateField('icon', name)
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}

const onHeaderMenuAction = (a: 'export' | 'import') => {
  headerMenuOpen.value = false
  if (a === 'export') openExport(selectedButton.value ?? undefined)
  else openImport(selectedButton.value ?? undefined)
}
const onHeaderMenuBtnKey = (e: KeyboardEvent) => {
  if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    headerMenuOpen.value = true
    nextTick(() => document.querySelector<HTMLElement>('header .bd-menu button')?.focus())
  }
}
const onHeaderMenuKey = (e: KeyboardEvent) => {
  const items = [...document.querySelectorAll<HTMLElement>('header .bd-menu button')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    items[(i + 1) % items.length]?.focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    items[(i - 1 + items.length) % items.length]?.focus()
  } else if (e.key === 'Escape') {
    headerMenuOpen.value = false
    headerMenuBtn.value?.focus()
  }
}
const onDocClickHeader = (e: MouseEvent) => {
  if (headerMenuOpen.value && !(e.target as HTMLElement).closest?.('header .bd-menu') && !(e.target as HTMLElement).closest?.('[data-cy="bd-open-key-menu"]')) {
    headerMenuOpen.value = false
  }
}

const availablePages = computed(() =>
  currentPages.value
    .filter((page) => page.is_folder === 0)
    .map((page) => ({ id: page.id, name: page.name }))
)

// Rastro de navegación para el breadcrumb: solo carpetas (is_folder === 1)
// apilan niveles; las páginas normales (is_folder === 0) resetean a [página].
// Esto cubre también los cambios remotos por websocket (tablet), que entran
// vía selectPage() sin pasar por onPageSelect.
const navTrail = ref<string[]>([])
const syncNavTrail = (page: { name?: string; is_folder?: number } | null | undefined) => {
  if (!page?.name) {
    if (!page) navTrail.value = []
    return
  }
  if (page.is_folder === 1) {
    const last = navTrail.value[navTrail.value.length - 1]
    if (last !== page.name) navTrail.value.push(page.name)
  } else if (navTrail.value.length !== 1 || navTrail.value[0] !== page.name) {
    navTrail.value = [page.name]
  }
}
watch(
  () => currentPage.value?.id,
  () => {
    if (!currentPage.value) {
      navTrail.value = []
      return
    }
    syncNavTrail(currentPage.value)
  }
)
const onNavBack = async () => {
  if (navTrail.value.length < 2) return
  navTrail.value.pop()
  const name = navTrail.value[navTrail.value.length - 1]
  const page = currentPages.value.find((p) => p.name === name)
  if (page) {
    await selectPage(page.id)
    engine.runLoad(allPositions)
  }
}

// Pantalla completa (oculta en iPhone, como antes)
const isFullscreen = ref(false)
const isIPhone = ref(false)
const isConnected = computed(() => connectionStatus.value === 'bg-success')
const toggleFullscreen = async () => {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
    else await document.exitFullscreen()
  } catch (error) {
    console.error('Error al cambiar pantalla completa:', error)
  }
}

// Perfiles
const handleProfileChange = async (profileId: string) => {
  await selectProfile(profileId)
  navTrail.value = currentPage.value ? [currentPage.value.name] : []
  engine.runLoad(allPositions)
}
const handleProfileCreate = async () => {
  const name = `Perfil ${profiles.value.length + 1}`
  const created = await createProfile(name)
  bdShowToast(t('bd.profileCreated', { name }))
  await selectProfile(created.id)
}
const handleProfileUpdate = async (profileId: string, updates: any) => {
  await updateProfile(profileId, updates)
}
const handleProfileDeleted = async (profileId: string) => {
  const target = profiles.value.find((p) => p.id === profileId)
  await deleteProfile(profileId)
  bdShowToast(t('bd.profileDeleted', { name: target?.name ?? '' }))
}
const handleProfileDuplicate = async (profileId: string) => {
  const orig = profiles.value.find((p) => p.id === profileId)
  if (!orig) return
  try {
    let data: any = (orig as any).data
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch {
        data = {}
      }
    }
    const cleanData = { ...(data ?? {}), isDefault: false }
    const copyName = `${orig.name} (copia)`
    const created = await apiPost('/profiles', { name: copyName, data: cleanData })
    // Copia páginas y botones
    const pages = await apiGet(`/pages?profileId=${encodeURIComponent(profileId)}`)
    const pageIdMap = new Map<string, string>()
    for (const pg of pages ?? []) {
      const np = await apiPost('/pages', {
        profile_id: created.id,
        name: pg.name,
        order_idx: pg.order_idx,
        is_folder: pg.is_folder,
        data: pg.data ?? {}
      })
      pageIdMap.set(pg.id, np.id)
      let buttons: any[] = []
      try {
        buttons = await apiGet(`/buttons?pageId=${encodeURIComponent(pg.id)}`)
      } catch {
        buttons = []
      }
      for (const b of buttons ?? []) {
        // Reescribe referencias a páginas internas (carpetas) al nuevo id
        const bdata = JSON.parse(JSON.stringify(b.data ?? {}))
        for (const a of bdata.actions ?? []) {
          const pid = a?.parameters?.pageId
          if (typeof pid === 'string' && pageIdMap.has(pid)) a.parameters.pageId = pageIdMap.get(pid)
        }
        await apiPost('/buttons', { page_id: np.id, position: b.position, data: bdata })
      }
    }
    // Repara referencias cruzadas a páginas creadas después (segunda pasada ligera)
    await loadProfiles()
    bdShowToast(t('bd.profileDuplicated', { name: copyName }))
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}
const handleAutoActivate = async (profileId: string) => {
  const target = profiles.value.find((p) => p.id === profileId)
  if (!target) return
  await selectProfile(profileId)
  navTrail.value = currentPage.value ? [currentPage.value.name] : []
  bdShowToast(t('bd.autoSwitched', { name: target.name }))
}

// Páginas (con estado de carga: deshabilita botones + spinner mientras opera.
// El timeout evita que un await colgado deje los botones bloqueados.)
const pageBusy = ref(false)
const PAGE_OP_TIMEOUT_MS = 15000

const withPageOp = async (fn: () => Promise<void>) => {
  if (pageBusy.value) return false
  pageBusy.value = true
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('__timeout__')), PAGE_OP_TIMEOUT_MS)
      )
    ])
    return true
  } catch (error: any) {
    if (error?.message === '__timeout__') {
      // No esperar a la recarga: si el fetch está colgado, loadProfile
      // también podría colgarse. Recarga en segundo plano y libera la UI.
      loadProfile().catch(() => {})
      bdShowToast(t('bd.slowOperation'))
    } else {
      bdShowToast(error?.message ?? 'Error')
    }
    return false
  } finally {
    pageBusy.value = false
  }
}
const uniquePageName = (base: string) => {
  const taken = new Set(currentPages.value.map((p) => p.name))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base} ${i}`)) i++
  return `${base} ${i}`
}
const onPageSelect = async (pageId: string) => {
  if (pageId === currentPage.value?.id) return
  await withPageOp(async () => {
    await selectPage(pageId)
    const page = currentPages.value.find((p) => p.id === pageId)
    syncNavTrail(page)
    engine.runLoad(allPositions)
  })
}
const onPageCreate = async () => {
  await withPageOp(async () => {
    const created = await createPage(uniquePageName(`Página ${currentPages.value.length + 1}`), false)
    await selectPage(created.id)
    const page = currentPages.value.find((p) => p.id === created.id)
    navTrail.value = page ? [page.name] : []
  })
}
const onPageRename = async (pageId: string, name: string) => {
  const oldName = currentPages.value.find((p) => p.id === pageId)?.name
  await withPageOp(async () => {
    await updatePage(pageId, { name })
    const page = currentPages.value.find((p) => p.id === pageId)
    if (page && oldName) {
      navTrail.value = navTrail.value.map((n) => (n === oldName ? page.name : n))
      if (navTrail.value.length === 0) navTrail.value = [page.name]
    }
  })
}
const onPageDelete = async (page: PageData | null) => {
  if (!page || currentPages.value.length < 2) return
  const snapshot = {
    name: page.name,
    isFolder: page.is_folder === 1,
    buttons: currentButtons.value
      .filter((b) => b.page_id === page.id)
      .map((b) => ({ position: b.position, data: JSON.parse(JSON.stringify(b.data)) }))
  }
  const ok = await withPageOp(async () => {
    await deletePage(page.id)
  })
  if (!ok) return
  bdShowToast(t('bd.pageDeleted', { name: snapshot.name }), async () => {
    pageBusy.value = true
    try {
      const restored = await createPage(uniquePageName(snapshot.name), snapshot.isFolder)
      for (const btn of snapshot.buttons) {
        await fetch(`${API_BASE}/buttons`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page_id: restored.id, position: btn.position, data: btn.data })
        })
      }
      await loadProfile()
      await selectPage(restored.id)
    } catch (error: any) {
      bdShowToast(error?.message ?? 'Error al restaurar la página')
    } finally {
      pageBusy.value = false
    }
  })
}

// Teclas: ejecución con motor de reglas (acciones + reglas + {{vars}})
const allPositions = () => Array.from({ length: gridCols.value * gridRows.value }, (_, i) => i)
const engine = createKeyEngine({
  getButton,
  getExecData: (pos: number) =>
    selectedButton.value === pos ? { ...buttonConfig.value } : (getButton(pos)?.data ?? null),
  execRemote: (action: any, ctx: Record<string, any>) =>
    executeSingleAction(action, { ...ctx, profileId: currentProfile.value?.id }),
  toast: (msg: string) => bdShowToast(msg),
  noActionsToast: () => bdShowToast(t('bd.noActionsToast')),
  profileName: () => currentProfile.value?.name ?? '',
  pageName: () => currentPage.value?.name ?? '',
  pageId: () => currentPage.value?.id ?? '',
  executing: executingButtons
})
const onExecute = (position: number) => {
  void engine.execKey(position, 'press')
}
const onDeleteButton = async (position: number) => {
  const btn = getButton(position)
  if (!btn) return
  const snapshot = JSON.parse(JSON.stringify(btn.data))
  await deleteButton(position)
  bdShowToast(t('bd.keyCleared'), async () => {
    buttonConfig.value = { ...snapshot }
    await saveButtonConfig()
  })
}
const onUpdateField = (key: string, value: any) => {
  buttonConfig.value = { ...buttonConfig.value, [key]: value }
}
const onUpdateAction = (index: number, patch: Record<string, any>) => {
  const actions = [...(buttonConfig.value.actions ?? [])]
  actions[index] = { ...actions[index], ...patch }
  buttonConfig.value = { ...buttonConfig.value, actions }
}
const onMoveAction = (index: number, dir: -1 | 1) => {
  const actions = [...(buttonConfig.value.actions ?? [])]
  const j = index + dir
  if (j < 0 || j >= actions.length) return
  ;[actions[index], actions[j]] = [actions[j], actions[index]]
  buttonConfig.value = { ...buttonConfig.value, actions }
}
const onTest = () => {
  if (selectedButton.value === null) return
  void engine.execKey(selectedButton.value, 'press')
}
const onClearKey = async () => {
  if (selectedButton.value === null || !getButton(selectedButton.value)) return
  const snapshot = JSON.parse(JSON.stringify(buttonConfig.value))
  buttonConfig.value = {
    ...buttonConfig.value,
    label: '',
    textTop: '',
    textBottom: '',
    icon: '',
    emoji: '',
    actions: [],
    rules: [],
    looks: []
  }
  // Guardado inmediato: sin esto el vaciado dependía del autoguardado
  // (800 ms) y dos mutaciones seguidas podían cancelar el timeout y dejar
  // isSaving colgado — la tecla parecía "pillada" sin vaciarse.
  await saveButtonConfig()
  bdShowToast(t('bd.keyCleared'), async () => {
    buttonConfig.value = { ...snapshot }
    await saveButtonConfig()
  })
}

// Acciones: biblioteca → tecla
const ensureEditableTarget = (): boolean => {
  if (mode.value !== 'edit') {
    bdShowToast(t('bd.switchToEdit'))
    return false
  }
  if (selectedButton.value === null) {
    bdShowToast(t('bd.selectKeyFirst'))
    return false
  }
  return true
}
const onActionPick = async (type: string) => {
  if (!ensureEditableTarget()) return
  try {
    addAction(type)
    // Guardado inmediato: sin esto la tecla vacía depende del autoguardado
    // (800 ms) y el usuario no ve nada al pulsar.
    await saveButtonConfig()
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}
const onActionDrop = async (position: number, type: string) => {
  if (mode.value !== 'edit') return
  try {
    await selectButton(position)
    addAction(type)
    await saveButtonConfig()
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}
const onActionDropSelected = async (type: string) => {
  if (!ensureEditableTarget()) return
  try {
    addAction(type)
    await saveButtonConfig()
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}
const focusLibrary = () => {
  if (!bdShowLeft.value) bdSetPanels(true, bdShowRight.value)
  nextTick(() => actionsPanel.value?.focusSearch())
}

// ---- Exportar / importar teclas (JSON como datos, nunca código) ----
const ioMode = ref<'export' | 'import'>('export')
const ioExportText = ref('')
const ioExportIntro = ref('')
const ioExportNeeds = ref<string[]>([])
const ioImportText = ref('')
const ioImportPos = ref<number | null>(null)
const ioParsed = ref<SharedDoc | null>(null)
const ioParseErrorKey = ref('')
const ioBusy = ref(false)

const apiBase = API_BASE
const apiGet = async (path: string) => {
  const res = await fetch(`${apiBase.value}${path}`)
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
  return res.json()
}
const apiPost = async (path: string, body: any) => {
  const res = await fetch(`${apiBase.value}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `POST ${path}: ${res.status}`)
  }
  return res.json().catch(() => ({}))
}
const apiDel = async (path: string) => {
  const res = await fetch(`${apiBase.value}${path}`, { method: 'DELETE' })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `DELETE ${path}: ${res.status}`)
  }
  return res.json().catch(() => ({}))
}

const manifestOf = (pid: string) => {
  const det = (pluginsDetailed.value ?? []).find((p: any) => p.id === pid)
  if (det?.manifest) return det.manifest
  const entry = (plugins.value ?? []).find(([id]: any[]) => id === pid)
  return entry?.[1]?.manifest ?? null
}
const marketOf = (pid: string) => (marketplace.value ?? []).find((m: any) => m.id === pid)

const ioTargetPos = computed<number | null>(() => {
  if (ioMode.value !== 'import') return null
  if (ioImportPos.value !== null) return ioImportPos.value
  if (selectedButton.value !== null) return selectedButton.value
  const total = gridCols.value * gridRows.value
  const taken = new Set((currentButtons.value ?? []).map((b: any) => b.position))
  return firstFreePosition(total, taken)
})
const ioTargetLabel = computed(() => {
  if (ioTargetPos.value === null) return ''
  const r = Math.floor(ioTargetPos.value / gridCols.value)
  const c = ioTargetPos.value % gridCols.value
  return `F${r + 1} · C${c + 1}`
})
const ioImportIntro = computed(() => {
  const base = t('bd.importIntro')
  return ioTargetPos.value !== null ? `${base} ${t('bd.importTarget', { pos: ioTargetLabel.value })}` : base
})
const ioParseError = computed(() => (ioParseErrorKey.value ? t(`bd.${ioParseErrorKey.value}`) : ''))
const ioPluginRows = computed(() => {
  if (!ioParsed.value) return []
  return ioParsed.value.plugins.map((p) => {
    const entry = (plugins.value ?? []).find(([id]: any[]) => id === p.id)
    const det = (pluginsDetailed.value ?? []).find((d: any) => d.id === p.id)
    const enabled = det ? det.enabled !== false : !!entry
    const m = marketOf(p.id)
    return {
      id: p.id,
      name: p.name,
      version: p.version,
      by: p.by ?? '',
      icon: p.icon,
      marketplaceUrl: p.marketplaceUrl ?? m?.zipUrl ?? m?.url ?? m?.repository ?? null,
      ok: !!entry && enabled,
      exists: !!entry
    }
  })
})
const ioMissing = computed(() => ioPluginRows.value.filter((r) => !r.ok))
const ioWillReplace = computed(() => {
  if (ioTargetPos.value === null) return false
  return !!getButton(ioTargetPos.value)
})
const ioCanImport = computed(() => !!ioParsed.value && ioMissing.value.length === 0 && ioTargetPos.value !== null && !ioBusy.value)

const buildExportDoc = async (position: number) => {
  const btn = getButton(position)
  const raw = btn?.data ?? (position === selectedButton.value ? { ...buttonConfig.value } : null)
  if (!raw) return null
  const key = cleanKey(raw)
  const pageIds = collectPageIds(key)
  const pages: SharedDoc['pages'] = []
  for (const pid of pageIds.slice(0, 16)) {
    const page = (currentPages.value ?? []).find((p) => p.id === pid)
    if (!page) continue
    let buttons: any[] = []
    try {
      buttons = await apiGet(`/buttons?pageId=${encodeURIComponent(pid)}`)
    } catch {
      buttons = (currentButtons.value ?? []).filter((b: any) => b.page_id === pid)
    }
    pages.push({
      id: page.id,
      name: page.name,
      is_folder: page.is_folder === 1 ? 1 : 0,
      buttons: (buttons ?? []).filter((b: any) => Number.isInteger(b.position)).slice(0, 64).map((b: any) => ({
        position: b.position,
        data: cleanKey(b.data)
      }))
    })
  }
  const usedPids = new Set<string>()
  const pushPid = (a: any) => {
    const pid = String(a?.type ?? '').split('.')[0]
    if (pid && pid !== 'local') usedPids.add(pid)
  }
  key.actions.forEach(pushPid)
  ;(key.rules ?? []).forEach((r) => {
    ;(r.then ?? []).forEach(pushPid)
    ;(r.else ?? []).forEach(pushPid)
  })
  pages.forEach((pg) => pg.buttons.forEach((b) => {
    b.data.actions.forEach(pushPid)
    ;(b.data.rules ?? []).forEach((r) => {
      ;(r.then ?? []).forEach(pushPid)
      ;(r.else ?? []).forEach(pushPid)
    })
  }))
  const plugList: SharedDoc['plugins'] = []
  for (const pid of usedPids) {
    const entry = (plugins.value ?? []).find(([id]: any[]) => id === pid)
    const m = manifestOf(pid)
    if (!entry && !m) continue
    const mk = marketOf(pid)
    plugList.push({
      id: pid,
      name: m?.name ?? entry?.[1]?.manifest?.name ?? pid,
      version: m?.version ?? entry?.[1]?.manifest?.version ?? '0.0.0',
      by: m?.author ?? m?.by ?? undefined,
      icon: m?.icon ?? undefined,
      manifest: m ?? undefined,
      marketplaceUrl: mk?.zipUrl ?? mk?.url ?? mk?.repository ?? null
    })
    if (plugList.length >= 16) break
  }
  const allNames = vars.value.map((v) => v.n)
  const used = keyUsedVars(key, pages, allNames)
  const varList: SharedDoc['vars'] = vars.value
    .filter((v) => used.includes(v.n))
    .map((v) => ({ n: v.n, t: v.t, v: v.v }))
  return { libredeck: 1 as const, type: 'key' as const, app: 'LibreDeck', key, pages, plugins: plugList, vars: varList }
}

const openExport = async (position?: number) => {
  const pos = position ?? selectedButton.value
  if (pos === null || pos === undefined) {
    bdShowToast(t('bd.selectKeyFirst'))
    return
  }
  if (!getButton(pos) && pos !== selectedButton.value) {
    bdShowToast(t('bd.selectKeyFirst'))
    return
  }
  ioMode.value = 'export'
  ioExportText.value = ''
  ioExportNeeds.value = []
  ioExportIntro.value = ''
  try {
    const doc = await buildExportDoc(pos)
    if (!doc) {
      bdShowToast(t('bd.selectKeyFirst'))
      return
    }
    ioExportText.value = JSON.stringify(doc, null, 2)
    const n = doc.key.actions.length
    const nr = (doc.key.rules ?? []).length
    const detail = `${n} ${n === 1 ? 'acción' : 'acciones'}${nr ? ` · ${nr} ${nr === 1 ? 'regla' : 'reglas'}` : ''}${doc.pages.length ? `, ${doc.pages.length} ${doc.pages.length === 1 ? 'carpeta' : 'carpetas'}` : ''}${doc.vars.length ? `, ${doc.vars.length} ${doc.vars.length === 1 ? 'variable' : 'variables'}` : ''}`
    ioExportIntro.value = t('bd.exportSummary', { name: doc.key.label || t('bd.emptyKey'), detail })
    ioExportNeeds.value = doc.plugins.map((p) => `${p.name} v${p.version}`)
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
    return
  }
  ioDialog.value?.show()
}

const openImport = (position?: number) => {
  ioMode.value = 'import'
  ioImportText.value = ''
  ioParsed.value = null
  ioParseErrorKey.value = ''
  ioImportPos.value = position ?? selectedButton.value ?? null
  ioDialog.value?.show()
}

const onIoText = (txt: string) => {
  ioImportText.value = txt
  if (!txt.trim()) {
    ioParsed.value = null
    ioParseErrorKey.value = ''
    return
  }
  const r = parseSharedDoc(txt)
  if (r.error) {
    ioParsed.value = null
    ioParseErrorKey.value = r.error
  } else {
    ioParsed.value = r.doc ?? null
    ioParseErrorKey.value = ''
  }
}

const onIoFile = (file: File) => {
  if (file.size > 200000) {
    ioParsed.value = null
    ioParseErrorKey.value = 'fileTooBig'
    return
  }
  file.text().then((txt) => onIoText(txt)).catch(() => {
    ioParseErrorKey.value = 'notValidJson'
  })
}

const onIoCopy = async () => {
  const txt = ioExportText.value
  if (!txt) return
  try {
    await navigator.clipboard.writeText(txt)
    bdShowToast(t('bd.codeCopied'))
  } catch {
    bdShowToast(t('bd.codeCopyHint'))
  }
}

const installRowPlugin = async (row: { id: string; marketplaceUrl?: string | null }) => {
  const det = (pluginsDetailed.value ?? []).find((d: any) => d.id === row.id)
  if (det || (plugins.value ?? []).some(([id]: any[]) => id === row.id)) {
    await setPluginEnabled(row.id, true)
    await loadPlugins()
    return
  }
  if (!row.marketplaceUrl) throw new Error(t('bd.codeOnlyTag'))
  pluginBusyId.value = row.id
  try {
    await installPluginFromUrl(row.marketplaceUrl, { sourceType: 'marketplace' })
  } finally {
    pluginBusyId.value = null
  }
}

const onIoInstallPlugin = async (id: string) => {
  const row = ioPluginRows.value.find((r) => r.id === id)
  if (!row) return
  try {
    await installRowPlugin(row)
    await loadPlugins()
    bdShowToast(t('bd.pluginReady', { name: row.name }))
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}

const onIoInstallAll = async () => {
  try {
    for (const row of ioMissing.value) await installRowPlugin(row)
    await loadPlugins()
    bdShowToast(t('bd.pluginsInstalled'))
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}

const uniqueImportPageName = (base: string, taken: Set<string>) => {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base} ${i}`)) i++
  return `${base} ${i}`
}

const ioVarsInfo = computed(() =>
  (ioParsed.value?.vars ?? []).map((v) => ({ n: v.n, exists: !!getVar(v.n) }))
)

const onIoConfirm = async () => {
  const doc = ioParsed.value
  const target = ioTargetPos.value
  if (!doc || target === null || ioBusy.value) return
  if (ioMissing.value.length > 0) return
  ioBusy.value = true
  try {
    const profileId = selectedProfile.value
    // Variables que usa (se crean las que falten; el deshacer las quita).
    const addedVars: string[] = []
    for (const v of doc.vars ?? []) {
      if (!getVar(v.n) && importVar(v)) addedVars.push(v.n)
    }
    const takenNames = new Set((currentPages.value ?? []).map((p) => p.name))
    const idMap = new Map<string, string>()
    const createdPageIds: string[] = []
    const remapActions = (list: any[]) => {
      for (const a of list ?? []) {
        const pid = a?.parameters?.pageId
        if (typeof pid === 'string' && idMap.has(pid)) a.parameters.pageId = idMap.get(pid)
      }
    }
    const remapRules = (rules: any[]) => {
      for (const r of rules ?? []) {
        remapActions(r?.then)
        remapActions(r?.else)
      }
    }
    for (const pg of doc.pages) {
      const created = await apiPost('/pages', {
        profile_id: profileId,
        name: uniqueImportPageName(pg.name, takenNames),
        order_idx: (currentPages.value ?? []).length + createdPageIds.length,
        is_folder: pg.is_folder,
        data: {}
      })
      takenNames.add(created.name ?? pg.name)
      idMap.set(pg.id, created.id)
      createdPageIds.push(created.id)
      for (const b of pg.buttons) {
        const data = JSON.parse(JSON.stringify(b.data))
        remapActions(data.actions)
        remapRules(data.rules)
        await apiPost('/buttons', { page_id: created.id, position: b.position, data })
      }
    }
    const remapped = JSON.parse(JSON.stringify(doc.key))
    remapActions(remapped.actions)
    remapRules(remapped.rules)
    const prevBtn = getButton(target)
    const prevData = prevBtn ? JSON.parse(JSON.stringify(prevBtn.data)) : null
    await selectButton(target)
    buttonConfig.value = { ...remapped }
    await saveButtonConfig()
    try {
      const fresh = await apiGet(`/buttons?pageId=${encodeURIComponent(currentPage.value?.id ?? '')}`)
      void fresh
    } catch { /* noop */ }
    ioDialog.value?.close()
    bdShowToast(t('bd.importedOk', { name: remapped.label || t('bd.emptyKey') }), async () => {
      for (const pid of createdPageIds) {
        try { await apiDel(`/pages/${encodeURIComponent(pid)}`) } catch { /* noop */ }
      }
      for (const n of addedVars) removeVar(n)
      await selectButton(target)
      if (prevData) {
        buttonConfig.value = { ...prevData }
        await saveButtonConfig()
      } else if (getButton(target)) {
        await deleteButton(target)
      }
    })
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  } finally {
    ioBusy.value = false
  }
}

// Plugins: ciclo de vida real contra el daemon
const onTogglePlugin = async (pluginId: string, on: boolean) => {
  pluginBusyId.value = pluginId
  try {
    await setPluginEnabled(pluginId, on)
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  } finally {
    pluginBusyId.value = null
  }
}
const onRemovePlugin = async (pluginId: string, name: string) => {
  pluginBusyId.value = pluginId
  try {
    await removePlugin(pluginId)
    bdShowToast(t('bd.pluginRemoved', { name }))
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  } finally {
    pluginBusyId.value = null
  }
}
const onInstallFile = async (file: File) => {
  pluginUploading.value = true
  try {
    await uploadPluginFile(file)
    bdShowToast(t('bd.pluginInstalled', { name: file.name }))
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  } finally {
    pluginUploading.value = false
  }
}
const onInstallUrl = async (url: string) => {
  pluginBusyId.value = url
  try {
    const res: any = await installPluginFromUrl(url)
    if (res?.elgato) bdShowToast(res.note ?? t('bd.pluginInstalled', { name: url }))
    else bdShowToast(t('bd.pluginInstalled', { name: url }))
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  } finally {
    pluginBusyId.value = null
  }
}
const onUpdatePlugin = async (pluginId: string) => {
  pluginBusyId.value = pluginId
  try {
    await updatePlugin(pluginId)
    bdShowToast(t('bd.pluginUpdated', { name: pluginId }))
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  } finally {
    pluginBusyId.value = null
  }
}
const onRollbackPlugin = async (pluginId: string) => {
  pluginBusyId.value = pluginId
  try {
    await rollbackPlugin(pluginId)
    bdShowToast(t('bd.pluginRolledBack', { name: pluginId }))
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  } finally {
    pluginBusyId.value = null
  }
}
const onReloadPlugin = async (pluginId: string) => {
  pluginBusyId.value = pluginId
  try {
    await reloadPlugin(pluginId)
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  } finally {
    pluginBusyId.value = null
  }
}

// ---- Servidor MCP propio (URL + tokens) ----
const mcpServerUrl = computed(() => `${API_BASE.value}/mcp`)
const mcpNewSecret = ref<string | null>(null)
const onCreateMcpToken = async (name: string, scopes: string[]) => {
  mcpNewSecret.value = null
  try {
    const { secret } = await createMcpToken(name, scopes)
    mcpNewSecret.value = secret
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
    mcpNewSecret.value = null
  }
}
const onUpdateMcpToken = async (id: string, patch: { scopes: string[] }) => {
  try {
    await updateMcpToken(id, patch)
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}
const onRevokeMcpToken = async (id: string) => {
  try {
    await revokeMcpToken(id)
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}

// Estado del StreamDeck físico (selector + repintado viven en Ajustes → Dispositivo)
const deviceConnected = ref(false)
const refreshDeviceStatus = async () => {
  try {
    const res = await fetch(`${API_BASE.value}/devices/streamdeck/status`)
    if (res.ok) {
      const st = await res.json()
      deviceConnected.value = !!st.isConnected
    }
  } catch {
    deviceConnected.value = false
  }
}
const onSdConnected = async () => {
  await updateStreamDeckButtons()
  await refreshDeviceStatus()
}
const onSdDisconnected = async () => {
  await updateStreamDeckButtons()
  await refreshDeviceStatus()
}

// Deshacer del toast
const doUndo = async () => {
  const undo = bdToast.value?.undo
  bdHideToast()
  if (undo) await undo()
}

// Updater (canónico Electrobun, como antes)
const hasElectrobunUpdater = typeof window !== 'undefined' && !!(window as any).electrobun
const currentVersion = ref('')
const latestVersion = ref('')
const updateInfo = ref<any>(null)
const isCheckingUpdate = ref(false)
const isUpdating = ref(false)
const updateCheckInterval = ref<ReturnType<typeof setInterval> | null>(null)
const updateResult = ref<{ success: boolean; message: string } | null>(null)
const showUpdateModal = async () => {
  if (!hasElectrobunUpdater) return
  await checkForUpdates()
  updateModal.value?.showModal()
}
const checkForUpdates = async () => {
  if (!hasElectrobunUpdater) return
  isCheckingUpdate.value = true
  try {
    const url = `http://${window.location.hostname}:3001/api/v1/version/check`
    const res = await fetch(url)
    if (res.ok) {
      const data = await res.json()
      latestVersion.value = data.latestVersion
      updateInfo.value = data
    }
  } catch (e) {
    console.error(e)
  } finally {
    isCheckingUpdate.value = false
  }
}
const startUpdate = async () => {
  if (!hasElectrobunUpdater) return
  isUpdating.value = true
  updateResult.value = null
  try {
    const url = `http://${window.location.hostname}:3001/api/v1/update`
    const res = await fetch(url, { method: 'POST' })
    if (!res.ok) throw new Error('Failed to start update')
  } catch (error) {
    console.error(error)
    updateResult.value = { success: false, message: 'Error al iniciar la actualización. Inténtalo de nuevo.' }
  } finally {
    isUpdating.value = false
  }
}

// Wake lock
const wakeLock = ref<any>(null)
const requestWakeLock = async () => {
  try {
    if ('wakeLock' in navigator) {
      wakeLock.value = await (navigator as any).wakeLock.request('screen')
      wakeLock.value.addEventListener('release', () => {})
    }
  } catch (err) {
    console.error('Error al activar Wake Lock:', err)
  }
}

// Autoguardado (igual que antes)
watch(selectedButton, (newVal, oldVal) => {
  isChangingButton.value = true
  if (newVal === null) {
    buttonConfig.value = {
      label: '',
      textTop: '',
      textBottom: '',
      fontSize: 14,
      icon: '',
      emoji: '',
      backgroundColor: '#374151',
      textColor: '#f1f5f9',
      showTitle: true,
      mode: 'seq',
      longPress: 'none',
      confirm: false,
      actions: [],
      rules: [],
      looks: []
    }
  }
  nextTick(() => {
    isChangingButton.value = false
  })
  void oldVal
})
watch(
  buttonConfig,
  (newConfig, oldConfig) => {
    // No bloquear por isSaving: si se está guardando, saveButtonConfig
    // reprograma el cambio en vez de perderlo (ver debouncedSave).
    if (isChangingButton.value) return
    if (selectedButton.value === null) return
    if (oldConfig && JSON.stringify(newConfig) === JSON.stringify(oldConfig)) return
    debouncedSave()
  },
  { deep: true, flush: 'post' }
)

const onKeyDown = (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    const anyDialog = document.querySelector('dialog[open]')
    if (!anyDialog) openPalette()
    return
  }
  if (event.key === 'Delete' && selectedButton.value !== null && mode.value === 'edit') {
    const tag = (event.target as HTMLElement)?.tagName
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      event.preventDefault()
      onDeleteButton(selectedButton.value)
    }
  }
  if (event.key === 'Escape' && mode.value === 'use') setMode('edit')
}

onMounted(async () => {
  loadProfiles().then(() => {
    // Reglas «load» de la página inicial.
    try { engine.runLoad(allPositions) } catch { /* noop */ }
  }).catch(() => {})
  loadMarketplace().catch(() => {})
  loadMcpTokens().catch(() => {})
  loadMcpScopes().catch(() => {})
  refreshDeviceStatus().catch(() => {})
  connectWebSocket()
  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('click', onDocClickHeader)
  // Motor de reglas: tic de 1 s (temporizadores + reevaluar apariencia).
  ruleTimer = setInterval(() => {
    try { engine.onTick(allPositions) } catch { /* noop */ }
  }, 1000)
  // Al cambiar una variable: reglas «var» que la observan.
  unsubVar = onVarChange((name) => {
    try { engine.onVarChange(name, allPositions) } catch { /* noop */ }
  })
  document.addEventListener('fullscreenchange', () => {
    isFullscreen.value = !!document.fullscreenElement
  })
  isIPhone.value = /iphone/.test(window.navigator.userAgent.toLowerCase())
  await requestWakeLock()
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && wakeLock.value === null) await requestWakeLock()
  })
  if (hasElectrobunUpdater) {
    try {
      const res = await fetch(`http://${window.location.hostname}:3001/api/v1/version`)
      if (res.ok) {
        const data = await res.json()
        currentVersion.value = data.version
      }
    } catch { /* noop */ }
    await checkForUpdates()
    updateCheckInterval.value = setInterval(checkForUpdates, 4 * 60 * 60 * 1000)
    window.addEventListener('update-completed', (event: any) => {
      updateResult.value = event.detail
      isUpdating.value = false
    })
  }
})

onUnmounted(() => {
  cleanup()
  window.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('click', onDocClickHeader)
  if (ruleTimer) {
    clearInterval(ruleTimer)
    ruleTimer = null
  }
  if (unsubVar) {
    unsubVar()
    unsubVar = null
  }
  if (updateCheckInterval.value) clearInterval(updateCheckInterval.value)
})
</script>
