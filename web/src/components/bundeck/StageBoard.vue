<template>
  <section class="bd-stage">
    <div class="bd-tool">
      <div class="bd-seg" role="group" :aria-label="t('bd.mode')">
        <button data-md="edit" :aria-pressed="mode === 'edit'" @click="$emit('mode-change', 'edit')">
          {{ t('bd.edit') }}
        </button>
        <button data-md="use" :aria-pressed="mode === 'use'" @click="$emit('mode-change', 'use')">
          {{ t('bd.use') }}
        </button>
      </div>

      <div class="bd-step">
        <span>{{ t('bd.rows') }}</span>
        <button data-d="r-1" :aria-label="t('bd.decreaseRow')" :disabled="gridRows <= 2" @click="$emit('grid-size-change', 0, -1)">−</button>
        <output>{{ gridRows }}</output>
        <button data-d="r1" :aria-label="t('bd.increaseRow')" :disabled="gridRows >= 6" @click="$emit('grid-size-change', 0, 1)">+</button>
      </div>
      <div class="bd-step">
        <span>{{ t('bd.columns') }}</span>
        <button data-d="c-1" :aria-label="t('bd.decreaseCol')" :disabled="gridCols <= 3" @click="$emit('grid-size-change', -1, 0)">−</button>
        <output>{{ gridCols }}</output>
        <button data-d="c1" :aria-label="t('bd.increaseCol')" :disabled="gridCols >= 8" @click="$emit('grid-size-change', 1, 0)">+</button>
      </div>

    </div>

    <div class="bd-floor">
      <div class="bd-crumb">
        <template v-if="navTrail.length > 1">
          <button class="bd-btn" @click="$emit('nav-back')">
            <ArrowLeft :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.back') }}
          </button>
          <span>
            <template v-for="(name, i) in navTrail" :key="i">
              <b v-if="i === navTrail.length - 1">{{ name }}</b>
              <template v-else>{{ name }} › </template>
            </template>
          </span>
        </template>
      </div>

      <div
        ref="container"
        :key="domVersion"
        data-swapy-container
        class="bd-plate"
        :data-l="labelMode"
        :style="{ '--bd-c': gridCols }"
        @keydown="onKeyNav"
      >
        <div v-for="index in gridCols * gridRows" :key="`slot-${index - 1}`" :data-swapy-slot="`slot-${index - 1}`">
          <div
            :key="getButton(index - 1) ? `item-${getButton(index - 1)!.id}` : `empty-${index - 1}`"
            :data-swapy-item="getButton(index - 1) ? `item-${getButton(index - 1)!.id}` : `empty-${index - 1}`"
            style="width: 100%; height: 100%"
          >
            <button
              class="bd-key"
              :class="{
                'bd-empty': !getButton(index - 1),
                'bd-hit': executingButtons.includes(index - 1)
              }"
              :data-id="`${Math.floor((index - 1) / gridCols)}:${(index - 1) % gridCols}`"
              :aria-pressed="selectedButton === index - 1"
              :aria-label="keyAriaLabel(index - 1)"
              :tabindex="mode === 'use' && !getButton(index - 1) ? -1 : undefined"
              :style="keyColorVar(index - 1)"
              data-cy="bd-key"
              @click="onKeyClick(index - 1)"
              @dblclick="mode === 'edit' ? $emit('button-execute', index - 1) : null"
              @pointerdown="onPressStart($event, index - 1)"
              @pointerup="onPressEnd(index - 1)"
              @pointercancel="onPressCancel"
              @pointerleave="onPressCancel"
              @contextmenu.prevent.stop="showContextMenu($event, index - 1)"
              @dragover.prevent="onDragOver($event, index - 1)"
              @dragleave="onDragLeave($event)"
              @drop.prevent="onDrop($event, index - 1)"
            >
              <template v-if="getButton(index - 1)">
                <span v-if="keyTop(index - 1)" class="bd-tt" :style="keyFont(index - 1)">{{ keyTop(index - 1) }}</span>
                <component
                  v-if="keyDyn(index - 1)"
                  :is="'span'"
                  class="bd-dyn"
                >{{ keyDyn(index - 1) }}</component>
                <component
                  v-else-if="keyIcon(index - 1)"
                  :is="keyIcon(index - 1)"
                  :size="28"
                  :stroke-width="1.75"
                  aria-hidden="true"
                />
                <span v-else-if="keyEmoji(index - 1)" style="font-size: 24px" aria-hidden="true">{{ keyEmoji(index - 1) }}</span>
                <span v-if="keyBottom(index - 1)" class="bd-tb" :style="keyFont(index - 1)">{{ keyBottom(index - 1) }}</span>
                <small v-else-if="labelMode !== 'n' && showTitleOf(index - 1) && keyLabel(index - 1)">{{ keyLabel(index - 1) }}</small>
                <span v-if="actionCount(index - 1) > 1" class="bd-bdg">
                  {{ actionCount(index - 1) }}
                </span>
              </template>
              <Plus v-else-if="mode === 'edit'" :size="16" stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <div class="bd-pages">
        <template v-for="page in currentPages" :key="page.id">
          <input
            v-if="renamingPageId === page.id"
            class="bd-inp bd-pin"
            type="text"
            :value="page.name"
            :aria-label="t('bd.renamePage')"
            data-cy="bd-page-rename-input"
            @keydown.enter="commitRename(($event.target as HTMLInputElement).value)"
            @keydown.escape="renamingPageId = null"
            @blur="commitRename(($event.target as HTMLInputElement).value)"
            :ref="(el) => { if (el) (el as HTMLInputElement).focus() }"
          />
          <div v-else class="bd-page" :class="{ 'bd-with-menu': mode === 'edit' }">
            <button
              class="bd-chip"
              :aria-pressed="page.id === currentPage?.id"
              :disabled="busy"
              @click="$emit('page-select', page.id)"
            >
              <Folder v-if="page.is_folder === 1" :size="14" stroke-width="1.75" aria-hidden="true" />{{ page.name }}
            </button>
            <button
              v-if="mode === 'edit'"
              class="bd-pagemenu-btn"
              :title="t('bd.pageMenu')"
              :aria-label="`${t('bd.pageMenu')}: ${page.name}`"
              :aria-expanded="menuPageId === page.id"
              aria-haspopup="menu"
              :disabled="busy"
              :data-cy="`bd-page-menu-${page.id}`"
              @click.stop="menuPageId = menuPageId === page.id ? null : page.id"
            >
              <Ellipsis :size="16" stroke-width="1.75" aria-hidden="true" />
            </button>
            <div v-if="menuPageId === page.id" class="bd-menu" role="menu">
              <button role="menuitem" @click="openRename(page.id)">
                <Pencil :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.rename') }}
              </button>
              <button
                role="menuitem"
                class="bd-dng"
                :disabled="currentPages.length < 2"
                @click="menuPageId = null; $emit('page-delete', page)"
              >
                <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.delete') }}
              </button>
            </div>
          </div>
        </template>
        <template v-if="mode === 'edit'">
          <button class="bd-pageadd" :class="{ 'bd-spin': busy }" :disabled="busy" :title="t('bd.addPage')" :aria-label="t('bd.addPage')" @click="$emit('page-create')" data-cy="bd-page-add">
            <RefreshCw v-if="busy" :size="16" stroke-width="1.75" aria-hidden="true" />
            <Plus v-else :size="16" stroke-width="1.75" aria-hidden="true" />
          </button>
        </template>
      </div>

      <p class="bd-cap">{{ caption }}</p>
    </div>

    <ContextMenu
      :show="contextMenu.show"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :items="contextMenuItems"
      @item-click="handleContextMenuItem"
      @close="hideContextMenu"
    />
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { createSwapy, type Swapy } from 'swapy'
import {
  Plus, Pencil, Trash2, Folder, ArrowLeft, RefreshCw, Ellipsis, Play, FileUp, FileDown
} from 'lucide-vue-next'
import * as LucideIcons from 'lucide-vue-next'
import ContextMenu from '../ContextMenu.vue'
import { useI18nStore } from '../../composables/useI18n'
import type { ButtonEntity, PageData } from '../../types/streamdeck'

const { t } = useI18nStore()

interface Props {
  gridCols: number
  gridRows: number
  selectedButton: number | null
  executingButtons: number[]
  buttonConfig: any
  getButton: (position: number) => ButtonEntity | undefined
  getButtonData: (position: number) => any
  /** Datos con apariencia condicional ya aplicada (opcional). */
  displayData?: (position: number) => any
  mode: 'edit' | 'use'
  labelMode: 'a' | 'h' | 'n'
  currentPages: PageData[]
  currentPage: PageData | null
  navTrail: string[]
  profileName: string
  busy: boolean
}

interface Emits {
  (e: 'button-click', position: number): void
  (e: 'button-execute', position: number): void
  (e: 'button-long-press', position: number): void
  (e: 'button-delete', position: number): void
  (e: 'button-export', position: number): void
  (e: 'button-import', position: number): void
  (e: 'swap', event: any): void
  (e: 'grid-size-change', deltaX: number, deltaY: number): void
  (e: 'mode-change', mode: 'edit' | 'use'): void
  (e: 'page-select', pageId: string): void
  (e: 'page-create'): void
  (e: 'page-delete', page: PageData | null): void
  (e: 'page-rename', pageId: string, name: string): void
  (e: 'nav-back'): void
  (e: 'action-drop', position: number, actionType: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const container = ref<HTMLElement | null>(null)
const swapy = ref<Swapy | null>(null)
// Swapy mueve nodos DOM imperativamente y el patch de Vue sobre esos nodos
// movidos restaura el orden viejo (probado: ni con :key por item se evita).
// Por eso al terminar un drag se destruye Swapy, se remonta el plate desde
// el estado optimista (Vue reconstruye el DOM correcto) y se crea una
// instancia nueva sobre el DOM ya reconciliado.
const domVersion = ref(0)
const renamingPageId = ref<string | null>(null)
const menuPageId = ref<string | null>(null)

const openRename = (pageId: string) => {
  menuPageId.value = null
  renamingPageId.value = pageId
}

// Cerrar el menú de página al pulsar fuera o con Escape
const onDocClick = (e: MouseEvent) => {
  if (!(e.target as HTMLElement).closest?.('.bd-page')) menuPageId.value = null
}

const caption = computed(() =>
  t('bd.caption', {
    profile: props.profileName,
    r: props.gridRows,
    c: props.gridCols,
    used: props.currentPages.length ? countUsed.value : 0,
    total: props.gridCols * props.gridRows
  })
)

const countUsed = computed(() => {
  let n = 0
  for (let i = 0; i < props.gridCols * props.gridRows; i++) {
    if (props.getButton(i)) n++
  }
  return n
})

const getLucideIcon = (iconName: string) => {
  const icons = LucideIcons as Record<string, any>
  return icons[iconName] ?? null
}

/** Datos con apariencia condicional aplicada si el padre la resuelve. */
const disp = (position: number) => props.displayData ? props.displayData(position) : props.getButtonData(position)

const keyIcon = (position: number) => {
  const icon = disp(position)?.icon
  return icon ? getLucideIcon(icon) : null
}
const keyEmoji = (position: number) => disp(position)?.emoji ?? ''
const keyTop = (position: number) => disp(position)?.textTop ?? ''
const keyBottom = (position: number) => disp(position)?.textBottom ?? ''
const keyDyn = (position: number) => props.getButtonData(position)?.dynamicValue ?? ''
const keyFont = (position: number) => {
  const fs = disp(position)?.fontSize
  return fs ? { fontSize: `${fs}px` } : undefined
}
const showTitleOf = (position: number) => disp(position)?.showTitle !== false
const keyLabel = (position: number) => {
  const d = disp(position)
  return d?.label || d?.textTop || d?.textBottom || ''
}
const keyColorVar = (position: number) => {
  const btn = props.getButton(position)
  if (!btn) return undefined
  const d = disp(position)
  const style: any = { '--bd-g': d?.textColor || '#e8e9eb' }
  // Color de fondo propio del botón (como en la UI clásica)
  if (d?.backgroundColor) style.background = d.backgroundColor
  return style
}
const keyAriaLabel = (position: number) => {
  const btn = props.getButton(position)
  if (!btn) {
    const r = Math.floor(position / props.gridCols)
    const c = position % props.gridCols
    return `Tecla vacía, fila ${r + 1}, columna ${c + 1}`
  }
  return keyLabel(position) || 'Tecla'
}

const onKeyClick = (position: number) => {
  if (longFired) {
    longFired = false
    return
  }
  if (props.mode === 'use') {
    emit('button-execute', position)
    return
  }
  emit('button-click', position)
}

// Pulsación larga (solo modo uso y si la tecla tiene reglas «long»).
// 600 ms mantenida → emite button-long-press y el clic posterior se consume.
let longTimer: ReturnType<typeof setTimeout> | null = null
let longFired = false
const LONG_MS = 600
const hasLongRules = (position: number) =>
  !!props.getButtonData(position)?.rules?.some((r: any) => r?.on && r?.when === 'long')
const onPressStart = (event: PointerEvent, position: number) => {
  if (props.mode !== 'use' || (event.button !== undefined && event.button !== 0)) return
  if (!hasLongRules(position)) return
  longFired = false
  if (longTimer) clearTimeout(longTimer)
  longTimer = setTimeout(() => {
    longTimer = null
    longFired = true
    emit('button-long-press', position)
  }, LONG_MS)
}
const onPressEnd = (_position: number) => {
  if (longTimer) {
    clearTimeout(longTimer)
    longTimer = null
  }
}
const onPressCancel = () => {
  if (longTimer) {
    clearTimeout(longTimer)
    longTimer = null
  }
  longFired = false
}

const actionCount = (position: number) => {
  const d = props.getButtonData(position)
  return (d?.actions?.length ?? 0) + (d?.rules?.length ?? 0)
}

// Arrastrar acción de la biblioteca sobre una tecla
const onDragOver = (event: DragEvent, position: number) => {
  if (!event.dataTransfer?.types.includes('application/json')) return
  if (props.mode !== 'edit') return
  ;(event.currentTarget as HTMLElement).classList.add('bd-over')
}
const onDragLeave = (event: DragEvent) => {
  ;(event.currentTarget as HTMLElement).classList.remove('bd-over')
}
const onDrop = (event: DragEvent, position: number) => {
  ;(event.currentTarget as HTMLElement).classList.remove('bd-over')
  if (props.mode !== 'edit') return
  try {
    const raw = event.dataTransfer?.getData('application/json')
    if (!raw) return
    const data = JSON.parse(raw)
    if (data?.type) emit('action-drop', position, data.type)
  } catch {
    /* noop */
  }
}

// Navegación con flechas entre teclas
const onKeyNav = (event: KeyboardEvent) => {
  const map: Record<string, [number, number]> = {
    ArrowRight: [0, 1],
    ArrowLeft: [0, -1],
    ArrowDown: [1, 0],
    ArrowUp: [-1, 0]
  }
  const d = map[event.key]
  const el = (event.target as HTMLElement).closest?.('.bd-key')
  if (!d || !el?.dataset.id) return
  const [r, c] = el.dataset.id.split(':').map(Number)
  const next = container.value?.querySelector(`[data-id="${r + d[0]}:${c + d[1]}"]`) as HTMLElement | null
  if (next) {
    event.preventDefault()
    next.focus()
  }
}

// Menú contextual (clic derecho) — también en modo Usar: exportar/importar.
const contextMenu = ref({ show: false, x: 0, y: 0, position: -1 })
const contextMenuItems = computed(() => {
  const button = props.getButton(contextMenu.value.position)
  // t('bd.*') no se puede usar fuera del setup traducido aquí, pero el
  // componente ya importa `t` de useI18nStore: lo usamos para etiquetas.
  if (button) {
    const items = [
      { id: 'execute', label: t('bd.pressKey'), icon: Play, danger: false },
      { id: 'export', label: t('bd.exportKey'), icon: FileUp, danger: false },
      { id: 'import', label: t('bd.importKey'), icon: FileDown, danger: false }
    ]
    if (props.mode === 'edit') {
      items.push({ id: 'delete', label: t('bd.delete'), icon: Trash2, danger: false })
    }
    return items
  }
  return [
    { id: 'create', label: t('bd.emptyKey'), icon: Plus, danger: false },
    { id: 'import', label: t('bd.importKey'), icon: FileDown, danger: false }
  ]
})
const showContextMenu = (event: MouseEvent, position: number) => {
  event.preventDefault()
  contextMenu.value = { show: true, x: event.clientX, y: event.clientY, position }
}
const hideContextMenu = () => {
  contextMenu.value.show = false
}
const handleContextMenuItem = (item: any) => {
  if (item.id === 'execute') emit('button-execute', contextMenu.value.position)
  else if (item.id === 'delete') emit('button-delete', contextMenu.value.position)
  else if (item.id === 'export') emit('button-export', contextMenu.value.position)
  else if (item.id === 'import') emit('button-import', contextMenu.value.position)
  else emit('button-click', contextMenu.value.position)
  hideContextMenu()
}

// Swapy — sin cambios funcionales respecto a la app anterior
const initializeSwapy = () => {
  if (container.value && !swapy.value && props.mode === 'edit') {
    try {
      swapy.value = createSwapy(container.value, { animation: 'dynamic' })
      swapy.value.onSwapEnd((event) => emit('swap', event))
    } catch (e) {
      console.error('[swapy] createSwapy failed:', e)
      swapy.value = null
    }
  }
}

// Tras un swap (estado ya sincronizado + re-render), re-vincular Swapy al DOM
const resyncSwapy = () => {
  if (props.mode !== 'edit') return
  swapy.value?.destroy()
  swapy.value = null
  // Remontar el plate: el DOM que dejó Swapy (nodos movidos a mano) se
  // descarta y Vue lo reconstruye desde el estado optimista.
  domVersion.value += 1
  // El ref apunta al nodo nuevo solo tras el patch: si aún no está,
  // reintentar en el siguiente tick en vez de dejar el grid sin Swapy.
  const bind = (retries: number) => {
    initializeSwapy()
    if (!swapy.value && retries > 0 && props.mode === 'edit') {
      void nextTick().then(() => bind(retries - 1))
    }
  }
  void nextTick().then(() => bind(3))
}
watch(
  () => props.mode,
  (mode) => {
    menuPageId.value = null
    if (mode === 'edit') initializeSwapy()
    else {
      swapy.value?.destroy()
      swapy.value = null
    }
  }
)

// Firma del contenido del grid: Swapy se crea con el grid vacío (los botones
// llegan por API después del mount) y su mapa interno quedaría con todo
// `empty` para siempre: el primer drag operaría sobre ese mapa rancio y la
// tecla "volvería" a su sitio. Al cambiar botones/tamaño se re-vincula Swapy
// al DOM reconciliado. Es el único resync automático: handleSwap ya no
// fuerza ninguno en la ruta feliz (lo dispararía dos veces).
const gridSignature = computed(() => {
  const parts: string[] = [`${props.gridCols}x${props.gridRows}`]
  const total = props.gridCols * props.gridRows
  for (let i = 0; i < total; i++) {
    parts.push(props.getButton(i)?.id ?? '')
  }
  return parts.join('|')
})
watch(gridSignature, () => {
  if (props.mode !== 'edit') return
  resyncSwapy()
})

onMounted(() => {
  initializeSwapy()
  document.addEventListener('keydown', onEsc)
  document.addEventListener('click', onDocClick)
  window.addEventListener('libredeck:swapy-resync', resyncSwapy)
})
onUnmounted(() => {
  swapy.value?.destroy()
  document.removeEventListener('keydown', onEsc)
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('libredeck:swapy-resync', resyncSwapy)
})
const onEsc = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    hideContextMenu()
    menuPageId.value = null
  }
}

const commitRename = (name: string) => {
  if (renamingPageId.value && name.trim()) {
    emit('page-rename', renamingPageId.value, name.trim())
  }
  renamingPageId.value = null
}
</script>
