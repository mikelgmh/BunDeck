<template>
  <dialog ref="dialog" class="bd-dlg bd-flex bd-pauto" :aria-label="t('bd.autoTitle')" data-cy="bd-auto-dialog">
    <div class="bd-dh">
      <div class="bd-tile"><AppWindow :size="20" stroke-width="1.75" aria-hidden="true" /></div>
      <div>
        <h2>{{ t('bd.autoTitle') }}</h2>
        <p class="bd-cap">{{ t('bd.autoSub') }}</p>
      </div>
      <span class="bd-sp"></span>
      <button class="bd-ibtn" data-cy="bd-auto-close" :aria-label="t('bd.close')" @click="close">
        <X :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>

    <div class="bd-pb" data-cy="bd-auto-body">
      <div class="bd-srow" style="padding-top: 0">
        <div>
          <b>{{ t('bd.autoEnable') }}</b>
          <p>{{ t('bd.autoEnableHint') }}</p>
        </div>
        <div class="bd-ctl">
          <label class="bd-sw">
            <input type="checkbox" v-model="cfg.enabled" :aria-label="t('bd.autoEnable')" @change="onPersist" />
            <span></span>
          </label>
        </div>
      </div>

      <div class="bd-srow" style="padding-top: 12px">
        <div>
          <b>{{ t('bd.autoDefault') }}</b>
          <p>{{ t('bd.autoDefaultHint') }}</p>
        </div>
        <div class="bd-ctl">
          <select v-model="defaultSel" class="bd-inp" :aria-label="t('bd.autoDefault')" @change="onPersist" data-cy="bd-auto-default">
            <option :value="KEEP">{{ t('bd.autoKeep') }}</option>
            <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
      </div>

      <div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px">
          <span class="bd-sh" style="margin: 0">{{ t('bd.autoRules') }} <span class="bd-cnt">{{ cfg.rules.length }}</span></span>
          <button class="bd-btn" data-cy="bd-auto-add" @click="addRule"><Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.autoAdd') }}</button>
        </div>
        <p class="bd-hint" style="margin-bottom: 12px">{{ t('bd.autoOrderHint') }}</p>
        <div style="display: flex; flex-direction: column; gap: 10px">
          <div v-if="!cfg.rules.length" class="bd-emp">
            <h2>{{ t('bd.autoEmpty') }}</h2>
            <p>{{ t('bd.autoEmptyHint') }}</p>
          </div>
          <div
            v-for="(r, idx) in cfg.rules"
            :key="r.id"
            class="bd-arule"
            :class="{ 'bd-matched': cfg.enabled && resolved?.rule?.id === r.id }"
            data-cy="bd-auto-rule"
          >
            <div class="bd-arule-head">
              <label class="bd-sw">
                <input type="checkbox" v-model="r.enabled" :aria-label="t('bd.autoRuleOn', { n: idx + 1 })" @change="onPersist" />
                <span></span>
              </label>
              <span class="bd-mono bd-cap">#{{ idx + 1 }}</span>
              <span style="font-size: 12px; color: var(--bd-mu)">{{ t('bd.autoActivate') }}</span>
              <select v-model="r.profileId" class="bd-inp" :aria-label="t('bd.autoTargetProfile')" style="width: auto; min-width: 140px; min-height: 32px; padding: 4px 10px" @change="onPersist">
                <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <span v-if="cfg.enabled && resolved?.rule?.id === r.id" class="bd-pauto-badge on" style="margin-left: auto"><i></i>{{ t('bd.autoMatchesNow') }}</span>
              <span v-else class="bd-sp"></span>
              <button class="bd-ibtn bd-sm" :disabled="idx === 0" :title="t('bd.moveUp')" :aria-label="t('bd.moveUp')" @click="move(idx, -1)"><ArrowUp :size="15" stroke-width="1.75" aria-hidden="true" /></button>
              <button class="bd-ibtn bd-sm" :disabled="idx === cfg.rules.length - 1" :title="t('bd.moveDown')" :aria-label="t('bd.moveDown')" @click="move(idx, 1)"><ArrowDown :size="15" stroke-width="1.75" aria-hidden="true" /></button>
              <button class="bd-ibtn bd-sm bd-dng" :title="t('bd.delete')" :aria-label="t('bd.deleteRule')" @click="removeRule(idx)"><Trash2 :size="15" stroke-width="1.75" aria-hidden="true" /></button>
            </div>
            <div class="bd-arule-grid">
              <select v-model="r.target" class="bd-inp" :aria-label="t('bd.autoCriterion')" style="min-height: 36px" @change="onPersist">
                <option value="app">{{ t('bd.autoTargetApp') }}</option>
                <option value="title">{{ t('bd.autoTargetTitle') }}</option>
                <option value="both">{{ t('bd.autoTargetBoth') }}</option>
              </select>
              <select v-model="r.op" class="bd-inp" :aria-label="t('bd.autoOperator')" style="min-height: 36px" @change="onPersist">
                <option value="contains">{{ t('bd.opContains') }}</option>
                <option value="exact">{{ t('bd.opExact') }}</option>
                <option value="starts">{{ t('bd.opStarts') }}</option>
                <option value="regex">{{ t('bd.opRegex') }}</option>
              </select>
              <input
                v-model="r.value"
                type="text"
                class="bd-inp bd-mono"
                :placeholder="r.target === 'title' ? t('bd.autoValTitlePh') : t('bd.autoValAppPh')"
                style="min-height: 36px"
                spellcheck="false"
                @change="onPersist"
              />
              <button class="bd-btn" style="min-height: 36px; white-space: nowrap" :title="t('bd.autoCaptureHint')" @click="capture(idx)">
                <Crosshair :size="15" stroke-width="1.75" aria-hidden="true" />{{ t('bd.autoCapture') }}
              </button>
            </div>
            <div v-if="r.target === 'both'" class="bd-arule-sub">
              <span class="bd-cap" style="padding-left: 4px">{{ t('bd.autoAndTitle') }}</span>
              <select v-model="r.titleOp" class="bd-inp" :aria-label="t('bd.autoTitleOp')" style="min-height: 36px" @change="onPersist">
                <option value="contains">{{ t('bd.opContains') }}</option>
                <option value="exact">{{ t('bd.opExact') }}</option>
                <option value="starts">{{ t('bd.opStarts') }}</option>
                <option value="regex">{{ t('bd.opRegex') }}</option>
              </select>
              <input
                v-model="r.titleValue"
                type="text"
                class="bd-inp bd-mono"
                :placeholder="t('bd.autoTitlePh')"
                style="min-height: 36px"
                spellcheck="false"
                @change="onPersist"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="bd-simbox">
        <div class="bd-sim-top">
          <div>
            <b style="font-size: 13px">{{ t('bd.autoSimTitle') }}</b>
            <p class="bd-cap">{{ t('bd.autoSimHint') }}</p>
          </div>
          <select v-model="simId" class="bd-inp" :aria-label="t('bd.autoSimWindow')" style="width: auto; min-width: 210px; min-height: 34px; padding: 4px 10px" data-cy="bd-auto-sim">
            <option v-for="w in simWindows" :key="simKey(w)" :value="simKey(w)">{{ w.name }} ({{ w.processName }})</option>
          </select>
        </div>
        <div class="bd-sim-win">
          <div class="bd-tile" style="width: 36px; height: 36px"><AppWindow :size="18" stroke-width="1.75" aria-hidden="true" /></div>
          <div class="bd-sim-meta">
            <b>{{ simWin?.title }}</b>
            <span>{{ t('bd.autoProcess') }}: {{ simWin?.processName }}</span>
          </div>
          <button class="bd-btn" style="white-space: nowrap" data-cy="bd-auto-new-from-win" @click="createFromWin">
            <Plus :size="15" stroke-width="1.75" aria-hidden="true" />{{ t('bd.autoCreateFromWin') }}
          </button>
        </div>
        <div class="bd-sim-res">
          <span>{{ t('bd.autoEval') }}:</span>
          <span v-if="!cfg.enabled">{{ t('bd.autoPaused') }}</span>
          <span v-else-if="resolved">{{ t('bd.autoWould') }} <strong>{{ profileName(resolved.profileId) }}</strong> {{ resolved.fallback ? t('bd.autoFallbackTag') : t('bd.autoRuleTag', { n: ruleIndex(resolved.rule?.id) }) }}</span>
          <span v-else>{{ t('bd.autoNoChange') }}</span>
        </div>
      </div>
    </div>

    <div class="bd-pafoot">
      <span class="bd-cap" data-cy="bd-auto-status">{{ statusText }}</span>
      <div class="bd-chips">
        <button class="bd-btn" data-cy="bd-auto-test" @click="testNow">{{ t('bd.autoTestNow') }}</button>
        <button class="bd-btn bd-pri" @click="close">{{ t('bd.done') }}</button>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { AppWindow, ArrowDown, ArrowUp, Crosshair, Plus, Trash2, X } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'
import {
  useAutoProfile,
  newAutoRule,
  resolveProfileForWin,
  type SimWindow
} from '../../composables/useAutoProfile'
import type { ProfileData } from '../../types/streamdeck'

const { t } = useI18nStore()

interface Props {
  profiles: ProfileData[]
}

interface Emits {
  (e: 'config-changed'): void
  (e: 'activate-profile', profileId: string, window: SimWindow): void
  (e: 'notify', message: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const KEEP = '__keep__'
const dialog = ref<HTMLDialogElement | null>(null)
const { config: cfg, windows, loadConfiguration, persist, refreshWindows } = useAutoProfile()
const simId = ref('')
const defaultSel = ref<string>(KEEP)

watch(
  () => cfg.value.defaultProfileId,
  (v) => {
    defaultSel.value = v ?? KEEP
  },
  { immediate: true }
)

const validProfile = (id: string) => props.profiles.some((p) => p.id === id)
const profileName = (id: string) => props.profiles.find((p) => p.id === id)?.name ?? id

const simWindows = computed<SimWindow[]>(() => (windows.value.length ? windows.value : []))
const simKey = (w: SimWindow) => String(w.hwnd || `${w.processName}|${w.title}`)
const simWin = computed<SimWindow | null>(() => simWindows.value.find((w) => simKey(w) === simId.value) ?? simWindows.value[0] ?? null)

const resolved = computed(() => {
  if (!simWin.value) return null
  return resolveProfileForWin(cfg.value.rules, simWin.value, validProfile, cfg.value.enabled ? cfg.value.defaultProfileId : null)
})
const activeCount = computed(() => cfg.value.rules.filter((r) => r.enabled).length)
const statusText = computed(() =>
  !cfg.value.enabled
    ? t('bd.autoPaused')
    : activeCount.value === 1
      ? t('bd.autoActiveCountOne')
      : t('bd.autoActiveCount', { n: activeCount.value })
)
const ruleIndex = (id?: string) => {
  if (!id) return 0
  const i = cfg.value.rules.findIndex((r) => r.id === id)
  return i >= 0 ? i + 1 : 0
}

const onPersist = async () => {
  cfg.value.defaultProfileId = defaultSel.value === KEEP ? null : defaultSel.value
  // Descarta reglas que apunten a perfiles que ya no existen
  cfg.value.rules = cfg.value.rules.filter((r) => validProfile(r.profileId))
  await persist()
  emit('config-changed')
}

const addRule = async () => {
  const fallback = props.profiles[0]?.id ?? ''
  cfg.value.rules.push(newAutoRule(fallback))
  await onPersist()
}

const removeRule = async (idx: number) => {
  const [bak] = cfg.value.rules.splice(idx, 1)
  await onPersist()
  if (bak) emit('notify', t('bd.autoRuleDeleted'))
}

const move = async (idx: number, dir: -1 | 1) => {
  const j = idx + dir
  if (j < 0 || j >= cfg.value.rules.length) return
  const arr = cfg.value.rules
  ;[arr[idx], arr[j]] = [arr[j], arr[idx]]
  await onPersist()
}

const capture = async (idx: number) => {
  const r = cfg.value.rules[idx]
  const w = simWin.value
  if (!r || !w) return
  if (r.target === 'title') r.value = w.title
  else if (r.target === 'both') {
    r.value = w.processName || w.executablePath
    r.titleValue = w.title
  } else {
    r.value = w.processName || w.executablePath
  }
  await onPersist()
  emit('notify', t('bd.autoCaptured', { name: w.name }))
}

const createFromWin = async () => {
  const w = simWin.value
  if (!w) return
  const rule = newAutoRule(props.profiles[0]?.id ?? '')
  rule.target = 'app'
  rule.op = 'contains'
  rule.value = w.processName || w.executablePath
  cfg.value.rules.push(rule)
  await onPersist()
  emit('notify', t('bd.autoRuleCreated', { name: w.name }))
}

const testNow = () => {
  const w = simWin.value
  if (!cfg.value.enabled) {
    emit('notify', t('bd.autoEnableFirst'))
    return
  }
  if (!w) return
  const res = resolveProfileForWin(cfg.value.rules, w, validProfile, cfg.value.defaultProfileId)
  if (!res) {
    emit('notify', t('bd.autoNoMatch', { name: w.name }))
    return
  }
  emit('activate-profile', res.profileId, w)
}

const show = async (focusProfileId?: string) => {
  await loadConfiguration()
  await refreshWindows()
  // Foco desde la pestaña Perfiles: si ese perfil no tiene regla, crea una vacía
  if (focusProfileId && validProfile(focusProfileId) && !cfg.value.rules.some((r) => r.profileId === focusProfileId)) {
    const rule = newAutoRule(focusProfileId)
    cfg.value.rules.push(rule)
    await persist()
    emit('config-changed')
  }
  defaultSel.value = cfg.value.defaultProfileId ?? KEEP
  const first = simWindows.value[0]
  if (first) simId.value = simKey(first)
  dialog.value?.showModal()
}

const close = () => dialog.value?.close()

defineExpose({ show, close })
</script>
