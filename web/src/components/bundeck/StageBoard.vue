<template>
  <section class="bd-stage" :class="{ 'bd-kiosk': kiosk }" :data-cy="kiosk ? 'bd-kiosk-grid' : undefined">
    <div v-if="!kiosk" class="bd-tool">
      <div class="bd-tgrp">
        <div class="bd-seg bd-modeseg" role="group" :aria-label="t('bd.mode')">
          <button data-md="edit" :aria-pressed="mode === 'edit' && !kiosk" @click="$emit('mode-change', 'edit')">
            {{ t('bd.edit') }}
          </button>
          <button data-md="use" :aria-pressed="mode === 'use' && !kiosk" @click="$emit('mode-change', 'use')">
            {{ t('bd.use') }}
          </button>
          <button data-md="kiosk" :aria-pressed="kiosk" data-cy="bd-mode-kiosk" :title="t('bd.kioskHint')" @click="$emit('kiosk-enter')">
            {{ t('bd.kiosk') }}
          </button>
        </div>
        <label class="bd-modesel">
          <span class="bd-sr">{{ t('bd.mode') }}</span>
          <select
            class="bd-inp"
            data-cy="bd-mode-select"
            :aria-label="t('bd.mode')"
            :value="kiosk ? 'kiosk' : mode"
            @change="onModeSelect(($event.target as HTMLSelectElement).value)"
          >
            <option value="edit">{{ t('bd.edit') }}</option>
            <option value="use">{{ t('bd.use') }}</option>
            <option value="kiosk">{{ t('bd.kiosk') }}</option>
          </select>
        </label>
      </div>
      <div class="bd-tgrp bd-mid">
        <div v-if="mode === 'edit'" class="bd-seg" role="group" aria-label="layout">
          <button :aria-pressed="(layoutMode ?? 'classic') === 'classic'" data-cy="bd-layout-classic" :disabled="!currentPage" :title="!currentPage ? t('bd.layoutLoadingPage') : ''" @click="$emit('layout-mode-change', 'classic')">
            {{ t('bd.layoutClassic') }}
          </button>
          <button :aria-pressed="(layoutMode ?? 'classic') === 'gridstack'" data-cy="bd-layout-gridstack" :disabled="!currentPage" :title="!currentPage ? t('bd.layoutLoadingPage') : ''" @click="$emit('layout-mode-change', 'gridstack')">
            {{ t('bd.layoutGridstack') }}
          </button>
        </div>

        <div class="bd-step" v-if="mode === 'edit'" data-cy="bd-grid-rows">
          <span>{{ t('bd.rows') }}</span>
          <button data-d="r-1" :aria-label="t('bd.decreaseRow')" :disabled="!canDecRow" :title="decRowBlocked ? t('bd.gridShrinkBlocked') : undefined" @click="$emit('grid-size-change', 0, -1)">−</button>
          <output>{{ gridRows }}</output>
          <button data-d="r1" :aria-label="t('bd.increaseRow')" :disabled="gridRows >= GRID_ROWS_MAX" @click="$emit('grid-size-change', 0, 1)">+</button>
        </div>
        <div class="bd-step" v-if="mode === 'edit'" data-cy="bd-grid-cols">
          <span>{{ t('bd.columns') }}</span>
          <button data-d="c-1" :aria-label="t('bd.decreaseCol')" :disabled="!canDecCol" :title="decColBlocked ? t('bd.gridShrinkBlocked') : undefined" @click="$emit('grid-size-change', -1, 0)">−</button>
          <output>{{ gridCols }}</output>
          <button data-d="c1" :aria-label="t('bd.increaseCol')" :disabled="gridCols >= GRID_COLS_MAX" @click="$emit('grid-size-change', 1, 0)">+</button>
        </div>
        <button
          v-if="isGsMode && mode === 'edit'"
          type="button"
          class="bd-btn bd-pri bd-gs-add-tool"
          data-cy="bd-gs-add-tool"
          :disabled="!currentPage || busy"
          :title="!currentPage ? t('bd.layoutLoadingPage') : t('bd.gsAddHint')"
          @click="$emit('gs-add')"
        >
          <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.gsAddKey') }}
        </button>
        <label v-if="mode === 'use'" class="bd-usel" data-cy="bd-preview-dev"><span>{{ t('bd.previewAs') }}</span><select :value="previewDeviceId ?? ''" :aria-label="t('bd.previewAs')" @change="$emit('preview-device-change', ($event.target as HTMLSelectElement).value || null)"><option value="">{{ t('bd.deviceNoScreen') }}…</option><option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }}</option></select></label>
      </div>

      <div class="bd-tgrp">
        <div v-if="visibleDevices.length" class="bd-dvwrap">
        <button
          type="button"
          class="bd-dvtrig"
          :class="{ 'bd-haswarn': unassignedCount > 0 }"
          :aria-expanded="devOpen"
          aria-controls="bd-dvpop"
          data-cy="bd-devices-btn"
          @click.stop="devOpen = !devOpen"
        >
          <MonitorSmartphone :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('bd.devicesTrigger') }}</span><span class="bd-dvbadge" data-cy="bd-devices-badge">{{ unassignedCount > 0 ? `⚠ ${visibleDevices.length - unassignedCount}/${visibleDevices.length}` : visibleDevices.length }}</span>
        </button>
        <div v-if="devOpen" id="bd-dvpop" class="bd-dvpop" data-cy="bd-devices-pop" role="dialog" :aria-label="t('bd.devicesTitle', { name: profileName })">
          <div class="bd-dvpop-hd"><b>{{ t('bd.devicesTitle', { name: profileName }) }}</b><button class="bd-btn" data-cy="bd-devices-manage" @click="devOpen = false; $emit('manage-devices')">{{ t('bd.devicesManage') }}</button></div>
          <div class="bd-dvpop-list">
            <label v-for="d in visibleDevices" :key="d.id" class="bd-dv" :class="{ 'bd-warn2': !assignments[d.id] }" :data-cy="`bd-device-row-${d.id}`">
              <span class="bd-dv-info"><span class="bd-dvi"><i class="bd-dot" :class="{ 'bd-ok': !!d.online }" :title="d.online ? t('bd.deviceOnline') : t('bd.deviceOffline')" aria-hidden="true"></i><component :is="deviceIcon(d.kind)" :size="18" stroke-width="1.75" aria-hidden="true" /></span><span class="bd-dvn"><span>{{ d.name }}</span><small>{{ deviceSub(d) }}</small></span></span>
              <select :value="assignments[d.id] ?? ''" :aria-label="d.name" :data-cy="`bd-device-page-${d.id}`" :title="noCompatibleTitle(d)" @change="$emit('device-assign', d.id, ($event.target as HTMLSelectElement).value || null)">
                <option value="">{{ t('bd.deviceNoScreen') }}</option>
                <option v-for="p in currentPages" :key="p.id" :value="p.id" :disabled="!compatOf(p, d).ok">{{ pageOptionLabel(p, d) }}</option>
              </select>
            </label>
          </div>
        </div>
        </div>
      </div>

    </div>

    <div class="bd-floor" ref="floorRef">
     <div class="bd-stack">
      <div v-if="showNoScreen" class="bd-gs-empty-state" data-cy="bd-no-screen">
        <p><b>{{ t('bd.deviceNoScreen') }}</b></p>
        <p class="bd-hint">{{ t('bd.deviceNoScreenHint', { name: previewDevice?.name ?? '', profile: profileName }) }}</p>
      </div>
      <template v-else>
      <div v-if="showFreeNote" class="bd-freenote" data-cy="bd-free-note"><Smartphone :size="15" stroke-width="1.75" aria-hidden="true" /><span><b>{{ t('bd.freeNote') }}</b></span></div>
      <div v-if="navTrail.length > 1" class="bd-crumb">
        <button class="bd-btn" @click="$emit('nav-back')">
          <ArrowLeft :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.back') }}
        </button>
        <span>
          <template v-for="(name, i) in navTrail" :key="i">
            <b v-if="i === navTrail.length - 1">{{ name }}</b>
            <template v-else>{{ name }} › </template>
          </template>
        </span>
      </div>

      <div
        v-if="(layoutMode ?? 'classic') === 'classic'"
        ref="container"
        :key="domVersion"
        data-swapy-container
        class="bd-plate"
        :data-l="labelMode"
        :style="plateStyle"
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
              @click="onKeyClick($event, index - 1)"
              @dblclick="mode === 'edit' ? $emit('button-execute', index - 1) : null"
              @pointerdown="onPressStart($event, index - 1)"
              @pointerup="onPressUp($event, index - 1)"
              @pointercancel="onPressCancel($event)"
              @pointerleave="onPressCancel($event)"
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
                  class="bd-dyn bd-data-swap"
                  :key="keyDyn(index - 1)"
                >{{ keyDyn(index - 1) }}</component>
                <img
                  v-else-if="keyImage(index - 1)"
                  :src="keyImage(index - 1)"
                  class="bd-kimg"
                  alt=""
                  aria-hidden="true"
                  draggable="false"
                />
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
              <Plus v-else-if="mode === 'edit' && !kiosk" :size="16" stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      <div
        v-else
        class="bd-gs-viewport"
      >
        <div
          class="bd-gs-wrap"
          :style="{ '--bd-c': gridCols, '--bd-r': gridRows, '--bd-gs-unit': `${gsCellSize}px`, '--bd-total-r': gsTotalRows }"
        >
          <div
            ref="gsContainer"
            class="grid-stack bd-gs"
            :class="{ 'bd-gs--ready': gsReady }"
            :style="{ visibility: gsReady || gsFailed ? undefined : 'hidden' }"
            data-cy="bd-gs-plate"
            @keydown="onKeyNav"
            @dragover.prevent="onGsDragOver"
            @drop.prevent="onGsDrop"
          >
            <div
              v-for="b in gsItems"
              :key="b.id"
              class="grid-stack-item"
              :gs-id="b.id"
              :gs-x="b.x"
              :gs-y="b.y"
              :gs-w="b.w"
              :gs-h="b.h"
              :data-gs-id="b.id"
            >
              <div class="grid-stack-item-content">
                <div
                  v-if="isControlSurface(b.position)"
                  class="bd-key vol-key"
                  :class="{ 'bd-sel': selectedButton === b.position }"
                  :aria-label="keyAriaLabel(b.position)"
                  :style="keyColorVar(b.position)"
                  :data-position="b.position"
                  data-cy="bd-key-vol"
                  @click="onKeyClick($event, b.position)"
                  @contextmenu.prevent.stop="showContextMenu($event, b.position)"
                  @dragover.prevent="onDragOver($event, b.position)"
                  @dragleave="onDragLeave($event)"
                  @drop.prevent="onDrop($event, b.position)"
                >
                  <ControlSurface
                    :action="controlActionOf(b.position)!"
                    :api-base="apiBase ?? ''"
                    :legacy-app="volumeAppOf(b.position)"
                    :label="keyLabel(b.position) || ''"
                    :readonly="mode !== 'use'"
                    :position="b.position"
                  />
                </div>
                <button
                  v-else
                  class="bd-key"
                  :class="{ 'bd-hit': executingButtons.includes(b.position) }"
                  :aria-pressed="selectedButton === b.position"
                  :aria-label="keyAriaLabel(b.position)"
                  :style="keyColorVar(b.position)"
                  :data-position="b.position"
                  data-cy="bd-key"
                  @click="onKeyClick($event, b.position)"
                  @dblclick="mode === 'edit' ? $emit('button-execute', b.position) : null"
                  @pointerdown="onPressStart($event, b.position)"
                  @pointerup="onPressUp($event, b.position)"
                  @pointercancel="onPressCancel($event)"
                  @pointerleave="onPressCancel($event)"
                  @contextmenu.prevent.stop="showContextMenu($event, b.position)"
                  @dragover.prevent="onDragOver($event, b.position)"
                  @dragleave="onDragLeave($event)"
                  @drop.prevent="onDrop($event, b.position)"
                >
                  <template v-if="getButton(b.position)">
                    <span v-if="keyTop(b.position)" class="bd-tt" :style="keyFont(b.position)">{{ keyTop(b.position) }}</span>
                    <component v-if="keyDyn(b.position)" :is="'span'" class="bd-dyn bd-data-swap" :key="keyDyn(b.position)">{{ keyDyn(b.position) }}</component>
                    <img
                      v-else-if="keyImage(b.position)"
                      :src="keyImage(b.position)"
                      class="bd-kimg"
                      alt=""
                      aria-hidden="true"
                      draggable="false"
                    />
                    <component
                      v-else-if="keyIcon(b.position)"
                      :is="keyIcon(b.position)"
                      :size="28"
                      :stroke-width="1.75"
                      aria-hidden="true"
                    />
                    <span v-else-if="keyEmoji(b.position)" style="font-size: 24px" aria-hidden="true">{{ keyEmoji(b.position) }}</span>
                    <span v-if="keyBottom(b.position)" class="bd-tb" :style="keyFont(b.position)">{{ keyBottom(b.position) }}</span>
                    <small v-else-if="labelMode !== 'n' && showTitleOf(b.position) && keyLabel(b.position)">{{ keyLabel(b.position) }}</small>
                    <span v-if="actionCount(b.position) > 1" class="bd-bdg">{{ actionCount(b.position) }}</span>
                  </template>
                  <Plus v-else-if="mode === 'edit' && !kiosk" :size="16" stroke-width="1.75" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      </template>
      <div v-if="!kiosk" class="bd-pages">
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
              :disabled="busy || pageBlocked(page)"
              :title="pageTitle(page)"
              :data-cy="`bd-page-${page.id}`"
              @click="$emit('page-select', page.id)"
            >
              <Folder v-if="page.is_folder === 1" :size="14" stroke-width="1.75" aria-hidden="true" /><Move v-else-if="pageLayoutOf(page) === 'gridstack'" :size="14" stroke-width="1.75" aria-hidden="true" />{{ page.name }}<span v-if="pageDevices(page).length" class="bd-dvs" :title="t('bd.shownOn', { devices: pageDevices(page).map((d) => d.name).join(', ') })"><component v-for="d in pageDevices(page).slice(0, 1)" :key="d.id" :is="deviceIcon(d.kind)" :size="12" stroke-width="1.75" aria-hidden="true" /></span>
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

      <p v-if="!kiosk" class="bd-cap">{{ caption }}</p>
     </div>
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
import type { Swapy } from 'swapy'
import 'gridstack/dist/gridstack.min.css'
// GridStack y Swapy se importan en dinámico (initGs/initializeSwapy): los
// imports estáticos engordan el chunk inicial y gridstack rompe el SSR
// de Astro (gridstack-engine sin extensión).
import {
  Plus, Pencil, Trash2, Folder, ArrowLeft, RefreshCw, Ellipsis, Play, FileUp, FileDown, Move, Monitor, Smartphone, Tablet, MonitorSmartphone, ScrollText
} from 'lucide-vue-next'
import ControlSurface from './ControlSurface.vue'
import { findControlAction } from '../../composables/useActionPresentation'
import { dynamicIcon } from '../../composables/useDynamicIcon'
import {
  gridResizeFits,
  GRID_COLS_MAX,
  GRID_COLS_MIN,
  GRID_ROWS_MAX,
  GRID_ROWS_MIN,
} from '../../composables/useDeckLayouts'
import ContextMenu from '../ContextMenu.vue'
import { useI18nStore } from '../../composables/useI18n'
import { bdAnimations, bdLongPressMs } from '../../composables/useBunDeckUi'
import { createPressFx, playPressFx, clearHoldFx } from '../../composables/usePressFx'
import { pressFeedback } from '../../composables/useFeedback'
import { hasLongContent } from '../../composables/usePressActions'
import { checkPageCompatibility, parseLayoutMode, resolvePageSize, resolveDeckSize, type LogicalDevice, type CompatView } from '../../composables/useDevices'
import { assetUrl, isAssetRef } from '../../composables/useKeyShare'
import type { ButtonEntity, PageData } from '../../types/streamdeck'

const { t } = useI18nStore()

interface Props {
  gridCols: number
  gridRows: number
  /** Tamaño real de tecla; en modo libre una celda mide keySize + 12px. */
  keySize?: number
  /** 'classic' = rejilla fija por position; 'gridstack' = redimensionable por x/y/w/h. */
  layoutMode?: 'classic' | 'gridstack'
  selectedButton: number | null
  executingButtons: number[]
  buttonConfig: any
  getButton: (position: number) => ButtonEntity | undefined
  /** Todos los botones de la página (para modo gridstack). */
  allButtons?: ButtonEntity[]
  getButtonData: (position: number) => any
  /** Datos con apariencia condicional ya aplicada (opcional). */
  displayData?: (position: number) => any
  mode: 'edit' | 'use'
  /** Modo kiosco: solo grid, sin toolbar ni navegación de páginas ni menús. */
  kiosk?: boolean
  labelMode: 'a' | 'h' | 'n'
  currentPages: PageData[]
  currentPage: PageData | null
  navTrail: string[]
  profileName: string
  busy: boolean
  /** Base de la API (puerto 3001): las imágenes `/assets/…` cuelgan de ahí. */
  apiBase?: string
  /** Dispositivos lógicos + qué pantalla muestra cada uno en este perfil. */
  devices?: LogicalDevice[]
  assignments?: Record<string, string>
  /** HW físico detectado (GET /devices/streamdeck/status → isConnected).
   *  Se pasa desde BunDeckApp junto a `devices`: cubre el caso en que el
   *  HW está conectado pero su fila lógica aún no existe en la lista. */
  hwConnected?: boolean
  /** Dispositivo simulado en modo uso ("Probar en"). */
  previewDeviceId?: string | null
  /** `profiles.data` del perfil actual (herencia del tamaño de página). */
  profileData?: any
  /** Umbral de hold en ms (por defecto el ajuste `bdLongPressMs`). */
  longPressMs?: number | null
}

interface Emits {
  (e: 'button-click', position: number): void
  (e: 'button-execute', position: number): void
  (e: 'button-long-press', position: number): void
  /** Toque corto en modo uso (el engine decide click/double/triple). */
  (e: 'button-tap', position: number): void
  (e: 'button-delete', position: number): void
  (e: 'button-export', position: number): void
  (e: 'button-import', position: number): void
  (e: 'button-logs', position: number): void
  (e: 'swap', event: any): void
  (e: 'grid-size-change', deltaX: number, deltaY: number): void
  (e: 'mode-change', mode: 'edit' | 'use'): void
  (e: 'kiosk-enter'): void
  (e: 'layout-mode-change', mode: 'classic' | 'gridstack'): void
  /** GridStack: widgets movidos/redimensionados [{id,x,y,w,h}]. */
  (e: 'layout-change', items: Array<{ id: string; x: number; y: number; w: number; h: number }>): void
  /** GridStack: pedir una tecla nueva 1×1 en la primera celda libre. */
  (e: 'gs-add'): void
  /** GridStack: soltar una acción en una celda vacía crea allí una tecla. */
  (e: 'action-drop-empty', x: number, y: number, actionType: string): void
  (e: 'page-select', pageId: string): void
  (e: 'page-create'): void
  (e: 'page-delete', page: PageData | null): void
  (e: 'page-rename', pageId: string, name: string): void
  (e: 'nav-back'): void
  (e: 'action-drop', position: number, actionType: string): void
  (e: 'device-assign', deviceId: string, pageId: string | null): void
  (e: 'preview-device-change', deviceId: string | null): void
  (e: 'manage-devices'): void
}

const props = withDefaults(defineProps<Props>(), {
  keySize: 76,
  kiosk: false,
  devices: () => [],
  assignments: () => ({}),
  hwConnected: false,
  previewDeviceId: null,
  profileData: undefined,
})
const emit = defineEmits<Emits>()

/** El <select> de modo (viewport estrecho) reutiliza los mismos eventos que
 *  las tabs: 'mode-change' para edit/use y 'kiosk-enter' para kiosco (los
 *  guards y la confirmación de salida viven en el padre, sin duplicar). */
const onModeSelect = (value: string) => {
  if (value === 'kiosk') emit('kiosk-enter')
  else emit('mode-change', value === 'use' ? 'use' : 'edit')
}

const container = ref<HTMLElement | null>(null)
const swapy = ref<Swapy | null>(null)
const gsContainer = ref<HTMLElement | null>(null)
let gs: any = null
const gsReady = ref(false)
// GridStack se importa en dinámico: hasta que posiciona los widgets, los
// nodos se apilan sin estilo (flash de "botones enormes" al cambiar a Libre).
// La placa se mantiene oculta (pero con su sitio reservado) hasta que
// GridStack la adopta; si la init falla del todo se muestra igual para no
// dejar la página vacía.
const gsFailed = ref(false)

/** Items GridStack: misma tecla/drawers, geometría x/y/w/h del daemon. */
const gsItems = computed(() => {
  const list = (props.allButtons ?? []).slice()
  const cols = Math.max(1, props.gridCols)
  const rows = Math.max(1, props.gridRows)
  return list.map((b) => {
    // El ancho clásico puede cambiar después de guardar una geometría libre.
    // GridStack no pinta widgets que empiezan fuera de las columnas actuales.
    const w = Math.min(cols, Math.max(1, Math.round(Number(b.w) || 1)))
    const h = Math.max(1, Math.round(Number(b.h) || 1))
    // Sin geometría (tecla clásica con x/y NULL): deriva de position, pero
    // ENVUELTA a las filas configuradas. Antes una position más allá del grid
    // (p. ej. 99 en 5×3 → y=19) estiraba el modo libre a decenas de filas
    // con el stepper marcando 3 ("tropecientas filas").
    const pos = Number.isInteger(b.position) ? (b.position as number) : 0
    const rawX = Number.isFinite(b.x) ? Number(b.x) : pos % cols
    const rawY = Number.isFinite(b.y) ? Number(b.y) : Math.floor(pos / cols) % rows
    const x = Math.min(Math.max(0, Math.floor(rawX)), cols - w)
    const y = Math.max(0, Math.floor(rawY))
    return { id: b.id, position: b.position, x, y, w, h }
  })
})

const gsTotalRows = computed(() =>
  Math.max(props.gridRows, 1, ...gsItems.value.map((item) => item.y + item.h))
)

const isGsMode = computed(() => (props.layoutMode ?? 'classic') === 'gridstack')

/** Aviso "modo libre": solo si hay un Stream Deck detectado. Criterio OR:
 *  - algún dispositivo lógico con kind === 'deck' (HW con fila lógica), O
 *  - `hwConnected` (HW conectado según GET /devices/streamdeck/status,
 *    aunque su fila lógica aún no exista). Sin deck no se muestra. */
const hasDeckDetected = computed(
  () => (props.devices ?? []).some((d) => d?.kind === 'deck') || !!props.hwConnected
)
const showFreeNote = computed(
  () => isGsMode.value && props.mode === 'edit' && hasDeckDetected.value
)

// ---- Dispositivos y pantallas por perfil ----
const devOpen = ref(false)
const deviceList = computed(() => props.devices ?? [])
/** El desplegable solo gestiona pantallas: únicamente lo que está en línea.
 *  Los desconectados (otro origen, invitados idos, hardware apagado) se
 *  gestionan en Acceso remoto y no ensucian la asignación. */
const visibleDevices = computed(() => deviceList.value.filter((d) => !!d.online))
const previewDevice = computed(() =>
  props.previewDeviceId ? (deviceList.value.find((d) => d.id === props.previewDeviceId) ?? null) : null
)
const showNoScreen = computed(() =>
  props.mode === 'use' && !!previewDevice.value && !props.assignments?.[previewDevice.value.id]
)
const unassignedCount = computed(() =>
  visibleDevices.value.filter((d) => !props.assignments?.[d.id]).length
)
const pageViewOf = (p: PageData): CompatView => ({
  id: p.id,
  name: p.name,
  is_folder: p.is_folder,
  parent_id: (p as any).parent_id ?? null,
  grid_cols: (p as any).grid_cols ?? null,
  grid_rows: (p as any).grid_rows ?? null,
  data: (p as any).data,
})
const compatOf = (p: PageData, d: LogicalDevice) =>
  checkPageCompatibility(pageViewOf(p), d, props.profileData)
const pageLayoutOf = (p: PageData) => parseLayoutMode((p as any).data)
const pageDevices = (p: PageData) =>
  deviceList.value.filter((d) => props.assignments?.[d.id] === p.id)
const deviceIcon = (kind: string) =>
  kind === 'deck' ? Monitor : kind === 'tablet' ? Tablet : Smartphone
const deckSizeOf = (d: LogicalDevice) => {
  const s = resolveDeckSize(d)
  return s ? `${s.cols}×${s.rows}` : ''
}
const deviceSub = (d: LogicalDevice) => {
  const base = d.kind === 'deck'
    ? t('bd.deviceDeckView', { size: deckSizeOf(d) })
    : t('bd.deviceAnyView')
  return `${base} · ${d.online ? t('bd.deviceOnline') : t('bd.deviceOffline')}`
}
/** Motivo legible de incompatibilidad (o null si es compatible). */
const reasonText = (p: PageData, d: LogicalDevice): string | null => {
  const c = compatOf(p, d)
  if (c.ok) return null
  if (c.why === 'free-mode') return t('bd.deviceCompatFree')
  const size = resolvePageSize(pageViewOf(p), props.profileData)
  const want = resolveDeckSize(d)
  return t('bd.deviceCompatSize', {
    size: `${size.cols}×${size.rows}`,
    want: want ? `${want.cols}×${want.rows}` : '',
  })
}
const pageViewLabel = (p: PageData): string => {
  if (pageLayoutOf(p) === 'gridstack') return t('bd.layoutGridstack')
  const size = resolvePageSize(pageViewOf(p), props.profileData)
  return `${size.cols}×${size.rows}`
}
const pageOptionLabel = (p: PageData, d: LogicalDevice): string => {
  const base = `${p.name} · ${pageViewLabel(p)}`
  const reason = reasonText(p, d)
  return reason ? `${base} (${reason})` : base
}
/** En modo uso, el dispositivo simulado no puede abrir páginas incompatibles. */
const pageBlocked = (p: PageData): boolean => {
  if (props.mode !== 'use' || !previewDevice.value) return false
  return !compatOf(p, previewDevice.value).ok
}
const pageTitle = (p: PageData): string | undefined => {
  const parts: string[] = []
  const devs = pageDevices(p)
  if (devs.length) parts.push(t('bd.shownOn', { devices: devs.map((d) => d.name).join(', ') }))
  if (props.mode === 'use' && previewDevice.value) {
    const reason = reasonText(p, previewDevice.value)
    if (reason) parts.push(reason)
  }
  return parts.length ? parts.join(' — ') : undefined
}
const noCompatibleTitle = (d: LogicalDevice): string | undefined => {
  if (d.kind !== 'deck') return undefined
  const anyOk = props.currentPages.some((p) => compatOf(p, d).ok)
  return anyOk ? undefined : t('bd.deviceNoCompatible', { size: deckSizeOf(d) })
}

/** Igual que el ejemplo: unidad = tecla + 12px; margen 6px por lado deja
 *  el contenido de cada celda cuadrado y del mismo tamaño que la tecla fija.
 *  En kiosco + libre la unidad la impone el fit (kioskFit): celdas cuadradas
 *  que encajan en el viewport; GridStack recibe ese valor vía cellHeight. */
const GS_GUTTER = 12
const GS_MARGIN = 6
const gsCellSize = computed(() => {
  if (props.kiosk && isGsMode.value && kioskFit.value != null) {
    return Math.max(12, Math.floor(kioskFit.value))
  }
  return Math.max(1, Math.round(props.keySize)) + GS_GUTTER
})
let gsChangeTimer: ReturnType<typeof setTimeout> | null = null
/** Nodos pendientes de persistir (por id): solo gestos del usuario. */
const pendingGs = new Map<string, { id: string; x: number; y: number; w: number; h: number }>()

const destroyGs = () => {
  if (gsChangeTimer) {
    clearTimeout(gsChangeTimer)
    gsChangeTimer = null
  }
  pendingGs.clear()
  clearHoldTimer()
  fx.cancel()
  destroyFxNodes()
  try { gs?.destroy(false) } catch { /* noop */ }
  gs = null
  gsReady.value = false
  gsFailed.value = false
}

const emitGsLayout = (items: any[]) => {
  if (!Array.isArray(items)) return
  emit(
    'layout-change',
    items.map((it: any) => ({
      id: String(it.id ?? it.el?.getAttribute?.('gs-id') ?? ''),
      x: Number(it.x ?? 0),
      y: Number(it.y ?? 0),
      w: Number(it.w ?? 1),
      h: Number(it.h ?? 1),
    }))
  )
}

const initGs = async (retries = 2) => {
  if (!gsContainer.value || !isGsMode.value) return
  destroyGs()
  try {
    const { GridStack } = await import('gridstack')
    if (!gsContainer.value || !isGsMode.value) return
    const instance = GridStack.init(
      {
        column: Math.max(1, props.gridCols),
        cellHeight: gsCellSize.value,
        margin: GS_MARGIN,
        // float:true = posicionamiento libre: los widgets se quedan donde se
        // sueltan aunque queden huecos (p. ej. uno en cada esquina). Con
        // float:false GridStack aplica "gravedad" y los junta.
        float: true,
        disableOneColumnMode: true,
        minRow: Math.max(1, props.gridRows),
        // El arrastre no extiende la placa más allá del contenido existente:
        // sin maxRow, soltar abajo crecía las filas con el stepper sin tocar.
        // (column ya acota el ancho; las columnas heredadas fuera de rango
        // las reubica el propio GridStack al adoptar.)
        maxRow: gsMaxRow.value,
        staticGrid: props.mode !== 'edit',
        resizable: { handles: 'se' },
        // El agarre es la propia tecla (.bd-key): GridStack omite el mousedown
        // en <button>, salvo cuando el botón ES el handle (el handle forma
        // parte de dragEls, ver DDDraggable #2703). Así todo el botón arrastra
        // en edición y el clic sin mover sigue seleccionando/ejecutando.
        draggable: { handle: '.bd-key' },
      } as any,
      gsContainer.value
    )
    if (!instance) throw new Error('GridStack no pudo inicializar la cuadrícula')
    gs = instance
    // Algunas versiones no adoptan los hijos que Vue ya había renderizado.
    // Registrarlos explícitamente evita que el modo Libre quede visualmente vacío
    // o con widgets a ancho completo ("botón enorme").
    // OJO: no llamar a gs.compact(): compacta con gravedad y junta los
    // widgets aunque el usuario los haya separado.
    if (typeof gs.makeWidget === 'function') {
      for (const item of gsContainer.value.querySelectorAll<HTMLElement>(':scope > .grid-stack-item')) {
        if (!(item as any).gridstackNode) gs.makeWidget(item)
      }
    }
    gsReady.value = true
    // Persistir SOLO al terminar un gesto del usuario (dragstop/resizestop).
    // El evento 'change' también lo emite GridStack al adoptar/montar los
    // widgets que Vue ya renderizó (init, makeWidget, column(),
    // updateOptions...) y al resolver colisiones heredadas: persistirlo
    // reescribía la geometría guardada en cada visita a la página (widgets
    // históricos fuera de rango teletransportados por el clamp, solapes
    // "resueltos" por GridStack, nodos fantasma duplicados con sufijo `_1`
    // cuyos PUTs devolvían 500 "Botón no encontrado").
    const queueGsNode = (el: any) => {
      try {
        const node = (el as any)?.gridstackNode
          ?? (typeof gs.getNode === 'function' ? gs.getNode(el) : null)
          ?? null
        const id = node?.id
          ?? (el as HTMLElement)?.getAttribute?.('gs-id')
          ?? (el as HTMLElement)?.getAttribute?.('data-gs-id')
        if (!id) return
        pendingGs.set(String(id), {
          id: String(id),
          x: Number(node?.x ?? (el as HTMLElement)?.getAttribute?.('gs-x') ?? 0),
          y: Number(node?.y ?? (el as HTMLElement)?.getAttribute?.('gs-y') ?? 0),
          w: Number(node?.w ?? (el as HTMLElement)?.getAttribute?.('gs-w') ?? 1),
          h: Number(node?.h ?? (el as HTMLElement)?.getAttribute?.('gs-h') ?? 1),
        })
      } catch { /* noop */ }
    }
    const scheduleGsEmit = () => {
      if (gsChangeTimer) clearTimeout(gsChangeTimer)
      gsChangeTimer = setTimeout(() => {
        gsChangeTimer = null
        if (pendingGs.size === 0) return
        emitGsLayout([...pendingGs.values()])
        pendingGs.clear()
      }, 250)
    }
    gs.on('dragstop', (_e: any, el: any) => {
      queueGsNode(el)
      scheduleGsEmit()
    })
    gs.on('resizestop', (_e: any, el: any) => {
      queueGsNode(el)
      scheduleGsEmit()
    })
  } catch (e) {
    console.error('[gridstack] init failed:', e)
    gs = null
    gsReady.value = false
    if (retries > 0) setTimeout(() => void initGs(retries - 1), 300)
    else gsFailed.value = true
  }
}

/** Adoptar en GridStack los widgets que Vue acaba de renderizar
 *  (p. ej. tecla recién creada 1×1) sin destruir la instancia.
 *  Sin compact(): debe respetar la posición libre del usuario. */
const adoptGsWidgets = () => {
  if (!gs || !gsContainer.value || !isGsMode.value) return
  try {
    if (typeof gs.makeWidget === 'function') {
      for (const item of gsContainer.value.querySelectorAll<HTMLElement>(':scope > .grid-stack-item')) {
        if (!(item as any).gridstackNode) gs.makeWidget(item)
      }
    }
  } catch { /* noop */ }
}

watch([() => props.layoutMode, () => props.mode], () => {
  if (!isGsMode.value) {
    destroyGs()
    // La instancia de Swapy quedó atada al DOM clásico anterior (o a nada
    // tras pasar por Libre): hay que re-vincularla a la placa recién montada
    // o el drag & drop clásico queda muerto tras volver de Libre.
    try { swapy.value?.destroy() } catch { /* noop */ }
    swapy.value = null
    if (props.mode === 'edit') void nextTick().then(() => initializeSwapy())
    return
  }
  // Al entrar en Libre el DOM clásico se desmonta: soltar Swapy para no
  // dejar una instancia atada a nodos muertos.
  try { swapy.value?.destroy() } catch { /* noop */ }
  swapy.value = null
  if (gs) {
    try { gs.setStatic(props.mode !== 'edit') } catch { /* noop */ }
    return
  }
  void nextTick().then(initGs)
})
watch(() => props.gridCols, (cols) => {
  if (!isGsMode.value) return
  if (gs && typeof gs.column === 'function') {
    try {
      gs.column(Math.max(1, cols))
      void nextTick().then(adoptGsWidgets)
      return
    } catch { /* noop */ }
  }
  void nextTick().then(initGs)
})
watch(() => props.gridRows, () => {
  if (!isGsMode.value || !gs) return
  try {
    if (typeof gs.updateOptions === 'function') gs.updateOptions({ minRow: Math.max(1, props.gridRows), maxRow: gsMaxRow.value } as any)
  } catch { /* noop */ }
})
watch(() => props.keySize, () => {
  if (!isGsMode.value || !gs) return
  // En kiosco + libre la unidad la manda kioskFit (ver watcher junto a
  // startKioskFit); aquí solo el caso escritorio para no pisarla.
  if (props.kiosk && kioskFit.value != null) return
  try {
    if (typeof gs.cellHeight === 'function') gs.cellHeight(gsCellSize.value)
    else void nextTick().then(initGs)
  } catch { /* noop */ }
})
// Los items los renderiza Vue; GridStack solo adopta nodos nuevos.
// No re-crear la instancia aquí: eso era lo que dejaba el primer widget
// a ancho completo y tapaba los "+" de abajo.
watch(gsItems, () => {
  if (!isGsMode.value || !gs) return
  // El tope de arrastre sigue al contenido (ver gsMaxRow): sin esto, tras
  // mover un widget el límite vivo quedaba obsoleto.
  try {
    if (typeof gs.updateOptions === 'function') gs.updateOptions({ maxRow: gsMaxRow.value } as any)
  } catch { /* noop */ }
  void nextTick().then(adoptGsWidgets)
})
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

// Cerrar el menú de página y el popover de dispositivos al pulsar fuera o con Escape
const onDocClick = (e: MouseEvent) => {
  if (!(e.target as HTMLElement).closest?.('.bd-page')) menuPageId.value = null
  if (!(e.target as HTMLElement).closest?.('.bd-dvwrap')) devOpen.value = false
}

const caption = computed(() => {
  if (isGsMode.value) {
    return t('bd.captionFree', {
      profile: props.profileName,
      n: gsItems.value.length,
    })
  }
  return t('bd.caption', {
    profile: props.profileName,
    r: props.gridRows,
    c: props.gridCols,
    used: props.currentPages.length ? countUsed.value : 0,
    total: props.gridCols * props.gridRows
  })
})

const countUsed = computed(() => {
  let n = 0
  for (let i = 0; i < props.gridCols * props.gridRows; i++) {
    if (props.getButton(i)) n++
  }
  return n
})

const getLucideIcon = (iconName: string) => dynamicIcon(iconName)

/** ¿Cabe el contenido actual en cols×rows? (clásico: por position; libre:
 *  por geometría x/y/w/h, derivando de position si falta, como el render). */
const contentFits = (cols: number, rows: number): boolean => {
  const positions: number[] = []
  if ((props.layoutMode ?? 'classic') === 'classic') {
    const total = Math.max(0, props.gridCols * props.gridRows)
    for (let i = 0; i < total; i++) {
      if (props.getButton(i)) positions.push(i)
    }
  }
  return gridResizeFits(
    (props.layoutMode ?? 'classic') === 'gridstack' ? 'gridstack' : 'classic',
    positions,
    (props.allButtons ?? []) as any[],
    cols,
    rows,
  )
}

/** Reducir filas/columnas no puede dejar teclas fuera del grid: en libre el
 *  stepper antes no hacía nada visible (GridStack manda sobre los botones)
 *  y la config quedaba inconsistente con la placa. */
const canDecRow = computed(() => props.gridRows > GRID_ROWS_MIN && contentFits(props.gridCols, props.gridRows - 1))
const canDecCol = computed(() => props.gridCols > GRID_COLS_MIN && contentFits(props.gridCols - 1, props.gridRows))
/** Motivo del bloqueo (para el tooltip): mínimo alcanzado vs contenido. */
const decRowBlocked = computed(() => props.gridRows > GRID_ROWS_MIN && !canDecRow.value)
const decColBlocked = computed(() => props.gridCols > GRID_COLS_MIN && !canDecCol.value)

/** Tope de filas para GridStack: arrastrar no puede extender la placa más
 *  allá de lo configurado… salvo el desbordamiento ya existente (no se
 *  recoloca nada a la fuerza; el usuario lo recoge creciendo el grid o
 *  subiendo widgets, y ya no puede encoger debajo del contenido). */
const gsMaxRow = computed(() => {
  let bottom = Math.max(1, props.gridRows)
  for (const item of gsItems.value) bottom = Math.max(bottom, item.y + item.h)
  return bottom
})

// ---- Kiosco: encajar el grid a lo ancho Y a lo alto sin deformar ----
// La tecla es cuadrada (aspect-ratio 1/1 en CSS): el tamaño que encaja es
//   S = min((anchoDisp - gaps - pads) / cols, (altoDisp - gaps - pads) / rows)
// Se mide contra el viewport (visualViewport en móvil: la barra URL cambia
// el alto) menos los paddings reales del floor/plate, más la altura de los
// hermanos del plate (caption, breadcrumb). El plate se centra con width:auto,
// así que si el alto manda, el grid no llega al borde ancho (letterbox).
const floorRef = ref<HTMLElement | null>(null)
const kioskFit = ref<number | null>(null)

const plateStyle = computed<Record<string, string | number>>(() => {
  const base: Record<string, string | number> = { '--bd-c': props.gridCols }
  if (props.kiosk && kioskFit.value != null && !isGsMode.value) {
    const s = Math.max(1, Math.floor(kioskFit.value))
    base['grid-template-columns'] = `repeat(${Math.max(1, props.gridCols)}, ${s}px)`
    base['width'] = 'auto'
    base['max-width'] = '100%'
  }
  return base
})

let kioskRO: ResizeObserver | null = null

function updateKioskFit() {
  if (!props.kiosk) {
    if (kioskFit.value !== null) kioskFit.value = null
    return
  }
  if (isGsMode.value) {
    updateKioskGsFit()
    return
  }
  const plate = container.value
  if (!plate || typeof window === 'undefined') return
  const floor = floorRef.value ?? (plate.closest?.('.bd-floor') as HTMLElement | null)
  if (!floor) return
  const vv = window.visualViewport
  const vpW = Math.max(1, vv?.width ?? document.documentElement.clientWidth ?? window.innerWidth)
  const vpH = Math.max(1, vv?.height ?? window.innerHeight)
  const fcs = getComputedStyle(floor)
  const fPadX = (parseFloat(fcs.paddingLeft) || 0) + (parseFloat(fcs.paddingRight) || 0)
  const fPadY = (parseFloat(fcs.paddingTop) || 0) + (parseFloat(fcs.paddingBottom) || 0)
  const pcs = getComputedStyle(plate)
  const padL = parseFloat(pcs.paddingLeft) || 0
  const padR = parseFloat(pcs.paddingRight) || 0
  const padT = parseFloat(pcs.paddingTop) || 0
  const padB = parseFloat(pcs.paddingBottom) || 0
  const colGap = parseFloat(pcs.columnGap || (pcs as any).gap) || 0
  const rowGap = parseFloat(pcs.rowGap || (pcs as any).gap) || 0
  const cols = Math.max(1, props.gridCols)
  const rows = Math.max(1, props.gridRows)
  // Hermanos del plate dentro del stack (caption, breadcrumb…): restan alto.
  let extraH = 0
  const stack = plate.parentElement
  if (stack) {
    const scs = getComputedStyle(stack)
    const stackGap = parseFloat(scs.rowGap || scs.columnGap || (scs as any).gap) || 0
    let n = 0
    for (const child of Array.from(stack.children)) {
      if (child === plate) continue
      const h = (child as HTMLElement).getBoundingClientRect?.().height ?? 0
      if (h > 0) {
        extraH += h
        n++
      }
    }
    if (n > 0) extraH += stackGap * n
  }
  const availW = vpW - fPadX - padL - padR
  const availH = vpH - fPadY - padT - padB - extraH
  const sW = (availW - colGap * (cols - 1)) / cols
  const sH = (availH - rowGap * (rows - 1)) / rows
  let s = Math.floor(Math.min(sW, sH))
  if (!Number.isFinite(s)) return
  // Cota inferior de seguridad: con los máximos (8×6) nunca se baja de ~25px
  // en un móvil pequeño; evita teclas de 0px si algo se mide a 0 en un tick.
  s = Math.max(12, s)
  if (kioskFit.value !== s) kioskFit.value = s
}

/** Kiosco + página libre (GridStack): la unidad --bd-gs-unit debe encajar en
 *  el viewport a lo ancho Y a lo alto para que las celdas sigan cuadradas.
 *  unit = min((availW - wrapPadX) / cols, (availH - wrapPadY - extraH) / total)
 *  con total = gsMaxRow (filas configuradas o fondo real de widgets, lo que
 *  ya limita el arrastre). extraH incluye los hermanos del viewport en el
 *  stack más la kiosk-bar fija (overlay que no reserva espacio). */
function updateKioskGsFit() {
  if (typeof window === 'undefined') return
  const floor = floorRef.value
  if (!floor) return
  const vv = window.visualViewport
  const vpW = Math.max(1, vv?.width ?? document.documentElement.clientWidth ?? window.innerWidth)
  const vpH = Math.max(1, vv?.height ?? window.innerHeight)
  const fcs = getComputedStyle(floor)
  const fPadX = (parseFloat(fcs.paddingLeft) || 0) + (parseFloat(fcs.paddingRight) || 0)
  const fPadY = (parseFloat(fcs.paddingTop) || 0) + (parseFloat(fcs.paddingBottom) || 0)
  // Paddings reales del wrap libre; fallback 48 (24+24 de escritorio).
  let padX = 48
  let padY = 48
  try {
    const wrapEl = (gsContainer.value?.closest?.('.bd-gs-wrap') as HTMLElement | null)
      ?? floor.querySelector?.('.bd-gs-wrap') as HTMLElement | null
    if (wrapEl) {
      const wcs = getComputedStyle(wrapEl)
      padX = (parseFloat(wcs.paddingLeft) || 0) + (parseFloat(wcs.paddingRight) || 0) || 48
      padY = (parseFloat(wcs.paddingTop) || 0) + (parseFloat(wcs.paddingBottom) || 0) || 48
    }
  } catch { /* fallback 48 */ }
  // Hermanos del viewport dentro del stack (breadcrumb, free-note…).
  let extraH = 0
  try {
    const viewport = (gsContainer.value?.closest?.('.bd-gs-viewport') as HTMLElement | null)
      ?? floor.querySelector?.('.bd-gs-viewport') as HTMLElement | null
    const stack = viewport?.parentElement ?? floor.querySelector?.('.bd-stack') as HTMLElement | null
    if (stack) {
      const scs = getComputedStyle(stack)
      const stackGap = parseFloat(scs.rowGap || scs.columnGap || (scs as any).gap) || 0
      let n = 0
      for (const child of Array.from(stack.children)) {
        if (child === viewport) continue
        const h = (child as HTMLElement).getBoundingClientRect?.().height ?? 0
        if (h > 0) {
          extraH += h
          n++
        }
      }
      if (n > 0) extraH += stackGap * n
    }
    // La kiosk-bar es fixed (overlay): el floor ya reserva aire abajo por
    // CSS, pero el fit debe restarla del alto disponible o la última fila
    // queda detrás de la barra y parece "cortada".
    const bar = document.querySelector?.('.kiosk-bar') as HTMLElement | null
    if (bar) {
      const h = bar.getBoundingClientRect?.().height ?? 0
      if (h > 0) extraH += h + 24
      else extraH += 76
    }
  } catch { /* sin extra medible */ }
  const cols = Math.max(1, props.gridCols)
  const total = Math.max(1, gsMaxRow.value, props.gridRows)
  const availW = vpW - fPadX - padX
  const availH = vpH - fPadY - padY - extraH
  let u = Math.floor(Math.min(availW / cols, availH / total))
  if (!Number.isFinite(u)) return
  u = Math.max(12, u)
  if (kioskFit.value !== u) kioskFit.value = u
}

function startKioskFit() {
  stopKioskFit()
  void nextTick().then(() => {
    updateKioskFit()
    // El wrap/contenedor libre se montan en el patch siguiente al cambio de
    // layoutMode: observarlos aquí o el RO nunca los vería en kiosco+libre.
    try {
      if (kioskRO) {
        if (gsContainer.value) kioskRO.observe(gsContainer.value)
        const wrapEl = gsContainer.value?.closest?.('.bd-gs-wrap') as HTMLElement | null
        if (wrapEl) kioskRO.observe(wrapEl)
      }
    } catch { /* noop */ }
  })
  if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') return
  try {
    kioskRO = new ResizeObserver(() => updateKioskFit())
    if (floorRef.value) kioskRO.observe(floorRef.value)
    if (container.value) kioskRO.observe(container.value)
    if (gsContainer.value) kioskRO.observe(gsContainer.value)
    const wrapEl = gsContainer.value?.closest?.('.bd-gs-wrap') as HTMLElement | null
    if (wrapEl) kioskRO.observe(wrapEl)
  } catch { /* sin ResizeObserver: tiran los listeners de ventana */ }
  window.addEventListener('resize', updateKioskFit)
  window.addEventListener('orientationchange', updateKioskFit)
  try {
    window.visualViewport?.addEventListener('resize', updateKioskFit)
  } catch { /* Safari antiguo */ }
}

function stopKioskFit() {
  try {
    kioskRO?.disconnect()
  } catch { /* noop */ }
  kioskRO = null
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', updateKioskFit)
    window.removeEventListener('orientationchange', updateKioskFit)
    try {
      window.visualViewport?.removeEventListener('resize', updateKioskFit)
    } catch { /* noop */ }
  }
}

watch(
  [() => props.kiosk, () => props.gridCols, () => props.gridRows, () => props.layoutMode, () => props.mode, () => props.navTrail?.length, () => props.profileName],
  ([isKiosk]) => {
    if (isKiosk) startKioskFit()
    else {
      stopKioskFit()
      kioskFit.value = null
    }
  }
)

// Kiosco + libre: cuando el fit recalcula la unidad, propagarla a la
// instancia viva de GridStack sin re-crearla (re-crear dejaba el primer
// widget a ancho completo). Misma llamada que el watcher de keySize.
// (Aquí abajo porque kioskFit/gsMaxRow se declaran justo encima.)
watch(kioskFit, (unit) => {
  if (!props.kiosk || !isGsMode.value || !gs || unit == null) return
  try {
    if (typeof gs.cellHeight === 'function') gs.cellHeight(unit)
    else void nextTick().then(initGs)
  } catch { /* noop */ }
})
// El fondo real (gsMaxRow) cambia con los widgets: el fit de kiosco debe
// reencajar la unidad o una tecla 2×2 nueva quedaría cortada.
watch(gsMaxRow, () => {
  if (props.kiosk && isGsMode.value) updateKioskFit()
})

/**
 * Resolver la apariencia es relativamente caro (entorno + expresiones + texto).
 * El template consulta varias propiedades por tecla; cachear por posición evita
 * reevaluar las mismas reglas repetidamente en un único render. La computed
 * conserva la reactividad de displayData/getButtonData (incluido displayTick).
 * Garantía: displayData se llama como máximo 1 vez por posición ocupada por
 * evaluación del computed; los helpers (disp/bdata) solo leen los Maps.
 */
const displayDataByPosition = computed(() => {
  const positions = new Set<number>()
  const total = Math.max(0, props.gridCols * props.gridRows)
  for (let position = 0; position < total; position++) {
    if (props.getButton(position)) positions.add(position)
  }
  for (const button of props.allButtons ?? []) {
    if (Number.isInteger(button.position) && button.position >= 0) positions.add(button.position)
  }

  const result = new Map<number, any>()
  for (const position of positions) {
    result.set(
      position,
      props.displayData ? props.displayData(position) : props.getButtonData(position)
    )
  }
  return result
})
const disp = (position: number) => {
  // Solo lectura del Map: displayData se evalúa una vez por posición en el
  // computed de arriba. Nunca llamar a props.displayData aquí (cada helper
  // del template pasaría por displayData -> getEnv + ev/intp de nuevo).
  const hit = displayDataByPosition.value.get(position)
  if (hit !== undefined) return hit
  return buttonDataByPosition.value.get(position) ?? props.getButtonData(position) ?? undefined
}

/** getButtonData también se lee ~3 veces por tecla: cachearlo por posición. */
const buttonDataByPosition = computed(() => {
  const positions = new Set<number>()
  const total = Math.max(0, props.gridCols * props.gridRows)
  for (let position = 0; position < total; position++) {
    if (props.getButton(position)) positions.add(position)
  }
  for (const button of props.allButtons ?? []) {
    if (Number.isInteger(button.position) && button.position >= 0) positions.add(button.position)
  }

  const result = new Map<number, any>()
  for (const position of positions) {
    result.set(position, props.getButtonData(position))
  }
  return result
})
const bdata = (position: number) =>
  buttonDataByPosition.value.get(position) ?? props.getButtonData(position) ?? undefined

const keyIcon = (position: number) => {
  const icon = disp(position)?.icon
  return typeof icon === 'string' && icon ? getLucideIcon(icon) : null
}
/** Imagen personalizada (`/assets/…` → absoluta contra la API). Los GIF animan solos en <img>. */
const keyImage = (position: number) => {
  const rel = disp(position)?.iconImage
  return isAssetRef(rel) ? assetUrl(props.apiBase ?? '', rel) : ''
}
const keyEmoji = (position: number) => disp(position)?.emoji ?? ''
const keyTop = (position: number) => disp(position)?.textTop ?? ''
const keyBottom = (position: number) => disp(position)?.textBottom ?? ''
const keyDyn = (position: number) => disp(position)?.dynamicValue ?? bdata(position)?.dynamicValue ?? ''
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

const onKeyClick = (event: MouseEvent | KeyboardEvent, position: number) => {
  if (props.mode !== 'use') {
    emit('button-click', position)
    return
  }
  // Modo uso: el tap táctil/ratón ya salió por pointerup; el clic posterior
  // se ignora. Solo el teclado (Enter/Espacio, sin pointer previo) llega aquí.
  if (suppressClickPos === position) {
    suppressClickPos = null
    return
  }
  if (lastPointer.pos === position && Date.now() - lastPointer.t < 700) return
  if (isControlSurface(position) || !props.getButton(position)) return
  const el = event.currentTarget as HTMLElement | null
  playPressFx(el, 'click', { animations: animOn() })
  pressFeedback('click')
  emit('button-tap', position)
}

// Pulsación: FX + hold configurable + multi-tap (Fase A+B).
// - pointerdown arma el hold solo si la tecla tiene contenido `long`
//   (lista o regla); al cumplirse emite button-long-press y el clic/tap
//   posterior se consume (suppressClickPos + holdFired).
// - pointerup cuenta el tap (ventana 340 ms, máx 3, por tecla) para el FX
//   inmediato y emite button-tap; el ENGINE decide click/double/triple.
// - Sin contenido long no hay timer: tap directo, como antes.
const fx = createPressFx()
const animOn = () => bdAnimations.value !== false
const effLongMs = () =>
  Number.isFinite(+(props.longPressMs ?? NaN))
    ? Math.min(1200, Math.max(200, Math.round(+(props.longPressMs as number))))
    : (bdLongPressMs.value ?? 500)
let holdTimer: ReturnType<typeof setTimeout> | null = null
let holdFired = false
let holdPos = -1
let downPos = -1
let suppressClickPos: number | null = null
const lastPointer = { pos: -1, t: 0 }
const clearHoldTimer = () => {
  if (holdTimer) {
    clearTimeout(holdTimer)
    holdTimer = null
  }
}
const onPressStart = (event: PointerEvent, position: number) => {
  // Solo botón principal: se ignoran medio/secundario (button > 0). El
  // táctil/lápiz puede reportar button 0 o -1 según navegador; ambos valen.
  if (props.mode !== 'use' || (event.button !== undefined && event.button > 0)) return
  lastPointer.pos = position
  lastPointer.t = Date.now()
  if (suppressClickPos !== null && suppressClickPos !== position) suppressClickPos = null
  if (isControlSurface(position) || !props.getButton(position)) return
  downPos = position
  if (!hasLongContent(bdata(position))) return
  const el = event.currentTarget as HTMLElement | null
  fx.onPressDown(el, position, effLongMs(), animOn())
  holdFired = false
  holdPos = position
  clearHoldTimer()
  const pt = { x: event.clientX, y: event.clientY }
  holdTimer = setTimeout(() => {
    holdTimer = null
    holdFired = true
    suppressClickPos = position
    if (el) {
      clearHoldFx(el)
      playPressFx(el, 'long', { animations: animOn(), point: pt })
    }
    pressFeedback('long')
    emit('button-long-press', position)
  }, effLongMs())
}
const onPressUp = (event: PointerEvent, position: number) => {
  clearHoldTimer()
  const el = event.currentTarget as HTMLElement | null
  if (el) clearHoldFx(el)
  if (props.mode !== 'use') {
    downPos = -1
    return
  }
  if (downPos !== position) {
    // Se soltó fuera de la tecla (ya pasó por pointerleave/cancel).
    holdFired = false
    return
  }
  downPos = -1
  if (holdFired && holdPos === position) {
    holdFired = false
    return // el long consume el tap posterior
  }
  holdFired = false
  if (isControlSurface(position) || !props.getButton(position)) return
  // Solo cuenta si hubo pointerdown previo (evita doble tap con el click).
  lastPointer.pos = position
  lastPointer.t = Date.now()
  const kind = fx.onPressUp(position)
  playPressFx(el, kind, {
    animations: animOn(),
    point: { x: event.clientX, y: event.clientY },
  })
  pressFeedback(kind === 'double' ? 'double' : kind === 'triple' ? 'triple' : 'click')
  emit('button-tap', position)
}
const onPressCancel = (event?: Event) => {
  clearHoldTimer()
  const el = (event?.currentTarget ?? null) as HTMLElement | null
  if (el) clearHoldFx(el)
  holdFired = false
  downPos = -1
  fx.cancel()
}

const actionCount = (position: number) => {
  const d = bdata(position)
  const pa = (d?.pressActions ?? {}) as Record<string, unknown>
  let extra = 0
  for (const k of ['click', 'double', 'triple', 'long']) {
    if (Array.isArray(pa[k])) extra += (pa[k] as unknown[]).length
  }
  return (d?.actions?.length ?? 0) + extra + (d?.rules?.length ?? 0)
}

/** Control interactivo de la tecla. La presencia de una acción de superficie
 *  decide el render, no un tipo de botón aparte. Se conserva el legado
 *  `widget_type: 'volume'` (sin acción) por compatibilidad. */
const controlActionOf = (position: number): any | undefined => {
  const btn = props.getButton(position) as any
  if (!btn) return undefined
  const found = findControlAction((bdata(position) as any)?.actions)
  if (found) return found
  if (btn.widget_type === 'volume') return { type: 'audio-mixer.volume-control', parameters: {} }
  return undefined
}
const isControlSurface = (position: number) => isGsMode.value && !!controlActionOf(position)
/** App objetivo del control de volumen (vacío = maestro). */
const volumeAppOf = (position: number): string | null => {
  const params = controlActionOf(position)?.parameters as any
  const app = params?.app
  if (typeof app === 'string' && app.trim()) return app.trim()
  const d = bdata(position) as any
  const legacy = d?.volumeApp ?? d?.app
  return typeof legacy === 'string' && legacy.trim() ? legacy.trim() : null
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
  event.stopPropagation()
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

const onGsDragOver = (event: DragEvent) => {
  if (props.mode === 'edit' && event.dataTransfer?.types.includes('application/json')) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }
}

const onGsDrop = (event: DragEvent) => {
  if (props.mode !== 'edit') return
  // Los drops sobre teclas existentes los procesa onDrop; no crear una segunda.
  if ((event.target as HTMLElement).closest?.('.grid-stack-item')) return
  try {
    const raw = event.dataTransfer?.getData('application/json')
    if (!raw) return
    const data = JSON.parse(raw)
    if (!data?.type) return

    // GridStack convierte el punto del puntero a coordenadas de celda,
    // incluyendo márgenes y scroll del área.
    const cell = gs?.getCellFromPixel?.(
      { left: event.clientX, top: event.clientY },
      true
    )
    const rect = gsContainer.value?.getBoundingClientRect()
    const x = cell?.x ?? (
      rect?.width
        ? Math.floor((event.clientX - rect.left) / (rect.width / Math.max(1, props.gridCols)))
        : 0
    )
    const y = cell?.y ?? (
      rect?.height
        ? Math.floor((event.clientY - rect.top) / gsCellSize.value)
        : 0
    )
    emit(
      'action-drop-empty',
      Math.max(0, Math.floor(Number(x) || 0)),
      Math.max(0, Math.floor(Number(y) || 0)),
      data.type
    )
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
// En kiosco no hay menú: solo ejecución directa.
const contextMenu = ref({ show: false, x: 0, y: 0, position: -1 })
const contextMenuItems = computed(() => {
  if (props.kiosk) {
    const button = props.getButton(contextMenu.value.position)
    return button
      ? [{ id: 'execute', label: t('bd.pressKey'), icon: Play, danger: false }]
      : []
  }
  const button = props.getButton(contextMenu.value.position)
  // t('bd.*') no se puede usar fuera del setup traducido aquí, pero el
  // componente ya importa `t` de useI18nStore: lo usamos para etiquetas.
  if (button) {
    const items = [
      { id: 'execute', label: t('bd.pressKey'), icon: Play, danger: false },
      { id: 'logs', label: t('bd.viewLogs'), icon: ScrollText, danger: false },
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
  // En kiosco no hay menús: el clic derecho no hace nada.
  if (props.kiosk) return
  contextMenu.value = { show: true, x: event.clientX, y: event.clientY, position }
}
const hideContextMenu = () => {
  contextMenu.value.show = false
}
const handleContextMenuItem = (item: any) => {
  if (item.id === 'execute') emit('button-execute', contextMenu.value.position)
  else if (item.id === 'logs') emit('button-logs', contextMenu.value.position)
  else if (item.id === 'delete') emit('button-delete', contextMenu.value.position)
  else if (item.id === 'export') emit('button-export', contextMenu.value.position)
  else if (item.id === 'import') emit('button-import', contextMenu.value.position)
  else emit('button-click', contextMenu.value.position)
  hideContextMenu()
}

// Swapy — solo rejilla clásica; GridStack gestiona el modo redimensionable.
// Import dinámico: fuera del chunk inicial; el mock `vi.mock('swapy')`
// de los tests sigue interceptando este import.
const initializeSwapy = async () => {
  if ((props.layoutMode ?? 'classic') !== 'classic') return
  if (container.value && !swapy.value && props.mode === 'edit') {
    try {
      const { createSwapy } = await import('swapy')
      // El modo o el contenedor pueden haber cambiado mientras se cargaba.
      if (!container.value || swapy.value || props.mode !== 'edit') return
      if ((props.layoutMode ?? 'classic') !== 'classic') return
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
  // (initializeSwapy es async por el import dinámico: se espera antes
  // de decidir si reintentar.)
  const bind = async (retries: number) => {
    await initializeSwapy()
    if (!swapy.value && retries > 0 && props.mode === 'edit') {
      await nextTick()
      await bind(retries - 1)
    }
  }
  void nextTick().then(() => bind(3))
}
watch(
  () => props.mode,
  (mode) => {
    menuPageId.value = null
    if (mode === 'edit') void initializeSwapy()
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
  void initializeSwapy()
  void nextTick().then(initGs)
  if (props.kiosk) startKioskFit()
  document.addEventListener('keydown', onEsc)
  document.addEventListener('click', onDocClick)
  window.addEventListener('libredeck:swapy-resync', resyncSwapy)
})
const destroyFxNodes = () => {
  try {
    for (const root of [container.value, gsContainer.value]) {
      root?.querySelectorAll('.bd-kfx').forEach((n) => n.remove())
    }
  } catch { /* noop */ }
}
onUnmounted(() => {
  swapy.value?.destroy()
  stopKioskFit()
  clearHoldTimer()
  fx.destroy()
  destroyFxNodes()
  destroyGs()
  document.removeEventListener('keydown', onEsc)
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('libredeck:swapy-resync', resyncSwapy)
})
const onEsc = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    hideContextMenu()
    menuPageId.value = null
    devOpen.value = false
  }
}

const commitRename = (name: string) => {
  if (renamingPageId.value && name.trim()) {
    emit('page-rename', renamingPageId.value, name.trim())
  }
  renamingPageId.value = null
}
</script>
