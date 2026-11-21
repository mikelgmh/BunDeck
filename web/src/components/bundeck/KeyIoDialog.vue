<template>
  <dialog ref="dlg" class="bd-dlg bd-flex" :aria-label="title" @close="emit('close')">
    <div class="bd-dh">
      <h2>{{ title }}</h2>
      <span class="bd-sp"></span>
      <button class="bd-ibtn" :aria-label="t('bd.close')" @click="close()">
        <X :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <div class="bd-pb" style="gap: 16px">
      <template v-if="mode === 'export'">
        <p>{{ exportIntro }}</p>
        <div v-if="needsPlugins.length" class="bd-warnbox">
          <Puzzle :size="16" stroke-width="1.75" aria-hidden="true" />
          <div>
            <b>{{ t('bd.exportNeedsPlugins') }}</b>
            <p>{{ needsPlugins.join(', ') }}</p>
          </div>
        </div>
        <label class="bd-sr" for="bd-iotx">{{ t('bd.keyCodeLabel') }}</label>
        <textarea id="bd-iotx" ref="exportArea" class="bd-inp bd-code" readonly rows="12" spellcheck="false" :value="exportText"></textarea>
        <div class="bd-chips">
          <button class="bd-btn bd-pri" data-cy="bd-io-copy" @click="emit('copy')">
            <Copy :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.copyCode') }}
          </button>
        </div>
        <p class="bd-hint">{{ t('bd.trustWarning') }}</p>
      </template>
      <template v-else>
        <p>{{ importIntro }}</p>
        <label class="bd-sr" for="bd-iotx">{{ t('bd.keyCodeLabel') }}</label>
        <textarea
          id="bd-iotx"
          ref="importArea"
          class="bd-inp bd-code"
          rows="9"
          spellcheck="false"
          :placeholder="t('bd.keyCodePlaceholder')"
          :value="importText"
          @input="emit('update:text', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>
        <div class="bd-chips">
          <label class="bd-btn" style="cursor: pointer">
            <Upload :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.chooseFile') }}
            <input type="file" accept=".json,application/json" class="bd-sr" @change="onFile" />
          </label>
        </div>
        <p v-if="parseError" class="bd-err" role="alert">{{ parseError }}</p>
        <template v-if="summary">
          <div class="bd-card">
            <div class="bd-top">
              <div class="bd-tile"><component :is="summaryIcon" :size="20" stroke-width="1.75" aria-hidden="true" /></div>
              <div>
                <b>{{ summary.key.label || t('bd.emptyKey') }}</b>
                <p>{{ summaryMeta }}</p>
              </div>
            </div>
          </div>
          <div v-if="varsInfo.length" class="bd-warnbox">
            <Variable :size="16" stroke-width="1.75" aria-hidden="true" />
            <div>
              <b>{{ t('bd.varsUsedTitle') }}</b>
              <p>{{ varsText }}</p>
            </div>
          </div>
          <div v-if="pluginRows.length">
            <b>{{ t('bd.pluginsNeeded') }}</b>
            <div v-for="p in pluginRows" :key="p.id" class="bd-lrow">
              <div class="bd-tile"><component :is="pluginIcon(p)" :size="20" stroke-width="1.75" aria-hidden="true" /></div>
              <div>
                <b>{{ p.name }}</b>
                <p>v{{ p.version }} · {{ p.by }} · {{ p.marketplaceUrl ? t('bd.marketplaceTag') : t('bd.codeOnlyTag') }}</p>
              </div>
              <span v-if="p.ok" class="bd-mono bd-cap">{{ t('bd.installed') }}</span>
              <button v-else class="bd-btn" @click="emit('install-plugin', p.id)">{{ p.exists ? t('bd.activate') : t('bd.install') }}</button>
            </div>
          </div>
          <p v-if="!canPlace" class="bd-err" role="alert">{{ t('bd.noFreeSlot') }}</p>
          <p v-else-if="willReplace" class="bd-cap">{{ t('bd.willReplace', { pos: targetLabel }) }}</p>
          <p class="bd-hint">{{ t('bd.trustWarning') }}</p>
          <div class="bd-chips">
            <button v-if="missingCount > 0" class="bd-btn" @click="emit('install-all')">
              {{ missingCount > 1 ? t('bd.installAll') : t('bd.installOne') }}
            </button>
            <button class="bd-btn bd-pri" data-cy="bd-io-confirm" :disabled="!canImport" @click="emit('confirm')">
              {{ t('bd.importKeyBtn') }}
            </button>
          </div>
        </template>
      </template>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { X, Copy, Upload, Puzzle, Variable, Settings } from 'lucide-vue-next'
import * as LucideIcons from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()
const icons = LucideIcons as Record<string, any>

interface Props {
  mode: 'export' | 'import'
  exportText?: string
  exportIntro?: string
  needsPlugins?: string[]
  importText?: string
  importIntro?: string
  parseError?: string
  summary?: any | null
  pluginRows?: Array<{ id: string; name: string; version: string; by: string; icon?: string; marketplaceUrl?: string | null; ok: boolean; exists: boolean }>
  varsInfo?: Array<{ n: string; exists: boolean }>
  missingCount?: number
  canPlace?: boolean
  willReplace?: boolean
  canImport?: boolean
  targetLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  exportText: '',
  exportIntro: '',
  needsPlugins: () => [],
  importText: '',
  importIntro: '',
  parseError: '',
  summary: null,
  pluginRows: () => [],
  varsInfo: () => [],
  missingCount: 0,
  canPlace: true,
  willReplace: false,
  canImport: false,
  targetLabel: ''
})

interface Emits {
  (e: 'copy'): void
  (e: 'update:text', text: string): void
  (e: 'file', file: File): void
  (e: 'install-plugin', id: string): void
  (e: 'install-all'): void
  (e: 'confirm'): void
  (e: 'close'): void
}

const emit = defineEmits<Emits>()
const dlg = ref<HTMLDialogElement | null>(null)
const exportArea = ref<HTMLTextAreaElement | null>(null)
const importArea = ref<HTMLTextAreaElement | null>(null)

const title = computed(() => props.mode === 'export' ? t('bd.exportKeyTitle') : t('bd.importKeyTitle'))
const summaryIcon = computed(() => {
  const n = props.summary?.key?.icon
  return (n && icons[n]) ?? Settings
})
const summaryMeta = computed(() => {
  const s = props.summary
  if (!s) return ''
  const n = s.key.actions.length
  const np = s.pages.length
  const nr = (s.key.rules ?? []).length
  return `${n} ${n === 1 ? 'acción' : 'acciones'}${nr ? ` · ${nr} ${nr === 1 ? 'regla' : 'reglas'}` : ''}${np ? ` · ${np} ${np === 1 ? 'carpeta' : 'carpetas'}` : ''}`
})
const varsText = computed(() =>
  props.varsInfo.map((v) => `${v.n}${v.exists ? ` (${t('bd.varExistsShort')})` : ` (${t('bd.varNewShort')})`}`).join(', ') + '.'
)
const pluginIcon = (p: { icon?: string }) => (p.icon && icons[p.icon]) ?? Puzzle

function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) emit('file', f)
}

function show() {
  if (!dlg.value?.open) dlg.value?.showModal()
  setTimeout(() => (props.mode === 'export' ? exportArea.value : importArea.value)?.focus(), 50)
}
function close() {
  dlg.value?.close()
}

defineExpose({ show, close })
</script>
