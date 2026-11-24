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
            <div v-for="(o, i) in asList(r.then)" :key="o.id ?? i" class="bd-ac">
              <ActionCard
                :action="o"
                :index="i"
                :show-wait="true"
                :plugins="plugins"
                :available-pages="availablePages"
                @update-action="(idx, patch) => updRuleAction(ri, 'then', idx, patch)"
                @update-param="(idx, k, v) => updRuleParam(ri, 'then', idx, k, v)"
                @remove="(idx) => delRuleAction(ri, 'then', idx)"
              />
            </div>
          </div>
          <button class="bd-btn bd-wide" @click="emit('open-palette', `r${ri}.then`)">
            <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.addAction') }}
          </button>
          <p class="bd-sh2">{{ t('bd.ruleElse') }}</p>
          <div class="bd-al">
            <div v-for="(o, i) in asList(r.else)" :key="o.id ?? i" class="bd-ac">
              <ActionCard
                :action="o"
                :index="i"
                :show-wait="true"
                :plugins="plugins"
                :available-pages="availablePages"
                @update-action="(idx, patch) => updRuleAction(ri, 'else', idx, patch)"
                @update-param="(idx, k, v) => updRuleParam(ri, 'else', idx, k, v)"
                @remove="(idx) => delRuleAction(ri, 'else', idx)"
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
              :value="toColorInput(buttonConfig.backgroundColor)"
              :aria-label="t('bd.background')"
              @input="emit('update-field', 'backgroundColor', ($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>

        <h3 class="bd-sh">{{ t('bd.keyVarsTitle') }}</h3>
        <p class="bd-hint" style="margin: 0 0 8px">{{ t('bd.keyVarsHint') }}</p>
        <div v-if="keyVarNames.length" class="bd-al" data-cy="bd-key-vars">
          <div v-for="n in keyVarNames" :key="n" class="bd-ac" style="display: flex; align-items: center; gap: 8px">
            <span class="bd-mono" style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis">{{ n }}</span>
            <span v-if="keyVarState(n).exists" class="bd-cnt">{{ keyVarState(n).value }}</span>
            <span v-else class="bd-cnt" :title="t('bd.varBadName')">{{ t('bd.keyVarMissing') }}</span>
            <button
              v-if="!keyVarState(n).exists"
              class="bd-btn"
              style="padding: 4px 10px"
              @click="createMissingVar(n)"
            >{{ t('bd.keyVarCreate') }}</button>
          </div>
        </div>
        <p v-else class="bd-hint" data-cy="bd-key-vars-empty">{{ t('bd.keyVarsEmpty') }}</p>

        <h3 class="bd-sh">{{ t('bd.toggleTitle') }}</h3>
        <p class="bd-hint" style="margin: 0 0 8px">{{ t('bd.toggleHint') }}</p>
        <div class="bd-fld">
          <label class="bd-sr" for="bd-toggle-var">{{ t('bd.toggleVarPh') }}</label>
          <div style="display: flex; gap: 8px">
            <input
              id="bd-toggle-var"
              type="text"
              class="bd-inp bd-mono"
              style="flex: 1; min-width: 0"
              v-model="toggleVarName"
              :placeholder="t('bd.toggleVarPh')"
              spellcheck="false"
              autocomplete="off"
              data-cy="bd-toggle-var-input"
            />
            <button class="bd-btn bd-pri" @click="applyToggleWizard" data-cy="bd-toggle-apply">
              <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.toggleApply') }}
            </button>
          </div>
          <p v-if="toggleMsg === 'ok'" class="bd-hint" style="margin: 8px 0 0">{{ t('bd.toggleOk') }}</p>
          <p v-if="toggleMsg === 'bad'" class="bd-err" style="margin: 8px 0 0">{{ t('bd.varBadName') }}</p>
        </div>

        <h3 class="bd-sh">{{ t('bd.statesTitle') }}</h3>
        <p class="bd-hint" style="margin: 0 0 8px">{{ t('bd.statesHint') }}</p>
        <div class="bd-fld">
          <div style="display: flex; gap: 8px">
            <input
              type="text"
              class="bd-inp bd-mono"
              style="flex: 1; min-width: 0"
              v-model="stateVarDraft"
              :placeholder="t('bd.statesVarPh')"
              spellcheck="false"
              autocomplete="off"
              data-cy="bd-state-var-input"
            />
            <button class="bd-btn" @click="applyStateVar" data-cy="bd-state-var-apply">{{ t('bd.statesUse') }}</button>
            <button v-if="stateVar" class="bd-btn" @click="clearStateVar">{{ t('bd.statesClear') }}</button>
          </div>
        </div>
        <div v-if="stateVar" data-cy="bd-states">
          <p class="bd-hint" style="margin: 0 0 8px">{{ t('bd.statesBaseHint') }}</p>
          <div v-for="s in stateEntries" :key="s.i" class="bd-rl">
            <div class="bd-ah">
              <b>{{ t('bd.stateN', { n: s.i }) }}</b>
              <span class="bd-mono" style="font-size: 11px; opacity: 0.7">{{ stateVar }} == {{ s.i }}</span>
              <button :aria-label="t('bd.delete')" :title="t('bd.delete')" @click="delState(s.i)">
                <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />
              </button>
            </div>
            <div class="bd-rg3">
              <input
                type="text"
                class="bd-inp"
                :value="s.look.t ?? ''"
                :placeholder="t('bd.lookTitlePh')"
                :aria-label="t('bd.keyTitle')"
                style="flex: 1; min-width: 120px"
                @input="setStateVisual(s.i, { t: ($event.target as HTMLInputElement).value })"
              />
              <button class="bd-btn" @click="openStateIcon(s.i)">
                <component :is="stateIcon(s.i)" :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.icon') }}…
              </button>
            </div>
            <div class="bd-cols" style="margin-bottom: 12px" role="group" :aria-label="t('bd.iconColor')">
              <button
                v-for="(hex, j) in SWATCHES"
                :key="hex"
                class="bd-cs"
                :style="{ '--bd-s': hex }"
                :aria-pressed="s.look.c === j"
                :aria-label="`Color ${j + 1}`"
                @click="setStateVisual(s.i, { c: s.look.c === j ? null : j })"
              ></button>
            </div>
            <div class="bd-cols" role="group" :aria-label="t('bd.keyBackground')">
              <button
                v-for="(hex, j) in LOOK_BGS"
                :key="String(hex)"
                class="bd-cs"
                :style="{ '--bd-s': hex ?? '#2d3036' }"
                :aria-pressed="(s.look.bg ?? 0) === j"
                :aria-label="`${t('bd.background')} ${j + 1}`"
                @click="setStateVisual(s.i, { bg: j })"
              ></button>
            </div>
          </div>
          <button class="bd-btn bd-wide" @click="addState" data-cy="bd-state-add">
            <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.stateAdd') }}
          </button>

          <h4 class="bd-sh">{{ t('bd.transTitle') }}</h4>
          <p class="bd-hint" style="margin: 0 0 8px">{{ t('bd.transHint') }}</p>
          <div v-for="k in pressKinds" :key="k" class="bd-fld">
            <label class="bd-lb" :for="`bd-trans-${k}`">{{ t(pressKindLabel[k]) }}</label>
            <select
              :id="`bd-trans-${k}`"
              class="bd-inp"
              :value="transOf(k).key"
              :data-cy="`bd-trans-${k}`"
              @change="setTrans(k, ($event.target as HTMLSelectElement).value)"
            >
              <option value="none">{{ t('bd.transNone') }}</option>
              <option value="next">{{ t('bd.transNext') }}</option>
              <option value="prev">{{ t('bd.transPrev') }}</option>
              <option v-for="i in transTargets" :key="i" :value="`go:${i}`">{{ t('bd.transGo', { n: i }) }}</option>
              <option v-if="transOf(k).key === 'custom'" value="custom" disabled>{{ t('bd.transCustom') }}</option>
            </select>
          </div>
        </div>

        <h3 class="bd-sh">{{ t('bd.looksTitle') }}</h3>
        <p class="bd-hint" style="margin: 0 0 12px">{{ t('bd.looksHint') }}</p>
        <div v-for="(l, li) in lookList" :key="li" class="bd-rl">
          <div class="bd-ah">
            <b>{{ t('bd.lookCond') }} {{ li + 1 }}</b>
            <button :aria-label="t('bd.delete')" :title="t('bd.delete')" @click="delLook(li)">
              <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />
            </button>
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
  </template>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { ChevronUp, ChevronDown, Plus, GripVertical, Ellipsis, Play, FileUp, FileDown, Trash2, ImagePlus, Zap } from 'lucide-vue-next'
import type { Swapy } from 'swapy'
import { dynamicIcon } from '../../composables/useDynamicIcon'
import ActionCard from './ActionCard.vue'
import { useI18nStore } from '../../composables/useI18n'
import {
  normalizePressActions,
  getActionsForKind,
  setActionsForKind,
  type PressKind,
} from '../../composables/usePressActions'
import { ev, fmt, intp, usedVarNames, IDRE, RES } from '../../composables/useExpressions'
import { vars, getVar, getEnv, addVar, persistVars, coerceVal, displayTick } from '../../composables/useVars'
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
  const idx = SWATCHES.indexOf(cur)
  return idx === -1 ? 0 : idx
})
const activeBg = computed(() => {
  const cur = String(props.buttonConfig?.backgroundColor ?? '').toLowerCase()
  return BG_SWATCHES.findIndex((h) => h.toLowerCase() === cur)
})
const toColorInput = (v: any) => {
  if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return v
  return '#374151'
}

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
      color: L && L.c != null && typeof SWATCHES[L.c] === 'string' ? SWATCHES[L.c] : textColor,
      bg: (L && L.bg ? (typeof LOOK_BGS[L.bg] === 'string' ? LOOK_BGS[L.bg] : null) : backgroundColor) as string | null,
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

/** Variables que lee o escribe esta tecla (acciones + reglas + apariencia). */
const keyVarNames = computed<string[]>(() => {
  const names = new Set<string>()
  const pushAction = (a: any) => {
    if (a?.type === 'local.set-var' || a?.type === 'local.toggle-var') {
      const n = String(a?.parameters?.name ?? '').trim()
      if (n) names.add(n)
    }
  }
  for (const a of asList(props.buttonConfig?.actions)) pushAction(a)
  const pa = props.buttonConfig?.pressActions
  if (pa && typeof pa === 'object') {
    for (const k of ['click', 'double', 'triple', 'long'] as const) {
      for (const a of asList((pa as any)[k])) pushAction(a)
    }
  }
  for (const r of ruleList.value) {
    if (r?.vn) names.add(String(r.vn))
    for (const side of ['then', 'else'] as const) {
      for (const a of asList((r as any)?.[side])) pushAction(a)
    }
  }
  const sv = String(props.buttonConfig?.stateVar ?? '').trim()
  if (sv) names.add(sv)
  try {
    const all = vars.value.map((v) => v.n)
    for (const n of usedVarNames(JSON.stringify(props.buttonConfig ?? {}), all)) names.add(n)
  } catch { /* noop */ }
  return [...names].sort((a, b) => a.localeCompare(b))
})
const keyVarState = (n: string) => {
  const v = getVar(n)
  if (!v) return { exists: false as const }
  return { exists: true as const, type: v.t, value: fmt(v.v) }
}
const createMissingVar = (n: string) => {
  if (getVar(n)) return
  if (!IDRE.test(n) || RES.includes(n.toLowerCase())) return
  addVar(n)
}

/** Wizard: toggle play/pause = variable sí/no + Alternar en click + look. */
const toggleVarName = ref('playing')
const toggleMsg = ref<'' | 'ok' | 'bad'>('')
const ensureBoolVar = (name: string): string => {
  const v = getVar(name)
  if (!v) {
    const created = addVar(name)
    // addVar genera otro nombre si el pedido no era válido; solo forzar
    // bool cuando se creó exactamente el pedido.
    const refV = getVar(created.n)
    if (refV && refV.n === name) {
      refV.t = 'bool'
      refV.v = false
      persistVars()
    }
    return created.n
  }
  if (v.t !== 'bool') {
    v.t = 'bool'
    v.v = !!v.v
    persistVars()
  }
  return v.n
}
const uid = () => 'g' + Math.random().toString(36).slice(2, 7)
const applyToggleWizard = () => {
  const raw = toggleVarName.value.trim()
  if (!IDRE.test(raw) || RES.includes(raw.toLowerCase())) {
    toggleMsg.value = 'bad'
    return
  }
  const name = ensureBoolVar(raw)
  toggleVarName.value = name
  const curClick = getActionsForKind(props.buttonConfig, 'click')
  const hasToggle = curClick.some(
    (a: any) => a?.type === 'local.toggle-var' && String(a?.parameters?.name ?? '') === name
  )
  if (!hasToggle) {
    const nextClick = [...curClick, { id: uid(), type: 'local.toggle-var', parameters: { name } }]
    const nextData = setActionsForKind(props.buttonConfig, 'click', nextClick)
    emit('update-field', 'pressActions', nextData.pressActions)
    emit('update-field', 'actions', nextData.actions)
  }
  const looks = [...lookList.value]
  if (!looks.some((l: any) => String(l?.cond ?? '').trim() === name)) {
    const baseIcon = String(props.buttonConfig?.icon ?? '')
    // Si la base es Pause, el estado activado vuelve a Play; si no, a Pause.
    const onIcon = baseIcon.toLowerCase() === 'pause' ? 'Play' : 'Pause'
    if (!baseIcon) emit('update-field', 'icon', 'Play')
    looks.push({ cond: name, t: '', i: onIcon, c: null, bg: 0 })
    emit('update-field', 'looks', looks)
  }
  toggleMsg.value = 'ok'
}

/* N estados: una variable numérica gobierna N iconos.
 * Estado 0 = base de la tecla; estados i>=1 = looks con cond `V == i`.
 * Las transiciones por pulsación son acciones `local.set-var` sobre V
 * en la lista de esa pulsación (visibles en la pestaña Acciones). */
const stateVar = computed(() => String(props.buttonConfig?.stateVar ?? '').trim())
const stateVarDraft = ref('')
watch(
  () => props.buttonConfig?.stateVar,
  (v) => { stateVarDraft.value = String(v ?? '') },
  { immediate: true }
)
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stateCondOf = (v: string, i: number) => `${v} == ${i}`
const parseStateCond = (cond: unknown, v: string): number | null => {
  if (!v) return null
  const m = new RegExp(`^\\s*${escRe(v)}\\s*==\\s*(\\d+)\\s*$`).exec(String(cond ?? ''))
  if (!m) return null
  const i = parseInt(m[1], 10)
  return Number.isFinite(i) ? i : null
}
const rawLooks = computed(() => (Array.isArray(props.buttonConfig?.looks) ? props.buttonConfig.looks : []))
/** Estados i>=1 con su índice real en looks[] (para el selector de icono). */
const stateEntries = computed(() => {
  const v = stateVar.value
  if (!v) return []
  const out: Array<{ i: number; li: number; look: any }> = []
  rawLooks.value.forEach((l: any, li: number) => {
    const i = parseStateCond(l?.cond, v)
    if (i !== null && i >= 1) out.push({ i, li, look: l })
  })
  return out.sort((a, b) => a.i - b.i)
})
const stateCount = computed(() => {
  if (!stateVar.value) return 0
  let m = 0
  for (const s of stateEntries.value) m = Math.max(m, s.i)
  return stateEntries.value.length ? m + 1 : 1
})
const transTargets = computed(() => Array.from({ length: stateCount.value }, (_, i) => i))
const ensureNumVar = (name: string): string => {
  const v = getVar(name)
  if (!v) {
    const created = addVar(name)
    const refV = getVar(created.n)
    if (refV && refV.n === name) {
      refV.t = 'num'
      refV.v = 0
      persistVars()
    }
    return created.n
  }
  if (v.t !== 'num') {
    v.t = 'num'
    v.v = coerceVal('num', v.v)
    persistVars()
  }
  return v.n
}
const applyStateVar = () => {
  const raw = stateVarDraft.value.trim()
  if (!IDRE.test(raw) || RES.includes(raw.toLowerCase())) return
  const name = ensureNumVar(raw)
  stateVarDraft.value = name
  if (name !== stateVar.value) emit('update-field', 'stateVar', name)
}
/** Quita la variable de estados; los looks gestionados pasan a ser
 *  condiciones normales (el usuario puede borrarlos). */
const clearStateVar = () => {
  emit('update-field', 'stateVar', '')
}
/** Emite listas por pulsación de una sola vez (un solo update-field por
 *  clave: varias llamadas seguidas con la misma base rancia se pisarían). */
const emitKindLists = (lists: Partial<Record<PressKind, any[]>>) => {
  let draft: any = props.buttonConfig
  for (const k of pressKinds) {
    if (lists[k] !== undefined) draft = setActionsForKind(draft, k, lists[k]!)
  }
  emit('update-field', 'pressActions', draft.pressActions)
  if (lists.click !== undefined) emit('update-field', 'actions', draft.actions)
}
const setKindList = (kind: PressKind, list: any[]) => emitKindLists({ [kind]: list } as Partial<Record<PressKind, any[]>>)
const stateIcon = (i: number) => {
  const s = stateEntries.value.find((e) => e.i === i)
  const n = typeof s?.look?.i === 'string' && s.look.i
    ? s.look.i
    : (typeof props.buttonConfig?.icon === 'string' ? props.buttonConfig.icon : '')
  return (n ? dynamicIcon(n) : null) ?? Zap
}
const openStateIcon = (i: number) => {
  const s = stateEntries.value.find((e) => e.i === i)
  if (s && s.li >= 0) emit('open-look-icon', s.li)
}
const setStateVisual = (i: number, patch: Record<string, any>) => {
  const v = stateVar.value
  if (!v) return
  const next = [...rawLooks.value]
  const li = next.findIndex((l: any) => parseStateCond(l?.cond, v) === i)
  if (li < 0) return
  const { cond, ...safe } = patch
  void cond
  next[li] = { ...next[li], ...safe }
  emit('update-field', 'looks', next)
}
/** Reescribe las transiciones afectadas al cambiar N (añadir/borrar).
 *  next/prev se regeneran con el nuevo módulo; los "ir a" fuera de rango
 *  o al estado borrado se eliminan; el resto se renumera. */
const fixTransitions = (newN: number, deleted?: number) => {
  const v = stateVar.value
  if (!v) return
  const lists: Partial<Record<PressKind, any[]>> = {}
  let touched = false
  for (const k of pressKinds) {
    const cur = getActionsForKind(props.buttonConfig, k)
    let changed = false
    const next = cur.map((a: any) => {
      if (a?.type !== 'local.set-var' || String(a?.parameters?.name ?? '') !== v) return a
      const expr = String(a?.parameters?.expr ?? '').trim()
      const norm = expr.replace(/\s+/g, '')
      if (/^\d+$/.test(expr)) {
        const j = parseInt(expr, 10)
        if (deleted !== undefined && j === deleted) { changed = true; return null }
        if (deleted !== undefined && j > deleted) {
          changed = true
          return { ...a, parameters: { ...(a.parameters ?? {}), expr: String(j - 1) } }
        }
        if (j >= newN) { changed = true; return null }
        return a
      }
      if (norm === `(${v}+1)%${stateCount.value}` || norm === `(${v}+${stateCount.value}-1)%${stateCount.value}`) {
        const isNext = norm === `(${v}+1)%${stateCount.value}`
        changed = true
        const nexpr = isNext ? `(${v} + 1) % ${newN}` : `(${v} + ${newN} - 1) % ${newN}`
        return { ...a, parameters: { ...(a.parameters ?? {}), expr: nexpr } }
      }
      return a
    }).filter((a: any) => a !== null)
    if (changed) {
      lists[k] = next
      touched = true
    }
  }
  if (touched) emitKindLists(lists)
}
const addState = () => {
  const v = stateVar.value
  if (!v) return
  const n = stateEntries.value.reduce((m, s) => Math.max(m, s.i), 0) + 1
  const looks = [...rawLooks.value]
  looks.push({ cond: stateCondOf(v, n), t: '', i: '', c: null, bg: 0 })
  emit('update-field', 'looks', looks)
  fixTransitions(n + 1)
}
const delState = (i: number) => {
  const v = stateVar.value
  if (!v || i < 1) return
  const kept = rawLooks.value.filter((l: any) => parseStateCond(l?.cond, v) !== i)
  for (const l of kept) {
    if (l && typeof l === 'object') {
      const j = parseStateCond(l?.cond, v)
      if (j !== null && j > i) l.cond = stateCondOf(v, j - 1)
    }
  }
  emit('update-field', 'looks', kept)
  const newMax = kept.reduce((m: number, l: any) => {
    const j = parseStateCond(l?.cond, v)
    return j !== null && j > m ? j : m
  }, 0)
  fixTransitions(Math.max(1, newMax + 1), i)
}
/** Clasifica la transición de una pulsación: none/next/prev/go:i/custom. */
const transOf = (kind: PressKind): { key: string } => {
  const v = stateVar.value
  if (!v) return { key: 'none' }
  const list = getActionsForKind(props.buttonConfig, kind)
  const found = [...list].reverse().find(
    (a: any) => a?.type === 'local.set-var' && String(a?.parameters?.name ?? '') === v
  )
  if (!found) return { key: 'none' }
  const expr = String(found?.parameters?.expr ?? '').trim()
  const n = Math.max(stateCount.value, 1)
  if (/^\d+$/.test(expr)) {
    const i = parseInt(expr, 10)
    return i >= 0 && i < n ? { key: `go:${i}` } : { key: 'custom' }
  }
  const norm = expr.replace(/\s+/g, '')
  if (norm === `(${v}+1)%${n}`) return { key: 'next' }
  if (norm === `(${v}+${n}-1)%${n}`) return { key: 'prev' }
  return { key: 'custom' }
}
const setTrans = (kind: PressKind, sel: string) => {
  const v = stateVar.value
  if (!v || sel === 'custom') return
  const n = Math.max(stateCount.value, 1)
  const cur = getActionsForKind(props.buttonConfig, kind)
  const next = cur.filter(
    (a: any) => !(a?.type === 'local.set-var' && String(a?.parameters?.name ?? '') === v)
  )
  if (sel !== 'none') {
    let expr = ''
    if (sel === 'next') expr = `(${v} + 1) % ${n}`
    else if (sel === 'prev') expr = `(${v} + ${n} - 1) % ${n}`
    else if (sel.startsWith('go:') && /^\d+$/.test(sel.slice(3))) expr = sel.slice(3)
    else return
    next.push({ id: uid(), type: 'local.set-var', parameters: { name: v, expr } })
  }
  setKindList(kind, next)
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

const onMenuAction = (a: 'test' | 'export' | 'import' | 'clear') => {
  menuOpen.value = false
  if (a === 'test') emit('test')
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
</script>
