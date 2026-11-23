<template>
  <div class="bd-cat" data-cy="bd-catalog">
    <div class="bd-cat-tools">
      <label class="bd-sr" for="bd-cat-q">{{ t('bd.catalogSearch') }}</label>
      <input
        id="bd-cat-q"
        v-model="q"
        class="bd-inp"
        type="search"
        :placeholder="t('bd.catalogSearch')"
        autocomplete="off"
        spellcheck="false"
        data-cy="bd-catalog-search"
      />
      <label class="bd-sr" for="bd-cat-fcat">{{ t('bd.catalogCategory') }}</label>
      <select id="bd-cat-fcat" v-model="category" class="bd-inp" data-cy="bd-catalog-category">
        <option value="all">{{ t('bd.catalogAll') }}</option>
        <option v-for="c in categories" :key="c" :value="c">{{ t(`bd.cat_${c}`) }}</option>
      </select>
      <label class="bd-cat-compat" :title="t('bd.catalogCompatibleOnlyHint')">
        <span>{{ t('bd.catalogCompatibleOnly') }}</span>
        <span class="bd-sw">
          <input
            v-model="compatibleOnly"
            type="checkbox"
            role="switch"
            :aria-label="t('bd.catalogCompatibleOnly')"
            data-cy="bd-catalog-compatible"
          />
          <span aria-hidden="true"></span>
        </span>
      </label>
    </div>

    <p v-if="loading" class="bd-hint" role="status">{{ t('bd.catalogLoading') }}</p>
    <p v-else-if="loadError" class="bd-err" role="alert">
      {{ t('bd.catalogLoadError') }}
      <button class="bd-btn" @click="refresh" data-cy="bd-catalog-retry">{{ t('bd.catalogRetry') }}</button>
    </p>
    <p v-else-if="!filtered.length" class="bd-hint">{{ t('bd.catalogNoResults') }}</p>

    <div v-else class="bd-cat-list">
      <div v-for="p in filtered" :key="p.id" class="bd-lrow bd-cat-item" data-cy="bd-catalog-item">
        <div class="bd-tile">
          <component :is="iconFor(p)" :size="20" stroke-width="1.75" aria-hidden="true" />
        </div>
        <div class="bd-cat-content">
          <b class="bd-cat-title">
            {{ p.name }}
            <TriangleAlert v-if="isPrivileged(p)" :size="15" stroke-width="1.75" :title="t('bd.catalogPrivilegedHint')" :aria-label="t('bd.catalogPrivilegedHint')" />
          </b>
          <p class="bd-cat-desc">{{ p.description }}</p>
          <p class="bd-cat-meta">
            <span class="bd-chip" data-cy="bd-catalog-cat">{{ t(`bd.cat_${p.category}`) }}</span>
            <span class="bd-chip" :title="`${p.actions.length} acciones`">v{{ p.version }} · {{ t('bd.actionsCount', { n: p.actions.length }) }}</span>
            <span v-if="isInstalled(p.id)" class="bd-chip bd-chip-ok" data-cy="bd-catalog-installed"><Check :size="13" aria-hidden="true" />{{ t('bd.catalogInstalled') }}</span>
            <span v-else class="bd-chip" data-cy="bd-catalog-not-installed">{{ t('bd.catalogNotInstalled') }}</span>
            <span v-if="p.compatible === false" class="bd-chip bd-chip-warn" :title="t('bd.catalogIncompatibleHint', { v: p.compatibility?.minVersion })" data-cy="bd-catalog-compat-no">
              <TriangleAlert :size="13" aria-hidden="true" />{{ t('bd.catalogIncompatible') }}
            </span>
            <span v-else class="bd-chip bd-chip-ok" data-cy="bd-catalog-compat-ok"><Check :size="13" aria-hidden="true" />{{ t('bd.catalogCompatible') }}</span>
          </p>
        </div>
        <button
          v-if="isInstalled(p.id)"
          class="bd-btn"
          :disabled="busyId === p.id"
          :data-cy="`bd-catalog-toggle-${p.id}`"
          @click="emit('toggle-plugin', p.id, !isEnabled(p.id))"
        >
          {{ isEnabled(p.id) ? t('bd.catalogDeactivate') : t('bd.catalogActivate') }}
        </button>
        <span v-else class="bd-hint">{{ t('bd.catalogBuiltin') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { Check, Package, TriangleAlert } from 'lucide-vue-next'
import * as LucideIcons from 'lucide-vue-next'
import { simpleIcon } from '../../composables/useSimpleIcons'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

interface Props {
  /** Base de la API, ej. `http://host:3001/api/v1` (mismo patrón que PluginSettingsDialog). */
  apiBase: string
  /** Detalle de plugins instalados (contrato de PluginsPane) para badges instalado/activo. */
  detailed?: any[]
  busyId?: string | null
}

interface Emits {
  (e: 'toggle-plugin', pluginId: string, on: boolean): void
}

const props = withDefaults(defineProps<Props>(), { detailed: () => [], busyId: null })
const emit = defineEmits<Emits>()

interface CatalogItem {
  id: string
  name: string
  version: string
  description: string
  author: string
  category: string
  type: string
  permissions: string[]
  actions: Array<{ id: string; name: string; description: string }>
  compatibility?: { os: string[]; minVersion: string }
  keywords: string[]
  checksum: string
  compatible?: boolean
  installed?: boolean
  enabled?: boolean
}

const items = ref<CatalogItem[]>([])
const loading = ref(false)
const loadError = ref('')
const q = ref('')
const category = ref('all')
const compatibleOnly = ref(false)

const icons = LucideIcons as Record<string, any>
const iconFor = (p: CatalogItem) => icons[(p as any).icon] ?? simpleIcon((p as any).icon) ?? Package

const categories = computed(() => [...new Set(items.value.map((p) => p.category))].sort())

const enabledById = computed(() => {
  const map = new Map<string, boolean>()
  for (const d of props.detailed ?? []) map.set(d.id, !!d.enabled)
  for (const p of items.value) {
    if (p.enabled !== undefined && !map.has(p.id)) map.set(p.id, !!p.enabled)
  }
  return map
})
const isInstalled = (id: string) =>
  (props.detailed ?? []).some((d) => d.id === id) || items.value.some((p) => p.id === id && p.installed)
const isEnabled = (id: string) => enabledById.value.get(id) ?? false
const isPrivileged = (p: CatalogItem) =>
  (p.permissions ?? []).some((perm) => ['shell', 'system', 'filesystem'].includes(perm))

const norm = (s: string) =>
  (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

const filtered = computed(() => {
  const needle = norm(q.value.trim())
  return items.value.filter((p) => {
    if (category.value !== 'all' && p.category !== category.value) return false
    if (compatibleOnly.value && p.compatible === false) return false
    if (!needle) return true
    const hay = norm(
      [p.id, p.name, p.description, p.author, p.category, ...(p.keywords ?? []), ...(p.actions ?? []).map((a) => `${a.id} ${a.name} ${a.description}`)].join(' ')
    )
    return needle.split(/\s+/).every((tok) => hay.includes(tok))
  })
})

const refresh = async () => {
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetch(`${props.apiBase}/catalog`, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    items.value = Array.isArray(data) ? data : (data.plugins ?? [])
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
watch(() => props.apiBase, refresh)

defineExpose({ refresh })
</script>
