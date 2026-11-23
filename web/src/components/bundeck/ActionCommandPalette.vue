<template>
  <dialog ref="dlg" class="bd-dlg bd-flex bd-cmd" :aria-label="t('bd.paletteTitle')" @close="emit('close')">
    <div class="bd-dh">
      <h2>{{ t('bd.paletteTitle') }}</h2>
      <span class="bd-sp"></span>
      <button class="bd-ibtn" :aria-label="t('bd.close')" @click="close()">
        <X :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <div class="bd-srch" style="margin: 0 16px">
      <Search :size="16" stroke-width="1.75" aria-hidden="true" />
      <label class="bd-sr" for="bd-cq">{{ t('bd.searchActions') }}</label>
      <input
        ref="searchInput"
        type="text"
        id="bd-cq"
        class="bd-inp"
        :placeholder="t('bd.searchActions')"
        autocomplete="off"
        v-model="query"
        @keydown="onInputKey"
      />
    </div>
    <p class="bd-hint" style="padding: 8px 20px 0">{{ t('bd.paletteHint') }}</p>
    <div class="bd-pb bd-cmd-list" ref="listEl" role="listbox" :aria-label="t('bd.paletteTitle')">
      <template v-for="group in groups" :key="group.name">
        <template v-if="group.items.length">
          <h3 class="bd-sh" style="margin: 12px 8px 4px">{{ group.name }}</h3>
          <button
            v-for="(a, idx) in group.items"
            :key="a.type"
            role="option"
            class="bd-act"
            :class="{ 'is-disabled': isUnconfigured(a.pid) }"
            :aria-selected="flatIndex(a) === activeIndex"
            :aria-disabled="isUnconfigured(a.pid)"
            data-cy="bd-palette-item"
            @click="pick(a)"
            @keydown="onItemKey($event, a)"
            @mouseenter="activeIndex = flatIndex(a)"
          >
            <component :is="a.icon" :size="18" stroke-width="1.75" aria-hidden="true" />
            <span>{{ a.name }}</span>
            <span
              v-if="a.surface === 'control'"
              class="bd-tag bd-tag-ctl"
              :title="a.freeModeOnly ? t('bd.actFreeOnlyHint') : t('bd.actControlHint')"
              data-cy="bd-palette-badge-control"
            >{{ t('bd.actControl') }}</span>
            <span
              v-else-if="a.surface === 'data'"
              class="bd-tag"
              :title="t('bd.actDataHint')"
              data-cy="bd-palette-badge-data"
            >{{ t('bd.actData') }}</span>
          </button>
        </template>
      </template>
      <p v-if="!flat.length" class="bd-hint" style="padding: 16px">{{ t('bd.noActionMatch') }}</p>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { Search, X, Settings } from 'lucide-vue-next'
import * as LucideIcons from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'
import { actionSurfaceKind, matchesActionQuery } from '../../composables/useActionPresentation'
import { LOCAL_ACTIONS } from '../../composables/useKeyEngine'

const { t } = useI18nStore()

interface Props {
  plugins: any[]
  detailed?: any[]
}

interface Emits {
  (e: 'pick', actionType: string): void
  (e: 'open-plugin-settings', pluginId: string): void
  (e: 'close'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const dlg = ref<HTMLDialogElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const query = ref('')
const activeIndex = ref(0)

const icons = LucideIcons as Record<string, any>

const detailOf = (pid: string) => (props.detailed ?? []).find((p: any) => p.id === pid)
const isUnconfigured = (pid: string) => {
  const d = detailOf(pid)
  if (!d) return false
  if (typeof d.configured === 'boolean') return d.requiresConfiguration === true && d.configured === false
  const required: string[] = d.missing ?? d.manifest?.settingsSchema?.required ?? []
  return required.length > 0 && (d.missing ?? []).length > 0
}
const manifestOf = (pid: string) => {
  const det = (props.detailed ?? []).find((p: any) => p.id === pid)
  if (det?.manifest) return det.manifest
  const entry = (props.plugins ?? []).find(([id]: any[]) => id === pid)
  return entry?.[1]?.manifest ?? null
}

const flat = computed(() => {
  const list: Array<{ type: string; name: string; group: string; pid: string; icon: any; surface: string; freeModeOnly: boolean }> = []
  const logicGroup = t('bd.logicGroup')
  for (const l of LOCAL_ACTIONS) {
    list.push({ type: l.type, name: t(l.nameKey), group: logicGroup, pid: 'local', icon: icons[l.icon] ?? Settings, surface: 'plain', freeModeOnly: false })
  }
  for (const entry of props.plugins ?? []) {
    const [pid, pdata] = entry
    const group = pdata?.manifest?.name ?? manifestOf(pid)?.name ?? pid
    for (const [aid, adata] of pdata?.actions ?? []) {
      list.push({
        type: `${pid}.${aid}`,
        name: adata?.name ?? aid,
        group,
        pid,
        icon: icons[adata?.icon] ?? Settings,
        surface: actionSurfaceKind(adata),
        freeModeOnly: (adata as any)?.freeModeOnly === true
      })
    }
  }
  const q = query.value.trim().toLowerCase()
  if (!q) return list
  return list.filter((a) => matchesActionQuery(a, q))
})

const groups = computed(() => {
  const map = new Map<string, { name: string; pid: string; items: typeof flat.value }>()
  for (const a of flat.value) {
    if (!map.has(a.group)) map.set(a.group, { name: a.group, pid: a.pid, items: [] })
    map.get(a.group)!.items.push(a)
  }
  return [...map.values()]
})

const flatIndex = (a: { type: string }) => flat.value.findIndex((x) => x.type === a.type)

watch(query, () => { activeIndex.value = 0 })

function focusItem(i: number) {
  const items = listEl.value?.querySelectorAll('[data-cy="bd-palette-item"]') as NodeListOf<HTMLElement> | undefined
  items?.[i]?.focus()
}

function pick(a: { type: string; pid: string }) {
  if (isUnconfigured(a.pid)) {
    emit('open-plugin-settings', a.pid)
    return
  }
  emit('pick', a.type)
  close()
}

function onInputKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = 0
    nextTick(() => focusItem(0))
  } else if (e.key === 'Enter') {
    const first = flat.value[0]
    if (first) pick(first)
  } else if (e.key === 'Escape') {
    close()
  }
}

function onItemKey(e: KeyboardEvent, a: { type: string; pid: string }) {
  const i = flat.value.findIndex((x) => x.type === a.type)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    const n = (i + 1) % flat.value.length
    activeIndex.value = n
    focusItem(n)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (i <= 0) {
      searchInput.value?.focus()
    } else {
      activeIndex.value = i - 1
      focusItem(i - 1)
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    pick(a)
  }
}

function show() {
  query.value = ''
  activeIndex.value = 0
  if (!dlg.value?.open) dlg.value?.showModal()
  nextTick(() => searchInput.value?.focus())
}

function close() {
  dlg.value?.close()
}

defineExpose({ show, close })
</script>
