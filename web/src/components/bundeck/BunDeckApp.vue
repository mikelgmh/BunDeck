<template>
  <div
    class="bundeck"
    :data-bd-pal="bdResolvedPalette"
    :data-anim="bdAnimations ? 1 : 0"
    :class="{ 'bd-dragging': false, 'bd-kiosk': kiosk }"
    :style="{
      '--bd-ks': (kiosk ? Math.max(bdKeySize, 96) : bdKeySize) + 'px',
      '--bd-rk': bdRadius + 'px',
      '--bd-br': (0.5 + 0.5 * bdBrightness / 100).toFixed(2),
      '--bd-lw': bdShowLeft ? '320px' : '52px',
      '--bd-rw': bdShowRight ? '400px' : '52px'
    }"
  >
    <!-- Sin permiso (LAN directa sin invitación): tapa la app para no
      mostrar ni operar nada; el anfitrión en localhost nunca la ve. -->
    <div v-if="lanDenied" class="bd-noperm" role="alert" data-cy="lan-denied">
      <div class="bd-noperm__card">
        <h1>🔒 {{ t('bd.lanDeniedTitle') }}</h1>
        <p>{{ t('bd.lanDeniedMsg') }}</p>
        <p class="bd-hint">{{ t('bd.lanDeniedHint') }}</p>
        <!-- Escape al relay (fast-path LAN con invitación caducada/usada):
          solo MUESTRA el código + copiar; nunca redirige solo (anti-bucle).
          Sin dominio inventado: la LAN no conoce el dominio del relay. -->
        <div v-if="lanRelayFallback" class="bd-noperm__fallback" data-cy="lan-relay-fallback">
          <p class="bd-hint">{{ t('bd.lanDeniedRelayFallback', { code: lanRelayFallback }) }}</p>
          <p class="bd-lan-link-row">
            <code class="bd-mono" data-cy="lan-relay-fallback-code">{{ lanRelayFallback }}</code>
            <button class="bd-btn" type="button" data-cy="lan-relay-fallback-copy" @click="copyRelayFallback">{{ relayFallbackCopied ? t('bd.lanDeniedRelayCopied') : t('bd.copy') }}</button>
          </p>
        </div>
      </div>
    </div>
    <!-- Túnel del relay con sesión muerta (reinicio, caducidad 24 h o daemon
      caído): tapa la app en vez de dejar un grid vacío; recargar reintenta
      (la sesión se restaura sola al reconectar el daemon). -->
    <div v-else-if="isTunnelRoute && tunnelSessionInvalid" class="bd-noperm" role="alert" data-cy="tunnel-gone">
      <div class="bd-noperm__card">
        <h1>{{ tunnelSessionInvalid === 'daemon-offline' ? '📡' : '🔒' }} {{ t('bd.tunnelGoneTitle') }}</h1>
        <p>{{ t('bd.tunnelGoneMsg') }}</p>
        <p class="bd-hint">{{ t('bd.tunnelGoneHint') }}</p>
        <button class="bd-btn bd-pri" type="button" @click="() => location.reload()">{{ t('bd.reload') }}</button>
      </div>
    </div>
    <template v-if="!lanDenied && !(isTunnelRoute && tunnelSessionInvalid)">
    <TitleBar v-if="!kiosk" />
    <header v-if="!kiosk" class="bd-top">
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
      <span
        v-if="isTunnelRoute"
        class="bd-status"
        :class="{ 'bd-on': rtcStatus === 'connected' }"
        role="status"
        :title="rtcStatus === 'connected' ? 'WebRTC P2P conectado' : rtcStatus === 'signaling' ? 'WebRTC conectando…' : 'Relay (fallback)'"
        data-cy="bd-rtc-status"
      >{{ rtcStatus === 'connected' ? 'P2P' : rtcStatus === 'signaling' ? '…' : 'Relay' }}</span>
      <div class="bd-tabs" role="tablist" :aria-label="t('bd.secProfiles')">
        <div
          v-for="profile in profiles"
          :key="profile.id"
          class="bd-tabwrap"
          :class="{ 'bd-active': profile.id === selectedProfile }"
        >
          <button
            role="tab"
            class="bd-tab"
            :aria-selected="profile.id === selectedProfile"
            @click="handleProfileChange(profile.id)"
            data-cy="bd-profile-tab"
          >
            {{ profile.name }}
          </button>
          <button
            class="bd-tabmenu-btn"
            :title="t('bd.profileMenu')"
            :aria-label="`${t('bd.profileMenu')}: ${profile.name}`"
            :aria-expanded="profileMenuOpen === profile.id"
            aria-haspopup="menu"
            @click.stop="toggleProfileMenu($event, profile.id)"
            :data-cy="`bd-profile-menu-${profile.id}`"
          >
            <Ellipsis :size="14" stroke-width="2" aria-hidden="true" />
          </button>
        </div>
        <button
          role="tab"
          class="bd-tab"
          :aria-selected="false"
          :title="t('bd.newProfile')"
          :aria-label="t('bd.newProfile')"
          @click="openProfileCreate()"
          data-cy="bd-profile-add"
        >
          <Plus :size="16" stroke-width="1.75" aria-hidden="true" />
        </button>
      </div>
      <!-- El menú vive en el header, FUERA de .bd-tabs (overflow-x:auto):
        dentro, el absolute quedaba recortado y el clic parecía no hacer
        nada. Al seguir bajo .bundeck hereda las variables del tema. -->
      <div
        v-if="profileMenuOpen && profileMenuProfile && profileMenuPos"
        class="bd-menu bd-profile-menu-portal"
        role="menu"
        data-cy="bd-profile-menu"
        :style="{ position: 'fixed', left: profileMenuPos.left + 'px', top: profileMenuPos.top + 'px', zIndex: 200 }"
        @keydown="onProfileMenuKey"
      >
        <button role="menuitem" data-cy="bd-profile-rename" @click="openProfileRename(profileMenuProfile)">
          <Pencil :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.rename') }}</span>
        </button>
        <button role="menuitem" data-cy="bd-profile-duplicate" @click="onProfileDuplicateMenu(profileMenuProfile.id)">
          <Copy :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.duplicate') }}</span>
        </button>
        <button
          role="menuitem"
          data-cy="bd-profile-export"
          :disabled="profileBackupBusy"
          @click="onProfileExportMenu(profileMenuProfile)"
        >
          <Download :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.exportProfile') }}</span>
        </button>
        <button
          role="menuitem"
          data-cy="bd-profile-import"
          :disabled="profileBackupBusy"
          @click="onProfileImportMenu()"
        >
          <Upload :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.importProfile') }}</span>
        </button>
        <button
          role="menuitem"
          class="bd-dng"
          data-cy="bd-profile-delete"
          :disabled="profiles.length < 2"
          @click="onProfileDeleteMenu(profileMenuProfile)"
        >
          <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.delete') }}</span>
        </button>
      </div>
      <input
        ref="profileImportInput"
        type="file"
        accept=".json,application/json"
        class="bd-hidden-file"
        data-cy="bd-profile-import-input"
        aria-hidden="true"
        tabindex="-1"
        @change="onProfileImportFile"
      />
      <button class="bd-ibtn" :title="t('bd.plugins')" :aria-label="t('bd.plugins')" @click="settingsDialog?.show('plugins')" data-cy="bd-open-plugins">
        <Puzzle :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
      <button
        class="bd-ibtn"
        :title="t('bd.secDevices')"
        :aria-label="t('bd.secDevices')"
        @click="settingsDialog?.show('devices')"
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

    <TunnelTransportBanner
      v-if="isTunnelRoute && !kiosk && showTransportBanner && !showTransportModal && (rtcStatus === 'connected' || rtcStatus === 'fallback')"
      :status="rtcStatus"
      @dismiss="showTransportBanner = false"
    />

    <TunnelConnectDialog
      v-if="showTransportModal"
      :status="rtcStatus"
      @dismiss="transportModalDismissed = true"
    />

    <main class="bd-main">
      <aside v-if="!kiosk" id="bd-drw" class="bd-side" :class="{ 'bd-collapsed': !bdShowLeft }" :aria-label="t('bd.libraryLabel')">
        <div v-if="bdShowLeft">
          <ActionsPanel
            ref="actionsPanel"
            :plugins="plugins"
            :detailed="pluginsDetailed"
            @action-pick="onActionPick"
            @action-logs="(p) => onActionTypeLogs(p)"
            @open-plugin-settings="(id) => openPluginSettings(id, 'settings')"
            @open-plugin-instructions="(id) => openPluginSettings(id, 'instructions')"
          />
        </div>
        <div v-else class="bd-collapsed-hit" aria-hidden="true"></div>
        <button
          class="bd-edge bd-edge-r"
          @click="bdSetPanels(!bdShowLeft, bdShowRight)"
          :title="bdShowLeft ? t('bd.collapseRight') : t('bd.expandRight')"
          :aria-label="bdShowLeft ? t('bd.collapseRight') : t('bd.expandRight')"
          :aria-expanded="bdShowLeft"
          :data-cy="bdShowLeft ? 'bd-collapse-left' : 'bd-expand-left'"
        >
          <PanelLeftClose v-if="bdShowLeft" :size="20" stroke-width="1.75" aria-hidden="true" />
          <PanelLeftOpen v-else :size="20" stroke-width="1.75" aria-hidden="true" />
        </button>
      </aside>

      <StageBoard
        :grid-cols="gridCols"
        :grid-rows="gridRows"
        :key-size="kiosk ? Math.max(bdKeySize, 96) : bdKeySize"
        :layout-mode="pageLayoutMode"
        :selected-button="selectedButton"
        :executing-buttons="executingButtons"
        :button-config="buttonConfig"
        :get-button="getButton"
        :all-buttons="currentButtons"
        :get-button-data="getButtonData"
        :display-data="(pos: number) => engine.resolveDisplay(pos)"
        :mode="mode"
        :kiosk="kiosk"
        :api-base="API_BASE"
        :label-mode="bdLabelMode"
        :current-pages="currentPages"
        :current-page="currentPage"
        :nav-trail="navTrail"
        :profile-name="currentProfile?.name ?? ''"
        :profile-data="(currentProfile as any)?.data"
        :devices="devStore.devices.value"
        :assignments="devStore.assignments.value"
        :hw-connected="devStore.hwStatus.value.connected"
        :preview-device-id="previewDeviceId"
        :busy="pageBusy"
        :long-press-ms="bdLongPressMs"
        @button-click="(pos) => selectButton(pos)"
        @button-execute="(pos) => onExecute(pos)"
        @button-long-press="(pos) => engine.execKey(pos, 'long')"
        @button-tap="(pos) => engine.tapKey(pos)"
        @button-delete="(pos) => onDeleteButton(pos)"
        @swap="handleSwap"
        @grid-size-change="onGridSizeChange"
        @mode-change="(m) => setMode(m)"
        @kiosk-enter="enterKiosk"
        @layout-mode-change="onLayoutModeChange"
        @layout-change="onGsLayoutChange"
        @gs-add="onGsAdd"
        @action-drop-empty="onGsActionDrop"
        @page-select="onPageSelectGuard"
        @page-create="onPageCreate"
        @page-delete="onPageDelete"
        @page-rename="onPageRename"
        @nav-back="onNavBack"
        @action-drop="onActionDrop"
        @button-export="(pos) => openExport(pos)"
        @button-import="(pos) => openImport(pos)"
        @button-logs="(pos) => onButtonLogs(pos)"
        @device-assign="onDeviceAssign"
        @preview-device-change="onPreviewDeviceChange"
        @manage-devices="() => settingsDialog?.show('devices')"
      />

      <aside v-if="!kiosk" id="bd-ins" class="bd-side" :class="{ 'bd-collapsed': !bdShowRight }" :aria-label="t('bd.inspectorLabel')">
        <div v-if="bdShowRight">
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
             :api-base="API_BASE"
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
            @view-logs="onKeyViewLogs"
            @action-logs="(p) => onKeyActionLogs(p)"
            @open-icon-picker="openIconPicker"
            @open-look-icon="(i) => openLookIconPicker(i)"
            @open-plugin-settings="(id) => openPluginSettings(id, 'settings')"
            @clear-image="onClearImage"
            @action-drop-selected="onActionDropSelected"
          />
        </div>
        <div v-else class="bd-collapsed-hit" aria-hidden="true"></div>
        <button
          class="bd-edge bd-edge-l"
          @click="bdSetPanels(bdShowLeft, !bdShowRight)"
          :title="bdShowRight ? t('bd.collapseLeft') : t('bd.expandLeft')"
          :aria-label="bdShowRight ? t('bd.collapseLeft') : t('bd.expandLeft')"
          :aria-expanded="bdShowRight"
          :data-cy="bdShowRight ? 'bd-collapse-right' : 'bd-expand-right'"
        >
          <PanelRightClose v-if="bdShowRight" :size="20" stroke-width="1.75" aria-hidden="true" />
          <PanelRightOpen v-else :size="20" stroke-width="1.75" aria-hidden="true" />
        </button>
      </aside>
    </main>

    <!-- Modo kiosco: solo grid + barra inferior (sustituye al caption y a
      los controles superiores). Salida discreta (botones de la barra +
      triple-tap en la esquina superior derecha + Escape), con
      confirmación. El pilotito de conexión es único (kconn/kled). -->
    <template v-if="kiosk">
      <div
        class="bd-kiosk-corner"
        data-cy="bd-kiosk-corner"
        :title="t('bd.kioskHint')"
        aria-hidden="true"
        @click="onKioskCornerTap"
      ></div>
      <div id="kbar" class="kiosk-bar" :class="{ 'is-collapsed': kioskBarCollapsed }" role="toolbar" :aria-label="t('bd.kioskExit')">
        <button
          class="kiosk-btn kiosk-collapse"
          data-cy="bd-kiosk-barcollapse"
          :aria-expanded="!kioskBarCollapsed"
          :aria-label="kioskBarCollapsed ? t('bd.kioskBarExpand') : t('bd.kioskBarCollapse')"
          :title="kioskBarCollapsed ? t('bd.kioskBarExpand') : t('bd.kioskBarCollapse')"
          @click="kioskBarCollapsed = !kioskBarCollapsed"
        >
          <ChevronRight v-if="kioskBarCollapsed" :size="16" stroke-width="1.75" aria-hidden="true" />
          <ChevronLeft v-else :size="16" stroke-width="1.75" aria-hidden="true" />
        </button>
        <div class="kiosk-collapsible">
        <button
          type="button"
          class="kconn"
          :data-cy="isTunnelRoute ? 'bd-kiosk-rtc' : 'bd-kiosk-conn'"
          :data-transport="kioskTransport"
          :title="kioskConnTitle"
          :aria-label="kioskConnTitle"
          aria-haspopup="dialog"
          @click="openKioskConn"
        >
          <span class="kled" :class="kioskTransport" aria-hidden="true"></span>
          <span>{{ kioskConnLabel }}</span>
        </button>
        <span class="kiosk-sep" aria-hidden="true"></span>
        <div
          id="kmarq"
          ref="kmarqRef"
          class="kmarquee"
          :class="{ 'is-static': !kioskMarqueeScroll }"
          role="marquee"
          :aria-label="kioskMarquee"
        >
          <div class="kmarquee-group"><span>{{ kioskMarquee }}</span></div>
          <div class="kmarquee-group" aria-hidden="true"><span>{{ kioskMarquee }}</span></div>
        </div>
        <span class="kiosk-sep" aria-hidden="true"></span>
        <span
          class="bd-kiosk-wake"
          data-cy="bd-kiosk-wake"
          :data-wake="wakeStatus"
          :title="wakeTitle"
          aria-hidden="true"
        ><i aria-hidden="true"></i></span>
        <button
          class="kiosk-btn"
          data-kfs=""
          data-cy="bd-kiosk-fullscreen"
          :title="t('bd.kioskFullscreen')"
          :aria-label="t('bd.kioskFullscreen')"
          @click="onKioskFullscreen"
        >
          <Minimize2 v-if="isFullscreen" :size="16" stroke-width="1.75" aria-hidden="true" />
          <Maximize2 v-else :size="16" stroke-width="1.75" aria-hidden="true" />
          <span>{{ t('bd.kioskFullscreen') }}</span>
        </button>
        <button
          class="kiosk-btn exit"
          data-kexit=""
          data-cy="bd-kiosk-exit"
          :title="t('bd.kioskExit')"
          :aria-label="t('bd.kioskExit')"
          @click="() => requestKioskExit('button')"
        >
          <LogOut :size="16" stroke-width="1.75" aria-hidden="true" />
          <span>{{ t('bd.kioskExit') }}</span>
        </button>
        </div>
      </div>
      <KioskConnDialog
        v-if="kioskConnOpen"
        :entries="kioskConnEntries"
        :transport-label="kioskConnLabel"
        :tone="kioskTransport"
        :ws-ok="isConnected"
        @dismiss="kioskConnOpen = false"
      />
    </template>

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
      :ws-connected="isConnected"
      :ws-url="WS_URL"
      :active-profile-id="selectedProfile"
      @language-changed="switchLanguage"
      @streamdeck-connected="onSdConnected"
      @streamdeck-disconnected="onSdDisconnected"
      @check-updates="showUpdateModal"
      @profile-updated="(id, updates) => handleProfileUpdate(id, updates)"
      @profile-deleted="(id) => handleProfileDeleted(id)"
      @profile-created="() => handleProfileCreate()"
      @profile-duplicated="(id) => handleProfileDuplicate(id)"
      @activate-profile="(id) => handleAutoActivate(id)"
      @streamdeck-imported="() => loadProfiles().catch(() => {})"
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
      @notify="(msg, undo) => bdShowToast(msg, undo)"
      @open-welcome="openWelcome"
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
      :current-image="buttonConfig.iconImage ?? ''"
      :api-base="API_BASE"
      @pick="(name) => onIconPick(name)"
      @pick-image="(url) => onPickImage(url)"
      @clear-image="onClearImage"
    />

    <QrDialog ref="qrDialog" @notify="(msg) => bdShowToast(msg)" />

    <PressLogsDialog ref="pressLogsDialog" :api-base="API_BASE" />

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

    <StreamDeckConflictDialog />

    <WelcomeDialog ref="welcomeDialog" @imported="loadProfiles().catch(() => {})" />

    <dialog ref="confirmDialog" class="bd-confirm" :aria-label="confirmTitle">
      <h2>{{ confirmTitle }}</h2>
      <p>{{ confirmMsg }}</p>
      <div class="bd-confirm-actions">
        <button class="bd-btn" @click="resolveConfirm(false)">{{ t('bd.cancel') }}</button>
        <button class="bd-btn bd-pri" @click="resolveConfirm(true)">{{ confirmOk }}</button>
      </div>
    </dialog>

    <dialog ref="presetDialog" class="bd-confirm" :aria-label="t('bd.presetDlgTitle')" @close="onPresetDialogClosed">
      <h2>{{ t('bd.presetDlgTitle') }}</h2>
      <p>{{ presetDlgMsg }}</p>
      <div class="bd-confirm-actions">
        <button class="bd-btn" data-cy="bd-preset-dlg-ignore" @click="resolvePreset('ignore')">{{ t('bd.presetIgnore') }}</button>
        <button v-if="presetDlgHasLooks" class="bd-btn bd-dng" data-cy="bd-preset-dlg-replace" @click="resolvePreset('replace')">{{ t('bd.presetReplace') }}</button>
        <button class="bd-btn bd-pri" data-cy="bd-preset-dlg-add" @click="resolvePreset('add')">{{ t('bd.presetAdd') }}</button>
      </div>
    </dialog>

    <dialog ref="profileNameDialog" class="bd-confirm" :aria-label="profileDialogTitle" @close="onProfileDialogClosed">
      <h2>{{ profileDialogTitle }}</h2>
      <div class="bd-confirm-body">
        <label class="bd-fld">
          <span class="bd-lb">{{ t('bd.profileName') }}</span>
          <input
            ref="profileNameInput"
            class="bd-inp"
            type="text"
            :value="profileDialogName"
            :placeholder="t('bd.profileNamePh')"
            data-cy="bd-profile-name-input"
            maxlength="80"
            @input="profileDialogName = ($event.target as HTMLInputElement).value"
            @keydown.enter.prevent="confirmProfileDialog()"
            @keydown.escape.prevent="closeProfileDialog()"
          />
        </label>
        <p v-if="profileDialogError" class="bd-err" role="alert">{{ profileDialogError }}</p>
      </div>
      <div class="bd-confirm-actions">
        <button class="bd-btn" @click="closeProfileDialog()">{{ t('bd.cancel') }}</button>
        <button class="bd-btn bd-pri" :disabled="!profileDialogName.trim()" data-cy="bd-profile-name-confirm" @click="confirmProfileDialog()">{{ profileDialogMode === 'create' ? t('bd.create') : t('bd.save') }}</button>
      </div>
    </dialog>

    <div v-if="bdToast" class="bd-toast bd-on" role="status" aria-live="polite">
      <span>{{ bdToast.message }}</span>
      <button v-if="bdToast.undo" @click="doUndo">{{ t('bd.undo') }}</button>
    </div>
    <!-- Velo de inactividad (web/remotos): opacidad según minutos de reposo. -->
    <BdIdleVeil />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick, defineAsyncComponent } from 'vue'
import { Plus, Puzzle, Maximize2, Minimize2, ChevronLeft, ChevronRight, QrCode, Settings, Monitor, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Ellipsis, FileUp, FileDown, Pencil, Copy, Trash2, Download, Upload, LogOut } from 'lucide-vue-next'
import { useStreamDeck, ensureDefaultIcon } from '../../composables/useStreamDeck'
import { useI18nStore } from '../../composables/useI18n'
import {
  bdResolvedPalette, bdLabelMode, bdKeySize, bdRadius, bdBrightness, bdAnimations, bdLongPressMs,
  bdShowLeft, bdShowRight, bdSetPanels, bdToast, bdShowToast, bdHideToast, initAppearanceSync
} from '../../composables/useBunDeckUi'
import { cleanKey, collectPageIds, parseSharedDoc, firstFreePosition, type SharedDoc } from '../../composables/useKeyShare'
import {
  fetchProfileBackup, triggerJsonDownload, safeProfileFilename, isProfileBackup,
  cloneBackupAsCopy, validateProfileBackup, restoreProfileBackup,
} from '../../composables/useProfileBackup'
import { planFreeCell, clampDropCell, gridResizeFits } from '../../composables/useDeckLayouts'
import {
  actionTypeSurfaceKind, findActionAdata, findControlAction, isControlAction
} from '../../composables/useActionPresentation'
import { createKeyEngine, keyUsedVars } from '../../composables/useKeyEngine'
import {
  parseKioskFromLocation,
  withKioskParam,
  withoutKioskParam,
  guardModeChange,
  isTripleTap,
  marqueeOverflows,
  requestFullscreen,
  type KioskExitReason,
} from '../../composables/useKiosk'
import { useKioskWakeLock } from '../../composables/useKioskWakeLock'
import { getTunnelToken } from '../../composables/useTunnel'
import { kioskTransportLabelKey } from '../../utils/kioskTransport'
import { readLanProbe, type ConnEntry } from '../../utils/kioskConnLog'
import { getRtcSingleton } from '../../composables/useRemoteRtc'
import {
  getActionsForKind,
  setActionsForKind,
  type PressKind,
} from '../../composables/usePressActions'
import { OPEN_ACTION_SETTINGS_EVENT } from '../../composables/useOpenActionSettings'
import { vars, onVarChange, getVar, importVar, removeVar } from '../../composables/useVars'
import { presetOfferFor, mergePresetLooks, cleanLooksList, resolvePresetLooks } from '../../composables/useExposedVariables'
import {
  useDevices, checkPageCompatibility, resolvePageSize, resolveDeckSize,
  type LogicalDevice,
} from '../../composables/useDevices'
import StageBoard from './StageBoard.vue'
import TitleBar from './TitleBar.vue'
import TunnelTransportBanner from './TunnelTransportBanner.vue'
import TunnelConnectDialog from './TunnelConnectDialog.vue'
import KioskConnDialog from './KioskConnDialog.vue'
import KeyInspector from './KeyInspector.vue'
import ActionsPanel from './ActionsPanel.vue'
import IosWarningDialog from './IosWarningDialog.vue'
import StreamDeckConflictDialog from './StreamDeckConflictDialog.vue'
// Diálogos pesados: chunks diferidos (solo cliente; BunDeckApp es
// client:load, así que no hay SSR que romper). Se cargan al abrirse.
const ActionCommandPalette = defineAsyncComponent(() => import('./ActionCommandPalette.vue'))
const KeyIoDialog = defineAsyncComponent(() => import('./KeyIoDialog.vue'))
const PluginSettingsDialog = defineAsyncComponent(() => import('./PluginSettingsDialog.vue'))
const SettingsDialog = defineAsyncComponent(() => import('./SettingsDialog.vue'))
const IconPickerDialog = defineAsyncComponent(() => import('./IconPickerDialog.vue'))
const QrDialog = defineAsyncComponent(() => import('./QrDialog.vue'))
const PressLogsDialog = defineAsyncComponent(() => import('./PressLogsDialog.vue'))
const BdIdleVeil = defineAsyncComponent(() => import('./BdIdleVeil.vue'))
const WelcomeDialog = defineAsyncComponent(() => import('./WelcomeDialog.vue'))
const UpdateModal = defineAsyncComponent(() => import('../UpdateModal.vue'))
import type { PageData } from '../../types/streamdeck'

const { t, currentLocale, setLocale, loadSavedLocale } = useI18nStore()
loadSavedLocale()

const switchLanguage = (newLocale: string) => setLocale(newLocale)

const mode = ref<'edit' | 'use'>('edit')
// Modo kiosco: entra por URL (?kiosk=1 / ?mode=kiosk / #kiosk). Mientras dura,
// el modo `edit` queda bloqueado y no se renderizan header/drawers/toolbars.
const kiosk = ref(false)
let kioskCornerTaps: number[] = []
// Pantalla siempre encendida en kiosco: Wake Lock + fallback de vídeo
// para iPads antiguos / HTTP local. Solo actúa con kiosco activo.
const { wakeStatus, ensureKioskWake, releaseKioskWake } = useKioskWakeLock(kiosk)
const wakeTitle = computed(() =>
  wakeStatus.value === 'wake-lock'
    ? t('bd.kioskKeepAwake')
    : wakeStatus.value === 'video'
      ? t('bd.kioskKeepAwakeFallback')
      : t('bd.kioskKeepAwakeOff')
)
const setMode = (m: 'edit' | 'use') => {
  mode.value = guardModeChange(kiosk.value, m)
  selectedButton.value = null
}

/** Entrada manual al kiosco (botón Kiosco en Editar/Usar): sin recargar,
 *  propaga ?kiosk=1 a la URL para que recargar/enlazar conserve el modo. */
const enterKiosk = () => {
  if (kiosk.value) return
  kiosk.value = true
  mode.value = 'use'
  selectedButton.value = null
  kioskCornerTaps = []
  try {
    window.history.replaceState(null, '', withKioskParam(window.location.href))
  } catch {
    /* sin history: el estado interno ya entró en kiosco */
  }
  // Dentro del gesto del clic: en iOS el fallback de vídeo lo exige.
  void ensureKioskWake()
}

/** Pide salir del kiosco (con confirmación) y limpia el param de la URL. */
const exitKiosk = () => {
  releaseKioskWake()
  kiosk.value = false
  kioskCornerTaps = []
  try {
    const clean = withoutKioskParam(window.location.href)
    window.history.replaceState(null, '', clean)
  } catch {
    /* sin history: el estado interno ya salió del kiosco */
  }
  if (mode.value !== 'use') mode.value = 'use'
  // Al volver a la UI completa, llevar el foco al primer tab de perfil.
  nextTick(() => {
    try {
      ;(document.querySelector('header.bd-top .bd-tab') as HTMLElement | null)?.focus()
    } catch {
      /* sin header visible: nada que enfocar */
    }
  })
}
const requestKioskExit = async (_reason: KioskExitReason) => {
  if (!kiosk.value) return
  const ok = await askConfirm(t('bd.kioskExitTitle'), t('bd.kioskExitMsg'), t('bd.kioskExit'))
  if (ok) exitKiosk()
}
/** Triple-tap en la esquina superior derecha = pedir salida del kiosco. */
const onKioskCornerTap = () => {
  const now = Date.now()
  kioskCornerTaps = [...kioskCornerTaps, now].slice(-5)
  if (isTripleTap(kioskCornerTaps, now)) {
    kioskCornerTaps = []
    void requestKioskExit('corner')
  }
}
// Atajos globales (Ajustes → Atajos, o broadcast `shortcut.triggered` del
// daemon cuando el launcher captura la hotkey): salida directa sin
// confirmación, la pulsación ya es un gesto explícito del usuario.
if (typeof window !== 'undefined') {
  window.addEventListener('bundeck:toggle-kiosk', () => {
    if (kiosk.value) exitKiosk()
    else enterKiosk()
  })
}
/** Pantalla completa bajo demanda (gesto del usuario; si falla, se sigue sin ella). */
const onKioskFullscreen = () => {
  void requestFullscreen()
}

const settingsDialog = ref<InstanceType<typeof SettingsDialog> | null>(null)
const iconPickerDialog = ref<InstanceType<typeof IconPickerDialog> | null>(null)
const qrDialog = ref<InstanceType<typeof QrDialog> | null>(null)
const pressLogsDialog = ref<InstanceType<typeof PressLogsDialog> | null>(null)
const actionsPanel = ref<InstanceType<typeof ActionsPanel> | null>(null)
const updateModal = ref<InstanceType<typeof UpdateModal> | null>(null)
const pluginSettingsDialog = ref<InstanceType<typeof PluginSettingsDialog> | null>(null)
const welcomeDialog = ref<{ show: (at?: number) => void; shouldAutoShow: () => boolean } | null>(null)

const openWelcome = (at = 0) => {
  welcomeDialog.value?.show(at)
}

const openPluginSettings = (pluginId: string, tab: 'settings' | 'instructions') => {
  pluginSettingsDialog.value?.show(pluginId, tab)
}

const {
  connectionStatus, connectionText, profiles, selectedProfile, currentProfile,
  currentPage, currentPages, currentButtons, plugins, gridCols, gridRows,
  selectedButton, executingButtons, buttonConfig, buttonConfigVersion, bumpConfigVersion, API_BASE, WS_URL,
  deviceId,
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
  lanDenied, redeemLanInviteFromUrl,
  lanRelayFallback,
  tunnelSessionInvalid,
  installProgress, clearInstallProgress
} = useStreamDeck()

// WebRTC P2P en modo túnel: badge + autoconexión en background (fallback intacto).
const rtc = getRtcSingleton()
const rtcStatus = rtc.status
const rtcDetail = rtc.detail
const isTunnelRoute = computed(() => getTunnelToken() !== null)
// Banner de transporte al entrar por túnel: visible hasta que el usuario lo
// cierre o pasen 8 s desde un estado terminal (connected/fallback).
const showTransportBanner = ref(false)
// Modal centrada de conexión: una vez por intento (se resetea al iniciar una
// conexión; el cierre manual no reabre hasta el próximo intento).
const transportModalDismissed = ref(false)
const showTransportModal = computed(() =>
  isTunnelRoute.value &&
  !transportModalDismissed.value &&
  (rtcStatus.value === 'idle' || rtcStatus.value === 'signaling')
)
let transportBannerTimer: ReturnType<typeof setTimeout> | null = null
let transportConnectTimer: ReturnType<typeof setTimeout> | null = null
watch(rtcStatus, (s) => {
  if (s === 'signaling') transportModalDismissed.value = false
  if (transportBannerTimer !== null) {
    clearTimeout(transportBannerTimer)
    transportBannerTimer = null
  }
  if (!isTunnelRoute.value || !showTransportBanner.value) return
  if (s === 'connected' || s === 'fallback') {
    transportBannerTimer = setTimeout(() => {
      showTransportBanner.value = false
      transportBannerTimer = null
    }, 8000)
  }
})

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

// ---- Dispositivos lógicos + pantallas por perfil ----
const devStore = useDevices(() => API_BASE.value)
const previewDeviceId = ref<string | null>(null)
const previewDevice = computed(() =>
  previewDeviceId.value
    ? (devStore.devices.value.find((d) => d.id === previewDeviceId.value) ?? null)
    : null
)

// Confirmación con promesa (guardas destructivas: libre / resize en decks).
const confirmDialog = ref<HTMLDialogElement | null>(null)
const confirmTitle = ref('')
const confirmMsg = ref('')
const confirmOk = ref('')
let confirmResolve: ((v: boolean) => void) | null = null
const askConfirm = (title: string, msg: string, ok: string): Promise<boolean> =>
  new Promise((resolve) => {
    confirmTitle.value = title
    confirmMsg.value = msg
    confirmOk.value = ok
    confirmResolve = resolve
    confirmDialog.value?.showModal()
  })
const resolveConfirm = (v: boolean) => {
  confirmDialog.value?.close()
  confirmResolve?.(v)
  confirmResolve = null
}

// Diálogo de presets al añadir una acción con estados: si es la única
// acción de la tecla y no hay condiciones, se añaden solas; si ya había
// acciones o condiciones, se pregunta ignorar / añadir / reemplazar.
const presetDialog = ref<HTMLDialogElement | null>(null)
const presetDlgMsg = ref('')
const presetDlgHasLooks = ref(false)
let presetResolve: ((v: 'ignore' | 'add' | 'replace') => void) | null = null
const askPreset = (msg: string, hasLooks: boolean): Promise<'ignore' | 'add' | 'replace'> =>
  new Promise((resolve) => {
    presetDlgMsg.value = msg
    presetDlgHasLooks.value = hasLooks
    presetResolve = resolve
    presetDialog.value?.showModal()
  })
const resolvePreset = (v: 'ignore' | 'add' | 'replace') => {
  presetDialog.value?.close()
  presetResolve?.(v)
  presetResolve = null
}
const onPresetDialogClosed = () => {
  // Cerrar con Escape/X equivale a ignorar (no se toca nada).
  if (presetResolve) {
    presetResolve('ignore')
    presetResolve = null
  }
}
/** Nº de acciones directas en todos los tipos de pulsación (sin reglas). */
const countPressActions = (cfg: any): number => {
  let n = 0
  for (const k of ['click', 'double', 'triple', 'long'] as const) n += getActionsForKind(cfg, k).length
  return n
}
/** Tras añadir la acción: auto-presets si es la única y no hay
 *  condiciones; si ya había acciones o condiciones, preguntar. */
const afterActionAdded = async (type: string, priorActions: number) => {
  const current = cleanLooksList(buttonConfig.value.looks)
  const offer = presetOfferFor(current, type)
  if (!offer) return
  const resolved = resolvePresetLooks(offer.groups, buttonConfig.value, t)
  const missing = resolved.filter((r) => !current.some((l) => String(l?.cond ?? '').trim() === r.cond))
  if (!missing.length) return
  if (priorActions === 0 && current.length === 0) {
    buttonConfig.value = { ...buttonConfig.value, looks: [...current, ...missing] }
    bumpConfigVersion()
    await saveButtonConfig()
    return
  }
  const varNames = [...new Set(offer.groups.map((g) => g.varName))].join(', ')
  const key = current.length ? 'bd.presetDlgMsg' : 'bd.presetDlgMsgNoLooks'
  const choice = await askPreset(t(key, { n: current.length, vars: varNames, m: missing.length }), current.length > 0)
  if (choice === 'ignore') return
  buttonConfig.value = { ...buttonConfig.value, looks: mergePresetLooks(current, resolved, choice) }
  bumpConfigVersion()
  await saveButtonConfig()
}

/** Vista mínima de página para la regla de compatibilidad. */
const compatPageOf = (p: any) => ({
  id: p.id,
  name: p.name,
  is_folder: p.is_folder,
  parent_id: p.parent_id ?? null,
  grid_cols: p.grid_cols ?? null,
  grid_rows: p.grid_rows ?? null,
  data: p.data,
})
const profileDataOf = computed(() => (currentProfile.value as any)?.data)
const compatOf = (p: any, d: LogicalDevice) =>
  checkPageCompatibility(compatPageOf(p), d, profileDataOf.value, devStore.hwStatus.value.grid)
/** Decks que muestran la página actual (o sus carpetas padre). */
const decksOfCurrentChain = computed(() => {
  const chain = new Set<string>()
  let cur: any = currentPage.value
  const byId = new Map((currentPages.value ?? []).map((p: any) => [p.id, p]))
  while (cur && !chain.has(cur.id)) {
    chain.add(cur.id)
    cur = cur.parent_id ? byId.get(cur.parent_id) : null
  }
  return devStore.devices.value.filter(
    (d) => d.kind === 'deck' && chain.has(devStore.assignments.value[d.id])
  )
})
/** Páginas que ningún deck de la cadena actual puede mostrar (selector de carpeta). */
const folderBlockedReasons = computed(() => {
  const decks = decksOfCurrentChain.value
  const out = new Map<string, string>()
  if (!decks.length) return out
  for (const p of currentPages.value ?? []) {
    const bad = decks.find((d) => !compatOf(p as any, d).ok)
    if (!bad) continue
    const c = checkPageCompatibility(compatPageOf(p as any), bad, profileDataOf.value, devStore.hwStatus.value.grid)
    out.set((p as any).id, c.why === 'free-mode'
      ? t('bd.deviceCompatFree')
      : (() => {
        const size = resolvePageSize(compatPageOf(p as any), profileDataOf.value)
        const want = resolveDeckSize(bad) ?? devStore.hwStatus.value.grid
        return t('bd.deviceCompatSize', {
          size: `${size.cols}×${size.rows}`,
          want: want ? `${want.cols}×${want.rows}` : '',
        })
      })())
  }
  return out
})

const canExportSelected = computed(() => {
  if (selectedButton.value === null) return false
  const b = getButton(selectedButton.value)
  return !!(b?.data?.actions?.length)
})

const openPalette = (path = 'acts') => {
  // En kiosco no hay paleta ni edición: se ignora en silencio.
  if (kiosk.value) return
  if (mode.value === 'use') {
    bdShowToast(t('bd.switchToEdit'))
    return
  }
  // En modo libre la paleta puede abrirse sin selección: al elegir acción
  // se crea una tecla nueva (ver ensureFreeKeyForAction).
  if (selectedButton.value === null && pageLayoutMode.value !== 'gridstack') {
    bdShowToast(t('bd.selectKeyFirst'))
    return
  }
  palettePath.value = path
  palette.value?.show()
}

const onPalettePick = async (type: string) => {
  // Paleta sobre el clic principal en libre sin selección = tecla nueva.
  // (double/triple/long y ramas de reglas necesitan una tecla destino.)
  const path = palettePath.value
  const mPress = /^(?:press:)?(click|double|triple|long)$/.exec(path)
  const isPlainClick = (mPress?.[1] ?? (!path || path === 'acts' ? 'click' : '')) === 'click'
  if (isPlainClick && (await ensureFreeKeyForAction(type))) {
    palettePath.value = 'acts'
    return
  }
  if (!ensureEditableTarget()) return
  try {
    palettePath.value = 'acts'
    if (mPress || !path || path === 'acts') {
      await addActionToKind(type, (mPress?.[1] ?? 'click') as PressKind)
    } else {
      const m = /^r(\d+)\.(then|else)$/.exec(path)
      const rules = [...(buttonConfig.value.rules ?? [])]
      const ri = m ? +m[1] : -1
      if (!m || !rules[ri]) {
        await addActionToKind(type, 'click')
      } else {
        const side = m[2] as 'then' | 'else'
        rules[ri] = { ...rules[ri], [side]: [...(rules[ri][side] ?? []), createAction(type)] }
        buttonConfig.value = { ...buttonConfig.value, rules }
        bumpConfigVersion()
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
        bumpConfigVersion()
        await saveButtonConfig()
        return
      }
    }
    // El icono Lucide sustituye a la imagen personalizada (la imagen manda
    // en el pintado, así que convivir confundiría).
    if (buttonConfig.value.iconImage) onUpdateField('iconImage', '')
    onUpdateField('icon', name)
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}
/** Imagen subida desde el diálogo: guardado inmediato (como las acciones). */
const onPickImage = async (url: string) => {
  try {
    if (!url) return
    onUpdateField('iconImage', url)
    await saveButtonConfig()
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}
/** Quitar la imagen personalizada (borra el fichero en el daemon, best-effort). */
const onClearImage = async () => {
  try {
    const cur = typeof buttonConfig.value.iconImage === 'string' ? buttonConfig.value.iconImage : ''
    onUpdateField('iconImage', '')
    await saveButtonConfig()
    if (cur.startsWith('/assets/')) {
      fetch(`${API_BASE.value}/assets`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cur })
      }).catch(() => {})
    }
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
  if (profileMenuOpen.value && !(e.target as HTMLElement).closest?.('.bd-tabwrap') && !(e.target as HTMLElement).closest?.('.bd-profile-menu-portal')) {
    closeProfileMenu()
  }
}
const onDocKeyProfile = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && profileMenuOpen.value) closeProfileMenu()
}
// El menú ya no recalcula su posición al hacer scroll/resize: se cierra para
// no quedar descolgado del botón ··· que lo abrió.
const onViewportChangeCloseProfile = () => {
  if (profileMenuOpen.value) closeProfileMenu()
}

const availablePages = computed(() =>
  currentPages.value
    .filter((page) => page.is_folder === 0)
    .map((page) => {
      const reason = folderBlockedReasons.value.get(page.id)
      return {
        id: page.id,
        name: page.name,
        disabled: reason !== undefined,
        disabledReason: reason,
      }
    })
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

// Barra inferior del kiosco: pilotito único de conexión + marquee. En túnel
// replica el mapa del antiguo TunnelKioskDot; en LAN directa, P2P si el WS
// vive y Desconectado en caso contrario.
const kioskTransport = computed(() => {
  if (isTunnelRoute.value) {
    if (rtcStatus.value === 'connected') return 'p2p'
    if (rtcStatus.value === 'fallback') return isConnected.value ? 'relay' : 'disconnected'
    return rtcStatus.value === 'signaling' ? 'probing' : 'connecting'
  }
  return isConnected.value ? 'p2p' : 'disconnected'
})
const kioskConnLabel = computed(() => t(kioskTransportLabelKey(kioskTransport.value)))
const kioskConnTitle = computed(() => {
  if (!isTunnelRoute.value) return isConnected.value ? t('bd.connected') : t('bd.disconnected')
  switch (kioskTransport.value) {
    case 'p2p': return t('bd.tunnelTransportP2p')
    case 'relay': return t('bd.tunnelTransportRelay')
    case 'disconnected': return t('bd.tunnelTransportDisconnected')
    case 'probing': return t('bd.tunnelTransportProbing')
    default: return t('bd.tunnelTransportConnecting')
  }
})
// Historial de conexión del kiosco: el pilotito es un botón que abre un
// diálogo de solo lectura (display, sin navegación ni copia). La LAN va
// primero (ocurrió antes que el P2P); en LAN sin redirect, vacío honesto.
const kioskConnOpen = ref(false)
const lanEntries = ref<ConnEntry[]>([])
const kioskConnEntries = computed<ConnEntry[]>(() => [...lanEntries.value, ...rtc.log.value])
const openKioskConn = () => {
  try {
    lanEntries.value = readLanProbe()
  } catch {
    lanEntries.value = []
  }
  kioskConnOpen.value = true
}
// Marquee de la barra: página actual · cuadrícula · dispositivo visible
// (vista previa o el propio; se omite si no hay ninguno).
const kioskDeviceName = computed(() => {
  const prev = previewDevice.value?.name?.trim()
  if (prev) return prev
  const own = devStore.devices.value.find((d) => d.id === deviceId.value)?.name?.trim()
  return own ?? ''
})
const kioskMarquee = computed(() => {
  const parts = [currentPage.value?.name?.trim() || '', `${gridCols.value} × ${gridRows.value}`]
  if (kioskDeviceName.value) parts.push(kioskDeviceName.value)
  return parts.filter(Boolean).join(' · ')
})
// Marquee infinito de dos grupos idénticos: solo se anima cuando el texto
// desborda; con texto corto queda fijo y centrado (sin movimiento inútil).
const kmarqRef = ref<HTMLElement | null>(null)
const kioskMarqueeScroll = ref(false)
// Barra colapsable en todos los viewports: contraída queda el icono.
// En móvil además flota sobre el grid (ver CSS) para no restar espacio.
const kioskBarCollapsed = ref(false)
let marqueeRO: ResizeObserver | null = null
const measureMarquee = () => {
  const el = kmarqRef.value
  // El texto, no el grupo: su padding-right de separación inflaría scrollWidth.
  const t = el?.querySelector('.kmarquee-group > span') as HTMLElement | null
  if (!el || !t) return
  kioskMarqueeScroll.value = marqueeOverflows(t.scrollWidth, el.clientWidth)
}
watch(kmarqRef, (el) => {
  marqueeRO?.disconnect()
  marqueeRO = null
  if (el && typeof ResizeObserver !== 'undefined') {
    try {
      marqueeRO = new ResizeObserver(() => measureMarquee())
      marqueeRO.observe(el)
    } catch { /* sin RO: medida puntual */ }
  }
  nextTick(measureMarquee)
})
watch(kioskMarquee, () => nextTick(measureMarquee))

// Perfiles
const profileMenuOpen = ref<string | null>(null)
const profileMenuPos = ref<{ left: number; top: number } | null>(null)
const profileMenuProfile = computed(() =>
  profiles.value.find((p) => p.id === profileMenuOpen.value) ?? null
)
const closeProfileMenu = () => {
  profileMenuOpen.value = null
  profileMenuPos.value = null
}
const toggleProfileMenu = (e: MouseEvent, profileId: string) => {
  if (profileMenuOpen.value === profileId) {
    closeProfileMenu()
    return
  }
  const rect = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  // Ancla bajo el botón ···, acotado al viewport para que no se salga.
  const menuW = 200
  const menuH = 220
  const left = rect
    ? Math.max(8, Math.min(rect.left, window.innerWidth - menuW - 8))
    : 8
  const top = rect
    ? Math.min(rect.bottom + 4, window.innerHeight - menuH - 8)
    : 8
  profileMenuOpen.value = profileId
  profileMenuPos.value = { left, top }
  nextTick(() =>
    document.querySelector<HTMLElement>('.bd-profile-menu-portal button')?.focus()
  )
}
const onProfileMenuKey = (e: KeyboardEvent) => {
  const items = [...document.querySelectorAll<HTMLElement>('.bd-profile-menu-portal button:not(:disabled)')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    items[(i + 1) % items.length]?.focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    items[(i - 1 + items.length) % items.length]?.focus()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeProfileMenu()
  }
}
const profileNameDialog = ref<HTMLDialogElement | null>(null)
const profileNameInput = ref<HTMLInputElement | null>(null)
const profileDialogMode = ref<'create' | 'rename'>('create')
const profileDialogName = ref('')
const profileDialogTarget = ref<string | null>(null)
const profileDialogError = ref('')
const profileDialogTitle = computed(() =>
  profileDialogMode.value === 'create' ? t('bd.createProfileTitle') : t('bd.renameProfileTitle')
)
const uniqueProfileName = (base: string, skipId?: string) => {
  const taken = new Set(profiles.value.filter((p) => p.id !== skipId).map((p) => p.name.trim().toLowerCase()))
  const clean = base.trim()
  if (!taken.has(clean.toLowerCase())) return clean
  let i = 2
  while (taken.has(`${clean} ${i}`.toLowerCase())) i++
  return `${clean} ${i}`
}
const openProfileCreate = () => {
  closeProfileMenu()
  profileDialogMode.value = 'create'
  profileDialogTarget.value = null
  profileDialogName.value = ''
  profileDialogError.value = ''
  profileNameDialog.value?.showModal()
  nextTick(() => profileNameInput.value?.focus())
}
const openProfileRename = (profile: { id: string; name: string }) => {
  closeProfileMenu()
  profileDialogMode.value = 'rename'
  profileDialogTarget.value = profile.id
  profileDialogName.value = profile.name
  profileDialogError.value = ''
  profileNameDialog.value?.showModal()
  nextTick(() => {
    profileNameInput.value?.focus()
    profileNameInput.value?.select()
  })
}
const closeProfileDialog = () => {
  profileNameDialog.value?.close()
}
const onProfileDialogClosed = () => {
  profileDialogName.value = ''
  profileDialogError.value = ''
  profileDialogTarget.value = null
}
const confirmProfileDialog = async () => {
  const name = profileDialogName.value.trim()
  if (!name) return
  try {
    if (profileDialogMode.value === 'create') {
      const finalName = uniqueProfileName(name)
      const created = await createProfile(finalName)
      bdShowToast(t('bd.profileCreated', { name: finalName }))
      await selectProfile(created.id)
      try { await devStore.loadAssignments(created.id) } catch { /* noop */ }
      navTrail.value = currentPage.value ? [currentPage.value.name] : []
    } else {
      const targetId = profileDialogTarget.value
      if (!targetId) return
      const finalName = uniqueProfileName(name, targetId)
      await updateProfile(targetId, { name: finalName })
      bdShowToast(t('bd.profileRenamed', { name: finalName }))
    }
    closeProfileDialog()
  } catch (e: any) {
    profileDialogError.value = String(e?.message ?? e)
  }
}
const handleProfileChange = async (profileId: string) => {
  closeProfileMenu()
  await selectProfile(profileId)
  // Asignaciones del perfil (el GET ya repara incompatibles en el daemon).
  try {
    await devStore.loadAssignments(profileId)
  } catch { /* sin daemon: se sigue sin dispositivos */ }
  // Si se simula un dispositivo, se abre su pantalla asignada.
  if (previewDevice.value) {
    const target = devStore.assignments.value[previewDevice.value.id]
    if (target && target !== currentPage.value?.id && (currentPages.value ?? []).some((p) => p.id === target)) {
      await selectPage(target)
    }
  }
  navTrail.value = currentPage.value ? [currentPage.value.name] : []
  engine.runLoad(allPositions)
}
const handleProfileCreate = async () => {
  openProfileCreate()
}
const handleProfileUpdate = async (profileId: string, updates: any) => {
  await updateProfile(profileId, updates)
}
const handleProfileDeleted = async (profileId: string) => {
  const target = profiles.value.find((p) => p.id === profileId)
  await deleteProfile(profileId)
  bdShowToast(t('bd.profileDeleted', { name: target?.name ?? '' }))
}
const onProfileDeleteMenu = async (profile: { id: string; name: string }) => {
  closeProfileMenu()
  if (profiles.value.length < 2) return
  const ok = await askConfirm(
    t('bd.deleteProfileTitle'),
    t('bd.deleteProfileMsg', { name: profile.name }),
    t('bd.delete')
  )
  if (!ok) return
  try {
    await deleteProfile(profile.id)
    bdShowToast(t('bd.profileDeleted', { name: profile.name }))
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}
const onProfileDuplicateMenu = async (profileId: string) => {
  closeProfileMenu()
  await handleProfileDuplicate(profileId)
}
// ---- Exportar / importar perfiles (menú ··· de cada tab) ----
const profileBackupBusy = ref(false)
const profileImportInput = ref<HTMLInputElement | null>(null)
const onProfileExportMenu = async (profile: { id: string; name: string }) => {
  closeProfileMenu()
  if (profileBackupBusy.value) return
  profileBackupBusy.value = true
  try {
    const backup = await fetchProfileBackup(API_BASE.value, profile.id)
    triggerJsonDownload(backup, `libredeck-perfil-${safeProfileFilename(profile.name)}.json`)
    bdShowToast(t('bd.profileExported', { name: profile.name }))
  } catch (e) {
    bdShowToast(`${t('bd.backupExportFailed')}: ${String((e as Error)?.message ?? e)}`)
  } finally {
    profileBackupBusy.value = false
  }
}
const onProfileImportMenu = () => {
  closeProfileMenu()
  if (profileBackupBusy.value) return
  // Reset para que elegir el mismo archivo dos veces dispare `change`.
  if (profileImportInput.value) profileImportInput.value.value = ''
  profileImportInput.value?.click()
}
const onProfileImportFile = async (e: Event) => {
  const file = (e.target as HTMLInputElement | null)?.files?.[0]
  if (!file) return
  if (profileBackupBusy.value) return
  profileBackupBusy.value = true
  try {
    const text = await file.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(t('bd.invalidBackup'))
    }
    if (!isProfileBackup(parsed)) throw new Error(t('bd.invalidBackup'))
    // Nombre único + ids nuevos: nunca se sobrescribe el original (merge por id).
    const wanted = uniqueProfileName(String(parsed.data.profiles[0]?.name ?? file.name))
    const copy = cloneBackupAsCopy(parsed, { newName: wanted })
    const checked = await validateProfileBackup(API_BASE.value, copy)
    if (!checked.valid) {
      const errs = Array.isArray(checked.errors) ? checked.errors.join('; ') : ''
      throw new Error(errs || t('bd.invalidBackup'))
    }
    await restoreProfileBackup(API_BASE.value, copy)
    await loadProfiles()
    const created = profiles.value.find((p) => p.id === copy.data.profiles[0]?.id)
    if (created) {
      try {
        await selectProfile(created.id)
        try { await devStore.loadAssignments(created.id) } catch { /* noop */ }
        navTrail.value = currentPage.value ? [currentPage.value.name] : []
      } catch { /* el perfil ya existe aunque falle la selección */ }
    }
    bdShowToast(t('bd.profileImported', { name: wanted }))
  } catch (err) {
    bdShowToast(`${t('bd.profileImportFailed')}: ${String((err as Error)?.message ?? err)}`)
  } finally {
    profileBackupBusy.value = false
    if (profileImportInput.value) profileImportInput.value.value = ''
  }
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
    // Anti-corrupción: si tras parsear no es objeto plano (string doblemente
    // codificado), el spread crearía claves numéricas y el payload explotaría
    // (incidente 118 MB). Igual para pg.data de páginas (string de la API).
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}
    const cleanData = { ...data, isDefault: false }
    const baseCopy = t('bd.profileCopyName', { name: orig.name })
    const copyName = uniqueProfileName(baseCopy)
    const created = await apiPost('/profiles', { name: copyName, data: cleanData })
    // Copia páginas y botones en DOS pasadas: primero todas las páginas
    // (mapa id viejo → nuevo completo) y después los botones, para que las
    // referencias `pageId` "hacia adelante" también se reescriban. Con una
    // sola pasada las referencias a páginas aún no creadas quedaban colgadas
    // al perfil original.
    const pages = await apiGet(`/pages?profileId=${encodeURIComponent(profileId)}`)
    const pageIdMap = new Map<string, string>()
    const asPageData = (d: unknown): Record<string, unknown> => {
      let v: any = d
      if (typeof v === 'string') {
        try { v = JSON.parse(v) } catch { return {} }
      }
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    }
    const createdPages: Array<{ orig: any; copy: any }> = []
    for (const pg of pages ?? []) {
      const np = await apiPost('/pages', {
        profile_id: created.id,
        name: pg.name,
        order_idx: pg.order_idx,
        is_folder: pg.is_folder,
        grid_cols: (pg as any).grid_cols ?? null,
        grid_rows: (pg as any).grid_rows ?? null,
        data: asPageData(pg.data)
      })
      pageIdMap.set(pg.id, np.id)
      createdPages.push({ orig: pg, copy: np })
    }
    const remapRefs = (obj: any) => {
      if (!obj || typeof obj !== 'object') return
      for (const a of obj.actions ?? []) {
        const pid = a?.parameters?.pageId
        if (typeof pid === 'string' && pageIdMap.has(pid)) a.parameters.pageId = pageIdMap.get(pid)
      }
      for (const r of obj.rules ?? []) {
        remapRefs({ actions: r?.then })
        remapRefs({ actions: r?.else })
      }
    }
    for (const { orig, copy } of createdPages) {
      let buttons: any[] = []
      try {
        buttons = await apiGet(`/buttons?pageId=${encodeURIComponent(orig.id)}`)
      } catch {
        buttons = []
      }
      for (const b of buttons ?? []) {
        // Reescribe referencias a páginas internas (carpetas) al nuevo id
        const bdata = JSON.parse(JSON.stringify(b.data ?? {}))
        remapRefs(bdata)
        await apiPost('/buttons', { page_id: copy.id, position: b.position, data: bdata })
      }
    }
    // Recargar para mostrar el duplicado y seleccionarlo.
    await loadProfiles()
    bdShowToast(t('bd.profileDuplicated', { name: copyName }))
    try {
      await selectProfile(created.id)
      try { await devStore.loadAssignments(created.id) } catch { /* noop */ }
      navTrail.value = currentPage.value ? [currentPage.value.name] : []
    } catch { /* el duplicado ya existe aunque falle la selección */ }
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
/** Guarda en modo uso: el dispositivo simulado no abre páginas incompatibles. */
const onPageSelectGuard = async (pageId: string) => {
  if (mode.value === 'use' && previewDevice.value && previewDevice.value.kind === 'deck') {
    const page = (currentPages.value ?? []).find((p) => p.id === pageId)
    if (page) {
      const c = compatOf(page, previewDevice.value)
      if (!c.ok) {
        const reason = c.why === 'free-mode'
          ? t('bd.deviceCompatFree')
          : (() => {
            const size = resolvePageSize(compatPageOf(page), profileDataOf.value)
            const want = resolveDeckSize(previewDevice.value!) ?? devStore.hwStatus.value.grid
            return t('bd.deviceCompatSize', {
              size: `${size.cols}×${size.rows}`,
              want: want ? `${want.cols}×${want.rows}` : '',
            })
          })()
        bdShowToast(t('bd.blockedNav', { page: page.name, device: previewDevice.value.name, reason }))
        return
      }
    }
  }
  await onPageSelect(pageId)
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
// ---- Dispositivos: asignar pantalla, simular, sincronizar ----
const onDeviceAssign = async (deviceId: string, pageId: string | null) => {
  if (!selectedProfile.value) return
  try {
    // Delta: solo el dispositivo tocado. El PUT valida cada entrada enviada,
    // así que arrastrar el mapa completo convertía cualquier asignación rancia
    // de OTRO dispositivo (página borrada, de otro perfil o vuelta incompatible
    // tras un resize) en un 422 que parecía culpar a la página elegida.
    const body = await devStore.saveAssignments(selectedProfile.value, { [deviceId]: pageId })
    if (body.repaired) {
      const dropped = (body.repaired.dropped ?? []) as Array<{ deviceName: string; pageName: string; reason: string }>
      for (const d of dropped) {
        bdShowToast(t('bd.pageUnassignedFrom', { page: d.pageName, devices: d.deviceName }))
      }
    }
    const device = devStore.devices.value.find((d) => d.id === deviceId)
    if (pageId) {
      const page = (currentPages.value ?? []).find((p) => p.id === pageId)
      bdShowToast(t('bd.deviceAssigned', { page: page?.name ?? pageId, device: device?.name ?? deviceId }))
    } else {
      bdShowToast(t('bd.deviceUnassigned', { device: device?.name ?? deviceId }))
    }
    // Si se simula este dispositivo en modo uso, abrir su pantalla (o vacío).
    if (deviceId === previewDeviceId.value && mode.value === 'use' && pageId) {
      await onPageSelect(pageId)
    }
  } catch (e: any) {
    if (e?.status === 422 && Array.isArray(e?.details) && e.details.length > 0) {
      const first = e.details[0]
      const pageName = (currentPages.value ?? []).find((p) => p.id === first.pageId)?.name ?? first.pageId
      const reason = first.reason === 'free-mode'
        ? t('bd.deviceCompatFree')
        : first.reason
      bdShowToast(t('bd.blockedNav', {
        page: pageName,
        device: devStore.devices.value.find((d) => d.id === first.deviceId)?.name ?? first.deviceId,
        reason,
      }))
    } else {
      bdShowToast(String(e?.message ?? e))
    }
  }
}
const onPreviewDeviceChange = async (deviceId: string | null) => {
  previewDeviceId.value = deviceId
  selectedButton.value = null
  if (mode.value === 'use' && deviceId) {
    const target = devStore.assignments.value[deviceId]
    if (target && target !== currentPage.value?.id && (currentPages.value ?? []).some((p) => p.id === target)) {
      await onPageSelect(target)
    }
  }
}
const onDevicesChanged = async () => {
  try {
    await devStore.loadDevices()
    if (selectedProfile.value) await devStore.loadAssignments(selectedProfile.value)
  } catch { /* noop */ }
}
const onPageBlockedMsg = (e: Event) => {
  const d = (e as CustomEvent).detail
  if (d?.pageId) {
    const page = (currentPages.value ?? []).find((p) => p.id === d.pageId)
    bdShowToast(t('bd.blockedNav', { page: page?.name ?? d.pageId, device: 'Stream Deck', reason: d.reason ?? '' }))
  }
}
// Errores de ejecución del daemon (vía WS `action.error` o respuesta 200 con
// success:false): toast visible. Dedupe de la ráfaga directo+eco WS.
let lastActionErrorMsg = ''
let lastActionErrorAt = 0
const onActionErrorMsg = (e: Event) => {
  const d = (e as CustomEvent).detail
  const msg = typeof d?.message === 'string' && d.message
    ? d.message
    : (typeof d?.error === 'string' ? d.error : 'Error al ejecutar la acción')
  const now = Date.now()
  if (msg === lastActionErrorMsg && now - lastActionErrorAt < 2000) return
  lastActionErrorMsg = msg
  lastActionErrorAt = now
  bdShowToast(msg)
}

const onPageDelete = async (page: PageData | null) => {
  if (!page || currentPages.value.length < 2) return
  // Snapshot desde la API (no solo del estado local): si se borra justo
  // después de crear teclas y el refetch por WS aún no llegó, el Deshacer
  // perdería botones.
  const toSnap = (b: any) => ({
    position: b.position,
    x: b.x ?? null,
    y: b.y ?? null,
    w: b.w ?? 1,
    h: b.h ?? 1,
    parent_widget_id: b.parent_widget_id ?? null,
    widget_type: b.widget_type ?? null,
    data: JSON.parse(JSON.stringify(b.data ?? {})),
  })
  let snapButtons: ReturnType<typeof toSnap>[]
  try {
    const fresh = await apiGet(`/buttons?pageId=${encodeURIComponent(page.id)}`)
    snapButtons = (fresh ?? []).map(toSnap)
  } catch {
    snapButtons = currentButtons.value.filter((b) => b.page_id === page.id).map(toSnap)
  }
  const snapshot = {
    name: page.name,
    isFolder: page.is_folder === 1,
    buttons: snapButtons,
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
        // apiPost (no fetch crudo): antes se usaba `${API_BASE}/buttons` con el
        // ComputedRef sin desenvolver → URL "[object Object]/buttons", el POST
        // fallaba en silencio y el Deshacer restauraba la página VACÍA.
        // Se conserva también la geometría libre (x/y/w/h): sin ella las
        // teclas restauradas colapsaban a positions legacy.
        await apiPost('/buttons', {
          page_id: restored.id,
          position: btn.position,
          ...(btn.x !== undefined && btn.x !== null ? { x: btn.x } : {}),
          ...(btn.y !== undefined && btn.y !== null ? { y: btn.y } : {}),
          w: btn.w ?? 1,
          h: btn.h ?? 1,
          ...(btn.parent_widget_id ? { parent_widget_id: btn.parent_widget_id } : {}),
          ...(btn.widget_type ? { widget_type: btn.widget_type } : {}),
          data: btn.data,
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
    executeSingleAction(action, {
      deviceId: deviceId.value,
      pressType: 'press',
      source: 'web',
      ...ctx,
      profileId: currentProfile.value?.id,
    }),
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
  bumpConfigVersion()
}
const onUpdateAction = (index: number, patch: Record<string, any>) => {
  const actions = [...(buttonConfig.value.actions ?? [])]
  actions[index] = { ...actions[index], ...patch }
  buttonConfig.value = { ...buttonConfig.value, actions }
  bumpConfigVersion()
}
const onMoveAction = (index: number, dir: -1 | 1) => {
  const actions = [...(buttonConfig.value.actions ?? [])]
  const j = index + dir
  if (j < 0 || j >= actions.length) return
  ;[actions[index], actions[j]] = [actions[j], actions[index]]
  buttonConfig.value = { ...buttonConfig.value, actions }
  bumpConfigVersion()
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
    iconImage: '',
    emoji: '',
    actions: [],
    rules: [],
    looks: [],
    stateVar: ''
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
/** Nombre legible de un control (para el diálogo de reemplazo). */
const controlLabelOf = (type: string): string => {
  const ad = findActionAdata(plugins.value as any, type)
  return (typeof ad?.name === 'string' && ad.name) || type
}
/**
 * Guarda de superficie: una tecla admite UN solo control interactivo.
 * - Otro control distinto → pide reemplazarlo (lo quita del borrador).
 * - El mismo control → avisa y no duplica.
 * Además, un control añadido en modo Fija avisa de que solo se representa
 * en modo Libre (se añade igual: en Fija la tecla se ve normal).
 * Devuelve false si no hay que continuar (cancelado o duplicado).
 */
const ensureControlSlot = async (type: string): Promise<boolean> => {
  if (actionTypeSurfaceKind(plugins.value as any, type) !== 'control') return true
  const draft = buttonConfig.value.actions ?? []
  const existing = findControlAction(draft)
  if (existing && existing.type !== type) {
    const ok = await askConfirm(
      t('bd.controlReplaceTitle'),
      t('bd.controlReplaceMsg', { old: controlLabelOf(existing.type), new: controlLabelOf(type) }),
      t('bd.controlReplaceOk')
    )
    if (!ok) return false
    buttonConfig.value = {
      ...buttonConfig.value,
      actions: draft.filter((a: any) => !isControlAction(a))
    }
    bumpConfigVersion()
  } else if (existing) {
    bdShowToast(t('bd.controlExists'))
    return false
  }
  if (pageLayoutMode.value !== 'gridstack') {
    bdShowToast(t('bd.controlNeedsFree'))
  }
  return true
}
/** Añade una acción a la lista del tipo de pulsación indicado. */
const addActionToKind = async (type: string, kind: PressKind): Promise<boolean> => {
  if (kind === 'click') return addActionGuarded(type)
  const priorActions = countPressActions(buttonConfig.value)
  if (!(await ensureControlSlot(type))) return false
  const next = setActionsForKind(buttonConfig.value, kind, [
    ...getActionsForKind(buttonConfig.value, kind),
    createAction(type),
  ])
  buttonConfig.value = next
  bumpConfigVersion()
  await saveButtonConfig()
  await afterActionAdded(type, priorActions)
  return true
}
/** Añade una acción al borrador con guarda de superficie y guardado inmediato. */
const addActionGuarded = async (type: string): Promise<boolean> => {
  const priorActions = countPressActions(buttonConfig.value)
  if (!(await ensureControlSlot(type))) return false
  addAction(type)
  // Guardado inmediato: sin esto la tecla vacía depende del autoguardado
  // (800 ms) y el usuario no ve nada al pulsar.
  await saveButtonConfig()
  await afterActionAdded(type, priorActions)
  return true
}
/** En modo libre, pulsar una acción de la biblioteca sin tecla seleccionada
 *  crea una tecla nueva con esa acción (no hay "huecos" seleccionables como
 *  en Fija: antes solo salía el toast "selecciona tecla"). En Fija o con
 *  selección válida devuelve false para seguir el flujo normal.
 *  `createFreeKey` ya deja la tecla creada y seleccionada. */
const ensureFreeKeyForAction = async (type: string): Promise<boolean> => {
  if (mode.value !== 'edit') return false
  if (pageLayoutMode.value !== 'gridstack') return false
  if (selectedButton.value !== null && getButton(selectedButton.value)) return false
  try {
    await createFreeKey({ actionType: type })
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
  return true
}
const onActionPick = async (type: string) => {
  // Modo libre: pulsar una acción sin tecla seleccionada crea una tecla
  // nueva con esa acción (no hay "huecos" que seleccionar como en Fija).
  if (await ensureFreeKeyForAction(type)) return
  if (!ensureEditableTarget()) return
  try {
    await addActionGuarded(type)
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}
const onActionDrop = async (position: number, type: string) => {
  if (mode.value !== 'edit') return
  try {
    await selectButton(position)
    await addActionGuarded(type)
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  }
}
const onActionDropSelected = async (type: string, kind?: PressKind) => {
  // Igual que pulsar en la biblioteca: en libre sin selección se crea tecla.
  // Solo para el clic principal; double/triple/long/reglas necesitan destino.
  if ((kind ?? 'click') === 'click' && await ensureFreeKeyForAction(type)) return
  if (!ensureEditableTarget()) return
  try {
    await addActionToKind(type, kind ?? 'click')
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
// Ningún fetch cuelga para siempre: sin timeout, un daemon ocupado dejaba
// pageBusy activo y toda la UI "pillada" (failed to fetch al abortar el navegador).
// Por el túnel (internet) las respuestas pesadas superan 15 s: presupuesto mayor.
const FETCH_TIMEOUT_MS = getTunnelToken() ? 45000 : 15000
const apiGet = async (path: string) => {
  const res = await fetch(`${apiBase.value}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
  return res.json()
}
const apiPost = async (path: string, body: any, timeoutMs: number = FETCH_TIMEOUT_MS) => {
  const res = await fetch(`${apiBase.value}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `POST ${path}: ${res.status}`)
  }
  return res.json().catch(() => ({}))
}
const apiDel = async (path: string) => {
  const res = await fetch(`${apiBase.value}${path}`, { method: 'DELETE', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `DELETE ${path}: ${res.status}`)
  }
  return res.json().catch(() => ({}))
}
const apiPut = async (path: string, body: any) => {
  const res = await fetch(`${apiBase.value}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `PUT ${path}: ${res.status}`)
  }
  return res.json().catch(() => ({}))
}
/** Modo de layout por página: 'classic' (rejilla fija) o 'gridstack' (redimensionable). */
const parsePageData = (d: any): Record<string, any> => {
  let cur: any = d
  // Tolera doble/triple codificación histórica (ver db.normalizeJsonData).
  for (let i = 0; i < 5 && typeof cur === 'string'; i++) {
    const t = cur.trim()
    if (!t) return {}
    try { cur = JSON.parse(t) } catch { return {} }
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}
}
/** Override optimista: la UI cambia al instante al pulsar Fija/Libre,
 *  aunque el PUT al daemon tarde o falle (entonces se revierte). */
const layoutModeOverride = ref<Record<string, 'classic' | 'gridstack'>>({})
const pageLayoutMode = computed<'classic' | 'gridstack'>(() => {
  const pid = (currentPage.value as any)?.id
  if (pid && layoutModeOverride.value[pid]) return layoutModeOverride.value[pid]
  const m = parsePageData((currentPage.value as any)?.data)?.layoutMode
  return m === 'gridstack' ? 'gridstack' : 'classic'
})
const onLayoutModeChange = async (mode: 'classic' | 'gridstack') => {
  if (!currentPage.value || pageLayoutMode.value === mode) return
  // Pasar a libre una página asignada a un deck pide confirmación y la desasigna.
  if (mode === 'gridstack') {
    const hw = decksOfCurrentChain.value.filter((d) =>
      (devStore.assignments.value[d.id] === (currentPage.value as any).id)
    )
    if (hw.length) {
      const ok = await askConfirm(
        t('bd.confirmFreeTitle'),
        t('bd.confirmFreeMsg', {
          page: (currentPage.value as any).name,
          devices: hw.map((d) => d.name).join(', '),
        }),
        t('bd.confirmFreeOk'),
      )
      if (!ok) return
      try {
        const map: Record<string, string | null> = {}
        for (const d of hw) map[d.id] = null
        await devStore.saveAssignments(selectedProfile.value, map)
        bdShowToast(t('bd.pageUnassignedFrom', {
          page: (currentPage.value as any).name,
          devices: hw.map((d) => d.name).join(', '),
        }))
      } catch (e) {
        bdShowToast(String((e as Error)?.message ?? e))
        return
      }
    }
  }
  const pid = (currentPage.value as any).id
  const prev = pageLayoutMode.value
  layoutModeOverride.value[pid] = mode
  try {
    const data = { ...parsePageData((currentPage.value as any)?.data), layoutMode: mode }
    await updatePage(pid, { data } as any)
    // Sincronizado: soltar el override para que mande el servidor.
    if (layoutModeOverride.value[pid] === mode) delete layoutModeOverride.value[pid]
  } catch (e) {
    if (layoutModeOverride.value[pid] === mode) layoutModeOverride.value[pid] = prev
    bdShowToast(String((e as Error)?.message ?? e))
  }
}
/** Cambio de filas/columnas con guarda: si un deck muestra esta página y el
 *  nuevo tamaño no le cabe, pide confirmación y la desasigna. */
const onGridSizeChange = async (dx: number, dy: number) => {
  const nextCols = gridCols.value + dx
  const nextRows = gridRows.value + dy
  // Guarda de contenido (los steppers ya la aplican en la UI): reducir no
  // puede dejar teclas fuera del grid. En libre el stepper antes no hacía
  // nada visible (GridStack manda) y la config quedaba inconsistente.
  if ((dx < 0 || dy < 0) && currentPage.value) {
    const positions = (currentButtons.value ?? []).map((b: any) => b.position)
    const fits = gridResizeFits(
      pageLayoutMode.value,
      positions,
      (currentButtons.value ?? []) as any[],
      nextCols,
      nextRows,
    )
    if (!fits) {
      bdShowToast(t('bd.gridShrinkBlocked'))
      return
    }
  }
  const hw = (currentPage.value ? decksOfCurrentChain.value.filter((d) =>
    devStore.assignments.value[d.id] === (currentPage.value as any).id
  ) : []).filter((d) => {
    const want = resolveDeckSize(d) ?? devStore.hwStatus.value.grid
    return !want || want.cols !== nextCols || want.rows !== nextRows
  })
  if (hw.length && currentPage.value) {
    const ok = await askConfirm(
      t('bd.confirmResizeTitle'),
      t('bd.confirmResizeMsg', {
        page: (currentPage.value as any).name,
        size: `${nextCols}×${nextRows}`,
        devices: hw.map((d) => {
          const want = resolveDeckSize(d) ?? devStore.hwStatus.value.grid
          return want ? `${d.name} (${want.cols}×${want.rows})` : d.name
        }).join(', '),
      }),
      t('bd.confirmResizeOk'),
    )
    if (!ok) return
  }
  await changeGridSize(dx, dy)
  if (hw.length && currentPage.value && selectedProfile.value) {
    try {
      const map: Record<string, string | null> = {}
      for (const d of hw) map[d.id] = null
      await devStore.saveAssignments(selectedProfile.value, map)
      bdShowToast(t('bd.pageUnassignedFrom', {
        page: (currentPage.value as any).name,
        devices: hw.map((d) => d.name).join(', '),
      }))
    } catch (e) {
      bdShowToast(String((e as Error)?.message ?? e))
    }
  }
}
/** Persistir geometría GridStack al mover/redimensionar (misma tecla, mismos drawers).
 *  Los PUT van en paralelo y el estado local se fusiona con las filas que
 *  devuelve el daemon: antes eran N PUTs en serie + un GET completo, y en
 *  modo libre con varias teclas la UI se quedaba "pillada".
 *  La geometría se acota a la cuadrícula configurada: un resize salvaje
 *  (p. ej. h=25) ya no puede estirar la placa con el stepper sin tocar.
 *  Los ids que ya no existen en la BD (nodos fantasma de GridStack tras
 *  duplicados/optimistas, ecos tardíos tras borrar) se ignoran en vez de
 *  acribillar al daemon con PUTs que solo devuelven 404. */
const onGsLayoutChange = async (items: Array<{ id: string; x: number; y: number; w: number; h: number }>) => {
  const known = new Set((currentButtons.value ?? []).map((b: any) => b?.id).filter((id) => typeof id === 'string'))
  const targets = (items ?? []).filter((it) => it?.id && known.has(String(it.id)))
  if (!targets.length) {
    // Nada que persistir (todo fantasma): reconciliar con la BD en segundo
    // plano para expulsar los nodos duplicados del grid.
    if ((items ?? []).some((it) => it?.id && !known.has(String(it.id)))) {
      loadProfile().catch(() => {})
    }
    return
  }
  const cols = Math.max(1, gridCols.value)
  const rows = Math.max(1, gridRows.value)
  try {
    const updated = (await Promise.all(targets.map((it) => {
      const w = Math.min(cols, Math.max(1, Math.round(Number(it.w) || 1)))
      const h0 = Math.max(1, Math.round(Number(it.h) || 1))
      const x = Math.min(Math.max(0, Math.floor(Number(it.x) || 0)), Math.max(0, cols - w))
      // Dentro de la cuadrícula: y ≤ rows-1 y h sin desbordar (el desborde
      // histórico previo se conserva hasta que el usuario lo mueva).
      const y = Math.min(Math.max(0, Math.floor(Number(it.y) || 0)), Math.max(0, rows - 1))
      const h = Math.min(h0, Math.max(1, rows - y))
      return apiPut(`/buttons/${encodeURIComponent(it.id)}`, { x, y, w, h }).catch((e) => {
        // La tecla pudo borrarse entre el drag y el PUT: no tumbar el resto.
        if (/404|no encontrado/i.test(String((e as Error)?.message ?? e))) return null
        throw e
      })
    })) ?? []).filter((b) => b && typeof b.id === 'string')
    const byId = new Map<string, any>()
    for (const b of updated ?? []) {
      if (b && typeof b.id === 'string') byId.set(b.id, b)
    }
    if (byId.size > 0) {
      currentButtons.value = currentButtons.value.map((b: any) => byId.get(b?.id) ?? b)
    }
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
    // Reconciliar en segundo plano sin bloquear: la BD manda.
    loadProfile().catch(() => {})
  }
}

/** Crear tecla libre. Una petición acotada + finally evita dejar Añadir
 *  deshabilitado indefinidamente si el daemon no responde. */
const createFreeKey = async (opts: { x?: number; y?: number; actionType?: string } = {}) => {
  if (!currentPage.value || pageBusy.value) {
    if (pageBusy.value) bdShowToast(t('bd.pageBusyRetry'))
    return
  }
  try {
    pageBusy.value = true
    const cols = Math.max(1, gridCols.value)
    const rows = Math.max(1, gridRows.value)
    const buttons = (currentButtons.value ?? []) as any[]
    // Un drop en una celda libre conserva el punto donde se soltó. Si está
    // ocupada (o no hay coordenadas), usar el mismo primer hueco que Añadir.
    // El drop se acota a la cuadrícula visible: antes una suelta debajo de la
    // placa persistía y enormes (p. ej. y=50) y el grid crecía a decenas de
    // filas con el stepper marcando 3.
    const drop = opts.x !== undefined && opts.y !== undefined
      ? clampDropCell(opts.x, opts.y, cols, rows)
      : { x: -1, y: -1 }
    const wantedX = drop.x
    const wantedY = drop.y
    const overlaps = (x: number, y: number) => buttons.some((b) => {
      const w = Math.min(cols, Math.max(1, Math.round(Number(b.w) || 1)))
      const h = Math.max(1, Math.round(Number(b.h) || 1))
      const rawX = Number.isFinite(b.x) ? Number(b.x) : (Number(b.position) || 0) % cols
      const rawY = Number.isFinite(b.y) ? Number(b.y) : Math.floor((Number(b.position) || 0) / cols)
      const bx = Math.min(Math.max(0, Math.floor(rawX)), cols - w)
      const by = Math.max(0, Math.floor(rawY))
      return x < bx + w && bx < x + 1 && y < by + h && by < y + 1
    })
    let spot: { x: number; y: number; position: number } | null = null
    if (wantedX >= 0 && wantedY >= 0 && !overlaps(wantedX, wantedY)) {
      const cell = wantedY * cols + wantedX
      const taken = new Set(buttons.map((b) => b.position))
      const maxPosition = buttons.reduce(
        (max, b) => Number.isInteger(b.position) ? Math.max(max, b.position) : max,
        -1
      )
      spot = { x: wantedX, y: wantedY, position: taken.has(cell) ? maxPosition + 1 : cell }
    } else {
      // planFreeCell solo mira ocupación geométrica: `position` puede quedar
      // stale al mover widgets en modo libre, pero su valor devuelto es único.
      spot = planFreeCell(buttons, cols, rows)
    }
    if (!spot) throw new Error(t('bd.gsNoRoom'))
    const data = ensureDefaultIcon(opts.actionType
      ? { actions: [createAction(opts.actionType)] }
      : {})
    const created = await apiPost('/buttons', {
      page_id: currentPage.value.id,
      position: spot.position,
      x: spot.x,
      y: spot.y,
      w: 1,
      h: 1,
      data,
    }, 15000)
    // POST devuelve la fila creada; no hace falta un segundo GET que también
    // podría quedarse pendiente y mantener bloqueado el control.
    // Upsert (no push ciego): el eco `button.created` del WS puede llegar
    // ANTES de que responda el POST y ya habría añadido la tecla → el push
    // duplicaba el id, GridStack veía dos nodos con el mismo gs-id,
    // recolocaba uno (p. ej. y=1) y emitía un fantasma `<id>_1` cuyos PUTs
    // devolvían 500 "Botón no encontrado".
    if (created && typeof created.id === 'string') {
      const idx = currentButtons.value.findIndex((b: any) => b?.id === created.id)
      if (idx > -1) currentButtons.value[idx] = created
      else currentButtons.value.push(created)
    }
    const pos = created?.position ?? spot.position
    await selectButton(pos)
  } catch (e) {
    bdShowToast(String((e as Error)?.message ?? e))
  } finally {
    pageBusy.value = false
  }
}
/** Añadir tecla vacía en el primer hueco libre. */
const onGsAdd = async () => createFreeKey()
/** Soltar acción en espacio vacío del grid crea y configura la tecla en un POST. */
const onGsActionDrop = async (x: number, y: number, type: string) => {
  if (mode.value !== 'edit' || pageLayoutMode.value !== 'gridstack') return
  await createFreeKey({ x, y, actionType: type })
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

// Registros de pulsación: el StageBoard emite la posición; aquí se resuelve
// el buttonId y se abre el diálogo (que pide GET /buttons/:id/logs).
const onButtonLogs = (position: number) => {
  const btn = getButton(position)
  if (!btn) return
  // getButtonData es un computed en useStreamDeck: el data plano sale del botón.
  const data = (btn as any)?.data ?? null
  const label = String(data?.label ?? data?.textTop ?? data?.textBottom ?? '')
  void pressLogsDialog.value?.show({ buttonId: btn.id, buttonLabel: label || null })
}
// «Ver registros» del inspector: la tecla en edición.
const onKeyViewLogs = () => {
  if (selectedButton.value === null || selectedButton.value === undefined) return
  onButtonLogs(selectedButton.value)
}
// Contextmenu sobre una acción del inspector: filtra por botón + tipo.
const onKeyActionLogs = (p: { kind: string; index: number; actionType: string }) => {
  const pos = selectedButton.value
  const btn = pos !== null && pos !== undefined ? getButton(pos) : undefined
  void pressLogsDialog.value?.show({
    buttonId: btn?.id ?? null,
    actionType: p?.actionType || null,
  })
}
// Contextmenu en la biblioteca: solo tipo de acción (columna botón visible).
const onActionTypeLogs = (p: { actionType: string }) => {
  if (!p?.actionType) return
  void pressLogsDialog.value?.show({ actionType: p.actionType })
}
// Drawer de ajustes pedido por un widget (NeedsConfig →
// `bundeck:open-action-settings`): equivale a clicar la tecla (selección) y
// asegura el drawer derecho abierto. En kiosco no hay drawer: no se cancela
// el evento y el widget queda como no-gestionado.
const onOpenActionSettings = (e: Event) => {
  if (kiosk.value) return
  const pos = Number((e as CustomEvent<{ position?: unknown }>)?.detail?.position)
  try {
    e.preventDefault()
  } catch {
    /* evento no cancelable: igual se intenta abrir el drawer */
  }
  if (Number.isInteger(pos) && pos >= 0) {
    void selectButton(pos).catch(() => {})
  }
  if (!bdShowRight.value) bdSetPanels(bdShowLeft.value, true)
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

// Copiar el código de escape al relay (pantalla "Sin permiso" con
// ?relayFallback=): el código queda seleccionado a mano si no hay clipboard.
const relayFallbackCopied = ref(false)
const copyRelayFallback = async () => {
  const code = String(lanRelayFallback.value ?? '').trim()
  if (!code) return
  try {
    await navigator.clipboard.writeText(code)
    relayFallbackCopied.value = true
  } catch {
    relayFallbackCopied.value = false
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

// Updater: en producción el dueño es el launcher (UPDATE_SYSTEM.md);
// aquí solo se consulta la versión instalada y, bajo Electrobun dev,
// el modal legacy (el daemon devuelve 501 en version/check y update).
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
    const url = `${API_BASE.value}/version/check`
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
    const url = `${API_BASE.value}/update`
    const res = await fetch(url, { method: 'POST' })
    if (!res.ok) throw new Error('Failed to start update')
  } catch (error) {
    console.error(error)
    updateResult.value = { success: false, message: 'Error al iniciar la actualización. Inténtalo de nuevo.' }
  } finally {
    isUpdating.value = false
  }
}

// Pantalla encendida en kiosco: ver `useKioskWakeLock` (Wake Lock API con
// fallback de vídeo para iPads antiguos / HTTP local). Sin bloque propio aquí.

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
      iconImage: '',
      emoji: '',
      backgroundColor: '',
      textColor: '#e8e9eb',
      showTitle: true,
      mode: 'seq',
      longPress: 'none',
      confirm: false,
      actions: [],
      rules: [],
      looks: [],
      stateVar: ''
    }
  }
  nextTick(() => {
    isChangingButton.value = false
  })
  void oldVal
})
// Autoguardado (igual que antes): el watcher observa el contador de
// ediciones en vez de comparar JSON.stringify del config en cada tecla.
// Cada mutación local (onUpdateField/onUpdateAction/onMoveAction,
// add/remove/reorder/param en el composable) incrementa el contador; los
// sets programáticos (selectButton/selectPage) no lo tocan y por tanto no
// disparan guardados. El debounce de 800 ms se mantiene en debouncedSave.
watch(
  buttonConfigVersion,
  () => {
    // No bloquear por isSaving: si se está guardando, saveButtonConfig
    // reprograma el cambio en vez de perderlo (ver debouncedSave).
    if (isChangingButton.value) return
    if (selectedButton.value === null) return
    debouncedSave()
  },
  { flush: 'post' }
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
  if (event.key === 'Escape' && mode.value === 'use') {
    // En kiosco, Escape pide salir del kiosco (con confirmación); fuera de
    // él, vuelve al modo edición como antes.
    if (kiosk.value) void requestKioskExit('escape')
    else setMode('edit')
  }
}

onMounted(async () => {
  // Entrada por invitación LAN (?invite= del QR/enlace): canjear ANTES de
  // cargar nada; sin invitación válida el daemon responde 401/403 y se
  // muestra la pantalla "Sin permiso".
  try {
    await redeemLanInviteFromUrl()
  } catch {
    /* el canje fallido deja lanDenied según la sonda */
  }
  // Entrada por QR: ?kiosk=1/?mode=kiosk/#kiosk → kiosco directo en modo uso.
  // Entrada por túnel del relay (/t/<token>/) sin param → modo uso (nunca editar);
  // el kiosco pleno lo pide el param (los QR/links lo propagan).
  try {
    if (parseKioskFromLocation()) {
      kiosk.value = true
      mode.value = 'use'
      selectedButton.value = null
    } else if (getTunnelToken()) {
      mode.value = 'use'
      selectedButton.value = null
    }
  } catch {
    /* sin location (SSR/tests): se queda en edición como antes */
  }
  // Apariencia compartida host ↔ remotos: adoptar el tema del servidor
  // (el remoto sigue al host, incluido el `auto` resuelto por el host).
  initAppearanceSync().catch(() => {})
  loadProfiles().then(async () => {    // Reglas «load» de la página inicial.
    try { engine.runLoad(allPositions) } catch { /* noop */ }
    // Asignaciones del perfil inicial (el GET repara incompatibles).
    try {
      if (selectedProfile.value) await devStore.loadAssignments(selectedProfile.value)
    } catch { /* sin daemon */ }
  }).catch(() => {})
  devStore.loadDevices().catch(() => {})
  devStore.loadHwStatus().catch(() => {})
  window.addEventListener('libredeck:devices-changed', onDevicesChanged)
  window.addEventListener('libredeck:page-blocked', onPageBlockedMsg as EventListener)
  window.addEventListener('libredeck:action-error', onActionErrorMsg as EventListener)
  // Widgets de superficie (NeedsConfig vía useOpenActionSettings): en modo uso
  // los clics dentro del widget no seleccionan la tecla (ControlSurface los
  // detiene), así que piden aquí selección + drawer derecho con los ajustes
  // de la acción. En edición los clics ya burbujean y seleccionan; el evento
  // además asegura el drawer abierto.
  // preventDefault() marca el evento como gestionado (ver el composable).
  window.addEventListener(OPEN_ACTION_SETTINGS_EVENT, onOpenActionSettings as EventListener)
  loadMarketplace().catch(() => {})
  loadMcpTokens().catch(() => {})
  loadMcpScopes().catch(() => {})
  refreshDeviceStatus().catch(() => {})
  connectWebSocket()
  // WebRTC P2P en túnel: intenta en background sin bloquear la carga (el
  // transporte relay sigue funcionando aunque P2P falle por NAT).
  try {
    const tunTok = getTunnelToken()
    if (tunTok) {
      // Entrada por túnel: intento nuevo y determinista. El singleton RTC
      // sobrevive a HMR/remontajes con un estado terminal (fallback) o un
      // `pc` rancio que haría que connect() devolviese false sin transitar:
      // se resetea a idle para que la modal salga desde el primer pintado
      // (una vez por intento; el cierre manual sigue sin reabrir y la modal
      // se cierra sola al resolver).
      console.debug('[tunnel] ruta túnel detectada, token…', tunTok.slice(0, 8))
      rtc.disconnect()
      showTransportBanner.value = true
      transportModalDismissed.value = false
      transportConnectTimer = setTimeout(() => {
        transportConnectTimer = null
        rtc.connect().catch(() => {})
      }, 1500)
    } else if (
      typeof window !== 'undefined' &&
      (/^\/ui\//.test(window.location.pathname) || /(?:[?&](?:token|sessionToken|session|t)=)/.test(window.location.search))
    ) {
      // Ruta con pinta de relay pero sin token extraíble: lo deja anotado
      // para diagnosticar por qué no sale la modal de conexión.
      console.debug('[tunnel] posible ruta relay sin token extraíble:', window.location.pathname)
    }
  } catch {
    /* RTC opcional */
  }
  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('click', onDocClickHeader)
  document.addEventListener('keydown', onDocKeyProfile)
  window.addEventListener('resize', onViewportChangeCloseProfile)
  // Capture para pillar también el scroll interno de .bd-tabs.
  window.addEventListener('scroll', onViewportChangeCloseProfile, true)
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
  // Guía de bienvenida: solo hasta que se pulse Saltar o se llegue al final.
  // Si se recarga a mitad, show() retoma el paso guardado (no se marca vista).
  // Se difiere un tick para que el chunk async del diálogo esté montado.
  nextTick(() => {
    try {
      if (welcomeDialog.value?.shouldAutoShow()) welcomeDialog.value.show()
    } catch { /* noop */ }
  })
  if (hasElectrobunUpdater) {
    try {
      const res = await fetch(`${API_BASE.value}/version`)
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
  // Marquee del kiosco: primera medida tras pintar + remedida al cargar
  // las fuentes (el ancho del texto puede cambiar).
  nextTick(measureMarquee)
  try {
    void document.fonts?.ready.then(() => measureMarquee())
  } catch { /* noop */ }
})

onUnmounted(() => {
  cleanup()
  marqueeRO?.disconnect()
  marqueeRO = null
  window.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('click', onDocClickHeader)
  document.removeEventListener('keydown', onDocKeyProfile)
  window.removeEventListener('resize', onViewportChangeCloseProfile)
  window.removeEventListener('scroll', onViewportChangeCloseProfile, true)
  window.removeEventListener('libredeck:devices-changed', onDevicesChanged)
  window.removeEventListener('libredeck:page-blocked', onPageBlockedMsg as EventListener)
  window.removeEventListener('libredeck:action-error', onActionErrorMsg as EventListener)
  window.removeEventListener(OPEN_ACTION_SETTINGS_EVENT, onOpenActionSettings as EventListener)
  if (ruleTimer) {
    clearInterval(ruleTimer)
    ruleTimer = null
  }
  if (transportBannerTimer !== null) {
    clearTimeout(transportBannerTimer)
    transportBannerTimer = null
  }
  if (transportConnectTimer !== null) {
    clearTimeout(transportConnectTimer)
    transportConnectTimer = null
  }
  if (unsubVar) {
    unsubVar()
    unsubVar = null
  }
  if (updateCheckInterval.value) clearInterval(updateCheckInterval.value)
})
</script>
