<template>
  <dialog ref="dialog" class="bd-dlg bd-grid" :aria-label="t('bd.dlgSettings')" data-cy="bd-settings">
    <nav class="bd-dnav" role="tablist" aria-orientation="vertical" :aria-label="t('bd.dlgSettings')">
      <span class="bd-sh">{{ t('bd.dlgSettings') }}</span>
      <button
        v-for="item in filteredNav"
        :key="item.id"
        role="tab"
        :data-sec="item.id"
        :aria-selected="section === item.id"
        @click="selectSection(item.id)"
      >
        <component :is="item.icon" :size="18" stroke-width="1.75" aria-hidden="true" />
        {{ item.label }}
      </button>
      <p v-if="query && !filteredNav.length" class="bd-dempty">{{ t('bd.settingsNoResults', { q: query }) }}</p>
    </nav>

    <div class="bd-dbody" ref="bodyEl">
      <div class="bd-dsearch">
        <Search :size="16" stroke-width="1.75" aria-hidden="true" />
        <input
          v-model="query"
          type="search"
          class="bd-inp"
          :placeholder="t('bd.settingsSearch')"
          :aria-label="t('bd.settingsSearch')"
          data-cy="bd-settings-search"
          @keydown.escape="query = ''"
        />
        <button v-if="query" class="bd-ibtn" :aria-label="t('bd.settingsClear')" :title="t('bd.settingsClear')" @click="query = ''">
          <X :size="14" stroke-width="1.75" aria-hidden="true" />
        </button>
      </div>
      <!-- Resultados de búsqueda: filtra el menú y salta al ajuste concreto -->
      <template v-if="isSearching">
        <h2>{{ t('bd.settingsResults', { n: searchResults.length }) }}</h2>
        <p class="bd-sub">{{ t('bd.settingsResultsHint') }}</p>
        <div v-if="searchResults.length" class="bd-sres-list">
          <button
            v-for="r in searchResults"
            :key="`${r.section}:${r.id}`"
            class="bd-sres"
            :data-cy="`bd-search-result-${r.section}-${r.id}`"
            @click="goToResult(r)"
          >
            <span class="bd-sres-sec">{{ r.sectionLabel }}</span>
            <b>{{ r.title }}</b>
            <span v-if="r.hint" class="bd-sres-hint">{{ r.hint }}</span>
          </button>
        </div>
        <p v-else class="bd-hint">{{ t('bd.settingsNoResults', { q: query }) }}</p>
      </template>
      <!-- General -->
      <template v-else-if="section === 'general'">
        <h2>{{ t('bd.secGeneral') }}</h2>
        <p class="bd-sub">{{ t('bd.generalSub') }}</p>
        <div class="bd-srow" data-setting="autostart">
          <div><b>{{ t('bd.startWithSystem') }}</b><p>{{ t('bd.startWithSystemHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.autostart" :aria-label="t('bd.startWithSystem')" /><span></span></label></div>
        </div>
        <div class="bd-srow" data-setting="tray">
          <div><b>{{ t('bd.keepInTray') }}</b><p>{{ t('bd.keepInTrayHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.tray" :aria-label="t('bd.keepInTray')" /><span></span></label></div>
        </div>
        <div v-if="showUpdates" class="bd-srow" data-setting="updates">
          <div><b>{{ t('bd.checkUpdates') }}</b><p>{{ t('bd.checkUpdatesHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.updates" :aria-label="t('bd.checkUpdates')" /><span></span></label></div>
        </div>
        <div class="bd-srow" data-setting="undo">
          <div><b>{{ t('bd.allowUndo') }}</b><p>{{ t('bd.allowUndoHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.undo" :aria-label="t('bd.allowUndo')" /><span></span></label></div>
        </div>
        <div class="bd-srow" data-setting="autoswitch">
          <div><b>{{ t('bd.autoSwitch') }}</b><p>{{ t('bd.autoSwitchHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" :checked="autoCfg.enabled" :aria-label="t('bd.autoSwitch')" @change="toggleAutoSwitch(($event.target as HTMLInputElement).checked)" /><span></span></label></div>
        </div>
      </template>

      <!-- Dispositivos: hardware conectado y pantallas por dispositivo -->
      <template v-else-if="section === 'devices'">
        <h2>{{ t('bd.secDevices') }}</h2>
        <p class="bd-sub">{{ t('bd.devicesIntro') }}</p>

        <section class="bd-settings-group" aria-labelledby="bd-device-hardware-title" data-cy="bd-device-hardware">
          <h3 id="bd-device-hardware-title" class="bd-settings-group__title">{{ t('bd.deviceHardware') }}</h3>
          <p class="bd-settings-group__sub">{{ t('bd.deviceHardwareSub') }}</p>

          <div class="bd-srow" data-setting="device">
            <div><b>{{ t('bd.streamdeckDevice') }}</b><p>{{ t('bd.streamdeckDeviceHint') }}</p></div>
            <div class="bd-ctl bd-ctl-device">
              <select
                class="bd-inp bd-device-select"
                v-model="selectedDevice"
                @change="handleDeviceChange"
                :aria-label="t('bd.selectStreamdeck')"
                :title="selectedDeviceTitle"
                data-cy="bd-device-select"
              >
                <option value="">{{ t('bd.selectStreamdeck') }}</option>
                <option v-for="(d, i) in devices" :key="d.path" :value="d.path" :title="deviceTitle(d)">{{ deviceShortLabel(d, i) }}</option>
              </select>
              <button class="bd-btn" :disabled="!selectedDevice" @click="testDevice">
                <Palette :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.testStreamdeck') }}
              </button>
              <p v-if="deviceStatus" class="bd-hint bd-device-status" :title="deviceStatus" aria-live="polite">{{ deviceStatusShort }}</p>
            </div>
          </div>

          <div class="bd-srow" data-setting="brightness">
            <div><b>{{ t('bd.brightness') }}</b><p>{{ t('bd.brightnessHint') }}</p></div>
            <div class="bd-ctl">
              <div class="bd-rg">
                <input type="range" class="bd-inp" min="0" max="100" step="1" :value="bdBrightness" :aria-label="t('bd.brightness')" @input="bdSetBrightness(+($event.target as HTMLInputElement).value)" />
                <output>{{ bdBrightness }}%</output>
              </div>
            </div>
          </div>

          <div class="bd-srow">
            <div><b>{{ t('bd.dimAfter') }}</b><p>{{ t('bd.dimAfterHint') }}</p></div>
            <div class="bd-ctl">
              <select class="bd-inp" v-model="mock.dim" :aria-label="t('bd.dimAfter')">
                <option>{{ t('bd.never') }}</option>
                <option>1 min</option>
                <option>5 min</option>
                <option>15 min</option>
                <option>1 hora</option>
              </select>
            </div>
          </div>

          <div class="bd-srow">
            <div><b>{{ t('bd.idleScreen') }}</b><p>{{ t('bd.idleScreenHint') }}</p></div>
            <div class="bd-ctl">
              <select class="bd-inp" v-model="mock.idle" :aria-label="t('bd.idleScreen')">
                <option>{{ t('bd.screenOff') }}</option>
                <option>{{ t('bd.clock') }}</option>
                <option>{{ t('bd.lastState') }}</option>
                <option>{{ t('bd.ownImage') }}</option>
              </select>
            </div>
          </div>

          <div class="bd-srow">
            <div><b>{{ t('bd.orientation') }}</b><p>{{ t('bd.orientationHint') }}</p></div>
            <div class="bd-ctl">
              <div class="bd-seg">
                <button v-for="o in ['0°', '90°', '180°', '270°']" :key="o" :aria-pressed="mock.orientation === o" @click="mock.orientation = o">{{ o }}</button>
              </div>
            </div>
          </div>

          <div class="bd-srow" data-setting="longpress">
            <div><b>{{ t('bd.longPressTime') }}</b><p>{{ t('bd.longPressTimeHint') }}</p></div>
            <div class="bd-ctl">
              <div class="bd-rg">
                <input type="range" class="bd-inp" min="200" max="1200" step="50" :value="bdLongPressMs" :aria-label="t('bd.longPressTime')" @input="bdSetLongPressMs(+($event.target as HTMLInputElement).value)" />
                <output>{{ bdLongPressMs }} ms</output>
              </div>
            </div>
          </div>

          <div class="bd-srow">
            <div><b>{{ t('bd.haptic') }}</b><p>{{ t('bd.hapticHint') }}</p></div>
            <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.haptic" :aria-label="t('bd.haptic')" /><span></span></label></div>
          </div>

          <div class="bd-srow">
            <div><b>{{ t('bd.clickSound') }}</b><p>{{ t('bd.clickSoundHint') }}</p></div>
            <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.sound" :aria-label="t('bd.clickSound')" /><span></span></label></div>
          </div>
        </section>
      </template>

      <!-- Perfiles (cableado a datos reales) -->
      <template v-else-if="section === 'profiles'">
        <h2>{{ t('bd.secProfiles') }}</h2>
        <p class="bd-sub">{{ t('bd.profilesSub') }}</p>
        <div class="bd-pauto-banner" data-setting="streamdeck-import">
          <div class="bd-pauto-info">
            <div class="bd-tile"><Import :size="20" stroke-width="1.75" aria-hidden="true" /></div>
            <div>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                <b>{{ t('bd.sdImportTitle') }}</b>
              </div>
              <p class="bd-cap" style="margin-top: 2px">{{ t('bd.sdImportHint') }}</p>
              <div v-if="sdProfiles.length" class="bd-sdimport-list" data-cy="bd-sdimport-list">
                <label v-for="p in sdProfiles" :key="p.uuid" class="bd-sdimport-item">
                  <input
                    type="checkbox"
                    :checked="sdChecked.includes(p.uuid)"
                    :data-cy="`bd-sdimport-check-${p.uuid}`"
                    @change="sdToggle(p.uuid, ($event.target as HTMLInputElement).checked)"
                  />
                  <span>{{ p.name }}</span>
                </label>
              </div>
              <p v-if="sdStatus" class="bd-cap" data-cy="bd-sdimport-status" aria-live="polite">{{ sdStatus }}</p>
            </div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button class="bd-btn" data-cy="bd-sdimport-detect" :disabled="sdBusy" @click="sdDetect">
              <Search :size="16" stroke-width="1.75" aria-hidden="true" />{{ sdBusy ? t('bd.sdDetecting') : t('bd.sdDetect') }}
            </button>
            <button class="bd-btn" data-cy="bd-sdimport-upload" :disabled="sdBusy" @click="sdFileInput?.click()">
              <Upload :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.sdUpload') }}
            </button>
            <button
              class="bd-btn bd-pri"
              data-cy="bd-sdimport-go"
              :disabled="sdBusy || !sdChecked.length"
              @click="sdImportSelected"
            >
              <Download :size="16" stroke-width="1.75" aria-hidden="true" />{{ sdBusy ? t('bd.sdImporting') : t('bd.sdImport') }}
            </button>
            <input
              ref="sdFileInput"
              type="file"
              accept=".streamDeckProfile,.zip"
              style="display: none"
              aria-hidden="true"
              tabindex="-1"
              @change="sdUpload(($event.target as HTMLInputElement).files?.[0] ?? null); ($event.target as HTMLInputElement).value = ''"
            />
          </div>
        </div>
        <div class="bd-pauto-banner">
          <div class="bd-pauto-info">
            <div class="bd-tile"><AppWindow :size="20" stroke-width="1.75" aria-hidden="true" /></div>
            <div>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                <b>{{ t('bd.autoBannerTitle') }}</b>
                <span class="bd-pauto-badge" :class="{ on: autoCfg.enabled }"><i></i>{{ autoBadgeText }}</span>
              </div>
              <p class="bd-cap" style="margin-top: 2px">{{ t('bd.autoBannerHint') }}</p>
            </div>
          </div>
          <button class="bd-btn bd-pri" data-cy="bd-open-auto" @click="openAuto()"><SlidersHorizontal :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.configure') }}</button>
        </div>
        <div v-for="p in profiles" :key="p.id" class="bd-pr">
          <div style="display: flex; align-items: center; gap: 8px; min-width: 0">
            <input
              type="text"
              class="bd-inp"
              :value="p.name"
              :aria-label="t('bd.profileName')"
              @change="emit('profile-updated', p.id, { name: ($event.target as HTMLInputElement).value })"
            />
            <span v-if="isDefaultProfile(p)" class="bd-tag-def" :title="t('bd.autoDefaultHint')">{{ t('bd.isDefaultTag') }}</span>
            <button
              class="bd-ibtn"
              :aria-label="`${t('bd.exportProfile')} ${p.name}`"
              :title="t('bd.exportProfile')"
              :disabled="!!exportingProfileId"
              :aria-busy="exportingProfileId === p.id"
              :data-cy="`bd-export-profile-${p.id}`"
              @click="exportProfile(p)"
            >
              <Download :size="16" stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
          <button class="bd-chip" :title="t('bd.configure')" @click="openAuto(p.id)" data-cy="bd-profile-windows">
            <AppWindow :size="14" stroke-width="1.75" aria-hidden="true" />{{ ruleCountLabel(p.id) }}
          </button>
          <button class="bd-btn" @click="emit('profile-duplicated', p.id)">{{ t('bd.duplicate') }}</button>
          <button class="bd-btn bd-dng" :disabled="profiles.length < 2" @click="emit('profile-deleted', p.id)">{{ t('bd.delete') }}</button>
        </div>
        <div style="margin-top: 16px">
          <button class="bd-btn" @click="emit('profile-created')">
            <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.newProfileBtn') }}
          </button>
        </div>
      </template>

      <!-- Exportación de la configuración -->
      <template v-else-if="section === 'backup'">
        <h2>{{ t('bd.secBackup') }}</h2>
        <p class="bd-sub">{{ t('bd.backupSub') }}</p>
        <section class="bd-settings-group" aria-labelledby="bd-backup-export-title" data-cy="bd-backup-export">
          <h3 id="bd-backup-export-title" class="bd-settings-group__title">{{ t('bd.backupExportTitle') }}</h3>
          <p class="bd-settings-group__sub">{{ t('bd.backupExportSub') }}</p>
          <div class="bd-backup-warning" role="note">
            <ShieldAlert :size="18" stroke-width="1.75" aria-hidden="true" />
            <p>{{ t('bd.backupSensitiveWarning') }}</p>
          </div>
          <div class="bd-srow">
            <div>
              <b>{{ t('bd.backupFullLabel') }}</b>
              <p>{{ t('bd.backupFullHint') }}</p>
            </div>
            <div class="bd-ctl">
              <button
                class="bd-btn bd-pri"
                data-cy="bd-export-full-backup"
                :disabled="exportingBackup"
                :aria-busy="exportingBackup"
                @click="exportFullBackup"
              >
                <Download :size="16" stroke-width="1.75" aria-hidden="true" />
                {{ exportingBackup ? t('bd.backupExporting') : t('bd.exportBackup') }}
              </button>
            </div>
          </div>
        </section>
        <section class="bd-settings-group" aria-labelledby="bd-backup-sdimport-title" data-cy="bd-backup-sdimport">
          <h3 id="bd-backup-sdimport-title" class="bd-settings-group__title">{{ t('bd.sdImportTitle') }}</h3>
          <div class="bd-srow" data-setting="backup-streamdeck">
            <div>
              <b>{{ t('bd.sdImportTitle') }}</b>
              <p>{{ t('bd.sdFromBackup') }}</p>
            </div>
            <div class="bd-ctl">
              <button class="bd-btn" data-cy="bd-backup-goto-sdimport" @click="section = 'profiles'">
                <Import :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.sdGoToImport') }}
              </button>
            </div>
          </div>
        </section>
      </template>

      <!-- Apariencia (funcional) -->
      <template v-else-if="section === 'appearance'">
        <h2>{{ t('bd.secAppearance') }}</h2>
        <p class="bd-sub">{{ t('bd.appearanceSub') }}</p>
        <div class="bd-srow" data-setting="language">
          <div><b>{{ t('bd.language') }}</b><p>{{ t('bd.interfaceLang') }}</p></div>
          <div class="bd-ctl">
            <select class="bd-inp" :aria-label="t('bd.language')" :value="currentLocale" data-cy="bd-language-select" @change="emit('language-changed', ($event.target as HTMLSelectElement).value)">
              <option value="es">{{ t('toolbar.spanish') }}</option>
              <option value="en">{{ t('toolbar.english') }}</option>
            </select>
          </div>
        </div>
        <div class="bd-srow bd-col" data-setting="palette">
          <div><b>{{ t('bd.palette') }}</b><p>{{ t('bd.paletteHint') }}</p></div>
          <div class="bd-pals">
            <button
              v-for="pal in palettes"
              :key="pal.id"
              class="bd-pal"
              :aria-pressed="bdPalette === pal.id"
              @click="bdSetPalette(pal.id)"
            >
              <span class="bd-sw4"><i v-for="(c, i) in pal.colors" :key="i" :style="{ background: c }"></i></span>
              {{ pal.label }}
            </button>
          </div>
        </div>
        <div class="bd-srow" data-setting="keysize">
          <div><b>{{ t('bd.keySize') }}</b><p>{{ t('bd.keySizeHint') }}</p></div>
          <div class="bd-ctl">
            <div class="bd-rg">
              <input type="range" class="bd-inp" min="56" max="96" step="4" :value="bdKeySize" :aria-label="t('bd.keySize')" @input="bdSetKeySize(+($event.target as HTMLInputElement).value)" />
              <output>{{ bdKeySize }} px</output>
            </div>
          </div>
        </div>
        <div class="bd-srow" data-setting="rounding">
          <div><b>{{ t('bd.rounding') }}</b><p>{{ t('bd.roundingHint') }}</p></div>
          <div class="bd-ctl">
            <div class="bd-rg">
              <input type="range" class="bd-inp" min="8" max="28" step="4" :value="bdRadius" :aria-label="t('bd.rounding')" @input="bdSetRadius(+($event.target as HTMLInputElement).value)" />
              <output>{{ bdRadius }} px</output>
            </div>
          </div>
        </div>
        <div class="bd-srow" data-setting="labels">
          <div><b>{{ t('bd.keyLabels') }}</b><p>{{ t('bd.keyLabelsHint') }}</p></div>
          <div class="bd-ctl">
            <div class="bd-seg">
              <button :aria-pressed="bdLabelMode === 'a'" @click="bdSetLabelMode('a')">{{ t('bd.labelsAlways') }}</button>
              <button :aria-pressed="bdLabelMode === 'h'" @click="bdSetLabelMode('h')">{{ t('bd.labelsHover') }}</button>
              <button :aria-pressed="bdLabelMode === 'n'" @click="bdSetLabelMode('n')">{{ t('bd.labelsNever') }}</button>
            </div>
          </div>
        </div>
        <div class="bd-srow" data-setting="animations">
          <div><b>{{ t('bd.animations') }}</b><p>{{ t('bd.animationsHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" :checked="bdAnimations" :aria-label="t('bd.animations')" @change="bdSetAnimations(($event.target as HTMLInputElement).checked)" /><span></span></label></div>
        </div>
      </template>

      <!-- Variables (globales: condiciones y textos {{}}) -->
      <template v-else-if="section === 'vars'">
        <h2>{{ t('bd.secVars') }}</h2>
        <p class="bd-sub">{{ t('bd.varsSub') }}</p>
        <div>
          <div v-for="(v, i) in varRows" :key="v.n" class="bd-vr">
            <div>
              <input
                type="text"
                class="bd-inp bd-mi"
                :value="v.n"
                :aria-label="t('bd.varName')"
                spellcheck="false"
                @change="renameVar(i, ($event.target as HTMLInputElement).value)"
              />
              <span v-if="varErr[i]" class="bd-err">{{ varErr[i] }}</span>
            </div>
            <select class="bd-inp" :value="v.t" :aria-label="t('bd.varType')" @change="changeVarType(i, ($event.target as HTMLSelectElement).value)">
              <option value="num">{{ t('bd.varNum') }}</option>
              <option value="txt">{{ t('bd.varTxt') }}</option>
              <option value="bool">{{ t('bd.varBool') }}</option>
            </select>
            <div>
              <label v-if="v.t === 'bool'" class="bd-sw">
                <input type="checkbox" :checked="!!v.v" :aria-label="`${t('bd.varValue')}: ${v.n}`" @change="changeVarValue(i, ($event.target as HTMLInputElement).checked)" />
                <span></span>
              </label>
              <input
                v-else
                :type="v.t === 'num' ? 'number' : 'text'"
                class="bd-inp"
                :value="v.v as any"
                :aria-label="`${t('bd.varValue')}: ${v.n}`"
                @change="changeVarValue(i, ($event.target as HTMLInputElement).value)"
              />
            </div>
            <button class="bd-ibtn" :aria-label="t('bd.delete')" :title="t('bd.delete')" @click="delVar(i)">
              <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div style="margin-top: 16px">
          <button class="bd-btn" @click="addVarRow">
            <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.newVar') }}
          </button>
        </div>
        <details class="bd-hp">
          <summary>{{ t('bd.helpTitle') }}</summary>
          <p>{{ t('bd.helpOps') }}</p>
          <p>{{ t('bd.helpFns') }}</p>
          <p>{{ t('bd.helpBuiltins') }}</p>
        </details>
      </template>

      <!-- Plugins -->
      <template v-else-if="section === 'plugins'">
        <h2>{{ t('bd.secPlugins') }}</h2>
        <p class="bd-sub">{{ t('bd.pluginsSub') }}</p>
        <PluginsPane
          ref="pluginsPane"
          :plugins="props.plugins"
          :detailed="props.detailed"
          :busy-id="props.busyId"
          :uploading="props.uploading"
          :install-progress="props.installProgress"
          :api-base="apiBase()"
          @toggle-plugin="(id, on) => emit('toggle-plugin', id, on)"
          @remove-plugin="(id, name) => emit('remove-plugin', id, name)"
          @install-file="(f) => emit('install-file', f)"
          @install-url="(url) => emit('install-url', url)"
          @update-plugin="(id) => emit('update-plugin', id)"
          @rollback-plugin="(id) => emit('rollback-plugin', id)"
          @reload-plugin="(id) => emit('reload-plugin', id)"
          @dismiss-install-progress="emit('dismiss-install-progress')"
          @notify="(msg) => emit('notify', msg)"
          @open-mcp-settings="section = 'mcp'"
        />
      </template>

      <!-- MCP -->
      <template v-else-if="section === 'mcp'">
        <h2>{{ t('bd.secMcp') }}</h2>
        <p class="bd-sub">{{ t('bd.mcpSub') }}</p>
        <McpPane
          :mcp-url="props.mcpUrl"
          :mcp-tokens="props.mcpTokens"
          :mcp-secret="props.mcpSecret"
          :mcp-scopes="props.mcpScopes"
          @create-mcp-token="(name, scopes) => emit('create-mcp-token', name, scopes)"
          @update-mcp-token="(id, patch) => emit('update-mcp-token', id, patch)"
          @revoke-mcp-token="(id) => emit('revoke-mcp-token', id)"
          @notify="(msg) => emit('notify', msg)"
        />
      </template>

      <!-- Acceso remoto E2E -->
      <template v-else-if="section === 'remote'">
        <RemotePane />
      </template>

      <!-- Atajos (visual) -->
      <template v-else-if="section === 'shortcuts'">
        <h2>{{ t('bd.secShortcuts') }}</h2>
        <p class="bd-sub">{{ t('bd.shortcutsSub') }}</p>
        <div class="bd-srow" data-setting="showhide">
          <div><b>{{ t('bd.showHideWindow') }}</b></div>
          <div class="bd-ctl">
            <span><kbd class="bd-kbd">Ctrl</kbd> <kbd class="bd-kbd">Alt</kbd> <kbd class="bd-kbd">P</kbd></span>
            <label class="bd-sw"><input type="checkbox" v-model="mock.k1" :aria-label="t('bd.showHideWindow')" /><span></span></label>
          </div>
        </div>
        <div class="bd-srow" data-setting="nextprofile">
          <div><b>{{ t('bd.nextProfile') }}</b></div>
          <div class="bd-ctl">
            <span><kbd class="bd-kbd">Ctrl</kbd> <kbd class="bd-kbd">Alt</kbd> <kbd class="bd-kbd">→</kbd></span>
            <label class="bd-sw"><input type="checkbox" v-model="mock.k2" :aria-label="t('bd.nextProfile')" /><span></span></label>
          </div>
        </div>
        <div class="bd-srow" data-setting="muteall">
          <div><b>{{ t('bd.muteAll') }}</b></div>
          <div class="bd-ctl">
            <span><kbd class="bd-kbd">Ctrl</kbd> <kbd class="bd-kbd">Alt</kbd> <kbd class="bd-kbd">M</kbd></span>
            <label class="bd-sw"><input type="checkbox" v-model="mock.k3" :aria-label="t('bd.muteAll')" /><span></span></label>
          </div>
        </div>
      </template>

      <!-- Avanzado -->
      <template v-else-if="section === 'advanced'">
        <h2>{{ t('bd.secAdvanced') }}</h2>
        <p class="bd-sub">{{ t('bd.advancedSub') }}</p>
        <div class="bd-srow" data-setting="port">
          <div><b>{{ t('bd.localPort') }}</b><p>{{ t('bd.localPortHint') }}</p></div>
          <div class="bd-ctl"><input type="number" class="bd-inp" v-model.number="mock.port" min="1024" max="65535" :aria-label="t('bd.localPort')" /></div>
        </div>
        <div class="bd-srow" data-setting="loglevel">
          <div><b>{{ t('bd.logLevel') }}</b><p>{{ t('bd.logLevelHint') }}</p></div>
          <div class="bd-ctl">
            <select class="bd-inp" v-model="mock.log" :aria-label="t('bd.logLevel')">
              <option>{{ t('bd.logErrors') }}</option>
              <option>{{ t('bd.logWarnings') }}</option>
              <option>{{ t('bd.logInfo') }}</option>
              <option>{{ t('bd.logDebug') }}</option>
            </select>
          </div>
        </div>
        <div class="bd-srow" data-setting="devmode">
          <div><b>{{ t('bd.devMode') }}</b><p>{{ t('bd.devModeHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.dev" :aria-label="t('bd.devMode')" /><span></span></label></div>
        </div>
        <div class="bd-srow" data-setting="reset">
          <div><b>{{ t('bd.resetSettings') }}</b><p>{{ t('bd.resetSettingsHint') }}</p></div>
          <div class="bd-ctl"><button class="bd-btn bd-dng" @click="resetAll">{{ t('bd.resetBtn') }}</button></div>
        </div>
      </template>

      <!-- Registros: estado de servicios + logs del daemon (diagnóstico multi-dispositivo) -->
      <template v-else-if="section === 'logs'">
        <DiagnosticsPane
          :api-base="apiBase()"
          :ws-url="props.wsUrl"
          :ws-connected="props.wsConnected"
          @notify="(msg) => emit('notify', msg)"
        />
      </template>

      <!-- Acerca de -->
      <template v-else>
        <h2>{{ t('bd.secAbout') }}</h2>
        <div class="bd-srow">
          <div><b>{{ t('bd.aboutTitle') }}</b><p>{{ t('bd.aboutText') }}</p></div>
          <div class="bd-ctl"><span class="bd-mono">{{ versionLine }}</span></div>
        </div>
        <div class="bd-srow">
          <div><b>{{ t('bd.aboutGuideTitle') }}</b><p>{{ t('bd.aboutGuideHint') }}</p></div>
          <div class="bd-ctl"><button class="bd-btn" data-cy="bd-open-welcome" @click="emit('open-welcome')"><Sparkles :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.aboutGuideBtn') }}</button></div>
        </div>
        <div class="bd-srow">
          <div><b>{{ t('bd.secAbout') }}</b><p>{{ t('bd.aboutReview') }}</p></div>
        </div>
      </template>
    </div>

    <div class="bd-dfoot">
      <span>{{ t('bd.instantSave') }}</span>
      <button class="bd-btn bd-pri" @click="close">{{ t('bd.done') }}</button>
    </div>
  </dialog>
  <AutoProfileDialog
    ref="autoDialog"
    :profiles="profiles"
    @config-changed="loadAutoCfg().catch(() => {})"
    @activate-profile="(id) => emit('activate-profile', id)"
    @notify="(msg) => emit('notify', msg)"
  />
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, defineAsyncComponent } from 'vue'
import {
  SlidersHorizontal, Users, Paintbrush, Puzzle, Network, Command, Wrench, Info, Plus, Palette, AppWindow, Variable, Trash2, Smartphone, MonitorSmartphone, Database, Download, Upload, Import, ShieldAlert, Sparkles, ScrollText, Search, X
} from 'lucide-vue-next'
import PluginsPane, { type PluginsTab } from './PluginsPane.vue'
// Paneles secundarios: chunks diferidos. PluginsPane queda estático porque
// show('plugins') necesita setTab de forma síncrona tras nextTick.
const McpPane = defineAsyncComponent(() => import('./McpPane.vue'))
const RemotePane = defineAsyncComponent(() => import('./RemotePane.vue'))
const DiagnosticsPane = defineAsyncComponent(() => import('./DiagnosticsPane.vue'))
const AutoProfileDialog = defineAsyncComponent(() => import('./AutoProfileDialog.vue'))
import { useI18nStore } from '../../composables/useI18n'
import {
  bdPalette, bdLabelMode, bdKeySize, bdRadius, bdBrightness, bdAnimations, bdLongPressMs,
  bdSetPalette, bdSetLabelMode, bdSetKeySize, bdSetRadius, bdSetBrightness, bdSetAnimations, bdSetLongPressMs
} from '../../composables/useBunDeckUi'
import { useAutoProfile } from '../../composables/useAutoProfile'
import { getTunnelToken, tunnelApiBase, tunnelConfigUrl } from '../../composables/useTunnel'
import {
  fetchDetectedProfiles, importDetectedProfiles, importStreamDeckFile, summarizeImportPlan,
  type DetectedSDProfile,
} from '../../composables/useStreamDeckImport'
import { vars, addVar, coerceVal, persistVars, setVarValue } from '../../composables/useVars'
import { IDRE, RES } from '../../composables/useExpressions'
import type { ProfileData } from '../../types/streamdeck'

const { t } = useI18nStore()

type Section = 'general' | 'devices' | 'profiles' | 'backup' | 'appearance' | 'vars' | 'plugins' | 'mcp' | 'remote' | 'shortcuts' | 'advanced' | 'logs' | 'about'

interface Props {
  currentLocale: string
  showUpdates: boolean
  profiles: ProfileData[]
  plugins?: any[]
  detailed?: any[]
  busyId?: string | null
  uploading?: boolean
  mcpUrl?: string
  mcpTokens?: any[]
  mcpSecret?: string | null
  mcpScopes?: Array<{ id: string; group: string }>
  installProgress?: { key: string; stage: string; message: string } | null
  wsConnected?: boolean
  wsUrl?: string
}

interface Emits {
  (e: 'language-changed', locale: string): void
  (e: 'streamdeck-connected'): void
  (e: 'streamdeck-disconnected'): void
  (e: 'check-updates'): void
  (e: 'profile-updated', profileId: string, updates: any): void
  (e: 'profile-deleted', profileId: string): void
  (e: 'profile-created'): void
  (e: 'profile-duplicated', profileId: string): void
  (e: 'activate-profile', profileId: string): void
  (e: 'streamdeck-imported'): void
  (e: 'notify', message: string, undo?: () => void): void
  (e: 'toggle-plugin', pluginId: string, on: boolean): void
  (e: 'remove-plugin', pluginId: string, name: string): void
  (e: 'install-file', file: File): void
  (e: 'install-url', url: string): void
  (e: 'update-plugin', pluginId: string): void
  (e: 'rollback-plugin', pluginId: string): void
  (e: 'reload-plugin', pluginId: string): void
  (e: 'create-mcp-token', name: string, scopes: string[]): void
  (e: 'update-mcp-token', id: string, patch: { scopes: string[] }): void
  (e: 'revoke-mcp-token', id: string): void
  (e: 'dismiss-install-progress'): void
  (e: 'open-welcome'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const dialog = ref<HTMLDialogElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
const section = ref<Section>('general')
const pluginsPane = ref<InstanceType<typeof PluginsPane> | null>(null)

const navItems = computed(() => [
  { id: 'general' as const, label: t('bd.secGeneral'), icon: SlidersHorizontal },
  { id: 'devices' as const, label: t('bd.secDevices'), icon: MonitorSmartphone },
  { id: 'profiles' as const, label: t('bd.secProfiles'), icon: Users },
  { id: 'backup' as const, label: t('bd.secBackup'), icon: Database },
  { id: 'appearance' as const, label: t('bd.secAppearance'), icon: Paintbrush },
  { id: 'vars' as const, label: t('bd.secVars'), icon: Variable },
  { id: 'plugins' as const, label: t('bd.secPlugins'), icon: Puzzle },
  { id: 'mcp' as const, label: t('bd.secMcp'), icon: Network },
  { id: 'remote' as const, label: t('bd.secRemote'), icon: Smartphone },
  { id: 'shortcuts' as const, label: t('bd.secShortcuts'), icon: Command },
  { id: 'advanced' as const, label: t('bd.secAdvanced'), icon: Wrench },
  { id: 'logs' as const, label: t('bd.secLogs'), icon: ScrollText },
  { id: 'about' as const, label: t('bd.secAbout'), icon: Info }
])

// Buscador: filtra el menú lateral y ofrece salto directo al ajuste concreto.
const query = ref('')
const norm = (s: string) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
const filteredNav = computed(() => {
  const q = norm(query.value.trim())
  if (!q) return navItems.value
  return navItems.value.filter((i) => norm(i.label).includes(q))
})
interface SearchEntry { section: Section; id: string; title: string; hint: string; sectionLabel: string }
const searchIndex = computed<SearchEntry[]>(() => {
  const L = (sec: Section, id: string, title: string, hint = ''): SearchEntry => ({
    section: sec,
    id,
    title,
    hint,
    sectionLabel: navItems.value.find((n) => n.id === sec)?.label ?? sec,
  })
  const entries: SearchEntry[] = [
    // Secciones (para que "apariencia", "copias", "atajos"… lleven a su página)
    ...navItems.value.map((n) => L(n.id, `sec-${n.id}`, n.label)),
    // General
    L('general', 'autostart', t('bd.startWithSystem'), t('bd.startWithSystemHint')),
    L('general', 'tray', t('bd.keepInTray'), t('bd.keepInTrayHint')),
    L('general', 'undo', t('bd.allowUndo'), t('bd.allowUndoHint')),
    L('general', 'autoswitch', t('bd.autoSwitch'), t('bd.autoSwitchHint')),
    // Dispositivos
    L('devices', 'device', t('bd.streamdeckDevice'), t('bd.streamdeckDeviceHint')),
    L('devices', 'brightness', t('bd.brightness'), t('bd.brightnessHint')),
    L('devices', 'longpress', t('bd.longPressTime'), t('bd.longPressTimeHint')),
    // Copias
    L('backup', 'backup-export', t('bd.backupExportTitle'), t('bd.backupExportSub')),
    L('backup', 'backup-streamdeck', t('bd.sdImportTitle'), t('bd.sdFromBackup')),
    // Perfiles
    L('profiles', 'streamdeck-import', t('bd.sdImportTitle'), t('bd.sdImportHint')),
    // Apariencia (incluye el idioma movido desde General)
    L('appearance', 'language', t('bd.language'), t('bd.interfaceLang')),
    L('appearance', 'palette', t('bd.palette'), t('bd.paletteHint')),
    L('appearance', 'keysize', t('bd.keySize'), t('bd.keySizeHint')),
    L('appearance', 'rounding', t('bd.rounding'), t('bd.roundingHint')),
    L('appearance', 'labels', t('bd.keyLabels'), t('bd.keyLabelsHint')),
    L('appearance', 'animations', t('bd.animations'), t('bd.animationsHint')),
    // Atajos
    L('shortcuts', 'showhide', t('bd.showHideWindow')),
    L('shortcuts', 'nextprofile', t('bd.nextProfile')),
    L('shortcuts', 'muteall', t('bd.muteAll')),
    // Avanzado
    L('advanced', 'port', t('bd.localPort'), t('bd.localPortHint')),
    L('advanced', 'loglevel', t('bd.logLevel'), t('bd.logLevelHint')),
    L('advanced', 'devmode', t('bd.devMode'), t('bd.devModeHint')),
    L('advanced', 'reset', t('bd.resetSettings'), t('bd.resetSettingsHint')),
  ]
  // Sin duplicados sección+id (las entradas de sección usan `sec-*`)
  const seen = new Set<string>()
  return entries.filter((e) => {
    const k = `${e.section}:${e.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
})
const isSearching = computed(() => query.value.trim().length > 0)
const searchResults = computed(() => {
  const q = norm(query.value.trim())
  if (!q) return []
  return searchIndex.value
    .filter((e) => norm(`${e.title} ${e.hint} ${e.sectionLabel}`).includes(q))
    .slice(0, 30)
})
const selectSection = (id: Section) => {
  section.value = id
  query.value = ''
  nextTick(() => bodyEl.value?.scrollTo(0, 0))
}
const goToResult = (r: SearchEntry) => {
  section.value = r.section
  const target = r.id.startsWith('sec-') ? null : r.id
  query.value = ''
  nextTick(() => {
    bodyEl.value?.scrollTo(0, 0)
    if (!target || !bodyEl.value) return
    requestAnimationFrame(() => {
      const el = bodyEl.value?.querySelector(`[data-setting="${target}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  })
}

const palettes = computed(() => [
  { id: 'auto' as const, label: t('bd.palAuto'), colors: ['#121315', '#f3f3f1', '#e0a84a', '#2d5be3'] },
  { id: 'grafito' as const, label: t('bd.palGrafito'), colors: ['#121315', '#1a1c1f', '#2d3036', '#e0a84a'] },
  { id: 'papel' as const, label: t('bd.palPapel'), colors: ['#f3f3f1', '#fbfbfa', '#2b2d31', '#2d5be3'] },
  { id: 'medianoche' as const, label: t('bd.palMedianoche'), colors: ['#0d131f', '#141c2c', '#1e2943', '#5ea2ff'] },
  { id: 'bosque' as const, label: t('bd.palBosque'), colors: ['#0f140f', '#161d16', '#212b20', '#a3d16b'] },
  { id: 'arena' as const, label: t('bd.palArena'), colors: ['#f0ebe2', '#f8f5ee', '#3a362e', '#5b7b38'] }
])

// Preferencias solo visuales (el daemon no las soporta): persisten en localStorage
const MOCK_KEY = 'bundeck:settings-mock'
function loadMock() {
  try {
    return JSON.parse(localStorage.getItem(MOCK_KEY) ?? '{}')
  } catch {
    return {}
  }
}
const mock = ref({
  autostart: false, tray: true, updates: true, undo: true,
  dim: '5 min', idle: '', orientation: '0°', haptic: true, sound: false,
  k1: true, k2: true, k3: false, port: 4455, log: '', dev: false,
  ...loadMock()
})
watch(
  mock,
  (v) => {
    try {
      localStorage.setItem(MOCK_KEY, JSON.stringify(v))
    } catch { /* noop */ }
  },
  { deep: true }
)

// Cambio automático de perfil (real, persistido en el daemon vía settings)
const { config: autoCfg, loadConfiguration: loadAutoCfg, persist: persistAutoCfg } = useAutoProfile()
const autoActiveRules = computed(() => autoCfg.value.rules.filter((r) => r.enabled).length)
const autoBadgeText = computed(() =>
  !autoCfg.value.enabled
    ? t('bd.autoOff')
    : autoActiveRules.value === 1
      ? t('bd.autoActiveOne')
      : t('bd.autoActive', { n: autoActiveRules.value })
)
const toggleAutoSwitch = async (on: boolean) => {
  autoCfg.value.enabled = on
  await persistAutoCfg()
}
onMounted(() => {
  loadAutoCfg().catch(() => {})
})
const parseProfileData = (p: ProfileData) => {
  let d: any = p.data
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d)
    } catch {
      d = {}
    }
  }
  return d ?? {}
}
const isDefaultProfile = (p: ProfileData) => {
  if (autoCfg.value.defaultProfileId) return autoCfg.value.defaultProfileId === p.id
  return parseProfileData(p)?.isDefault === true
}
const ruleCountLabel = (profileId: string) => {
  const n = autoCfg.value.rules.filter((r) => r.profileId === profileId).length
  if (n === 0) return t('bd.noWindows')
  if (n === 1) return t('bd.oneWindow')
  return t('bd.windowCount', { n })
}
const autoDialog = ref<InstanceType<typeof AutoProfileDialog> | null>(null)
const openAuto = (focusProfileId?: string) => {
  // AutoProfileDialog es async: si su chunk aún está cargando, reintentar
  // unos ticks antes de rendirse (evita el clic "muerto" en arranque frío).
  let tries = 5
  const attempt = () => {
    if (autoDialog.value?.show) {
      autoDialog.value.show(focusProfileId)
      return
    }
    if (--tries > 0) nextTick(attempt)
  }
  attempt()
}

// Variables globales (intérprete propio; persisten en localStorage)
const varRows = vars
const varErr = ref<Record<number, string>>({})
const addVarRow = () => {
  addVar()
}
const renameVar = (i: number, name: string) => {
  const n = name.trim()
  if (!IDRE.test(n) || RES.includes(n.toLowerCase())) {
    varErr.value[i] = t('bd.varBadName')
    return
  }
  if (vars.value.some((v, j) => j !== i && v.n === n)) {
    varErr.value[i] = t('bd.varExists')
    return
  }
  varErr.value[i] = ''
  vars.value[i].n = n
  persistVars()
}
const changeVarType = (i: number, vtype: string) => {
  const v = vars.value[i]
  v.t = vtype === 'bool' ? 'bool' : vtype === 'txt' ? 'txt' : 'num'
  v.v = coerceVal(v.t, v.t === 'num' ? 0 : v.t === 'bool' ? false : '')
  persistVars()
}
const changeVarValue = (i: number, raw: any) => {
  const v = vars.value[i]
  if (v) setVarValue(v.n, raw)
}
const delVar = (i: number) => {
  vars.value.splice(i, 1)
  persistVars()
}

// Stream Deck real (misma lógica que antes)
const devices = ref<any[]>([])
const selectedDevice = ref('')
const deviceStatus = ref('')
const versionLine = ref('')
const exportingProfileId = ref<string | null>(null)
const exportingBackup = ref(false)

// Etiqueta corta para el <select>: solo el modelo (el path HID es larguísimo
// y desborda el ajuste). El path completo queda en `title` como tooltip.
const deviceShortLabel = (d: any, index: number) => {
  const model = String(d?.model ?? '').trim() || 'Stream Deck'
  const sameModelCount = devices.value.filter((x) => String(x?.model ?? '').trim() === String(d?.model ?? '').trim()).length
  return sameModelCount > 1 ? `${model} · ${index + 1}` : model
}
const deviceTitle = (d: any) => {
  const model = String(d?.model ?? '').trim() || 'Stream Deck'
  return d?.path ? `${model} (${d.path})` : model
}
const selectedDeviceTitle = computed(() => {
  const found = devices.value.find((d) => d.path === selectedDevice.value)
  if (found) return deviceTitle(found)
  return selectedDevice.value || ''
})
const deviceStatusShort = computed(() => {
  if (!deviceStatus.value) return ''
  const found = devices.value.find((d) => d.path === deviceStatus.value)
  if (found) return deviceShortLabel(found, devices.value.indexOf(found))
  // Sin lista (o path desconocido): recorta el path para que no rompa el layout
  return deviceStatus.value.length > 40
    ? `…${deviceStatus.value.slice(-36)}`
    : deviceStatus.value
})
const apiPort = ref(3001)
const apiBase = () => {
  if (typeof window !== 'undefined') {
    const tunnelToken = getTunnelToken()
    if (tunnelToken) return tunnelApiBase(tunnelToken)
    return `${window.location.protocol}//${window.location.hostname}:${apiPort.value}/api/v1`
  }
  return 'http://localhost:3001/api/v1'
}

const downloadBackup = async (path: string, filename: string) => {
  const res = await fetch(`${apiBase()}${path}`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `HTTP ${res.status}`)
  }

  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 1000)
}

const safeFilename = (name: string) =>
  name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'perfil'

const exportProfile = async (profile: ProfileData) => {
  if (exportingProfileId.value) return
  exportingProfileId.value = profile.id
  try {
    await downloadBackup(
      `/backups/profiles/${encodeURIComponent(profile.id)}/export`,
      `libredeck-perfil-${safeFilename(profile.name)}.json`
    )
    emit('notify', t('bd.profileExported', { name: profile.name }))
  } catch (error) {
    emit('notify', `${t('bd.backupExportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    exportingProfileId.value = null
  }
}

const exportFullBackup = async () => {
  if (exportingBackup.value) return
  exportingBackup.value = true
  try {
    const date = new Date().toISOString().slice(0, 10)
    await downloadBackup('/backups/export', `libredeck-backup-${date}.json`)
    emit('notify', t('bd.backupExported'))
  } catch (error) {
    emit('notify', `${t('bd.backupExportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    exportingBackup.value = false
  }
}

// Importar perfiles de Stream Deck (Elgato): detectados o .streamDeckProfile.
// Siempre crea perfiles nuevos «(importado)»; al terminar se avisa al padre
// para recargar la lista de perfiles.
const sdProfiles = ref<DetectedSDProfile[]>([])
const sdChecked = ref<string[]>([])
const sdBusy = ref(false)
const sdStatus = ref('')
const sdFileInput = ref<HTMLInputElement | null>(null)

const sdDescribe = (r: { counts: { native: number; bridge: number; placeholder: number; buttons: number } }) => {
  const s = summarizeImportPlan({ counts: r.counts, warnings: [] })
  return t('bd.sdSummary', { total: s.total, native: s.native, bridge: s.bridge, pending: s.pending })
}

const sdDetect = async () => {
  if (sdBusy.value) return
  sdBusy.value = true
  sdStatus.value = ''
  try {
    sdProfiles.value = await fetchDetectedProfiles(apiBase())
    sdChecked.value = sdProfiles.value.map((p) => p.uuid)
    sdStatus.value = sdProfiles.value.length === 0
      ? t('bd.sdImportNotFound')
      : sdProfiles.value.length === 1
        ? t('bd.sdImportDetectedOne')
        : t('bd.sdImportDetected', { n: sdProfiles.value.length })
  } catch (error) {
    sdStatus.value = `${t('bd.sdImportFailed')}: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    sdBusy.value = false
  }
}

const sdToggle = (uuid: string, on: boolean) => {
  sdChecked.value = on
    ? [...new Set([...sdChecked.value, uuid])]
    : sdChecked.value.filter((u) => u !== uuid)
}

const sdImportSelected = async () => {
  if (sdBusy.value || !sdChecked.value.length) {
    if (!sdChecked.value.length) emit('notify', t('bd.sdNoSelection'))
    return
  }
  sdBusy.value = true
  sdStatus.value = t('bd.sdImporting')
  try {
    const results = await importDetectedProfiles(apiBase(), sdChecked.value)
    for (const r of results) {
      emit('notify', `${t('bd.sdImported', { name: r.profileName ?? r.name })} — ${sdDescribe(r)}`)
    }
    sdStatus.value = results.map((r) => `${t('bd.sdImported', { name: r.profileName ?? r.name })} — ${sdDescribe(r)}`).join(' · ')
    emit('streamdeck-imported')
  } catch (error) {
    const msg = `${t('bd.sdImportFailed')}: ${error instanceof Error ? error.message : String(error)}`
    sdStatus.value = msg
    emit('notify', msg)
  } finally {
    sdBusy.value = false
  }
}

const sdUpload = async (file: File | null) => {
  if (!file || sdBusy.value) return
  sdBusy.value = true
  sdStatus.value = t('bd.sdImporting')
  try {
    const r = await importStreamDeckFile(apiBase(), file)
    emit('notify', `${t('bd.sdImported', { name: r.profileName ?? r.name })} — ${sdDescribe(r)}`)
    sdStatus.value = `${t('bd.sdImported', { name: r.profileName ?? r.name })} — ${sdDescribe(r)}`
    emit('streamdeck-imported')
  } catch (error) {
    const msg = `${t('bd.sdImportFailed')}: ${error instanceof Error ? error.message : String(error)}`
    sdStatus.value = msg
    emit('notify', msg)
  } finally {
    sdBusy.value = false
  }
}

const syncApiPort = async () => {
  try {
    const tunnelToken = getTunnelToken()
    const url = tunnelToken
      ? tunnelConfigUrl(tunnelToken)
      : typeof window !== 'undefined'
        ? `${window.location.protocol}//${window.location.hostname}:3001/config`
        : '/config'
    const res = await fetch(url)
    if (res.ok) {
      const cfg = await res.json()
      if (cfg.apiPort) apiPort.value = cfg.apiPort
    }
  } catch { /* puerto por defecto */ }
}
const loadStatus = async () => {
  try {
    const res = await fetch(`${apiBase()}/devices/streamdeck/status`)
    if (res.ok) {
      const st = await res.json()
      if (st.isConnected && st.connectedDevice) {
        selectedDevice.value = st.connectedDevice
        deviceStatus.value = st.connectedDevice
      }
    }
  } catch { /* sin daemon */ }
}
const loadDevices = async () => {
  try {
    const res = await fetch(`${apiBase()}/devices/streamdeck`)
    devices.value = res.ok ? (await res.json() ?? []) : []
    if (!Array.isArray(devices.value)) devices.value = []
  } catch {
    devices.value = []
  }
}
const loadVersion = async () => {
  try {
    const res = await fetch(`${apiBase()}/version`)
    if (res.ok) {
      const data = await res.json()
      versionLine.value = data.version ? `v${data.version}` : ''
    }
  } catch { /* noop */ }
}
const handleDeviceChange = async () => {
  const path = selectedDevice.value
  try {
    if (path) {
      const res = await fetch(`${apiBase()}/devices/streamdeck/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devicePath: path })
      })
      const result = await res.json()
      if (result.success) {
        deviceStatus.value = result.connectedDevice ?? ''
        emit('streamdeck-connected')
      } else {
        selectedDevice.value = ''
        deviceStatus.value = ''
      }
    } else {
      await fetch(`${apiBase()}/devices/streamdeck/disconnect`, { method: 'POST' })
      deviceStatus.value = ''
      emit('streamdeck-disconnected')
    }
  } catch {
    selectedDevice.value = ''
    deviceStatus.value = ''
  }
}
const testDevice = async () => {
  try {
    await fetch(`${apiBase()}/devices/streamdeck/test`, { method: 'POST' })
  } catch { /* noop */ }
}

const resetAll = () => {
  bdSetPalette('auto')
  bdSetLabelMode('a')
  bdSetKeySize(76)
  bdSetRadius(16)
  bdSetBrightness(80)
  bdSetAnimations(true)
  bdSetLongPressMs(500)
  emit('notify', t('bd.settingsReset'))
}

const show = (at?: Section, pluginTab?: PluginsTab) => {
  section.value = at ?? 'general'
  query.value = ''
  if (at === 'plugins') {
    nextTick(() => pluginsPane.value?.setTab(pluginTab ?? 'inst'))
  }
  if (at === 'profiles' || !at) {
    loadAutoCfg().catch(() => {})
  }
  bodyEl.value?.scrollTo(0, 0)
  dialog.value?.showModal()
  void syncApiPort().then(() => {
    loadDevices()
    loadStatus()
  })
  loadVersion()
}
const close = () => dialog.value?.close()

defineExpose({ show, close })
</script>
