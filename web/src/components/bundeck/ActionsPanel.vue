<template>
  <div>
    <h1 class="bd-ttl">{{ t('bd.actionsTitle') }}</h1>
    <div class="bd-srch">
      <Search :size="16" stroke-width="1.75" aria-hidden="true" />
      <label class="bd-sr" for="bd-q">{{ t('bd.searchActions') }}</label>
      <input
        ref="searchInput"
        type="text"
        id="bd-q"
        class="bd-inp"
        :placeholder="t('bd.searchActions')"
        autocomplete="off"
        v-model="query"
      />
    </div>
    <p class="bd-hint">{{ t('bd.actionsHint') }}</p>
    <div>
      <template v-for="group in groups" :key="group.name">
        <div v-if="group.items.length" class="bd-grp">
          <button
            v-if="isUnconfigured(group.pid)"
            class="bd-ibtn bd-warn"
            :aria-label="t('bd.pluginNotConfigured')"
            :title="t('bd.pluginNotConfigured')"
            data-cy="bd-plugin-unconfigured"
            @click.stop="emit('open-plugin-settings', group.pid)"
          >
            <TriangleAlert :size="16" stroke-width="1.75" aria-hidden="true" />
          </button>
          <h3 class="bd-sh">{{ group.name }}</h3>
          <span class="bd-sp"></span>
          <div v-if="pluginHasSettings(group.pid) || pluginHasInstructions(group.pid)" class="bd-menuwrap">
            <button
              class="bd-ibtn bd-dots"
              :aria-label="t('bd.pluginMenu')"
              :aria-expanded="openMenuFor === group.pid"
              @click.stop="openMenuFor = openMenuFor === group.pid ? null : group.pid"
              data-cy="bd-plugin-menu"
            >
              <Ellipsis :size="16" stroke-width="1.75" aria-hidden="true" />
            </button>
            <div v-if="openMenuFor === group.pid" class="bd-menu" role="menu">
              <button v-if="pluginHasSettings(group.pid)" role="menuitem" @click="openMenuFor = null; emit('open-plugin-settings', group.pid)">
                <Settings :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.pluginSettings') }}
              </button>
              <button v-if="pluginHasInstructions(group.pid)" role="menuitem" @click="openMenuFor = null; emit('open-plugin-instructions', group.pid)">
                <BookOpen :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.pluginInstructions') }}
              </button>
            </div>
          </div>
        </div>
        <button
          v-for="action in group.items"
          :key="action.type"
          class="bd-act"
          :class="{ 'is-disabled': isUnconfigured(action.pid) }"
          :draggable="!isUnconfigured(action.pid)"
          :aria-disabled="isUnconfigured(action.pid)"
          :title="isUnconfigured(action.pid) ? t('bd.pluginNotConfigured') : undefined"
          data-cy="bd-action-item"
          @dragstart="onDragStart($event, action)"
          @click="onPick(action)"
        >
          <component :is="action.icon" :size="18" stroke-width="1.75" aria-hidden="true" />
          <span>{{ action.name }}</span>
        </button>
      </template>
      <p v-if="!flat.length" class="bd-hint">{{ t('bd.noActionMatch') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Search, Settings, Ellipsis, BookOpen, TriangleAlert, Variable, ToggleLeft, MessageSquare } from 'lucide-vue-next'
import { dynamicIcon } from '../../composables/useDynamicIcon'
import { useI18nStore } from '../../composables/useI18n'
import { LOCAL_ACTIONS } from '../../composables/useKeyEngine'

const { t } = useI18nStore()

interface Props {
  plugins: any[]
  detailed?: any[]
}

interface Emits {
  (e: 'action-pick', actionType: string): void
  (e: 'open-plugin-settings', pluginId: string): void
  (e: 'open-plugin-instructions', pluginId: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const openMenuFor = ref<string | null>(null)

/** Iconos locales: imports nombrados (tree-shaken). Los de plugins llegan
 *  por nombre dinámico y se resuelven diferidos (ver useDynamicIcon). */
const localIcons: Record<string, any> = { Variable, ToggleLeft, MessageSquare }
const resolveIcon = (name: unknown, fallback: any = Settings) =>
  (typeof name === 'string' && localIcons[name]) || dynamicIcon(name) || fallback

const manifestOf = (pid: string) => {
  const det = (props.detailed ?? []).find((p: any) => p.id === pid)
  if (det?.manifest) return det.manifest
  const entry = (props.plugins ?? []).find(([id]: any[]) => id === pid)
  return entry?.[1]?.manifest ?? null
}
const pluginHasSettings = (pid: string) => {
  const m = manifestOf(pid)
  return !!(m?.settingsSchema ?? m?.ui?.settingsSchema)
}
const pluginHasInstructions = (pid: string) => {
  const m = manifestOf(pid)
  return typeof m?.instructions === 'string' && m.instructions.length > 0
}

/**
 * Gating genérico (a prueba de futuro): un grupo está "sin configurar"
 * cuando el detalle del daemon dice requiresConfiguration && !configured.
 * Sin entrada en detailed (versiones viejas del daemon) no se bloquea.
 */
const detailOf = (pid: string) => (props.detailed ?? []).find((p: any) => p.id === pid)
const isUnconfigured = (pid: string) => {
  const d = detailOf(pid)
  if (!d) return false
  if (typeof d.configured === 'boolean') return d.requiresConfiguration === true && d.configured === false
  // Fallback para daemons sin `configured`: required vs values si vinieran.
  const required: string[] = d.missing ?? d.manifest?.settingsSchema?.required ?? []
  return required.length > 0 && (d.missing ?? []).length > 0
}

const flat = computed(() => {
  const list: Array<{ type: string; name: string; group: string; pid: string; icon: any }> = []
  const logicGroup = t('bd.logicGroup')
  for (const l of LOCAL_ACTIONS) {
    list.push({ type: l.type, name: t(l.nameKey), group: logicGroup, pid: 'local', icon: resolveIcon(l.icon) })
  }
  for (const entry of props.plugins ?? []) {
    const [pid, pdata] = entry
    const group = pdata?.manifest?.name ?? pid
    for (const [aid, adata] of pdata?.actions ?? []) {
      list.push({
        type: `${pid}.${aid}`,
        name: adata?.name ?? aid,
        group,
        pid,
        icon: resolveIcon(adata?.icon)
      })
    }
  }
  const q = query.value.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (a) => a.name.toLowerCase().includes(q) || a.type.toLowerCase().includes(q)
  )
})

const groups = computed(() => {
  const map = new Map<string, { name: string; pid: string; items: typeof flat.value }>()
  for (const a of flat.value) {
    if (!map.has(a.group)) map.set(a.group, { name: a.group, pid: a.pid, items: [] })
    map.get(a.group)!.items.push(a)
  }
  return [...map.values()]
})

const onDragStart = (event: DragEvent, action: { type: string; name: string; pid: string }) => {
  if (isUnconfigured(action.pid)) {
    event.preventDefault()
    return
  }
  event.dataTransfer?.setData('application/json', JSON.stringify({ type: action.type, name: action.name }))
  event.dataTransfer!.effectAllowed = 'copy'
}

const onPick = (action: { type: string; pid: string }) => {
  // Las acciones sin configurar no se pueden añadir: abren la modal de configuración.
  if (isUnconfigured(action.pid)) {
    emit('open-plugin-settings', action.pid)
    return
  }
  emit('action-pick', action.type)
}

const focusSearch = () => {
  searchInput.value?.focus()
}

// Cierra el menú ⋯ al pulsar fuera
const onDocClick = (e: MouseEvent) => {
  if (!(e.target as HTMLElement).closest?.('.bd-menuwrap')) openMenuFor.value = null
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))

defineExpose({ focusSearch })
</script>
