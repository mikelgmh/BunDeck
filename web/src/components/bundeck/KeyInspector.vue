<template>
  <template v-if="mode === 'use'">
    <div class="bd-ibody">
      <div class="bd-emp">
        <h2>{{ t('bd.useModeTitle') }}</h2>
        <p>{{ t('bd.useModeHint') }}</p>
        <p class="bd-hint">{{ t('bd.useModeExportHint') }}</p>
      </div>
    </div>
  </template>
  <template v-else-if="selectedPosition === null || selectedPosition === undefined">
    <div class="bd-ibody">
      <div class="bd-emp">
        <h2>{{ t('bd.chooseKey') }}</h2>
        <p>{{ t('bd.chooseKeyHint') }}</p>
      </div>
      <div class="bd-chips" style="justify-content: center">
        <button class="bd-btn" @click="emit('import-key')">
          <FileDown :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.importKey') }}
        </button>
      </div>
    </div>
  </template>
  <template v-else>
    <div class="bd-ih">
      <button
        class="bd-pv bd-pvbtn"
        :style="{ '--bd-g': preview.color, background: preview.bg || undefined }"
        :aria-label="t('bd.changeImage')"
        :title="t('bd.changeImage')"
        data-cy="bd-key-preview"
        @click="emit('open-icon-picker')"
      >
        <img v-if="previewImage" :src="previewImage" class="bd-pvimg" alt="" aria-hidden="true" />
        <component v-else-if="previewIcon" :is="previewIcon" :size="26" stroke-width="1.75" aria-hidden="true" />
        <span class="bd-pvov" aria-hidden="true"><ImagePlus :size="20" stroke-width="1.75" /></span>
      </button>
      <div class="bd-it">
        <p class="bd-mono bd-cap">F{{ row + 1 }} Â· C{{ col + 1 }}</p>
        <label class="bd-sr" for="bd-ft">{{ t('bd.keyTitle') }}</label>
        <input
          type="text"
          id="bd-ft"
          class="bd-tin"
          data-cy="bd-key-title"
          :value="buttonConfig.label ?? ''"
          maxlength="40"
          :placeholder="t('bd.keyTitle')"
          @input="emit('update-field', 'label', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <div style="position: relative">
        <button
          ref="menuBtn"
          class="bd-ibtn"
          :aria-label="t('bd.keyOptions')"
          :title="t('bd.keyOptions')"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
          @keydown="onMenuBtnKey"
        >
          <Ellipsis :size="20" stroke-width="1.75" aria-hidden="true" />
        </button>
        <div v-if="menuOpen" class="bd-menu" role="menu" style="right: 0; left: auto" @keydown="onMenuKey">
          <button role="menuitem" @click="onMenuAction('test')">
            <Play :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.pressKey') }}</span>
          </button>
          <button v-if="hasButton" role="menuitem" data-cy="bd-key-menu-logs" @click="onMenuAction('logs')">
            <ScrollText :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.viewLogs') }}</span>
          </button>
          <button role="menuitem" :disabled="!hasButton" @click="onMenuAction('export')">
            <FileUp :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.exportKey') }}</span>
          </button>
          <button role="menuitem" @click="onMenuAction('import')">
            <FileDown :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.importKey') }}</span>
          </button>
          <button v-if="hasButton" role="menuitem" class="bd-dng" @click="onMenuAction('clear')">
            <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.clear') }}</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="hasButton" class="bd-itabs" role="tablist">
      <button
        role="tab"
        data-cy="bd-tab-actions"
        :aria-selected="tab === 'actions'"
        @click="tab = 'actions'"
      >
        {{ t('bd.tabActions') }} <span class="bd-cnt">{{ buttonConfig.actions?.length ?? 0 }}</span>
      </button>
      <button
        role="tab"
        data-cy="bd-tab-rules"
        :aria-selected="tab === 'rules'"
        @click="tab = 'rules'"
      >
        {{ t('bd.tabRules') }} <span class="bd-cnt">{{ ruleList.length }}</span>
      </button>
      <button
        role="tab"
        data-cy="bd-tab-appearance"
        :aria-selected="tab === 'appearance'"
        @click="tab = 'appearance'"
      >
        {{ t('bd.tabAppearance') }}
      </button>
      <button
        role="tab"
        data-cy="bd-tab-behavior"
        :aria-selected="tab === 'behavior'"
        @click="tab = 'behavior'"
      >
        {{ t('bd.tabBehavior') }}
      </button>
    </div>

    <div class="bd-ibody">
      <template v-if="!hasButton">
        <div class="bd-emp">
          <h2>{{ t('bd.emptyKey') }}</h2>
          <p>{{ t('bd.emptyKeyHint') }}</p>
        </div>
        <div class="bd-chips" style="justify-content: center">
          <button class="bd-btn" @click="emit('open-palette', 'acts')">
            <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.addAction') }}
          </button>
          <button class="bd-btn" @click="emit('import-key')">
            <FileDown :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.importKey') }}
          </button>
        </div>
      </template>

      <!-- ACCIONES -->
      <template v-else-if="tab === 'actions'">
        <h1 class="bd-ttl" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)">{{ t('bd.inspectorTitle') }}</h1>
        <!-- Subtabs por tipo de pulsación: cada tipo tiene su propia lista.
             `click` equivale al `actions[]` legacy (espejo en lectura y
             escritura). Las reglas `when: double/triple` conviven: se
             ejecutan DESPUÉS de la lista del mismo tipo. -->
        <div class="bd-seg" role="tablist" :aria-label="t('bd.pressKind')" style="margin-bottom: 12px; width: 100%">
          <button
            v-for="k in pressKinds"
            :key="k"
            role="tab"
            :data-cy="`bd-press-kind-${k}`"
            :aria-selected="pressTab === k"
            :aria-pressed="pressTab === k"
            @click="pressTab = k"
          >
            {{ t(pressKindLabel[k]) }} <span class="bd-cnt">{{ pressCount(k) }}</span>
          </button>
        </div>
        <p class="bd-hint" style="margin: 0 0 12px">{{ t('bd.pressKindHint') }}</p>
        <div
          @dragover.prevent="dragOver = true"
          @dragleave="dragOver = false"
          @drop.prevent="onDrop"
          :style="dragOver ? 'outline: 2px dashed var(--bd-ac); outline-offset: 4px; border-radius: 12px;' : undefined"
        >
          <ol v-if="pressList?.length" ref="actionsList" class="bd-al" :key="`bd-al-${pressTab}`">
            <li
              v-for="(action, i) in pressList"
              :key="action.id ?? i"
              class="bd-ac"
              data-cy="bd-action-row"
              :data-swapy-slot="`slot-${action.id ?? i}`"
              @contextmenu.prevent="onActionCtx($event, pressTab, i, action?.type)"
            >
              <div :data-swapy-item="`item-${action.id ?? i}`">
                <ActionCard
                  :action="action"
                  :index="i"
                  :show-wait="execMode === 'seq'"
                  :plugins="plugins"
                  :available-pages="availablePages"
                  @update-action="(idx, patch) => updPressAction(idx, patch)"
                  @update-param="(idx, k, v) => updPressParam(idx, k, v)"
                  @remove="(idx) => rmPressAction(idx)"
                  @open-plugin-settings="(pluginId) => emit('open-plugin-settings', pluginId)"
                >
                  <template #handle>
                    <button
                      data-swapy-handle
                      class="bd-grip"
                      :data-gi="i"
                      :aria-label="`${t('bd.dragToReorder')} ${i + 1}`"
                      :title="t('bd.dragToReorder')"
                      @keydown="onGripKey($event, i)"
                    >
                      <GripVertical :size="16" stroke-width="1.75" aria-hidden="true" />
                    </button>
                    <span class="bd-n">{{ i + 1 }}</span>
                  </template>
                  <template #extra-buttons>
                    <button
                      :disabled="i === 0"
                      aria-label="Subir"
                      title="Subir"
                      @click="movePressAction(i, -1)"
                    >
                      <ChevronUp :size="16" stroke-width="1.75" aria-hidden="true" />
                    </button>
                    <button
                      :disabled="i === (pressList?.length ?? 0) - 1"
                      aria-label="Bajar"
                      title="Bajar"
                      @click="movePressAction(i, 1)"
                    >
                      <ChevronDown :size="16" stroke-width="1.75" aria-hidden="true" />
                    </button>
                  </template>
                </ActionCard>
              </div>
            </li>
          </ol>
          <p v-else class="bd-hint">{{ t('bd.noActions') }}</p>
        </div>

        <button class="bd-btn bd-wide" data-cy="bd-add-action" @click="emit('open-palette', `press:${pressTab}`)">
          <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.addAction') }}<kbd class="bd-kbd">Ctrl K</kbd>
        </button>
        <p class="bd-hint" style="margin-top: 12px">{{ t('bd.rulesHintShort') }}</p>
      </template>

      <!-- REGLAS -->
      <template v-else-if="tab === 'rules'">
        <p class="bd-hint" style="margin: 0 0 16px">{{ t('bd.rulesHint') }}</p>
        <div v-for="(r, ri) in ruleList" :key="r.id ?? ri" class="bd-rl">
          <div class="bd-ah">
            <label class="bd-sw">
              <input
                type="checkbox"
                :checked="r.on !== false"
                :aria-label="`${t('bd.rule')} ${ri + 1}`"
                @change="setRule(ri, { on: ($event.target as HTMLInputElement).checked })"
              />
              <span></span>
            </label>
            <b>{{ t('bd.rule') }} {{ ri + 1 }}</b>
            <button :aria-label="t('bd.delete')" :title="t('bd.delete')" @click="delRule(ri)">
              <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
          <div class="bd-rg3">
            <label class="bd-lb" :for="`bd-rw-${ri}`" style="margin: 0">{{ t('bd.ruleWhen') }}</label>
            <select :id="`bd-rw-${ri}`" class="bd-inp" :value="r.when ?? 'press'" @change="setRule(ri, { when: ($event.target as HTMLSelectElement).value })">
              <option value="press">{{ t('bd.whenPress') }}</option>
              <option value="double">{{ t('bd.whenDouble') }}</option>
              <option value="triple">{{ t('bd.whenTriple') }}</option>
              <option value="long">{{ t('bd.whenLong') }}</option>
              <option value="load">{{ t('bd.whenLoad') }}</option>
              <option value="timer">{{ t('bd.whenTimer') }}</option>
              <option value="var">{{ t('bd.whenVar') }}</option>
            </select>
            <label v-if="(r.when ?? 'press') === 'timer'" class="bd-dl2" style="margin: 0">
              {{ t('bd.everySec') }}
              <input
                type="number"
                class="bd-inp"
                :value="r.every ?? 5"
                min="1"
                max="3600"
                :aria-label="t('bd.seconds')"
                @input="setRule(ri, { every: Math.max(1, +($event.target as HTMLInputElement).value || 1) })"
              />
            </label>
            <select
              v-if="(r.when ?? 'press') === 'var'"
              class="bd-inp"
              :value="r.vn ?? ''"
              :aria-label="t('bd.varName')"
              @change="setRule(ri, { vn: ($event.target as HTMLSelectElement).value })"
            >
              <option value="">{{ t('bd.varChoose') }}</option>
              <option v-for="v in varList" :key="v.n" :value="v.n">{{ v.n }}</option>
            </select>
          </div>
          <div class="bd-fld">
            <label class="bd-lb" :for="`bd-rc-${ri}`">{{ t('bd.ruleIf') }}</label>
            <input
              :id="`bd-rc-${ri}`"
              type="text"
              class="bd-inp bd-mono"
              :value="r.cond ?? ''"
              :placeholder="t('bd.ruleCondPh')"
              spellcheck="false"
              autocomplete="off"
              @input="setRule(ri, { cond: ($event.target as HTMLInputElement).value })"
            />
            <p class="bd-cb"><span v-html="condBadge(r.cond ?? '')"></span></p>
          </div>
          <p class="bd-sh2">{{ t('bd.ruleThen') }}</p>
          <div class="bd-al">
            <div v-for="(o, i) in asList(r.then)" :key="o.id ?? i" class="bd-ac" @contextmenu.prevent="onActionCtx($event, `r${ri}.then`, i, o?.type)">
              <ActionCard
                :action="o"
                :index="i"
                :show-wait="true"
                :plugins="plugins"
                :available-pages="availablePages"
                @update-action="(idx, patch) => updRuleAction(ri, 'then', idx, patch)"
                @update-param="(idx, k, v) => updRuleParam(ri, 'then', idx, k, v)"
                @remove="(idx) => delRuleAction(ri, 'then', idx)"
                @open-plugin-settings="(pluginId) => emit('open-plugin-settings', pluginId)"
              />
            </div>
          </div>
          <button class="bd-btn bd-wide" @click="emit('open-palette', `r${ri}.then`)">
            <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.addAction') }}
          </button>
          <p class="bd-sh2">{{ t('bd.ruleElse') }}</p>
          <div class="bd-al">
            <div v-for="(o, i) in asList(r.else)" :key="o.id ?? i" class="bd-ac" @contextmenu.prevent="onActionCtx($event, `r${ri}.else`, i, o?.type)">
              <ActionCard
                :action="o"
                :index="i"
                :show-wait="true"
                :plugins="plugins"
                :available-pages="availablePages"
                @update-action="(idx, patch) => updRuleAction(ri, 'else', idx, patch)"
                @update-param="(idx, k, v) => updRuleParam(ri, 'else', idx, k, v)"
                @remove="(idx) => delRuleAction(ri, 'else', idx)"
                @open-plugin-settings="(pluginId) => emit('open-plugin-settings', pluginId)"
              />
            </div>
          </div>
          <button class="bd-btn bd-wide" @click="emit('open-palette', `r${ri}.else`)">
            <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.addAction') }}
          </button>
        </div>
        <button class="bd-btn bd-wide" data-cy="bd-add-rule" @click="addRule">
          <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.newRule') }}
        </button>
        <details class="bd-hp">
          <summary>{{ t('bd.helpTitle') }}</summary>
          <p>{{ t('bd.helpOps') }}</p>
          <p>{{ t('bd.helpFns') }}</p>
          <p>{{ t('bd.helpBuiltins') }}</p>
        </details>
      </template>

      <!-- ASPECTO -->
      <template v-else-if="tab === 'appearance'">
        <div class="bd-row2">
          <span>{{ t('bd.showTitle') }}</span>
          <label class="bd-sw">
            <input
              type="checkbox"
              :aria-label="t('bd.showTitle')"
              :checked="buttonConfig.showTitle !== false"
              @change="emit('update-field', 'showTitle', ($event.target as HTMLInputElement).checked)"
            />
            <span></span>
          </label>
        </div>

        <div class="bd-fld" style="margin-top: 12px">
          <label class="bd-lb" for="bd-fbadge">{{ t('bd.keyBadge') }}</label>
          <input
            type="text"
            id="bd-fbadge"
            class="bd-inp"
            data-cy="bd-key-badge"
            :value="buttonConfig.badge ?? ''"
            maxlength="12"
            :placeholder="t('bd.keyBadgeHint')"
            spellcheck="false"
            autocomplete="off"
            @input="emit('update-field', 'badge', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <div class="bd-fld" style="margin-top: 12px">
          <span class="bd-lb">{{ t('bd.icon') }}</span>
          <button class="bd-icb" @click="emit('open-icon-picker')">
            <img v-if="previewImage" :src="previewImage" class="bd-ics" alt="" aria-hidden="true" />
            <component v-else-if="iconComponent" :is="iconComponent" :size="24" stroke-width="1.75" aria-hidden="true" />
            <span>{{ iconKebab }}</span>
            <i class="bd-sp"></i>
            {{ t('bd.change') }}
          </button>
          <button v-if="hasKeyImage" class="bd-btn bd-wide" style="margin-top: 8px" @click="emit('clear-image')">
            <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.removeImage') }}
          </button>
        </div>

        <div class="bd-fld">
          <span class="bd-lb">{{ t('bd.iconColor') }}</span>
          <div class="bd-cols">
            <button
              v-for="(hex, j) in SWATCHES"
              :key="hex"
              class="bd-cs"
              :style="{ '--bd-s': hex }"
              :aria-pressed="activeSwatch === j"
              :aria-label="`Color ${j + 1}`"
              @click="emit('update-field', 'textColor', hex)"
            ></button>
            <input
              type="color"
              class="bd-cs"
              style="padding: 0; border: 1px solid var(--bd-ln)"
              :value="toColorInput(buttonConfig.textColor)"
              :aria-label="t('bd.iconCustom')"
              :title="t('bd.iconCustom')"
              data-cy="bd-icon-custom-color"
              @input="emit('update-field', 'textColor', ($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>

        <div class="bd-fld">
          <span class="bd-lb">{{ t('bd.keyBackground') }}</span>
          <div class="bd-cols">
            <button
              type="button"
              class="bd-cs bd-bg-default"
              :aria-pressed="!buttonConfig.backgroundColor"
              :aria-label="t('bd.keyBackgroundDefault')"
              :title="t('bd.keyBackgroundDefault')"
              data-cy="bd-bg-default"
              @click="emit('update-field', 'backgroundColor', '')"
            ></button>
            <button
              v-for="(hex, j) in BG_SWATCHES"
              :key="hex"
              class="bd-cs"
              :style="{ '--bd-s': hex }"
              :aria-pressed="activeBg === j"
              :aria-label="`${t('bd.background')} ${j + 1}`"
              @click="emit('update-field', 'backgroundColor', hex)"
            ></button>
            <input
              type="color"
              class="bd-cs"
              style="padding: 0; border: 1px solid var(--bd-ln)"
              :value="toColorInput(buttonConfig.backgroundColor, '#374151')"
              :aria-label="t('bd.background')"
              @input="emit('update-field', 'backgroundColor', ($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>

        <h3 class="bd-sh">
          <span>{{ t('bd.availVarsTitle') }}</span>
          <span class="bd-var-legend">
            <span><i class="bd-dot" style="background: #6fcf97"></i>{{ t('bd.availVarKey') }}</span>
            <span><i class="bd-dot" style="background: #82b4ea"></i>{{ t('bd.availVarGlobal') }}</span>
          </span>
        </h3>
        <p class="bd-hint" style="margin: 0 0 8px">{{ t('bd.availVarsHint') }}</p>
        <div v-if="availableVars.length" class="bd-vars-grid" data-cy="bd-available-vars">
          <div
            v-for="v in availableVars"
            :key="v.name"
            class="bd-var-chip"
            :data-scope="v.origin"
            :title="v.origin === 'action' ? `${v.fromAction ?? ''} — ${t('bd.availVarAutoHint')}` : t('bd.availVarEditHint')"
          >
            <span class="bd-dot" :style="{ background: v.origin === 'action' ? '#6fcf97' : '#82b4ea' }"></span>
            <span class="bd-var-name" @click="copyVar(v.name)" :title="t('bd.availVarCopyHint')">{{ copiedVar === v.name ? t('bd.availVarCopied') : v.name }}</span>
            <span v-if="v.origin === 'action'" class="bd-sr">{{ v.fromAction }}</span>
            <template v-if="v.origin === 'action'">
              <span class="bd-var-ro" :title="t('bd.availVarAutoHint')">{{ v.live || t('bd.availVarUnknownShort') }}</span>
            </template>
            <template v-else-if="globalVarType(v.name) === 'bool'">
              <button
                type="button"
                class="bd-var-val-bool"
                :data-val="String(globalVarVal(v.name))"
                :title="t('bd.availVarEditHint')"
                @click="toggleGlobalVar(v.name)"
              >{{ fmtBoolShort(globalVarVal(v.name)) }}</button>
            </template>
            <template v-else-if="globalVarType(v.name) === 'num'">
              <input
                type="number"
                class="bd-var-val-inp"
                :value="globalVarVal(v.name)"
                :aria-label="v.name"
                @input="setGlobalVar(v.name, ($event.target as HTMLInputElement).value)"
              />
            </template>
            <template v-else>
              <input
                type="text"
                class="bd-var-val-inp bd-var-val-txt"
                :value="globalVarVal(v.name)"
                :aria-label="v.name"
                spellcheck="false"
                autocomplete="off"
                @input="setGlobalVar(v.name, ($event.target as HTMLInputElement).value)"
              />
            </template>
            <button
              class="bd-use-mini"
              :data-cy="`bd-avail-use-${v.name}`"
              :title="t('bd.availVarUse')"
              :aria-label="t('bd.availVarUse')"
              @click="useCondFromVar(v)"
            >+</button>
          </div>
        </div>
        <p v-else class="bd-hint" data-cy="bd-available-vars-empty">{{ t('bd.availVarsEmpty') }}</p>

        <h3 class="bd-sh">
          <span>{{ t('bd.looksTitle') }}</span>
          <span class="bd-var-legend">{{ t('bd.looksPrio') }}</span>
        </h3>
        <p class="bd-hint" style="margin: 0 0 10px">{{ t('bd.looksHint') }}</p>
        <div v-if="varPresets.length" class="bd-presets" data-cy="bd-presets">
          <p class="bd-hint" style="margin: 0">{{ t('bd.presetHint') }}</p>
          <div v-for="g in varPresets" :key="g.varName" class="bd-preset-row">
            <span class="bd-mono bd-preset-var" :title="g.fromAction">{{ g.varName }}</span>
            <button
              class="bd-btn bd-preset-btn"
              :data-cy="`bd-preset-${g.varName}-on`"
              :title="g.on.cond"
              @click="addPreset(g.on, false)"
            >{{ t(g.on.titleKey) }}</button>
            <button
              class="bd-btn bd-preset-btn"
              :data-cy="`bd-preset-${g.varName}-off`"
              :title="g.off.cond"
              @click="addPreset(g.off, true)"
            >{{ t(g.off.titleKey) }}</button>
          </div>
        </div>
        <div v-for="(l, li) in lookList" :key="li" class="bd-rl" :class="{ 'is-matched': firstMatchedLook === li }">
          <div class="bd-ah">
            <b>{{ t('bd.lookCond') }} {{ li + 1 }}</b>
            <span class="bd-status-pill" :class="{ active: firstMatchedLook === li }">{{ lookStatusText(li) }}</span>
            <button :aria-label="t('bd.delete')" :title="t('bd.delete')" @click="delLook(li)">
              <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
          <div class="bd-cond-builder">
            <div class="bd-clause-row">
              <select
                class="bd-sel bd-sel-var"
                :value="condParts(li).name"
                :aria-label="t('bd.varName')"
                @change="setCondPart(li, { name: ($event.target as HTMLSelectElement).value })"
              >
                <optgroup v-if="keyVarsList.length" :label="t('bd.availVarKey')">
                  <option v-for="v in keyVarsList" :key="v.name" :value="v.name">{{ v.name }}</option>
                </optgroup>
                <optgroup v-if="globalVarsList.length" :label="t('bd.availVarGlobal')">
                  <option v-for="v in globalVarsList" :key="v.name" :value="v.name">{{ v.name }}</option>
                </optgroup>
              </select>
              <select
                class="bd-sel bd-sel-op"
                :value="condParts(li).op"
                aria-label="="
                @change="setCondPart(li, { op: ($event.target as HTMLSelectElement).value })"
              >
                <option v-for="o in condOpsFor(condParts(li).name)" :key="o.v" :value="o.v">{{ o.label }}</option>
              </select>
              <select
                v-if="condVarType(condParts(li).name) === 'bool'"
                class="bd-clause-val"
                :value="condParts(li).val"
                @change="setCondPart(li, { val: ($event.target as HTMLSelectElement).value })"
              >
                <option value="true">{{ t('bd.varTrue') }}</option>
                <option value="false">{{ t('bd.varFalse') }}</option>
              </select>
              <input
                v-else
                class="bd-clause-val"
                :type="condVarType(condParts(li).name) === 'num' ? 'number' : 'text'"
                :value="condParts(li).val"
                :placeholder="t('bd.condValPh')"
                spellcheck="false"
                autocomplete="off"
                @input="setCondPart(li, { val: ($event.target as HTMLInputElement).value })"
              />
            </div>
            <p class="bd-cb">{{ condReadable(li) }}</p>
          </div>
          <div class="bd-fld">
            <label class="bd-sr" :for="`bd-lc-${li}`">{{ t('bd.ruleIf') }}</label>
            <input
              :id="`bd-lc-${li}`"
              type="text"
              class="bd-inp bd-mono"
              :value="l.cond ?? ''"
              :placeholder="t('bd.ruleCondPh')"
              spellcheck="false"
              autocomplete="off"
              @input="setLook(li, { cond: ($event.target as HTMLInputElement).value })"
            />
            <p class="bd-cb"><span v-html="condBadge(l.cond ?? '')"></span></p>
          </div>
          <div class="bd-rg3">
            <input
              type="text"
              class="bd-inp"
              :value="l.t ?? ''"
              :placeholder="t('bd.lookTitlePh')"
              :aria-label="t('bd.keyTitle')"
              style="flex: 1; min-width: 120px"
              @input="setLook(li, { t: ($event.target as HTMLInputElement).value })"
            />
            <button class="bd-btn" @click="emit('open-look-icon', li)">
              <component :is="lookIcon(li)" :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.icon') }}â€¦
            </button>
          </div>
          <div class="bd-cols" style="margin-bottom: 12px" role="group" :aria-label="t('bd.iconColor')">
            <button
              v-for="(hex, j) in SWATCHES"
              :key="hex"
              class="bd-cs"
              :style="{ '--bd-s': hex }"
              :aria-pressed="l.c === j"
              :aria-label="`Color ${j + 1}`"
              @click="setLook(li, { c: l.c === j ? null : j })"
            ></button>
            <input
              type="color"
              class="bd-cs"
              style="padding: 0; border: 1px solid var(--bd-ln)"
              :value="lookCustomColor(li)"
              :aria-pressed="isLookCustomColor(li)"
              :aria-label="t('bd.iconCustom')"
              :title="t('bd.iconCustom')"
              :data-cy="`bd-look-custom-color-${li}`"
              @input="setLook(li, { c: ($event.target as HTMLInputElement).value })"
            />
          </div>
          <div class="bd-cols" role="group" :aria-label="t('bd.keyBackground')">
            <button
              v-for="(hex, j) in LOOK_BGS"
              :key="String(hex)"
              class="bd-cs"
              :style="{ '--bd-s': hex ?? '#2d3036' }"
              :aria-pressed="(l.bg ?? 0) === j"
              :aria-label="`${t('bd.background')} ${j + 1}`"
              @click="setLook(li, { bg: j })"
            ></button>
            <input
              type="color"
              class="bd-cs"
              style="padding: 0; border: 1px solid var(--bd-ln)"
              :value="lookCustomBg(li)"
              :aria-pressed="isLookCustomBg(li)"
              :aria-label="t('bd.background')"
              :title="t('bd.background')"
              :data-cy="`bd-look-custom-bg-${li}`"
              @input="setLook(li, { bg: ($event.target as HTMLInputElement).value })"
            />
          </div>
        </div>
        <button class="bd-btn bd-wide" data-cy="bd-add-look" @click="addLook">
          <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.addLook') }}
        </button>
      </template>

      <!-- COMPORTAMIENTO -->
      <template v-else>
        <template v-if="(buttonConfig.actions?.length ?? 0) > 1">
          <h3 class="bd-sh" style="margin-top: 0">{{ t('bd.execution') }}</h3>
          <div class="bd-fld">
            <label class="bd-lb" for="bd-fm">{{ t('bd.onPress') }}</label>
            <select
              id="bd-fm"
              class="bd-inp"
              :value="execMode"
              @change="emit('update-field', 'mode', ($event.target as HTMLSelectElement).value)"
            >
              <option value="seq">{{ t('bd.execSeq') }}</option>
              <option value="par">{{ t('bd.execPar') }}</option>
              <option value="alt">{{ t('bd.execAlt') }}</option>
            </select>
          </div>
        </template>

        <div class="bd-fld">
          <label class="bd-lb" for="bd-flp">{{ t('bd.longPress') }}</label>
          <select
            id="bd-flp"
            class="bd-inp"
            :value="buttonConfig.longPress ?? 'none'"
            @change="emit('update-field', 'longPress', ($event.target as HTMLSelectElement).value)"
          >
            <option value="none">{{ t('bd.lpNone') }}</option>
            <option value="folder">{{ t('bd.lpFolder') }}</option>
            <option value="repeat">{{ t('bd.lpRepeat') }}</option>
            <option value="mute">{{ t('bd.lpMute') }}</option>
          </select>
        </div>

        <div class="bd-row2">
          <span>{{ t('bd.confirmExec') }}</span>
          <label class="bd-sw">
            <input
              type="checkbox"
              :aria-label="t('bd.confirmExec')"
              :checked="!!buttonConfig.confirm"
              @change="emit('update-field', 'confirm', ($event.target as HTMLInputElement).checked)"
            />
            <span></span>
          </label>
        </div>

        <h3 class="bd-sh">{{ t('bd.dangerZone') }}</h3>
        <button class="bd-btn bd-dng" @click="emit('clear')">
          <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.clear') }}
        </button>
      </template>
    </div>

    <div class="bd-ifoot">
      <button class="bd-btn bd-pri" data-cy="bd-test-key" :disabled="!hasButton" @click="emit('test')">{{ t('bd.pressKey') }}</button>
      <button class="bd-btn" :disabled="!hasButton" @click="emit('export-key')">
        <FileUp :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.exportKey') }}
      </button>
      <button class="bd-btn" @click="emit('import-key')">
        <FileDown :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.importKey') }}
      </button>
    </div>

    <ContextMenu
      :show="actionMenu.show"
      :x="actionMenu.x"
      :y="actionMenu.y"
      :items="actionMenuItems"
      @item-click="onActionMenuItem"
      @close="actionMenu.show = false"
    />
  </template>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { ChevronUp, ChevronDown, Plus, GripVertical, Ellipsis, Play, FileUp, FileDown, Trash2, ImagePlus, Zap, ScrollText } from 'lucide-vue-next'
import type { Swapy } from 'swapy'
import { dynamicIcon } from '../../composables/useDynamicIcon'
import ActionCard from './ActionCard.vue'
import ContextMenu from '../ContextMenu.vue'
import { useI18nStore } from '../../composables/useI18n'
import {
  normalizePressActions,
  setActionsForKind,
  type PressKind,
} from '../../composables/usePressActions'
import { ev, fmt, intp, usedVarNames } from '../../composables/useExpressions'
import { vars, getVar, getEnv, setVarValue, displayTick, pushVarToDaemon } from '../../composables/useVars'
import { availableVarsOf, presetsFor, resolvePresetLook, type VarStatePreset } from '../../composables/useExposedVariables'
import { assetUrl, isAssetRef } from '../../composables/useKeyShare'

const { t } = useI18nStore()

const SWATCHES = ['#e8e9eb', '#e8b04e', '#86cba5', '#82b4ea', '#ec8e7f', '#c7a6e0']
const BG_SWATCHES = ['#374151', '#5a2b2b', '#2b5a3a', '#2b3f5a', '#5a4a24', '#4b315e']
const LOOK_BGS: Array<string | null> = [null, '#5a2b2b', '#2b5a3a', '#2b3f5a', '#5a4a24', '#4b315e']

interface Props {
  mode: 'edit' | 'use'
  selectedPosition: number | null
  hasButton: boolean
  row: number
  col: number
  buttonConfig: any
  plugins: any[]
  availablePages: Array<{ id: string; name: string }>
  profileName?: string
  pageName?: string
  /** Base de la API (puerto 3001): los assets `/assets/…` cuelgan de ahí. */
  apiBase?: string
}

interface Emits {
  (e: 'update-field', key: string, value: any): void
  (e: 'update-action', index: number, patch: Record<string, any>): void
  (e: 'update-action-param', index: number, paramKey: string, value: any): void
  (e: 'move-action', index: number, dir: -1 | 1): void
  (e: 'remove-action', index: number): void
  (e: 'reorder-actions', newOrderedActions: any[]): void
  (e: 'focus-library'): void
  (e: 'open-palette', path: string): void
  (e: 'test'): void
  (e: 'clear'): void
  (e: 'export-key'): void
  (e: 'import-key'): void
  (e: 'open-icon-picker'): void
  (e: 'open-look-icon', index: number): void
  (e: 'clear-image'): void
  (e: 'action-drop-selected', actionType: string, kind?: PressKind): void
  (e: 'view-logs'): void
  (e: 'action-logs', payload: { kind: string; index: number; actionType: string }): void
  (e: 'open-plugin-settings', pluginId: string): void
}

const props = withDefaults(defineProps<Props>(), { profileName: '', pageName: '', apiBase: '' })
const emit = defineEmits<Emits>()

const tab = ref<'actions' | 'rules' | 'appearance' | 'behavior'>('actions')
// Subtab por tipo de pulsación dentro de Acciones.
const pressKinds: PressKind[] = ['click', 'double', 'triple', 'long']
const pressKindLabel: Record<PressKind, string> = {
  click: 'bd.pressClick',
  double: 'bd.pressDouble',
  triple: 'bd.pressTriple',
  long: 'bd.pressLong',
}
const pressTab = ref<PressKind>('click')
/** Listas normalizadas (click migra de `actions[]` legacy en lectura). */
const pressLists = computed(() => normalizePressActions(props.buttonConfig))
const pressList = computed<any[]>(() =>
  pressTab.value === 'click' ? asList(props.buttonConfig?.actions) : pressLists.value[pressTab.value]
)
const pressCount = (k: PressKind): number =>
  k === 'click' ? asList(props.buttonConfig?.actions).length : pressLists.value[k].length
/** Escribe la lista del subtab activo (click espeja a `actions[]`). */
const setPressList = (list: any[]) => {
  const next = setActionsForKind(props.buttonConfig, pressTab.value, list)
  emit('update-field', 'pressActions', next.pressActions)
  if (pressTab.value === 'click') emit('update-field', 'actions', next.actions)
}
const rmPressAction = (i: number) => setPressList(pressList.value.filter((_, j) => j !== i))
const movePressAction = (i: number, dir: -1 | 1) => {
  const list = [...pressList.value]
  const j = i + dir
  if (j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j], list[i]]
  setPressList(list)
}
const updPressAction = (i: number, patch: Record<string, any>) => {
  const list = [...pressList.value]
  list[i] = { ...list[i], ...patch }
  setPressList(list)
}
const updPressParam = (i: number, k: string, v: any) => {
  const list = [...pressList.value]
  list[i] = { ...list[i], parameters: { ...(list[i]?.parameters ?? {}), [k]: v } }
  setPressList(list)
}
// Sin tecla no hay reglas/aspecto que mostrar: volver a acciones evita
// que las pestaÃ±as parezcan "no clicables" (mismo empty-state en todas).
watch(
  () => props.hasButton,
  (v) => {
    if (!v) tab.value = 'actions'
  }
)
/** Lista segura para ramas entonces/si-no corruptas (no-array). */
const asList = (v: unknown): any[] => (Array.isArray(v) ? v : [])
const menuOpen = ref(false)
const menuBtn = ref<HTMLElement | null>(null)
const dragOver = ref(false)

const actionsList = ref<HTMLElement | null>(null)
let swapyInstance: Swapy | null = null
let swapping = false
let orderBeforeSwap: string[] = []

const actionKey = (action: any, i: number) => String(action?.id ?? i)
const ruleList = computed<any[]>(() => {
  const r = props.buttonConfig?.rules
  return Array.isArray(r) ? r.filter((x) => x && typeof x === 'object') : []
})
const lookList = computed<any[]>(() => {
  const l = props.buttonConfig?.looks
  return Array.isArray(l) ? l.filter((x) => x && typeof x === 'object') : []
})
const varList = computed(() => vars.value)
/** Incorporadas de tiempo: solo entonces el badge depende del tick de 1 s. */
const BADGE_TIME_RE = /(^|[^\p{L}\p{N}_])(hora|minuto|segundo|dia)(?![\p{L}\p{N}_])/u
/** Badge "condiciÃ³n ahora: â€¦" memoizado por (cond + valores de vars usadas + tick si usa tiempo).
 *  Sin cachÃ©, cada render reevaluaba ev() por cada regla y look, y el tick
 *  suscribÃ­a todo el inspector al temporizador aunque nada fuese dinÃ¡mico. */
const badgeCache = new Map<string, string>()
const badgeKeyOf = (s: string): string => {
  const used = usedVarNames(s, vars.value.map((v) => v.n))
  // Leer el tick solo si hace falta: si no, este render no se suscribe al
  // temporizador y el v-html no se recalcula cada segundo.
  let key = BADGE_TIME_RE.test(s) ? `${s}\n#${displayTick.value}\n` : `${s}\n#\n`
  for (const n of used) key += `${n}=${String(getVar(n)?.v ?? '')};`
  return key
}

const condBadge = (src: unknown): string => {
  const s = String(src ?? '')
  if (!s.trim()) return esc(t('bd.condAlways'))
  const key = badgeKeyOf(s)
  const hit = badgeCache.get(key)
  if (hit !== undefined) return hit
  let out: string
  try {
    out = `${esc(t('bd.condNow'))}: <b>${esc(fmt(ev(s, getEnv(props.profileName, props.pageName))))}<\/b>`
  } catch (e: any) {
    out = `<span class="bd-err">${esc(e?.message ?? String(e))}<\/span>`
  }
  badgeCache.set(key, out)
  if (badgeCache.size > 200) badgeCache.clear()
  return out
}
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

const destroySwapy = () => {
  swapyInstance?.destroy()
  swapyInstance = null
}

const initSwapy = async () => {
  await nextTick()
  destroySwapy()
  if (tab.value !== 'actions') return
  if (!actionsList.value || !(props.buttonConfig?.actions?.length > 0)) return
  // Import dinÃ¡mico: fuera del chunk inicial (ver StageBoard).
  try {
    const { createSwapy } = await import('swapy')
    // La pestaÃ±a o la lista pueden haber cambiado mientras se cargaba.
    if (tab.value !== 'actions' || !actionsList.value) return
    if (!(props.buttonConfig?.actions?.length > 0)) return
    swapyInstance = createSwapy(actionsList.value, { animation: 'dynamic' })
    swapyInstance.onSwapStart(() => {
      swapping = true
      orderBeforeSwap = pressList.value.map(actionKey)
    })
    swapyInstance.onSwapEnd((event: any) => {
      const map = event.slotItemMap
      if (!map) {
        swapping = false
        return
      }
      let itemIds: string[] = []
      if (map.asObject) {
        itemIds = (Object.values(map.asObject).filter(Boolean) as string[]).map((s) =>
          String(s).replace(/^item-/, '')
        )
      } else if (Array.isArray(map.asArray)) {
        itemIds = map.asArray
          .filter((x: any) => x?.itemId)
          .map((x: any) => String(x.itemId).replace(/^item-/, ''))
      }
      const actions = pressList.value
      const reordered = itemIds
        .map((k) => actions.find((a: any, i: number) => actionKey(a, i) === k))
        .filter(Boolean)
      const changed =
        reordered.length === actions.length &&
        itemIds.some((k, index) => k !== orderBeforeSwap[index])
      if (changed) {
        if (pressTab.value === 'click') emit('reorder-actions', reordered)
        else setPressList(reordered)
      }
    setTimeout(() => {
      swapping = false
      orderBeforeSwap = []
    }, 100)
    })
  } catch (e) {
    console.error('[swapy] initSwapy failed:', e)
    swapyInstance = null
  }
}

const onGlobalDragStart = (event: DragEvent) => {
  if (event.dataTransfer?.types.includes('application/json')) {
    dragOver.value = false
    swapyInstance?.enable(false)
  }
}
const onGlobalDragEnd = () => {
  swapyInstance?.enable(true)
}

watch(
  () => (tab.value === 'actions' ? pressList.value.length : 0),
  async (len) => {
    if (swapping) return
    if (len > 0 && tab.value === 'actions') await initSwapy()
    else destroySwapy()
  }
)
watch(pressTab, async () => {
  await initSwapy()
})
watch(() => props.selectedPosition, async () => {
  await initSwapy()
})
watch(tab, async () => {
  await initSwapy()
})

onMounted(() => {
  initSwapy()
  document.addEventListener('dragstart', onGlobalDragStart)
  document.addEventListener('dragend', onGlobalDragEnd)
  document.addEventListener('click', onDocClick)
})
onUnmounted(() => {
  destroySwapy()
  document.removeEventListener('dragstart', onGlobalDragStart)
  document.removeEventListener('dragend', onGlobalDragEnd)
  document.removeEventListener('click', onDocClick)
})

const onDocClick = (e: MouseEvent) => {
  if (menuOpen.value && !(e.target as HTMLElement).closest?.('.bd-menu') && e.target !== menuBtn.value && !menuBtn.value?.contains(e.target as Node)) {
    menuOpen.value = false
  }
}

const execMode = computed(() => props.buttonConfig?.mode ?? 'seq')

const activeSwatch = computed(() => {
  const cur = String(props.buttonConfig?.textColor ?? '').toLowerCase()
  return SWATCHES.indexOf(cur)
})
const activeBg = computed(() => {
  const cur = String(props.buttonConfig?.backgroundColor ?? '').toLowerCase()
  return BG_SWATCHES.findIndex((h) => h.toLowerCase() === cur)
})
const toColorInput = (v: any, fallback = '#e8e9eb') => {
  if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return v
  return fallback
}
/** Color libre `#rrggbb` en un look (frente a índice de paleta). */
const lookHex = (v: unknown): string | null =>
  (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null)
const isLookCustomColor = (li: number): boolean => lookHex(lookList.value[li]?.c) !== null
const isLookCustomBg = (li: number): boolean => lookHex(lookList.value[li]?.bg) !== null
const lookCustomColor = (li: number): string => lookHex(lookList.value[li]?.c) ?? '#e8e9eb'
const lookCustomBg = (li: number): string => lookHex(lookList.value[li]?.bg) ?? '#374151'

const iconComponent = computed(() => {
  const name = props.buttonConfig?.icon
  return typeof name === 'string' && name ? dynamicIcon(name) : null
})
const iconKebab = computed(() => {
  const name: string = String(props.buttonConfig?.icon ?? '')
  return name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()
})

/** Vista previa con apariencia condicional aplicada. */
const preview = computed(() => {
  const rawStatic = props.buttonConfig ?? {}
  const rawLooks = Array.isArray(rawStatic.looks) ? rawStatic.looks : []
  const previewStatic =
    !rawLooks.some((l: any) => String(l?.cond ?? '').trim()) &&
    !/\{\{/.test(String(rawStatic.label ?? ''))
  try {
    // Solo suscribirse al tick si hay looks con condiciÃ³n o {{}} en el tÃ­tulo;
    // si no, la vista previa estÃ¡tica no se recalcula cada segundo.
    if (!previewStatic) void displayTick.value
    const E = getEnv(props.profileName, props.pageName)
    const raw = props.buttonConfig ?? {}
    const looks = Array.isArray(raw.looks) ? raw.looks : []
    const L = looks.find((l: any) => {
      try { return !!(l?.cond && String(l.cond).trim() && ev(String(l.cond), E)) } catch { return false }
    })
    const textColor = typeof raw.textColor === 'string' ? raw.textColor : '#e8e9eb'
    const backgroundColor = typeof raw.backgroundColor === 'string' ? raw.backgroundColor : null
    return {
      label: intp(String(L?.t ?? raw.label ?? ''), E),
      color: lookHex(L?.c) ?? (L && L.c != null && typeof SWATCHES[L.c as number] === 'string' ? SWATCHES[L.c as number] as string : textColor),
      bg: (lookHex(L?.bg) ?? (L && L.bg ? (typeof LOOK_BGS[L.bg as number] === 'string' ? LOOK_BGS[L.bg as number] as string : null) : null) ?? backgroundColor) as string | null,
      iconName: String(L?.i || raw.icon || ''),
      image: typeof raw.iconImage === 'string' ? raw.iconImage : ''
    }
  } catch {
    const raw = props.buttonConfig ?? {}
    return {
      label: String(raw?.label ?? ''),
      color: typeof raw?.textColor === 'string' ? raw.textColor : '#e8e9eb',
      bg: (typeof raw?.backgroundColor === 'string' ? raw.backgroundColor : null) as string | null,
      iconName: String(raw?.icon ?? ''),
      image: typeof raw?.iconImage === 'string' ? raw.iconImage : ''
    }
  }
})
const previewImage = computed(() => {
  const rel = String((preview.value as any).image ?? '')
  return isAssetRef(rel) ? assetUrl(props.apiBase, rel) : ''
})
const hasKeyImage = computed(() => previewImage.value !== '')
const previewIcon = computed(() => {
  const n = (preview.value as any).iconName
  return n ? dynamicIcon(n) : null
})

const setRules = (next: any[]) => emit('update-field', 'rules', next)
const setRule = (ri: number, patch: Record<string, any>) => {
  const next = [...ruleList.value]
  next[ri] = { ...next[ri], ...patch }
  setRules(next)
}
const addRule = () => {
  setRules([...ruleList.value, { id: 'g' + Math.random().toString(36).slice(2, 7), on: true, when: 'press', every: 5, vn: '', cond: '', then: [], else: [] }])
}
const delRule = (ri: number) => setRules(ruleList.value.filter((_, i) => i !== ri))
const updRuleAction = (ri: number, side: 'then' | 'else', i: number, patch: Record<string, any>) => {
  const next = [...ruleList.value]
  const cur = Array.isArray(next[ri]?.[side]) ? next[ri][side] : []
  const list = [...cur]
  list[i] = { ...list[i], ...patch }
  next[ri] = { ...next[ri], [side]: list }
  setRules(next)
}
const updRuleParam = (ri: number, side: 'then' | 'else', i: number, k: string, v: any) => {
  const next = [...ruleList.value]
  const cur = Array.isArray(next[ri]?.[side]) ? next[ri][side] : []
  const list = [...cur]
  list[i] = { ...list[i], parameters: { ...(list[i]?.parameters ?? {}), [k]: v } }
  next[ri] = { ...next[ri], [side]: list }
  setRules(next)
}
const delRuleAction = (ri: number, side: 'then' | 'else', i: number) => {
  const next = [...ruleList.value]
  const cur = Array.isArray(next[ri]?.[side]) ? next[ri][side] : []
  next[ri] = { ...next[ri], [side]: cur.filter((_: any, j: number) => j !== i) }
  setRules(next)
}

const setLooks = (next: any[]) => emit('update-field', 'looks', next)
const setLook = (li: number, patch: Record<string, any>) => {
  const next = [...lookList.value]
  next[li] = { ...next[li], ...patch }
  setLooks(next)
}
const addLook = () => setLooks([...lookList.value, { cond: '', t: '', i: '', c: null, bg: 0 }])
const delLook = (li: number) => setLooks(lookList.value.filter((_, i) => i !== li))
const lookIcon = (li: number) => {
  const n = typeof lookList.value[li]?.i === 'string' && lookList.value[li].i
    ? lookList.value[li].i
    : (typeof props.buttonConfig?.icon === 'string' ? props.buttonConfig.icon : '')
  return (n ? dynamicIcon(n) : null) ?? Zap
}

/** Variables disponibles en Aspecto: las que exponen las acciones de esta
 *  tecla (contrato variables/exposed.ts, valor en vivo) + globales. */
const availableVars = computed(() => availableVarsOf(props.buttonConfig))
/** Pares on/off predefinidos para las variables de estado de esta tecla. */
const varPresets = computed(() => presetsFor(props.buttonConfig))
/** Añade un look predefinido (se omite si la condición ya existe). El look
 *  del estado por defecto hereda el icono del botón si el usuario ya lo
 *  personalizó (si no, usa el de la acción). */
const addPreset = (p: VarStatePreset, isOff: boolean) => {
  const resolved = resolvePresetLook(p, isOff, props.buttonConfig, t)
  if (lookList.value.some((l: any) => String(l?.cond ?? '').trim() === resolved.cond)) return
  setLooks([...lookList.value, resolved])
}
/** Añade una condición `variable` (bool) a la apariencia condicional. */
const useCondFromVar = (v: { name: string; type: string }) => {
  const cond = v.type === 'bool' ? v.name : `${v.name} == ${v.name}`
  if (lookList.value.some((l: any) => String(l?.cond ?? '').trim() === cond)) return
  setLooks([...lookList.value, { cond, t: '', i: '', c: null, bg: 0 }])
}

/** Variables en vivo (rejilla compacta): las de acción son de solo lectura
 *  (las controla la acción automáticamente); las globales se editan aquí. */
const copiedVar = ref<string | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null
const copyVar = (name: string) => {
  const text = `{{${name}}}`
  try {
    void navigator.clipboard?.writeText(text)
  } catch { /* portapapeles no disponible */ }
  copiedVar.value = name
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copiedVar.value = null }, 800)
}
const globalVarType = (name: string): string => {
  const v = getVar(name)
  if (v) return v.t
  const avail = availableVarsOf(props.buttonConfig).find((a) => a.name === name)
  return avail?.type === 'bool' ? 'bool' : avail?.type === 'num' ? 'num' : 'txt'
}
const globalVarVal = (name: string): any => getVar(name)?.v ?? ''
const fmtBoolShort = (v: any): string => {
  if (v === true) return t('bd.varTrue')
  if (v === false) return t('bd.varFalse')
  return t('bd.availVarUnknownShort')
}
const toggleGlobalVar = (name: string) => {
  const cur = getVar(name)
  if (!cur) return
  if (cur.t === 'bool') setVarValue(name, !cur.v)
  else if (cur.t === 'num') setVarValue(name, cur.v ? 0 : 1)
  else setVarValue(name, cur.v ? '' : '1')
  // El daemon debe enterarse (hardware + reglas): best-effort por WS.
  pushVarToDaemon(name)
}
const setGlobalVar = (name: string, raw: any) => {
  const cur = getVar(name)
  if (!cur) return
  if (cur.t === 'num') {
    const x = +raw
    setVarValue(name, Number.isFinite(x) ? x : 0)
  } else if (cur.t === 'bool') {
    setVarValue(name, raw === true || raw === 'true' || raw === '1')
  } else {
    setVarValue(name, String(raw ?? ''))
  }
  pushVarToDaemon(name)
}
/** Constructor visual de condiciones (una cláusula por look).
 *  Lee/escribe el mismo `cond` en texto: `nombre`, `nombre == valor`, etc. */
const COND_OPS = [
  { v: '==', label: '=' },
  { v: '!=', label: '≠' },
  { v: '>', label: '>' },
  { v: '>=', label: '≥' },
  { v: '<', label: '<' },
  { v: '<=', label: '≤' },
  { v: 'contains', label: '⊃' },
]
const keyVarsList = computed(() => availableVars.value.filter((v) => v.origin === 'action'))
const globalVarsList = computed(() => availableVars.value.filter((v) => v.origin !== 'action'))
const condVarType = (name: string): string => {
  const avail = availableVars.value.find((v) => v.name === name)
  if (avail) return avail.type === 'bool' ? 'bool' : avail.type === 'num' ? 'num' : 'txt'
  return getVar(name)?.t ?? 'txt'
}
const condOpsFor = (name: string) => {
  if (condVarType(name) === 'bool') return COND_OPS.filter((o) => o.v === '==' || o.v === '!=')
  return COND_OPS
}
const condParts = (li: number): { name: string; op: string; val: string } => {
  const cond = String(lookList.value[li]?.cond ?? '')
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|>|<|contains)?\s*([\s\S]*?)\s*$/.exec(cond)
  const fallback = availableVars.value[0]?.name ?? ''
  if (!m || !m[1]) return { name: fallback, op: '==', val: '' }
  if (!m[2]) return { name: m[1], op: '==', val: 'true' }
  let val = m[3] ?? ''
  const q = /^(['"])([\s\S]*)\1$/.exec(val)
  if (q) val = q[2]
  return { name: m[1], op: m[2], val }
}
const setCondPart = (li: number, patch: Partial<{ name: string; op: string; val: string }>) => {
  const cur = condParts(li)
  const name = patch.name ?? cur.name
  if (!name) return
  let op = patch.op ?? cur.op
  let val = patch.val ?? cur.val
  if (condVarType(name) === 'bool' && op !== '==' && op !== '!=') op = '=='
  const cond = op === '==' && (val === '' || val == null) && condVarType(name) !== 'bool'
    ? name
    : `${name} ${op} ${val}`.trim()
  setLook(li, { cond })
}
const condReadable = (li: number): string => {
  const p = condParts(li)
  if (!String(lookList.value[li]?.cond ?? '').trim()) return t('bd.condAlways')
  const disp = p.val === 'true' ? t('bd.varTrue') : p.val === 'false' ? t('bd.varFalse') : p.val
  const opLabel = COND_OPS.find((o) => o.v === p.op)?.label ?? p.op
  return `${p.name} ${opLabel} ${disp}`
}
const lookTruth = (li: number): boolean | null => {
  const cond = String(lookList.value[li]?.cond ?? '')
  if (!cond.trim()) return true
  try {
    void displayTick.value
    return !!ev(cond, getEnv(props.profileName, props.pageName))
  } catch { return null }
}
const firstMatchedLook = computed(() => {
  for (let i = 0; i < lookList.value.length; i++) {
    if (lookTruth(i) === true) return i
  }
  return -1
})
const lookStatusText = (li: number): string => {
  const v = lookTruth(li)
  if (v === true) return firstMatchedLook.value === li ? t('bd.condActive') : t('bd.condWaiting')
  if (v === null) return t('bd.condFalse')
  return t('bd.condFalse')
}

const onDrop = (event: DragEvent) => {
  dragOver.value = false
  try {
    const raw = event.dataTransfer?.getData('application/json')
    if (!raw) return
    const data = JSON.parse(raw)
    if (data?.type) emit('action-drop-selected', data.type, pressTab.value)
  } catch {
    /* noop */
  }
}

/** Flechas del teclado sobre el asa: reordena sin ratÃ³n ni tÃ¡ctil. */
const onGripKey = (e: KeyboardEvent, i: number) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  const j = i + (e.key === 'ArrowUp' ? -1 : 1)
  if (j < 0 || j >= pressList.value.length) return
  e.preventDefault()
  movePressAction(i, e.key === 'ArrowUp' ? -1 : 1)
  nextTick(() => {
    document.querySelector<HTMLElement>(`.bd-grip[data-gi="${j}"]`)?.focus()
  })
}

const onMenuAction = (a: 'test' | 'export' | 'import' | 'clear' | 'logs') => {
  menuOpen.value = false
  if (a === 'test') emit('test')
  else if (a === 'logs') emit('view-logs')
  else if (a === 'export') emit('export-key')
  else if (a === 'import') emit('import-key')
  else emit('clear')
}
const onMenuBtnKey = (e: KeyboardEvent) => {
  if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    menuOpen.value = true
    nextTick(() => document.querySelector<HTMLElement>('.bd-menu button')?.focus())
  }
}
const onMenuKey = (e: KeyboardEvent) => {
  const items = [...document.querySelectorAll<HTMLElement>('.bd-ih .bd-menu button')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    items[(i + 1) % items.length]?.focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    items[(i - 1 + items.length) % items.length]?.focus()
  } else if (e.key === 'Escape') {
    menuOpen.value = false
    menuBtn.value?.focus()
  }
}

// Menú contextual sobre filas de acción: un único item «Ver registros»
// que emite la acción concreta (kind + índice + tipo) al contenedor.
const actionMenu = ref({
  show: false,
  x: 0,
  y: 0,
  kind: '',
  index: -1,
  actionType: '',
})
const actionMenuItems = computed(() => [
  { id: 'action-logs', label: t('bd.viewLogs'), icon: ScrollText, danger: false },
])
const onActionCtx = (e: MouseEvent, kind: string, index: number, actionType?: string) => {
  actionMenu.value = {
    show: true,
    x: e.clientX,
    y: e.clientY,
    kind: String(kind ?? ''),
    index,
    actionType: String(actionType ?? ''),
  }
}
const onActionMenuItem = () => {
  emit('action-logs', {
    kind: actionMenu.value.kind,
    index: actionMenu.value.index,
    actionType: actionMenu.value.actionType,
  })
  actionMenu.value.show = false
}
</script>
