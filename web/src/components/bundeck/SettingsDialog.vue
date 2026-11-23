<template>
  <dialog ref="dialog" class="bd-dlg bd-grid" :aria-label="t('bd.dlgSettings')" data-cy="bd-settings">
    <nav class="bd-dnav" role="tablist" aria-orientation="vertical" :aria-label="t('bd.dlgSettings')">
      <span class="bd-sh">{{ t('bd.dlgSettings') }}</span>
      <button
        v-for="item in navItems"
        :key="item.id"
        role="tab"
        :data-sec="item.id"
        :aria-selected="section === item.id"
        @click="section = item.id"
      >
        <component :is="item.icon" :size="18" stroke-width="1.75" aria-hidden="true" />
        {{ item.label }}
      </button>
    </nav>

    <div class="bd-dbody" ref="bodyEl">
      <!-- General -->
      <template v-if="section === 'general'">
        <h2>{{ t('bd.secGeneral') }}</h2>
        <p class="bd-sub">{{ t('bd.generalSub') }}</p>
        <div class="bd-srow">
          <div><b>{{ t('bd.language') }}</b><p>{{ t('bd.interfaceLang') }}</p></div>
          <div class="bd-ctl">
            <select class="bd-inp" :aria-label="t('bd.language')" :value="currentLocale" data-cy="bd-language-select" @change="emit('language-changed', ($event.target as HTMLSelectElement).value)">
              <option value="es">{{ t('toolbar.spanish') }}</option>
              <option value="en">{{ t('toolbar.english') }}</option>
            </select>
          </div>
        </div>
        <div class="bd-srow">
          <div><b>{{ t('bd.startWithSystem') }}</b><p>{{ t('bd.startWithSystemHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.autostart" :aria-label="t('bd.startWithSystem')" /><span></span></label></div>
        </div>
        <div class="bd-srow">
          <div><b>{{ t('bd.keepInTray') }}</b><p>{{ t('bd.keepInTrayHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.tray" :aria-label="t('bd.keepInTray')" /><span></span></label></div>
        </div>
        <div v-if="showUpdates" class="bd-srow">
          <div><b>{{ t('bd.checkUpdates') }}</b><p>{{ t('bd.checkUpdatesHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.updates" :aria-label="t('bd.checkUpdates')" /><span></span></label></div>
        </div>
        <div class="bd-srow">
          <div><b>{{ t('bd.allowUndo') }}</b><p>{{ t('bd.allowUndoHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.undo" :aria-label="t('bd.allowUndo')" /><span></span></label></div>
        </div>
        <div class="bd-srow">
          <div><b>{{ t('bd.autoSwitch') }}</b><p>{{ t('bd.autoSwitchHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" :checked="autoCfg.enabled" :aria-label="t('bd.autoSwitch')" @change="toggleAutoSwitch(($event.target as HTMLInputElement).checked)" /><span></span></label></div>
        </div>
      </template>

      <!-- Dispositivo -->
      <template v-else-if="section === 'device'">
        <h2>{{ t('bd.secDevice') }}</h2>
        <p class="bd-sub">{{ t('bd.deviceSub') }}</p>
        <div class="bd-srow">
          <div><b>{{ t('bd.brightness') }}</b><p>{{ t('bd.brightnessHint') }}</p></div>
          <div class="bd-ctl">
            <div class="bd-rg">
              <input type="range" class="bd-inp" min="0" max="100" step="1" :value="bdBrightness" :aria-label="t('bd.brightness')" @input="bdSetBrightness(+($event.target as HTMLInputElement).value)" />
              <output>{{ bdBrightness }}%</output>
            </div>
          </div>
        </div>
        <div class="bd-srow">
          <div><b>{{ t('bd.streamdeckDevice') }}</b></div>
          <div class="bd-ctl bd-ctl-device" style="flex-direction: column; align-items: stretch; gap: 8px; min-width: 0; max-width: 280px; width: 100%">
            <select
              class="bd-inp bd-device-select"
              style="width: 100%; max-width: 100%"
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
        <div class="bd-srow">
          <div><b>{{ t('bd.longPressTime') }}</b><p>{{ t('bd.longPressTimeHint') }}</p></div>
          <div class="bd-ctl">
            <div class="bd-rg">
              <input type="range" class="bd-inp" min="200" max="1200" step="50" v-model.number="mock.longpress" :aria-label="t('bd.longPressTime')" />
              <output>{{ mock.longpress }} ms</output>
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
      </template>

      <!-- Dispositivos lógicos (pantallas por perfil) -->
      <template v-else-if="section === 'devices'">
        <h2>{{ t('bd.secDevices') }}</h2>
        <p class="bd-sub">{{ t('bd.devicesSub') }}</p>
        <p class="bd-hint" data-cy="bd-hw-hint">{{ hwHint }}</p>
        <div>
          <div v-for="d in devStore.devices.value" :key="d.id" class="bd-pr dvrow" :data-cy="`bd-device-${d.id}`">
            <input
              type="text"
              class="bd-inp"
              :value="d.name"
              :aria-label="t('bd.secDevices')"
              @change="renameLogicalDevice(d, ($event.target as HTMLInputElement).value)"
            />
            <select
              class="bd-inp"
              :value="d.kind"
              :aria-label="t('bd.secDevices')"
              @change="changeLogicalKind(d, ($event.target as HTMLSelectElement).value)"
            >
              <option value="deck">{{ t('bd.deviceKindDeck') }}</option>
              <option value="phone">{{ t('bd.deviceKindPhone') }}</option>
              <option value="tablet">{{ t('bd.deviceKindTablet') }}</option>
            </select>
            <select
              v-if="d.kind === 'deck'"
              class="bd-inp"
              :value="d.model ?? ''"
              :aria-label="t('bd.deviceKindDeck')"
              @change="changeLogicalModel(d, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="m in DECK_MODELS" :key="m.id" :value="m.id">{{ m.label }} · {{ m.cols }}×{{ m.rows }}</option>
            </select>
            <span v-else class="bd-hint">{{ t('bd.deviceAnyView') }}</span>
            <button class="bd-ibtn" :aria-label="t('bd.delete')" :title="t('bd.delete')" @click="deleteLogicalDevice(d)">
              <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div style="margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap">
          <button class="bd-btn" data-cy="bd-device-add-deck" @click="addLogicalDevice('deck')">
            <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.deviceAddDeck') }}
          </button>
          <button class="bd-btn" data-cy="bd-device-add-phone" @click="addLogicalDevice('phone')">
            <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.deviceAddPhone') }}
          </button>
          <button class="bd-btn" data-cy="bd-device-add-tablet" @click="addLogicalDevice('tablet')">
            <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.deviceAddTablet') }}
          </button>
        </div>
      </template>

      <!-- Perfiles (cableado a datos reales) -->
      <template v-else-if="section === 'profiles'">
        <h2>{{ t('bd.secProfiles') }}</h2>
        <p class="bd-sub">{{ t('bd.profilesSub') }}</p>
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

      <!-- Apariencia (funcional) -->
      <template v-else-if="section === 'appearance'">
        <h2>{{ t('bd.secAppearance') }}</h2>
        <p class="bd-sub">{{ t('bd.appearanceSub') }}</p>
        <div class="bd-srow bd-col">
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
        <div class="bd-srow">
          <div><b>{{ t('bd.keySize') }}</b><p>{{ t('bd.keySizeHint') }}</p></div>
          <div class="bd-ctl">
            <div class="bd-rg">
              <input type="range" class="bd-inp" min="56" max="96" step="4" :value="bdKeySize" :aria-label="t('bd.keySize')" @input="bdSetKeySize(+($event.target as HTMLInputElement).value)" />
              <output>{{ bdKeySize }} px</output>
            </div>
          </div>
        </div>
        <div class="bd-srow">
          <div><b>{{ t('bd.rounding') }}</b><p>{{ t('bd.roundingHint') }}</p></div>
          <div class="bd-ctl">
            <div class="bd-rg">
              <input type="range" class="bd-inp" min="8" max="28" step="4" :value="bdRadius" :aria-label="t('bd.rounding')" @input="bdSetRadius(+($event.target as HTMLInputElement).value)" />
              <output>{{ bdRadius }} px</output>
            </div>
          </div>
        </div>
        <div class="bd-srow">
          <div><b>{{ t('bd.keyLabels') }}</b><p>{{ t('bd.keyLabelsHint') }}</p></div>
          <div class="bd-ctl">
            <div class="bd-seg">
              <button :aria-pressed="bdLabelMode === 'a'" @click="bdSetLabelMode('a')">{{ t('bd.labelsAlways') }}</button>
              <button :aria-pressed="bdLabelMode === 'h'" @click="bdSetLabelMode('h')">{{ t('bd.labelsHover') }}</button>
              <button :aria-pressed="bdLabelMode === 'n'" @click="bdSetLabelMode('n')">{{ t('bd.labelsNever') }}</button>
            </div>
          </div>
        </div>
        <div class="bd-srow">
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
        <div class="bd-srow">
          <div><b>{{ t('bd.showHideWindow') }}</b></div>
          <div class="bd-ctl">
            <span><kbd class="bd-kbd">Ctrl</kbd> <kbd class="bd-kbd">Alt</kbd> <kbd class="bd-kbd">P</kbd></span>
            <label class="bd-sw"><input type="checkbox" v-model="mock.k1" :aria-label="t('bd.showHideWindow')" /><span></span></label>
          </div>
        </div>
        <div class="bd-srow">
          <div><b>{{ t('bd.nextProfile') }}</b></div>
          <div class="bd-ctl">
            <span><kbd class="bd-kbd">Ctrl</kbd> <kbd class="bd-kbd">Alt</kbd> <kbd class="bd-kbd">→</kbd></span>
            <label class="bd-sw"><input type="checkbox" v-model="mock.k2" :aria-label="t('bd.nextProfile')" /><span></span></label>
          </div>
        </div>
        <div class="bd-srow">
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
        <div class="bd-srow">
          <div><b>{{ t('bd.localPort') }}</b><p>{{ t('bd.localPortHint') }}</p></div>
          <div class="bd-ctl"><input type="number" class="bd-inp" v-model.number="mock.port" min="1024" max="65535" :aria-label="t('bd.localPort')" /></div>
        </div>
        <div class="bd-srow">
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
        <div class="bd-srow">
          <div><b>{{ t('bd.devMode') }}</b><p>{{ t('bd.devModeHint') }}</p></div>
          <div class="bd-ctl"><label class="bd-sw"><input type="checkbox" v-model="mock.dev" :aria-label="t('bd.devMode')" /><span></span></label></div>
        </div>
        <div class="bd-srow">
          <div><b>{{ t('bd.resetSettings') }}</b><p>{{ t('bd.resetSettingsHint') }}</p></div>
          <div class="bd-ctl"><button class="bd-btn bd-dng" @click="resetAll">{{ t('bd.resetBtn') }}</button></div>
        </div>
      </template>

      <!-- Acerca de -->
      <template v-else>
        <h2>{{ t('bd.secAbout') }}</h2>
        <div class="bd-srow">
          <div><b>{{ t('bd.aboutTitle') }}</b><p>{{ t('bd.aboutText') }}</p></div>
          <div class="bd-ctl"><span class="bd-mono">{{ versionLine }}</span></div>
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
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import {
  SlidersHorizontal, Monitor, Users, Paintbrush, Puzzle, Network, Command, Wrench, Info, Plus, Palette, AppWindow, Variable, Trash2, Smartphone, MonitorSmartphone
} from 'lucide-vue-next'
import PluginsPane, { type PluginsTab } from './PluginsPane.vue'
import McpPane from './McpPane.vue'
import RemotePane from './RemotePane.vue'
import AutoProfileDialog from './AutoProfileDialog.vue'
import { useI18nStore } from '../../composables/useI18n'
import {
  bdPalette, bdLabelMode, bdKeySize, bdRadius, bdBrightness, bdAnimations,
  bdSetPalette, bdSetLabelMode, bdSetKeySize, bdSetRadius, bdSetBrightness, bdSetAnimations
} from '../../composables/useBunDeckUi'
import { useAutoProfile } from '../../composables/useAutoProfile'
import { getTunnelToken, tunnelApiBase, tunnelConfigUrl } from '../../composables/useTunnel'
import { vars, addVar, coerceVal, persistVars, setVarValue } from '../../composables/useVars'
import {
  useDevices, DECK_MODELS, DEFAULT_DECK_MODEL, type LogicalDevice,
} from '../../composables/useDevices'
import { IDRE, RES } from '../../composables/useExpressions'
import type { ProfileData } from '../../types/streamdeck'

const { t } = useI18nStore()

type Section = 'general' | 'device' | 'devices' | 'profiles' | 'appearance' | 'vars' | 'plugins' | 'mcp' | 'remote' | 'shortcuts' | 'advanced' | 'about'

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
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const dialog = ref<HTMLDialogElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
const section = ref<Section>('general')
const pluginsPane = ref<InstanceType<typeof PluginsPane> | null>(null)

const navItems = computed(() => [
  { id: 'general' as const, label: t('bd.secGeneral'), icon: SlidersHorizontal },
  { id: 'device' as const, label: t('bd.secDevice'), icon: Monitor },
  { id: 'devices' as const, label: t('bd.secDevices'), icon: MonitorSmartphone },
  { id: 'profiles' as const, label: t('bd.secProfiles'), icon: Users },
  { id: 'appearance' as const, label: t('bd.secAppearance'), icon: Paintbrush },
  { id: 'vars' as const, label: t('bd.secVars'), icon: Variable },
  { id: 'plugins' as const, label: t('bd.secPlugins'), icon: Puzzle },
  { id: 'mcp' as const, label: t('bd.secMcp'), icon: Network },
  { id: 'remote' as const, label: t('bd.secRemote'), icon: Smartphone },
  { id: 'shortcuts' as const, label: t('bd.secShortcuts'), icon: Command },
  { id: 'advanced' as const, label: t('bd.secAdvanced'), icon: Wrench },
  { id: 'about' as const, label: t('bd.secAbout'), icon: Info }
])

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
  dim: '5 min', idle: '', orientation: '0°', longpress: 500, haptic: true, sound: false,
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
  autoDialog.value?.show(focusProfileId)
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

// ---- Dispositivos lógicos (pantallas por perfil) ----
const devStore = useDevices(() => apiBase())
const hwHint = computed(() => {
  const hw = devStore.hwStatus.value
  if (hw.connected && hw.grid) {
    const model = DECK_MODELS.find((m) => m.id === hw.modelGuess)
    return t('bd.deviceHwDetected', {
      model: model?.label ?? 'Stream Deck',
      size: `${hw.grid.cols}×${hw.grid.rows}`,
    })
  }
  return t('bd.deviceHwUnknown')
})
const loadLogicalDevices = async () => {
  try {
    await devStore.loadDevices()
    await devStore.loadHwStatus()
  } catch { /* sin daemon */ }
}
const addLogicalDevice = async (kind: 'deck' | 'phone' | 'tablet') => {
  try {
    const n = devStore.devices.value.filter((d) => d.kind === kind).length + 1
    const base = kind === 'deck' ? t('bd.deviceKindDeck') : kind === 'phone' ? t('bd.deviceKindPhone') : t('bd.deviceKindTablet')
    const preset = DECK_MODELS.find((m) => m.id === DEFAULT_DECK_MODEL)!
    const created = await devStore.createDevice({
      name: `${base} ${n}`,
      kind,
      ...(kind === 'deck' ? { model: preset.id, cols: preset.cols, rows: preset.rows } : {}),
    })
    emit('notify', t('bd.deviceAdded', { name: created.name }))
  } catch (e) {
    emit('notify', String((e as Error)?.message ?? e))
  }
}
const renameLogicalDevice = async (d: LogicalDevice, name: string) => {
  const clean = name.trim().slice(0, 80)
  if (!clean || clean === d.name) return
  try {
    await devStore.updateDevice(d.id, { name: clean })
  } catch (e) {
    emit('notify', String((e as Error)?.message ?? e))
    await loadLogicalDevices()
  }
}
const changeLogicalKind = async (d: LogicalDevice, kind: string) => {
  if (kind === d.kind) return
  try {
    if (kind === 'deck') {
      const preset = DECK_MODELS.find((m) => m.id === (d.model ?? DEFAULT_DECK_MODEL)) ?? DECK_MODELS.find((m) => m.id === DEFAULT_DECK_MODEL)!
      await devStore.updateDevice(d.id, { kind: 'deck', model: preset.id, cols: preset.cols, rows: preset.rows })
    } else {
      await devStore.updateDevice(d.id, { kind: kind as 'phone' | 'tablet', model: null, cols: null, rows: null })
    }
  } catch (e) {
    emit('notify', String((e as Error)?.message ?? e))
  }
}
const changeLogicalModel = async (d: LogicalDevice, model: string) => {
  const preset = DECK_MODELS.find((m) => m.id === model)
  if (!preset || preset.id === d.model) return
  try {
    await devStore.updateDevice(d.id, { model: preset.id, cols: preset.cols, rows: preset.rows })
  } catch (e) {
    emit('notify', String((e as Error)?.message ?? e))
  }
}
const deleteLogicalDevice = async (d: LogicalDevice) => {
  try {
    const { snapshot } = await devStore.deleteDevice(d.id)
    emit('notify', t('bd.deviceDeleted', { name: d.name }), async () => {
      try {
        await devStore.restoreDevice(snapshot)
      } catch (e) {
        emit('notify', String((e as Error)?.message ?? e))
      }
    })
  } catch (e) {
    emit('notify', String((e as Error)?.message ?? e))
  }
}

const resetAll = () => {
  bdSetPalette('auto')
  bdSetLabelMode('a')
  bdSetKeySize(76)
  bdSetRadius(16)
  bdSetBrightness(80)
  bdSetAnimations(true)
  emit('notify', t('bd.settingsReset'))
}

const show = (at?: Section, pluginTab?: PluginsTab) => {
  section.value = at ?? 'general'
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
    loadLogicalDevices()
  })
  loadVersion()
}
const close = () => dialog.value?.close()

defineExpose({ show, close })
</script>
