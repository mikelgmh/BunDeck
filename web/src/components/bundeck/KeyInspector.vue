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
      <div
        class="bd-pv"
        :style="{ '--bd-g': preview.color, background: preview.bg || undefined }"
        :aria-label="t('bd.keyPreview')"
        role="img"
      >
        <component v-if="previewIcon" :is="previewIcon" :size="26" stroke-width="1.75" aria-hidden="true" />
      </div>
      <div class="bd-it">
        <p class="bd-mono bd-cap">F{{ row + 1 }} · C{{ col + 1 }}</p>
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

    <div class="bd-itabs" role="tablist">
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
      <button role="tab" :aria-selected="tab === 'appearance'" @click="tab = 'appearance'">
        {{ t('bd.tabAppearance') }}
      </button>
      <button role="tab" :aria-selected="tab === 'behavior'" @click="tab = 'behavior'">
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
        <div
          @dragover.prevent="dragOver = true"
          @dragleave="dragOver = false"
          @drop.prevent="onDrop"
          :style="dragOver ? 'outline: 2px dashed var(--bd-ac); outline-offset: 4px; border-radius: 12px;' : undefined"
        >
          <ol v-if="buttonConfig.actions?.length" ref="actionsList" class="bd-al">
            <li
              v-for="(action, i) in buttonConfig.actions"
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
                  @update-action="(idx, patch) => emit('update-action', idx, patch)"
                  @update-param="(idx, k, v) => emit('update-action-param', idx, k, v)"
                  @remove="(idx) => emit('remove-action', idx)"
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
                      @click="emit('move-action', i, -1)"
                    >
                      <ChevronUp :size="16" stroke-width="1.75" aria-hidden="true" />
                    </button>
                    <button
                      :disabled="i === buttonConfig.actions.length - 1"
                      aria-label="Bajar"
                      title="Bajar"
                      @click="emit('move-action', i, 1)"
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

        <button class="bd-btn bd-wide" data-cy="bd-add-action" @click="emit('open-palette', 'acts')">
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
            <div v-for="(o, i) in (r.then ?? [])" :key="o.id ?? i" class="bd-ac">
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
            <div v-for="(o, i) in (r.else ?? [])" :key="o.id ?? i" class="bd-ac">
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
            <component v-if="iconComponent" :is="iconComponent" :size="24" stroke-width="1.75" aria-hidden="true" />
            <span>{{ iconKebab }}</span>
            <i class="bd-sp"></i>
            {{ t('bd.change') }}
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
              <component :is="lookIcon(li)" :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.icon') }}…
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
import { ChevronUp, ChevronDown, Plus, Settings, GripVertical, Ellipsis, Play, FileUp, FileDown, Trash2 } from 'lucide-vue-next'
import * as LucideIcons from 'lucide-vue-next'
import { createSwapy, type Swapy } from 'swapy'
import ActionCard from './ActionCard.vue'
import { useI18nStore } from '../../composables/useI18n'
import { ev, fmt, intp } from '../../composables/useExpressions'
import { vars, getEnv, displayTick } from '../../composables/useVars'

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
  (e: 'action-drop-selected', actionType: string): void
}

const props = withDefaults(defineProps<Props>(), { profileName: '', pageName: '' })
const emit = defineEmits<Emits>()

const tab = ref<'actions' | 'rules' | 'appearance' | 'behavior'>('actions')
const menuOpen = ref(false)
const menuBtn = ref<HTMLElement | null>(null)
const dragOver = ref(false)

const actionsList = ref<HTMLElement | null>(null)
let swapyInstance: Swapy | null = null
let swapping = false
let orderBeforeSwap: string[] = []

const actionKey = (action: any, i: number) => String(action?.id ?? i)
const ruleList = computed<any[]>(() => props.buttonConfig?.rules ?? [])
const lookList = computed<any[]>(() => props.buttonConfig?.looks ?? [])
const varList = computed(() => vars.value)
const envNow = () => {
  void displayTick.value
  return getEnv(props.profileName, props.pageName)
}

const condBadge = (src: string): string => {
  if (!(src || '').trim()) return esc(t('bd.condAlways'))
  try {
    return `${esc(t('bd.condNow'))}: <b>${esc(fmt(ev(src, envNow())))}<\/b>`
  } catch (e: any) {
    return `<span class="bd-err">${esc(e?.message ?? String(e))}<\/span>`
  }
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
  swapyInstance = createSwapy(actionsList.value, { animation: 'dynamic' })
  swapyInstance.onSwapStart(() => {
    swapping = true
    orderBeforeSwap = (props.buttonConfig.actions ?? []).map(actionKey)
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
    const actions = props.buttonConfig.actions ?? []
    const reordered = itemIds
      .map((k) => actions.find((a: any, i: number) => actionKey(a, i) === k))
      .filter(Boolean)
    const changed =
      reordered.length === actions.length &&
      itemIds.some((k, index) => k !== orderBeforeSwap[index])
    if (changed) emit('reorder-actions', reordered)
    setTimeout(() => {
      swapping = false
      orderBeforeSwap = []
    }, 100)
  })
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
  () => props.buttonConfig?.actions?.length ?? 0,
  async (len) => {
    if (swapping) return
    if (len > 0 && tab.value === 'actions') await initSwapy()
    else destroySwapy()
  }
)
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
  const cur = (props.buttonConfig?.textColor ?? '').toLowerCase()
  const idx = SWATCHES.indexOf(cur)
  return idx === -1 ? 0 : idx
})
const activeBg = computed(() => {
  const cur = (props.buttonConfig?.backgroundColor ?? '').toLowerCase()
  return BG_SWATCHES.findIndex((h) => h.toLowerCase() === cur)
})
const toColorInput = (v: any) => {
  if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return v
  return '#374151'
}

const icons = LucideIcons as Record<string, any>
const iconComponent = computed(() => {
  const name = props.buttonConfig?.icon
  return name ? icons[name] ?? null : null
})
const iconKebab = computed(() => {
  const name: string = props.buttonConfig?.icon ?? ''
  return name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()
})

/** Vista previa con apariencia condicional aplicada. */
const preview = computed(() => {
  void displayTick.value
  const E = envNow()
  const raw = props.buttonConfig ?? {}
  const L = (raw.looks ?? []).find((l: any) => {
    try { return !!(l?.cond && String(l.cond).trim() && ev(l.cond, E)) } catch { return false }
  })
  return {
    label: intp(String(L?.t || raw.label || ''), E),
    color: L && L.c != null ? SWATCHES[L.c] ?? raw.textColor : raw.textColor || '#e8e9eb',
    bg: (L && L.bg ? (LOOK_BGS[L.bg] ?? null) : (raw.backgroundColor || null)) as string | null,
    iconName: String(L?.i || raw.icon || '')
  }
})
const previewIcon = computed(() => {
  const n = (preview.value as any).iconName
  return n ? icons[n] ?? null : null
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
  const list = [...(next[ri]?.[side] ?? [])]
  list[i] = { ...list[i], ...patch }
  next[ri] = { ...next[ri], [side]: list }
  setRules(next)
}
const updRuleParam = (ri: number, side: 'then' | 'else', i: number, k: string, v: any) => {
  const next = [...ruleList.value]
  const list = [...(next[ri]?.[side] ?? [])]
  list[i] = { ...list[i], parameters: { ...(list[i]?.parameters ?? {}), [k]: v } }
  next[ri] = { ...next[ri], [side]: list }
  setRules(next)
}
const delRuleAction = (ri: number, side: 'then' | 'else', i: number) => {
  const next = [...ruleList.value]
  next[ri] = { ...next[ri], [side]: (next[ri]?.[side] ?? []).filter((_: any, j: number) => j !== i) }
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
  const n = lookList.value[li]?.i || props.buttonConfig?.icon
  return (n && icons[n]) ?? icons['Zap'] ?? Settings
}

const onDrop = (event: DragEvent) => {
  dragOver.value = false
  try {
    const raw = event.dataTransfer?.getData('application/json')
    if (!raw) return
    const data = JSON.parse(raw)
    if (data?.type) emit('action-drop-selected', data.type)
  } catch {
    /* noop */
  }
}

/** Flechas del teclado sobre el asa: reordena sin ratón ni táctil. */
const onGripKey = (e: KeyboardEvent, i: number) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  const j = i + (e.key === 'ArrowUp' ? -1 : 1)
  if (j < 0 || j >= (props.buttonConfig.actions?.length ?? 0)) return
  e.preventDefault()
  emit('move-action', i, e.key === 'ArrowUp' ? -1 : 1)
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
