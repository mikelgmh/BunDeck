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
        @input="onQueryInput"
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
          :title="isUnconfigured(action.pid) ? t('bd.pluginNotConfigured') : action.name"
          data-cy="bd-action-item"
          :data-action-type="action.type"
          @dragstart="onDragStart($event, action)"
          @click="onPick(action)"
          @contextmenu.prevent="onCtx($event, action)"
        >
          <component :is="action.icon" :size="18" stroke-width="1.75" aria-hidden="true" />
          <span>{{ action.name }}</span>
          <span
            v-if="action.surface === 'control'"
            class="bd-tag bd-tag-ctl"
            :title="action.freeModeOnly ? t('bd.actFreeOnlyHint') : t('bd.actControlHint')"
            data-cy="bd-action-badge-control"
          >{{ t('bd.actControl') }}</span>
          <span
            v-else-if="action.surface === 'data'"
            class="bd-tag"
            :title="t('bd.actDataHint')"
            data-cy="bd-action-badge-data"
          >{{ t('bd.actData') }}</span>
          <span
            v-if="action.surface === 'control' && action.freeModeOnly"
            class="bd-tag"
            data-cy="bd-action-badge-free"
          >{{ t('bd.actFreeOnly') }}</span>
        </button>
      </template>
      <p v-if="!flat.length" class="bd-hint">{{ t('bd.noActionMatch') }}</p>
    </div>
    <ContextMenu
      :show="menu.show"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @item-click="onMenuItem"
      @close="menu.show = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Search, Settings, Ellipsis, BookOpen, TriangleAlert, Variable, ToggleLeft, MessageSquare, ScrollText } from 'lucide-vue-next'
import ContextMenu from '../ContextMenu.vue'
import { dynamicIcon } from '../../composables/useDynamicIcon'
import { useI18nStore } from '../../composables/useI18n'
import { usePluginLocale } from '../../composables/usePluginLocale'
import { actionSurfaceKind, matchesActionQuery } from '../../composables/useActionPresentation'
import { LOCAL_ACTIONS } from '../../composables/useKeyEngine'

const { t } = useI18nStore()
const { currentLocale, localizeActionField } = usePluginLocale()

interface Props {
  plugins: any[]
  detailed?: any[]
}

interface Emits {
  (e: 'action-pick', actionType: string): void
  (e: 'action-logs', payload: { actionType: string }): void
  (e: 'open-plugin-settings', pluginId: string): void
  (e: 'open-plugin-instructions', pluginId: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const query = ref('')
const debouncedQuery = ref('')
let queryTimer: ReturnType<typeof setTimeout> | null = null
const onQueryInput = () => {
  // La lista se reconstruye (plugins × acciones) por tecla: sin debounce el
  // filtrado corre en cada keystroke y el hover/listado va con lag.
  if (queryTimer) clearTimeout(queryTimer)
  queryTimer = setTimeout(() => { debouncedQuery.value = query.value }, 150)
}
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
  const list: Array<{ type: string; name: string; group: string; pid: string; icon: any; surface: string; freeModeOnly: boolean }> = []
  const logicGroup = t('bd.logicGroup')
  for (const l of LOCAL_ACTIONS) {
    list.push({ type: l.type, name: t(l.nameKey), group: logicGroup, pid: 'local', icon: resolveIcon(l.icon), surface: 'plain', freeModeOnly: false })
  }
  for (const entry of props.plugins ?? []) {
    const [pid, pdata] = entry
    const group = pdata?.manifest?.name ?? pid
    for (const [aid, adata] of pdata?.actions ?? []) {
      // Las acciones ocultas (alias heredados) siguen funcionando pero no se listan
      if ((adata as any)?.hidden === true) continue
      list.push({
        type: `${pid}.${aid}`,
        name: localizeActionField(adata, 'name', currentLocale.value, aid),
        group,
        pid,
        icon: resolveIcon(adata?.icon),
        // Clase de presentación: ejecución | dato dinámico | control.
        surface: actionSurfaceKind(adata),
        freeModeOnly: (adata as any)?.freeModeOnly === true
      })
    }
  }
  const q = debouncedQuery.value.trim().toLowerCase()
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

// Menú contextual sobre filas de acción: «Ver registros» emite el tipo
// de acción (sin buttonId: el diálogo muestra la columna botón).
const menu = ref({ show: false, x: 0, y: 0, actionType: '' })
const menuItems = computed(() => [
  { id: 'action-logs', label: t('bd.viewLogs'), icon: ScrollText, danger: false },
])
const onCtx = (e: MouseEvent, action: { type: string }) => {
  menu.value = { show: true, x: e.clientX, y: e.clientY, actionType: action.type }
}
const onMenuItem = () => {
  emit('action-logs', { actionType: menu.value.actionType })
  menu.value.show = false
}

// Cierra el menú ⋯ al pulsar fuera
const onDocClick = (e: MouseEvent) => {
  if (!(e.target as HTMLElement).closest?.('.bd-menuwrap')) openMenuFor.value = null
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))

defineExpose({ focusSearch })
</script>
