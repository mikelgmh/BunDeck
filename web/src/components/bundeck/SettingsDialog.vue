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
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" :checked="autostartEnabled" :disabled="autostartLoading" :aria-label="t('bd.startWithSystem')" @change="toggleAutostart(($event.target as HTMLInputElement).checked)" /><span></span></label></div>
        </div>
        <p v-if="autostartError" class="bd-err" role="alert">{{ autostartError }}</p>
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

          <div class="bd-srow" data-setting="hwbrightness">
            <div><b>{{ t('bd.hwBrightness') }}</b><p>{{ t('bd.hwBrightnessHint') }}</p></div>
            <div class="bd-ctl">
              <div class="bd-rg">
                <input type="range" class="bd-inp" min="0" max="100" step="1" :value="hwBrightness" :disabled="!selectedDevice" :aria-label="t('bd.hwBrightness')" data-cy="bd-hw-brightness" @input="onHwBrightnessInput(+($event.target as HTMLInputElement).value)" />
                <output>{{ hwBrightness }}%</output>
              </div>
              <p v-if="!selectedDevice" class="bd-hint">{{ t('bd.noHwSelected') }}</p>
            </div>
          </div>

          <div class="bd-srow" data-setting="dim">
            <div><b>{{ t('bd.dimAfterMin') }}</b><p>{{ t('bd.dimAfterMinHint') }}</p></div>
            <div class="bd-ctl">
              <div class="bd-rg">
                <input type="number" class="bd-inp" min="0" max="1440" step="1" :value="hwDimMin" :disabled="!selectedDevice || hwDisplayLoading" :aria-label="t('bd.dimAfterMin')" data-cy="bd-hw-dim-min" @change="onHwDimMinChange(+($event.target as HTMLInputElement).value)" />
                <output>{{ t('bd.minutesUnit') }}</output>
              </div>
            </div>
          </div>

          <div class="bd-srow" data-setting="idle">
            <div><b>{{ t('bd.idleAction') }}</b><p>{{ t('bd.idleActionHint') }}</p></div>
            <div class="bd-ctl">
              <select class="bd-inp" :value="hwIdleAction" :disabled="!selectedDevice || hwDisplayLoading" :aria-label="t('bd.idleAction')" data-cy="bd-hw-idle-action" @change="onHwIdleActionChange(($event.target as HTMLSelectElement).value)">
                <option value="off">{{ t('bd.idleOff') }}</option>
                <option value="dim">{{ t('bd.idleDim') }}</option>
                <option value="clock">{{ t('bd.idleClock') }}</option>
              </select>
            </div>
          </div>

          <div class="bd-srow" data-setting="idlemin">
            <div><b>{{ t('bd.idleMinutes') }}</b><p>{{ t('bd.idleMinutesHint') }}</p></div>
            <div class="bd-ctl">
              <div class="bd-rg">
                <input type="number" class="bd-inp" min="0" max="1440" step="1" :value="hwIdleMin" :disabled="!selectedDevice || hwDisplayLoading" :aria-label="t('bd.idleMinutes')" data-cy="bd-hw-idle-min" @change="onHwIdleMinChange(+($event.target as HTMLInputElement).value)" />
                <output>{{ t('bd.minutesUnit') }}</output>
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

          <div class="bd-srow" data-setting="haptic">
            <div><b>{{ t('bd.haptic') }}</b><p>{{ t('bd.hapticHint') }}</p></div>
            <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" :checked="bdHaptic" :aria-label="t('bd.haptic')" @change="bdSetHaptic(($event.target as HTMLInputElement).checked)" /><span></span></label></div>
          </div>

          <div class="bd-srow" data-setting="sound">
            <div><b>{{ t('bd.clickSound') }}</b><p>{{ t('bd.clickSoundHint') }}</p></div>
            <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" :checked="bdClickSound" :aria-label="t('bd.clickSound')" @change="bdSetClickSound(($event.target as HTMLInputElement).checked)" /><span></span></label></div>
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
          <div class="bd-srow" data-setting="backup-export">
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
        <div class="bd-srow" data-setting="uibrightness">
          <div><b>{{ t('bd.uiBrightness') }}</b><p>{{ t('bd.uiBrightnessHint') }}</p></div>
          <div class="bd-ctl">
            <div class="bd-rg">
              <input type="range" class="bd-inp" min="0" max="100" step="1" :value="bdBrightness" :aria-label="t('bd.uiBrightness')" data-cy="bd-ui-brightness" @input="bdSetBrightness(+($event.target as HTMLInputElement).value)" />
              <output>{{ bdBrightness }}%</output>
            </div>
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

      <!-- Atajos (capturables, con listener global in-app) -->
      <template v-else-if="section === 'shortcuts'">
        <h2>{{ t('bd.secShortcuts') }}</h2>
        <p class="bd-sub">{{ t('bd.shortcutsSub') }}</p>
        <p class="bd-hint">{{ t('bd.shortcutGlobalHint') }}</p>
        <div v-if="shortcutConflicts.length" class="bd-backup-warning" role="alert" data-cy="bd-shortcut-conflicts">
          <b>{{ t('bd.shortcutConflict') }}:</b>
          {{ shortcutConflicts.map((g) => g.map((id) => shortcutLabel(id)).join(' + ')).join(' · ') }}
        </div>
        <div v-for="id in shortcutIds" :key="id" class="bd-srow" :data-setting="`shortcut-${id}`">
          <div>
            <b>{{ shortcutLabel(id) }}</b>
            <p v-if="shortcutHasConflict(id)" class="bd-err">{{ t('bd.shortcutConflict') }}</p>
          </div>
          <div class="bd-ctl">
            <button
              class="bd-btn"
              :data-cy="`bd-shortcut-recapture-${id}`"
              :aria-label="`${shortcutLabel(id)}: ${shortcutsMap[id].combo}`"
              @click="startCapture(id)"
            >
              <template v-if="capturingId === id">{{ t('bd.shortcutPressKeys') }}…</template>
              <template v-else><kbd v-for="(part, i) in shortcutsMap[id].combo.split('+')" :key="i" class="bd-kbd">{{ part }}</kbd></template>
            </button>
            <label class="bd-sw">
              <input
                type="checkbox"
                :checked="shortcutsMap[id].enabled"
                :data-cy="`bd-shortcut-toggle-${id}`"
                :aria-label="shortcutLabel(id)"
                @change="setShortcutEnabled(id, ($event.target as HTMLInputElement).checked)"
              /><span></span>
            </label>
          </div>
        </div>
        <div class="bd-srow" data-setting="shortcuts-reset">
          <div><b>{{ t('bd.shortcutReset') }}</b><p>{{ t('bd.shortcutHint') }}</p></div>
          <div class="bd-ctl"><button class="bd-btn" data-cy="bd-shortcuts-reset" @click="resetShortcuts">{{ t('bd.shortcutReset') }}</button></div>
        </div>
      </template>

      <!-- Avanzado -->
      <template v-else-if="section === 'advanced'">
        <h2>{{ t('bd.secAdvanced') }}</h2>
        <p class="bd-sub">{{ t('bd.advancedSub') }}</p>
        <FactoryResetSection
          :api-base="apiBase()"
          @notify="(msg) => emit('notify', msg)"
          @reset-done="handleFactoryResetDone"
        />
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
import { ref, computed, nextTick, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import {
  SlidersHorizontal, Users, Paintbrush, Puzzle, Network, Command, Wrench, Info, Plus, Palette, AppWindow, Variable, Trash2, Smartphone, MonitorSmartphone, Database, Download, Upload, Import, ShieldAlert, Sparkles, ScrollText, Search, X
} from 'lucide-vue-next'
import PluginsPane, { type PluginsTab } from './PluginsPane.vue'
import FactoryResetSection from './FactoryResetSection.vue'
// Paneles secundarios: chunks diferidos. PluginsPane queda estático porque
// show('plugins') necesita setTab de forma síncrona tras nextTick.
const McpPane = defineAsyncComponent(() => import('./McpPane.vue'))
const RemotePane = defineAsyncComponent(() => import('./RemotePane.vue'))
const DiagnosticsPane = defineAsyncComponent(() => import('./DiagnosticsPane.vue'))
const AutoProfileDialog = defineAsyncComponent(() => import('./AutoProfileDialog.vue'))
import { useI18nStore } from '../../composables/useI18n'
import {
  bdPalette, bdLabelMode, bdKeySize, bdRadius, bdBrightness, bdAnimations, bdLongPressMs, bdClickSound, bdHaptic,
  bdSetPalette, bdSetLabelMode, bdSetKeySize, bdSetRadius, bdSetBrightness, bdSetAnimations, bdSetLongPressMs, bdSetClickSound, bdSetHaptic,
  bdShowLeft, bdShowRight, bdSetPanels
} from '../../composables/useBunDeckUi'
import { useAutoProfile } from '../../composables/useAutoProfile'
import {
  DEVICE_DISPLAY_DEFAULTS,
  clampHwBrightness,
  clampIdleMinutes,
  fetchDeviceDisplay,
  saveDeviceDisplay,
  webIdleMinutes,
  type DeviceIdleAction,
} from '../../composables/useDeviceDisplay'
import { loadAutostart, saveAutostart } from '../../composables/useAutostart'
import { getTunnelToken, tunnelApiBase, tunnelConfigUrl } from '../../composables/useTunnel'
import {
  fetchDetectedProfiles, importDetectedProfiles, importStreamDeckFile, summarizeImportPlan,
  type DetectedSDProfile,
} from '../../composables/useStreamDeckImport'
import { vars, addVar, coerceVal, persistVars, setVarValue, pushVarToDaemon } from '../../composables/useVars'
import { IDRE, RES } from '../../composables/useExpressions'
import {
  SHORTCUT_IDS, DEFAULT_SHORTCUTS, SHORTCUTS_CONFIG_KEY,
  loadShortcutsState, saveShortcutsState, parseDaemonShortcutsConfig, serializeDaemonShortcutsConfig,
  findShortcutConflicts, comboFromEvent, stepProfile,
  installGlobalShortcuts,
  type ShortcutId, type ShortcutMap, type KeyEventLike,
} from '../../composables/useShortcuts'
import type { ProfileData } from '../../types/streamdeck'

const { t } = useI18nStore()

type Section = 'general' | 'devices' | 'profiles' | 'backup' | 'appearance' | 'vars' | 'plugins' | 'mcp' | 'remote' | 'shortcuts' | 'advanced' | 'logs' | 'about'

interface Props {
  currentLocale: string
  showUpdates: boolean
  profiles: ProfileData[]
  /** Perfil activo (para perfil siguiente/anterior por atajo). */
  activeProfileId?: string | null
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
    L('general', 'autoswitch', t('bd.autoSwitch'), t('bd.autoSwitchHint')),
    // Dispositivos
    L('devices', 'device', t('bd.streamdeckDevice'), t('bd.streamdeckDeviceHint')),
    L('devices', 'hwbrightness', t('bd.hwBrightness'), t('bd.hwBrightnessHint')),
    L('devices', 'dim', t('bd.dimAfterMin'), t('bd.dimAfterMinHint')),
    L('devices', 'idle', t('bd.idleAction'), t('bd.idleActionHint')),
    L('devices', 'idlemin', t('bd.idleMinutes'), t('bd.idleMinutesHint')),
    L('devices', 'longpress', t('bd.longPressTime'), t('bd.longPressTimeHint')),
    L('devices', 'haptic', t('bd.haptic'), t('bd.hapticHint')),
    L('devices', 'sound', t('bd.clickSound'), t('bd.clickSoundHint')),
    // Copias
    L('backup', 'backup-export', t('bd.backupExportTitle'), t('bd.backupExportSub')),
    L('backup', 'backup-streamdeck', t('bd.sdImportTitle'), t('bd.sdFromBackup')),
    // Perfiles
    L('profiles', 'streamdeck-import', t('bd.sdImportTitle'), t('bd.sdImportHint')),
    // Apariencia (incluye el idioma movido desde General)
    L('appearance', 'language', t('bd.language'), t('bd.interfaceLang')),
    L('appearance', 'palette', t('bd.palette'), t('bd.paletteHint')),
    L('appearance', 'uibrightness', t('bd.uiBrightness'), t('bd.uiBrightnessHint')),
    L('appearance', 'keysize', t('bd.keySize'), t('bd.keySizeHint')),
    L('appearance', 'rounding', t('bd.rounding'), t('bd.roundingHint')),
    L('appearance', 'labels', t('bd.keyLabels'), t('bd.keyLabelsHint')),
    L('appearance', 'animations', t('bd.animations'), t('bd.animationsHint')),
    // Atajos
    L('shortcuts', 'shortcut-toggle-panels', t('bd.showHideWindow'), t('bd.shortcutGlobalHint')),
    L('shortcuts', 'shortcut-next-profile', t('bd.nextProfile')) ,
    L('shortcuts', 'shortcut-prev-profile', t('bd.prevProfile')),
    L('shortcuts', 'shortcut-mute-all', t('bd.muteAll')),
    L('shortcuts', 'shortcut-toggle-kiosk', t('bd.toggleKiosk')),
    // Avanzado
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

// (Sin estado mock: todos los ajustes de este diálogo son reales —
//  daemon, localStorage con clave propia o composables dedicados.)

// ---- Atajos de teclado (Fase 1 in-app + registro para el launcher) ----
// El estado vive aquí (el diálogo siempre está montado): combos + toggles,
// listener keydown global, recaptura por botón y sincronización con el
// daemon (`settings` → `shortcuts.config`, que el launcher Rust sondea).
const shortcutIds = SHORTCUT_IDS
const shortcutsMap = ref<ShortcutMap>(loadShortcutsState())
const capturingId = ref<ShortcutId | null>(null)
const seenShortcutExecutions = new Set<string>()
const shortcutConflicts = computed(() => findShortcutConflicts(shortcutsMap.value))
const shortcutHasConflict = (id: ShortcutId) => shortcutConflicts.value.some((g) => g.includes(id))
const shortcutLabel = (id: ShortcutId): string =>
  id === 'toggle-panels' ? t('bd.showHideWindow')
  : id === 'next-profile' ? t('bd.nextProfile')
  : id === 'prev-profile' ? t('bd.prevProfile')
  : id === 'mute-all' ? t('bd.muteAll')
  : t('bd.toggleKiosk')

let shortcutSyncTimer: ReturnType<typeof setTimeout> | null = null
const syncShortcutsToDaemon = () => {
  if (shortcutSyncTimer) return
  shortcutSyncTimer = setTimeout(() => {
    shortcutSyncTimer = null
    try {
      void fetch(`${apiBase()}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: SHORTCUTS_CONFIG_KEY, value: serializeDaemonShortcutsConfig(shortcutsMap.value) }),
      }).catch(() => {})
    } catch { /* sin daemon: el estado local sigue mandando */ }
  }, 400)
}
const persistShortcuts = () => {
  saveShortcutsState(shortcutsMap.value)
  syncShortcutsToDaemon()
}
const loadShortcutsFromDaemon = async () => {
  try {
    const res = await fetch(`${apiBase()}/settings?key=${encodeURIComponent(SHORTCUTS_CONFIG_KEY)}`)
    if (!res.ok) return
    const parsed = parseDaemonShortcutsConfig((await res.json())?.value)
    if (parsed) {
      shortcutsMap.value = parsed
      saveShortcutsState(parsed)
    }
  } catch { /* sin daemon */ }
}
const setShortcutEnabled = (id: ShortcutId, on: boolean) => {
  shortcutsMap.value[id].enabled = on
  persistShortcuts()
}
const resetShortcuts = () => {
  shortcutsMap.value = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS))
  capturingId.value = null
  persistShortcuts()
  emit('notify', t('bd.settingsReset'))
}
const startCapture = (id: ShortcutId) => {
  capturingId.value = id
}
const onCaptureKeydown = (ev: KeyboardEvent) => {
  const id = capturingId.value
  if (!id) return
  ev.preventDefault()
  ev.stopPropagation()
  if (ev.key === 'Escape') {
    capturingId.value = null
    return
  }
  const combo = comboFromEvent(ev as unknown as KeyEventLike)
  if (combo) {
    shortcutsMap.value[id].combo = combo
    capturingId.value = null
    persistShortcuts()
  }
}

const runShortcutLocal = async (id: ShortcutId): Promise<void> => {
  if (id === 'next-profile' || id === 'prev-profile') {
    const ids = props.profiles.map((p) => p.id)
    const target = stepProfile(ids, props.activeProfileId ?? null, id === 'next-profile' ? 1 : -1)
    if (target) emit('activate-profile', target)
    return
  }
  if (id === 'toggle-panels') {
    const hidden = !bdShowLeft.value && !bdShowRight.value
    bdSetPanels(hidden, hidden)
    return
  }
  if (id === 'toggle-kiosk') {
    window.dispatchEvent(new CustomEvent('bundeck:toggle-kiosk'))
    return
  }
  if (id === 'mute-all') {
    try {
      const res = await fetch(`${apiBase()}/actions/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: { type: 'app-volume', pluginId: 'audio-mixer', parameters: { mute: 'true' } },
          context: { source: 'shortcut', shortcutId: id },
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (error) {
      emit('notify', `${t('bd.muteAll')}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// Ejecuta un atajo con anti-doble-ejecución por `executionId`.
// - local (tecla pulsada aquí): se ejecuta + se avisa al daemon en modo
//   `notifyOnly` para que difunda a otros clientes sin re-ejecutar.
// - remoto (`bundeck:shortcut` desde el broadcast del daemon, p. ej.
//   hotkey global del launcher): el daemon ya aplicó las acciones de
//   servidor; aquí solo se aplican las solo-UI (paneles, kiosco).
const SERVER_SHORTCUTS: ShortcutId[] = ['next-profile', 'prev-profile', 'mute-all']
const triggerShortcut = (id: ShortcutId, executionId: string, remote: boolean) => {
  if (seenShortcutExecutions.has(executionId)) return
  seenShortcutExecutions.add(executionId)
  if (seenShortcutExecutions.size > 200) {
    const first = seenShortcutExecutions.values().next().value
    if (first) seenShortcutExecutions.delete(first)
  }
  if (remote && SERVER_SHORTCUTS.includes(id)) return
  void runShortcutLocal(id)
  if (!remote) {
    try {
      void fetch(`${apiBase()}/shortcuts/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, source: 'web', executionId, notifyOnly: true }),
      }).catch(() => {})
    } catch { /* noop */ }
  }
}
let uninstallShortcuts: (() => void) | null = null
const onRemoteShortcut = (ev: Event) => {
  const d = (ev as CustomEvent).detail ?? {}
  if (typeof d?.id !== 'string' || !(SHORTCUT_IDS as readonly string[]).includes(d.id)) return
  triggerShortcut(d.id as ShortcutId, typeof d?.executionId === 'string' && d.executionId ? d.executionId : `remote-${Date.now()}`, true)
}

// Arranque con el sistema: setting real `system.autostart` del daemon
// (ver daemon/src/system-autostart.ts). Lo aplica el launcher Rust en el
// SO; aquí solo se lee/escribe la preferencia, con estado de carga y error.
const autostartEnabled = ref(false)
const autostartLoading = ref(false)
const autostartError = ref('')
const loadAutostartState = async () => {
  autostartLoading.value = true
  autostartError.value = ''
  try {
    autostartEnabled.value = await loadAutostart(apiBase())
  } catch {
    autostartError.value = t('bd.autostartError')
  } finally {
    autostartLoading.value = false
  }
}
const toggleAutostart = async (on: boolean) => {
  autostartLoading.value = true
  autostartError.value = ''
  try {
    await saveAutostart(apiBase(), on)
    autostartEnabled.value = on
  } catch (error) {
    autostartError.value = t('bd.autostartError')
    emit('notify', `${t('bd.autostartError')}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    autostartLoading.value = false
  }
}

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
  loadShortcutsFromDaemon().catch(() => {})
  uninstallShortcuts = installGlobalShortcuts(
    (id, executionId) => triggerShortcut(id, executionId, false),
    { getMap: () => shortcutsMap.value, isCapturing: () => capturingId.value !== null },
  )
  window.addEventListener('bundeck:shortcut', onRemoteShortcut)
  window.addEventListener('keydown', onCaptureKeydown, true)
})
onUnmounted(() => {
  uninstallShortcuts?.()
  uninstallShortcuts = null
  window.removeEventListener('bundeck:shortcut', onRemoteShortcut)
  window.removeEventListener('keydown', onCaptureKeydown, true)
  if (shortcutSyncTimer) {
    clearTimeout(shortcutSyncTimer)
    shortcutSyncTimer = null
  }
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
  const v = addVar()
  // La crea también en el daemon (hardware + reglas la ven enseguida).
  pushVarToDaemon(v.n)
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
  pushVarToDaemon(v.n)
}
const changeVarValue = (i: number, raw: any) => {
  const v = vars.value[i]
  if (v && setVarValue(v.n, raw)) pushVarToDaemon(v.n)
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
        void loadHwDisplay()
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
// ---- Pantalla HW por dispositivo (brillo + dim + idle, ver daemon) ----
const hwBrightness = ref<number>(DEVICE_DISPLAY_DEFAULTS.brightness)
const hwDimMin = ref<number>(Math.round(DEVICE_DISPLAY_DEFAULTS.dimAfterSec / 60))
const hwIdleMin = ref<number>(DEVICE_DISPLAY_DEFAULTS.idleMinutes)
const hwIdleAction = ref<DeviceIdleAction>(DEVICE_DISPLAY_DEFAULTS.idleAction)
const hwDisplayLoading = ref(false)
let hwSaveTimer: ReturnType<typeof setTimeout> | null = null

const loadHwDisplay = async () => {
  if (!selectedDevice.value) return
  hwDisplayLoading.value = true
  try {
    const s = await fetchDeviceDisplay(apiBase(), selectedDevice.value)
    hwBrightness.value = s.brightness
    hwDimMin.value = Math.round(s.dimAfterSec / 60)
    hwIdleMin.value = s.idleMinutes
    hwIdleAction.value = s.idleAction
    // El velo web/remoto sigue estos mismos minutos de reposo.
    webIdleMinutes.value = s.idleMinutes
  } catch {
    /* sin daemon o sin ajustes: se mantienen los defaults */
  } finally {
    hwDisplayLoading.value = false
  }
}
const pushHwDisplay = async (patch: Record<string, unknown>) => {
  if (!selectedDevice.value || hwDisplayLoading.value) return
  try {
    const s = await saveDeviceDisplay(apiBase(), selectedDevice.value, patch as any)
    hwBrightness.value = s.brightness
    hwDimMin.value = Math.round(s.dimAfterSec / 60)
    hwIdleMin.value = s.idleMinutes
    hwIdleAction.value = s.idleAction
    webIdleMinutes.value = s.idleMinutes
  } catch (e) {
    emit('notify', String((e as Error)?.message ?? e))
    // Releer para no dejar el control en un valor no guardado.
    void loadHwDisplay()
  }
}
const scheduleHwSave = (patch: Record<string, unknown>) => {
  if (hwSaveTimer) clearTimeout(hwSaveTimer)
  hwSaveTimer = setTimeout(() => {
    hwSaveTimer = null
    void pushHwDisplay(patch)
  }, 400)
}
const onHwBrightnessInput = (v: number) => {
  hwBrightness.value = clampHwBrightness(v)
  scheduleHwSave({ brightness: hwBrightness.value })
}
const onHwDimMinChange = (v: number) => {
  hwDimMin.value = clampIdleMinutes(v)
  void pushHwDisplay({ dimAfterSec: hwDimMin.value * 60 })
}
const onHwIdleMinChange = (v: number) => {
  hwIdleMin.value = clampIdleMinutes(v)
  void pushHwDisplay({ idleMinutes: hwIdleMin.value })
}
const onHwIdleActionChange = (v: string) => {
  const a = (['off', 'dim', 'clock'] as DeviceIdleAction[]).includes(v as DeviceIdleAction)
    ? (v as DeviceIdleAction)
    : DEVICE_DISPLAY_DEFAULTS.idleAction
  hwIdleAction.value = a
  void pushHwDisplay({ idleAction: a })
}
const testDevice = async () => {
  try {
    await fetch(`${apiBase()}/devices/streamdeck/test`, { method: 'POST' })
  } catch { /* noop */ }
}

const handleFactoryResetDone = () => {
  // El daemon ya restauró la instalación fresca y se limpió el
  // localStorage: recargar deja la UI en el estado por defecto.
  window.location.reload()
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
    loadStatus().then(() => loadHwDisplay()).catch(() => {})
    loadAutostartState().catch(() => {})
  })
  loadVersion()
}
const close = () => dialog.value?.close()

defineExpose({ show, close })
</script>
