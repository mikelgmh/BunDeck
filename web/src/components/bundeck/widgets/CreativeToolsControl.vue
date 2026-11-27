<template>
  <section class="creative-control" :data-editor="editor" data-cy="widget-creative-tools" :aria-label="label || editorName">
    <header class="creative-head">
      <span class="creative-mark" aria-hidden="true"><component :is="editorIcon" :size="17" /></span>
      <div class="creative-heading">
        <strong>{{ label || editorName }}</strong>
        <span class="m-plus">{{ subtitle }}</span>
      </div>
      <span v-if="busy" class="current-chip busy-chip"><LoaderCircle :size="13" class="spin" aria-hidden="true" />{{ tr('Ejecutando…', 'Running…') }}</span>
      <span v-else-if="anchorValue" class="current-chip m-plus">{{ anchorValue }}</span>
    </header>

    <p v-if="error" class="creative-error" role="alert" :title="error">{{ error }}</p>

    <!-- XS (<200px): 4 botones esenciales, sin listas ni scroll. -->
    <div class="xs-essentials" role="group" :aria-label="tr('Acciones esenciales', 'Essential actions')">
      <template v-if="editor === 'premiere'">
        <button class="tool-btn tool-btn--main" type="button" :disabled="readonly || busy" :aria-label="tr('Reproducir o pausar', 'Play or pause')" :title="tr('Reproducir o pausar', 'Play or pause')" @click="run('transport', { operation: 'play-pause' })"><Play :size="19" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Fotograma anterior', 'Previous frame')" :title="tr('Fotograma anterior', 'Previous frame')" @click="run('transport', { operation: 'frame-back' })"><SkipBack :size="18" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Fotograma siguiente', 'Next frame')" :title="tr('Fotograma siguiente', 'Next frame')" @click="run('transport', { operation: 'frame-forward' })"><SkipForward :size="18" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Guardar', 'Save')" :title="tr('Guardar', 'Save')" @click="run('save')"><Save :size="18" aria-hidden="true" /></button>
      </template>
      <template v-else-if="editor === 'davinci'">
        <button class="tool-btn tool-btn--main" type="button" :disabled="readonly || busy" :aria-label="tr('Reproducir o pausar', 'Play or pause')" :title="tr('Reproducir o pausar', 'Play or pause')" @click="run('transport', { operation: 'play-pause' })"><Play :size="19" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Detener', 'Stop')" :title="tr('Detener', 'Stop')" @click="run('transport', { operation: 'stop' })"><Square :size="17" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Cuchilla', 'Blade')" :title="tr('Cuchilla', 'Blade')" @click="run('edit', { operation: 'blade' })"><Slice :size="18" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Guardar', 'Save')" :title="tr('Guardar', 'Save')" @click="run('save-project')"><Save :size="18" aria-hidden="true" /></button>
      </template>
      <template v-else-if="editor === 'photoshop'">
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Reducir tamaño del pincel', 'Decrease brush size')" :title="tr('Reducir tamaño del pincel', 'Decrease brush size')" @click="run('brush-size', { direction: 'decrease' })"><Minus :size="19" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Aumentar tamaño del pincel', 'Increase brush size')" :title="tr('Aumentar tamaño del pincel', 'Increase brush size')" @click="run('brush-size', { direction: 'increase' })"><Plus :size="19" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Deshacer', 'Undo')" :title="tr('Deshacer', 'Undo')" @click="run('history', { operation: 'undo' })"><Undo2 :size="18" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Guardar', 'Save')" :title="tr('Guardar', 'Save')" @click="run('save-export', { operation: 'save' })"><Save :size="18" aria-hidden="true" /></button>
      </template>
      <template v-else>
        <button class="tool-btn tool-btn--main" type="button" :disabled="readonly || busy" :aria-label="tr('Renderizar imagen', 'Render image')" :title="tr('Renderizar imagen', 'Render image')" @click="run('render', { operation: 'render-image' })"><Image :size="19" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Guardar', 'Save')" :title="tr('Guardar', 'Save')" @click="run('save', { operation: 'save' })"><Save :size="18" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Vista de cámara', 'Camera view')" :title="tr('Vista de cámara', 'Camera view')" @click="run('viewport', { view: 'camera' })"><Camera :size="18" aria-hidden="true" /></button>
        <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Encuadrar todo', 'Frame all')" :title="tr('Encuadrar todo', 'Frame all')" @click="run('viewport', { view: 'frame-all' })"><Frame :size="18" aria-hidden="true" /></button>
      </template>
    </div>

    <!-- M+ (≥200px): grupos completos paginados sin scroll. L (≥340px): listas largas e inputs. -->
    <div ref="groupsEl" class="full-groups">
      <template v-if="editor === 'premiere'">
        <div class="control-group page" data-page-item>
          <span class="group-title">{{ tr('TRANSPORTE', 'TRANSPORT') }}</span>
          <div class="control-grid">
            <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Retroceder', 'Reverse')" :title="tr('Retroceder', 'Reverse')" @click="run('transport', { operation: 'reverse' })"><Rewind :size="17" aria-hidden="true" /></button>
            <button class="tool-btn tool-btn--main" type="button" :disabled="readonly || busy" :aria-label="tr('Reproducir o pausar', 'Play or pause')" :title="tr('Reproducir o pausar', 'Play or pause')" @click="run('transport', { operation: 'play-pause' })"><Play :size="17" aria-hidden="true" /></button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Detener shuttle', 'Stop shuttle')" :title="tr('Detener shuttle', 'Stop shuttle')" @click="run('transport', { operation: 'shuttle-stop' })"><Square :size="16" aria-hidden="true" /></button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Avanzar', 'Forward')" :title="tr('Avanzar', 'Forward')" @click="run('transport', { operation: 'forward' })"><FastForward :size="17" aria-hidden="true" /></button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Fotograma anterior', 'Previous frame')" :title="tr('Fotograma anterior', 'Previous frame')" @click="run('transport', { operation: 'frame-back' })"><SkipBack :size="16" aria-hidden="true" /></button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Fotograma siguiente', 'Next frame')" :title="tr('Fotograma siguiente', 'Next frame')" @click="run('transport', { operation: 'frame-forward' })"><SkipForward :size="16" aria-hidden="true" /></button>
          </div>
        </div>
        <div class="control-group only-l page" data-page-item>
          <span class="group-title">{{ tr('JOG / SHUTTLE', 'JOG / SHUTTLE') }}</span>
          <div class="control-grid control-grid--labels">
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('jog-shuttle', { mode: 'shuttle-back' })"><Rewind :size="15" aria-hidden="true" />{{ tr('Atrás', 'Back') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('jog-shuttle', { mode: 'shuttle-stop' })"><Square :size="14" aria-hidden="true" />{{ tr('Detener', 'Stop') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('jog-shuttle', { mode: 'shuttle-forward' })"><FastForward :size="15" aria-hidden="true" />{{ tr('Adelante', 'Forward') }}</button>
          </div>
        </div>
        <div class="control-group only-l page" data-page-item>
          <span class="group-title">{{ tr('MARCAS Y MARCADORES', 'MARKS & MARKERS') }}</span>
          <div class="control-grid control-grid--labels">
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('mark', { point: 'mark-in' })"><CornerDownLeft :size="15" aria-hidden="true" />{{ tr('Entrada', 'In') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('mark', { point: 'mark-out' })"><CornerDownRight :size="15" aria-hidden="true" />{{ tr('Salida', 'Out') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('marker', { operation: 'add-marker' })"><Flag :size="15" aria-hidden="true" />{{ tr('Marcador', 'Marker') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('marker', { operation: 'go-prev-marker' })"><ChevronLeft :size="15" aria-hidden="true" />{{ tr('Anterior', 'Previous') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('marker', { operation: 'go-next-marker' })"><ChevronRight :size="15" aria-hidden="true" />{{ tr('Siguiente', 'Next') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('mark', { point: 'clear-in-out' })"><X :size="15" aria-hidden="true" />{{ tr('Limpiar', 'Clear') }}</button>
          </div>
        </div>
        <div class="control-footer page" data-page-item>
          <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('history', { operation: 'undo' })"><Undo2 :size="15" aria-hidden="true" />{{ tr('Deshacer', 'Undo') }}</button>
          <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('save')"><Save :size="15" aria-hidden="true" />{{ tr('Guardar', 'Save') }}</button>
        </div>
      </template>

      <template v-else-if="editor === 'davinci'">
        <div class="control-group page" data-page-item>
          <span class="group-title">{{ tr('TRANSPORTE', 'TRANSPORT') }}</span>
          <div class="control-grid">
            <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Reproducir hacia atrás', 'Play in reverse')" :title="tr('Reproducir hacia atrás', 'Play in reverse')" @click="run('transport', { operation: 'play-reverse' })"><Rewind :size="17" aria-hidden="true" /></button>
            <button class="tool-btn tool-btn--main" type="button" :disabled="readonly || busy" :aria-label="tr('Reproducir o pausar', 'Play or pause')" :title="tr('Reproducir o pausar', 'Play or pause')" @click="run('transport', { operation: 'play-pause' })"><Play :size="17" aria-hidden="true" /></button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Detener', 'Stop')" :title="tr('Detener', 'Stop')" @click="run('transport', { operation: 'stop' })"><Square :size="16" aria-hidden="true" /></button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Reproducir hacia adelante', 'Play forward')" :title="tr('Reproducir hacia adelante', 'Play forward')" @click="run('transport', { operation: 'play-forward' })"><FastForward :size="17" aria-hidden="true" /></button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Fotograma anterior', 'Previous frame')" :title="tr('Fotograma anterior', 'Previous frame')" @click="run('transport', { operation: 'frame-back' })"><SkipBack :size="16" aria-hidden="true" /></button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Fotograma siguiente', 'Next frame')" :title="tr('Fotograma siguiente', 'Next frame')" @click="run('transport', { operation: 'frame-forward' })"><SkipForward :size="16" aria-hidden="true" /></button>
          </div>
        </div>
        <div class="control-group page" data-page-item>
          <span class="group-title">{{ tr('EDICIÓN', 'EDITING') }}</span>
          <div class="control-grid control-grid--labels">
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('edit', { operation: 'cut' })"><Scissors :size="15" aria-hidden="true" />{{ tr('Cortar', 'Cut') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('edit', { operation: 'copy' })"><Copy :size="15" aria-hidden="true" />{{ tr('Copiar', 'Copy') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('edit', { operation: 'paste' })"><Clipboard :size="15" aria-hidden="true" />{{ tr('Pegar', 'Paste') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('edit', { operation: 'blade' })"><Slice :size="15" aria-hidden="true" />{{ tr('Cuchilla', 'Blade') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('edit', { operation: 'delete' })"><Trash2 :size="15" aria-hidden="true" />{{ tr('Eliminar', 'Delete') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('marker', { operation: 'add-marker' })"><Flag :size="15" aria-hidden="true" />{{ tr('Marcador', 'Marker') }}</button>
          </div>
        </div>
        <div class="control-footer only-l page" data-page-item>
          <label class="render-hotkey"><span>{{ tr('Atajo de render', 'Render shortcut') }}</span><input v-model="renderHotkey" :disabled="readonly || busy" :placeholder="tr('Ej. ctrl+f12', 'e.g. ctrl+f12')" /></label>
          <button class="tool-btn" type="button" :disabled="readonly || busy || !renderHotkey.trim()" @click="run('render-start', { hotkey: renderHotkey.trim() })"><Clapperboard :size="15" aria-hidden="true" />{{ tr('Render', 'Render') }}</button>
          <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('save-project')"><Save :size="15" aria-hidden="true" />{{ tr('Guardar', 'Save') }}</button>
        </div>
        <div class="page-row only-l page" data-page-item :aria-label="tr('Cambiar página de DaVinci', 'Switch DaVinci page')">
          <button v-for="page in davinciPages" :key="page" class="page-btn" type="button" :disabled="readonly || busy" :aria-label="`${tr('Página', 'Page')} ${pageName(page)}`" @click="run('switch-page', { page })">{{ pageName(page) }}</button>
        </div>
      </template>

      <template v-else-if="editor === 'photoshop'">
        <div class="brush-control page" data-page-item>
          <span class="group-title">{{ tr('TAMAÑO DE PINCEL', 'BRUSH SIZE') }}</span>
          <div class="brush-buttons">
            <button class="tool-btn brush-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Reducir tamaño del pincel', 'Decrease brush size')" :title="tr('Reducir tamaño del pincel', 'Decrease brush size')" @click="run('brush-size', { direction: 'decrease' })"><Minus :size="18" aria-hidden="true" /></button>
            <span class="brush-glyph" aria-hidden="true"><Brush :size="23" /></span>
            <button class="tool-btn brush-btn" type="button" :disabled="readonly || busy" :aria-label="tr('Aumentar tamaño del pincel', 'Increase brush size')" :title="tr('Aumentar tamaño del pincel', 'Increase brush size')" @click="run('brush-size', { direction: 'increase' })"><Plus :size="18" aria-hidden="true" /></button>
          </div>
        </div>
        <div class="control-group only-l page" data-page-item>
          <span class="group-title">{{ tr('HERRAMIENTAS', 'TOOLS') }}</span>
          <AutoCarousel :count="toolPages.length" :interval-ms="carouselMs" :show-dots="toolPages.length > 1" :dots-label="tr('Herramientas', 'Tools')">
            <template #default="{ index }">
              <div class="tool-list">
                <button v-for="tool in toolPages[index] ?? []" :key="tool.id" class="tool-btn tool-choice" :class="{ selected: anchorValue === tool.id }" type="button" :disabled="readonly || busy" @click="run('tool-select', { tool: tool.id })">
                  <component :is="tool.icon" :size="16" aria-hidden="true" /><span>{{ tool.label }}</span><kbd>{{ tool.key }}</kbd>
                </button>
              </div>
            </template>
          </AutoCarousel>
        </div>
        <div class="control-group page" data-page-item>
          <span class="group-title">{{ tr('CAPAS E HISTORIAL', 'LAYERS & HISTORY') }}</span>
          <div class="control-grid control-grid--labels">
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('layer-ops', { op: 'new' })"><Layers2 :size="15" aria-hidden="true" />{{ tr('Nueva capa', 'New layer') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('layer-ops', { op: 'duplicate' })"><Copy :size="15" aria-hidden="true" />{{ tr('Duplicar', 'Duplicate') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('layer-ops', { op: 'merge-down' })"><Combine :size="15" aria-hidden="true" />{{ tr('Combinar', 'Merge down') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('history', { operation: 'undo' })"><Undo2 :size="15" aria-hidden="true" />{{ tr('Deshacer', 'Undo') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('history', { operation: 'redo' })"><Redo2 :size="15" aria-hidden="true" />{{ tr('Rehacer', 'Redo') }}</button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('save-export', { operation: 'save' })"><Save :size="15" aria-hidden="true" />{{ tr('Guardar', 'Save') }}</button>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="control-group only-l page" data-page-item>
          <span class="group-title">{{ tr('VISTA 3D', '3D VIEW') }}</span>
          <AutoCarousel :count="viewPages.length" :interval-ms="carouselMs" :show-dots="viewPages.length > 1" :dots-label="tr('Vistas', 'Views')">
            <template #default="{ index }">
              <div class="control-grid control-grid--labels">
                <button v-for="view in viewPages[index] ?? []" :key="view.id" class="tool-btn" :class="{ selected: anchorValue === view.id }" type="button" :disabled="readonly || busy" @click="run('viewport', { view: view.id })"><component :is="view.icon" :size="16" aria-hidden="true" /><span>{{ view.label }}</span></button>
              </div>
            </template>
          </AutoCarousel>
        </div>
        <div class="control-group page" data-page-item>
          <span class="group-title">{{ tr('RENDER', 'RENDER') }}</span>
          <div class="control-grid control-grid--labels">
            <button class="tool-btn tool-btn--main" type="button" :disabled="readonly || busy" @click="run('render', { operation: 'render-image' })"><Image :size="16" aria-hidden="true" /><span>{{ tr('Imagen', 'Image') }}</span></button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('render', { operation: 'render-animation' })"><Film :size="16" aria-hidden="true" /><span>{{ tr('Animación', 'Animation') }}</span></button>
            <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('render', { operation: 'cancel-render' })"><X :size="16" aria-hidden="true" /><span>{{ tr('Cancelar', 'Cancel') }}</span></button>
          </div>
        </div>
        <div class="control-footer page" data-page-item>
          <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('save', { operation: 'save' })"><Save :size="15" aria-hidden="true" />{{ tr('Guardar', 'Save') }}</button>
          <button class="tool-btn" type="button" :disabled="readonly || busy" @click="run('save', { operation: 'save-incremental' })"><Files :size="15" aria-hidden="true" />{{ tr('Incremental', 'Incremental') }}</button>
        </div>
      </template>
    </div>

    <div v-if="groupsPager.numPages.value > 1" class="group-pager fit-pager" role="tablist" :aria-label="tr('Grupos', 'Groups')">
      <button
        v-for="i in groupsPager.numPages.value"
        :key="i"
        type="button"
        role="tab"
        class="pager-dot"
        :class="{ 'is-active': groupsPager.index.value === i - 1 }"
        :aria-selected="groupsPager.index.value === i - 1"
        :aria-label="`${tr('Grupo', 'Group')} ${i}/${groupsPager.numPages.value}`"
        @click.stop="groupsPager.goTo(i - 1)"
      />
      <small>{{ groupsPager.index.value + 1 }}/{{ groupsPager.numPages.value }}</small>
    </div>

    <span class="sr-status" role="status" aria-live="polite">{{ busy ? tr('Ejecutando…', 'Running…') : error }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  Blend, Box, Brush, Camera, ChevronLeft, ChevronRight, Clapperboard, Clipboard, Combine,
  Copy, CornerDownLeft, CornerDownRight, FastForward, Files, Film, Flag, Frame, Image,
  Layers2, LoaderCircle, Minus, Play, Plus, Redo2, Rewind, Save, Scissors, Slice, SkipBack,
  SkipForward, Square, Trash2, Undo2, X,
} from 'lucide-vue-next'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import { useI18nStore } from '../../../composables/useI18n'
import { resolveCarouselMs } from '../../../composables/useAutoCarousel'
import { useFitPager } from '../../../composables/useFitPager'
import AutoCarousel from './shared/AutoCarousel.vue'

interface Props {
  action: { type: string; parameters: Record<string, any> }
  apiBase: string
  label?: string
  readonly?: boolean
  /** Posición de la tecla (la reenvía ControlSurface; reservada para NeedsConfig). */
  position?: number | null
}

const props = withDefaults(defineProps<Props>(), { label: '', readonly: false, position: null })
const { currentLocale } = useI18nStore()
const tr = (es: string, en: string) => currentLocale.value.toLowerCase().startsWith('en') ? en : es
const editor = computed(() => {
  const prefix = props.action?.type?.split('.')[0]
  return ['premiere', 'davinci', 'photoshop', 'blender'].includes(prefix) ? prefix : 'premiere'
})
const editorName = computed(() => tr(
  ({ premiere: 'Premiere Pro', davinci: 'DaVinci Resolve', photoshop: 'Photoshop', blender: 'Blender' } as Record<string, string>)[editor.value],
  ({ premiere: 'Premiere Pro', davinci: 'DaVinci Resolve', photoshop: 'Photoshop', blender: 'Blender' } as Record<string, string>)[editor.value],
))
const editorIcon = computed(() => ({ premiere: Clapperboard, davinci: Film, photoshop: Brush, blender: Blend }[editor.value]))
const subtitle = computed(() => ({
  premiere: tr('Línea de tiempo · JKL · marcas', 'Timeline · JKL · marks'),
  davinci: tr('Edición · transporte · render', 'Editing · transport · render'),
  photoshop: tr('Pincel · herramientas · capas', 'Brush · tools · layers'),
  blender: tr('Viewport · render · proyecto', 'Viewport · render · project'),
}[editor.value]))
const params = computed(() => props.action?.parameters ?? {})
const busy = ref(false)
const error = ref('')
const renderHotkey = ref('')
const anchorValue = computed(() => {
  const p = params.value
  const raw = String(p.operation ?? p.view ?? p.tool ?? p.direction ?? p.page ?? '')
  const labels: Record<string, [string, string]> = {
    'play-pause': ['Reproducir / pausar', 'Play / pause'],
    reverse: ['Retroceder', 'Reverse'],
    forward: ['Avanzar', 'Forward'],
    'play-reverse': ['Reproducir hacia atrás', 'Play in reverse'],
    'play-forward': ['Reproducir hacia adelante', 'Play forward'],
    'render-image': ['Imagen', 'Image'],
    'render-animation': ['Animación', 'Animation'],
    'save-incremental': ['Guardado incremental', 'Incremental save'],
    increase: ['Aumentar', 'Increase'],
    decrease: ['Reducir', 'Decrease'],
    front: ['Frontal', 'Front'],
    back: ['Trasera', 'Back'],
    top: ['Cenital', 'Top'],
    bottom: ['Inferior', 'Bottom'],
    right: ['Derecha', 'Right'],
    left: ['Izquierda', 'Left'],
    camera: ['Cámara', 'Camera'],
    'toggle-perspective': ['Perspectiva / ortográfica', 'Perspective / orthographic'],
    'frame-all': ['Encuadrar todo', 'Frame all'],
    'shade-solid': ['Sombreado', 'Shading'],
    media: ['Media', 'Media'],
    edit: ['Edit', 'Edit'],
    fusion: ['Fusion', 'Fusion'],
    color: ['Color', 'Color'],
    fairlight: ['Fairlight', 'Fairlight'],
    deliver: ['Deliver', 'Deliver'],
    'mark-in': ['Marca de entrada', 'Mark in'],
    'mark-out': ['Marca de salida', 'Mark out'],
    undo: ['Deshacer', 'Undo'],
    redo: ['Rehacer', 'Redo'],
  }
  return labels[raw] ? tr(...labels[raw]) : raw
})
const davinciPages = ['media', 'edit', 'fusion', 'color', 'fairlight', 'deliver']
const pageName = (page: string) => page[0].toUpperCase() + page.slice(1)
const photoshopTools = computed(() => [
  { id: 'move', label: tr('Mover', 'Move'), key: 'V', icon: Box },
  { id: 'marquee', label: tr('Marco', 'Marquee'), key: 'M', icon: Square },
  { id: 'lasso', label: tr('Lazo', 'Lasso'), key: 'L', icon: Scissors },
  { id: 'quick-select', label: tr('Selección rápida', 'Quick select'), key: 'W', icon: Blend },
  { id: 'crop', label: tr('Recortar', 'Crop'), key: 'C', icon: Box },
  { id: 'eyedropper', label: tr('Cuentagotas', 'Eyedropper'), key: 'I', icon: Plus },
  { id: 'brush', label: tr('Pincel', 'Brush'), key: 'B', icon: Brush },
  { id: 'clone', label: tr('Tampón', 'Clone stamp'), key: 'S', icon: Copy },
  { id: 'eraser', label: tr('Borrador', 'Eraser'), key: 'E', icon: X },
  { id: 'gradient', label: tr('Degradado', 'Gradient'), key: 'G', icon: Blend },
  { id: 'text', label: tr('Texto', 'Text'), key: 'T', icon: Image },
  { id: 'hand', label: tr('Mano', 'Hand'), key: 'H', icon: Box },
  { id: 'zoom', label: tr('Zoom', 'Zoom'), key: 'Z', icon: Plus },
])
const blenderViews = computed(() => [
  { id: 'front', label: tr('Frontal', 'Front'), icon: Box },
  { id: 'back', label: tr('Trasera', 'Back'), icon: Box },
  { id: 'top', label: tr('Cenital', 'Top'), icon: Box },
  { id: 'bottom', label: tr('Inferior', 'Bottom'), icon: Box },
  { id: 'right', label: tr('Derecha', 'Right'), icon: Box },
  { id: 'left', label: tr('Izquierda', 'Left'), icon: Box },
  { id: 'camera', label: tr('Cámara', 'Camera'), icon: Camera },
  { id: 'toggle-perspective', label: tr('Orto / Persp.', 'Ortho / persp.'), icon: Blend },
  { id: 'frame-all', label: tr('Encuadrar', 'Frame all'), icon: Frame },
  { id: 'shade-solid', label: tr('Sombreado', 'Shading'), icon: Blend },
])

/**
 * Listas largas sin scroll: páginas de 5 que rotan con `carouselMs`
 * (ausente=4000, <=0=off). Con 1 sola página se pinta entera.
 */
const carouselMs = computed(() => resolveCarouselMs(params.value))
const LIST_PAGE = 5
function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = []
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size))
  return pages
}
const toolPages = computed(() => chunk(photoshopTools.value, LIST_PAGE))
const viewPages = computed(() => chunk(blenderViews.value, LIST_PAGE))

/**
 * Grupos sin scroll: cuando no caben se muestran por páginas que rotan con
 * `carouselMs`; cuando caben, todos a la vez (ver useFitPager).
 */
const groupsEl = ref<HTMLElement | null>(null)
const groupsPager = useFitPager(groupsEl, { intervalMs: carouselMs, gap: 8 })
watch(editor, () => void nextTick().then(() => groupsPager.measure()))

/**
 * Sin configurar: no aplica. Los cuatro editores funcionan con los presets de
 * atajos integrados del daemon (p. ej. `PREMIERE_TRANSPORT`); la superficie no
 * exige ningún parámetro identificador, así que `NeedsConfig` no se pinta.
 * Se declara `position` igualmente por el contrato de ControlSurface.
 */

async function run(actionId: string, overrides: Record<string, unknown> = {}) {
  if (busy.value || props.readonly) return
  busy.value = true
  error.value = ''
  const { operation: _operation, point: _point, mode: _mode, view: _view, op: _op, tool: _tool, page: _page, hotkey: _hotkey, ...shared } = params.value
  try {
    const raw = await executeWidgetAction(props.apiBase, `${editor.value}.${actionId}`, { ...shared, ...overrides })
    if (raw?.success === false) throw new Error(raw.error || tr('No se pudo completar la acción.', 'Could not complete the action.'))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : tr('No se pudo completar la acción.', 'Could not complete the action.')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.creative-control {
  --creative-accent: var(--bd-ac, #e0a84a);
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container-type: size;
  container-name: creative-tools;
  position: relative;
  color: var(--bd-ink, #ece9e2);
  background: var(--bd-sf, #1b1d20);
  border: 1px solid var(--bd-ln, #34373b);
  border-radius: var(--bd-rk, 14px);
  padding: clamp(8px, 2cqi, 14px);
  display: flex;
  flex-direction: column;
  gap: clamp(8px, 1.9cqi, 13px);
  font: 500 clamp(10px, 2.35cqi, 13px)/1.3 var(--bd-sans, inherit);
}
.creative-head, .creative-brand { display: flex; align-items: center; }
.creative-head { gap: 8px; flex: none; }
.creative-brand { min-width: 0; gap: 9px; flex: 1; }
.creative-mark { display: grid; place-items: center; width: 31px; height: 31px; flex: none; color: var(--creative-accent); background: color-mix(in srgb, var(--creative-accent) 12%, transparent); border-radius: 9px; }
.creative-heading { display: grid; gap: 2px; min-width: 0; flex: 1; }
.creative-heading strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1.08em; }
.creative-heading span { overflow: hidden; color: var(--bd-mu, #a3a5a8); font-size: .78em; text-overflow: ellipsis; white-space: nowrap; }
.current-chip { max-width: 36%; overflow: hidden; padding: 4px 7px; flex: none; color: var(--creative-accent); background: color-mix(in srgb, var(--creative-accent) 10%, transparent); border-radius: 7px; text-overflow: ellipsis; white-space: nowrap; font: 500 .82em var(--bd-mono, ui-monospace, monospace); }
.busy-chip { display: inline-flex; align-items: center; gap: 5px; }
/* XS: fila de 4 esenciales que rellena la tecla (altura acotada en teclas altas). */
.xs-essentials { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; flex: 1; min-height: 0; align-content: start; }
.xs-essentials > .tool-btn { min-height: 44px; height: 100%; max-height: 64px; }
/* M+: grupos completos (los largos e inputs solo en L). */
.full-groups { display: none; }
.control-group { display: grid; gap: 6px; min-width: 0; }
.group-title { color: var(--bd-mu, #a3a5a8); font-size: .72em; letter-spacing: .07em; }
.control-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 5px; }
.control-grid--labels { grid-template-columns: repeat(auto-fit, minmax(min(74px, 30%), 1fr)); }
.tool-btn { display: inline-flex; min-width: 0; min-height: 34px; align-items: center; justify-content: center; gap: 5px; padding: 5px 7px; border: 1px solid var(--bd-ln, #3b3d40); border-radius: 8px; color: var(--bd-ink, #ece9e2); background: var(--bd-bg, #242629); font: inherit; cursor: pointer; transition: border-color 120ms ease, background 120ms ease, transform 120ms ease; }
.tool-btn:hover:not(:disabled) { border-color: var(--creative-accent); }
.tool-btn:active:not(:disabled) { transform: translateY(1px); }
.tool-btn:focus-visible, .page-btn:focus-visible, .render-hotkey input:focus-visible { outline: 2px solid var(--creative-accent); outline-offset: 2px; }
.tool-btn:disabled { opacity: .48; cursor: not-allowed; }
.tool-btn--main { border-color: color-mix(in srgb, var(--creative-accent) 65%, var(--bd-ln, #3b3d40)); background: color-mix(in srgb, var(--creative-accent) 16%, var(--bd-bg, #242629)); }
.tool-btn.selected { color: var(--creative-accent); border-color: var(--creative-accent); }
.control-footer, .brush-buttons, .page-row { display: flex; align-items: center; }
.control-footer { flex-wrap: wrap; gap: 5px; }
.control-footer > .tool-btn { flex: 1; }
.page-row { flex-wrap: wrap; gap: 4px; }
.page-btn { min-width: 0; flex: 1; padding: 5px 6px; border: 1px solid var(--bd-ln, #3b3d40); border-radius: 7px; color: var(--bd-ink, #ece9e2); background: var(--bd-bg, #242629); font: 500 .76em var(--bd-mono, ui-monospace, monospace); text-transform: capitalize; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.page-btn:hover:not(:disabled) { border-color: var(--creative-accent); }
.brush-control { display: grid; gap: 6px; }
.brush-buttons { justify-content: space-between; gap: 8px; }
.brush-btn { width: 42px; height: 38px; }
.brush-glyph { display: grid; place-items: center; width: 48px; height: 38px; color: var(--creative-accent); }
.tool-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); gap: 5px; }
.tool-choice { justify-content: flex-start; }
.tool-choice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.control-grid--labels .tool-btn span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-choice kbd { margin-left: auto; padding: 1px 4px; border: 1px solid var(--bd-ln, #3b3d40); border-radius: 4px; color: var(--bd-mu, #a3a5a8); font: 500 .8em var(--bd-mono, ui-monospace, monospace); }
.render-hotkey { display: grid; flex: 1; min-width: 100px; gap: 3px; color: var(--bd-mu, #a3a5a8); font-size: .76em; }
.render-hotkey input { width: 100%; min-width: 0; box-sizing: border-box; height: 30px; padding: 0 7px; border: 1px solid var(--bd-ln, #3b3d40); border-radius: 7px; color: var(--bd-ink, #ece9e2); background: var(--bd-bg, #242629); font: inherit; }
/* En XS el error largo se recorta a una línea (texto completo en `title`). */
.creative-error { margin: 0; flex: none; padding: 7px 9px; border-left: 2px solid var(--bd-danger, #e5484d); color: var(--bd-danger, #ff8b84); background: color-mix(in srgb, var(--bd-danger, #e5484d) 9%, transparent); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: .86em; }
.only-l { display: none !important; }
.control-footer.only-l { display: none !important; }
.page-row.only-l { display: none !important; }
/* En XS se ocultan subtítulo y chip (quedan icono + nombre). */
.creative-heading .m-plus, .current-chip.m-plus { display: none; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@container creative-tools (min-width: 200px) and (min-height: 140px) {
  .creative-control { overflow: hidden; }
  .creative-heading .m-plus { display: block; }
  .current-chip.m-plus { display: block; }
  .busy-chip.m-plus { display: inline-flex; }
  .xs-essentials { display: none !important; }
  .full-groups { display: flex; flex: 1 1 auto; flex-direction: column; gap: clamp(8px, 1.9cqi, 13px); min-height: 0; overflow: hidden; }
  .creative-error { white-space: normal; overflow-wrap: anywhere; }
}
/* Páginas de grupos (ver useFitPager): la visible manda; el resto, ocultas. */
/* El slot del carrusel interno rellena la vista (las parrillas auto-fit
   colapsarían como flex-item sin ancho mínimo). */
.full-groups :deep(.bd-carousel-view) > * { flex: 1 1 auto; min-width: 0; }
.full-groups > .page { display: flex; flex: none; flex-direction: column; min-width: 0; min-height: 0; }
.group-pager { display: flex; flex: none; align-items: center; justify-content: center; gap: 6px; padding-top: 2px; }
.pager-dot { width: 7px; height: 7px; padding: 0; border: 0; border-radius: 999px; background: currentcolor; opacity: .3; cursor: pointer; }
.pager-dot.is-active { width: 16px; opacity: .9; }
.group-pager small { color: var(--bd-mu, #a3a5a8); font-size: 10px; font-variant-numeric: tabular-nums; }
/* Baja altura con anchura M/L (p. ej. filas 2×1/3×1 anchas): 4 esenciales
   sin scroll en lugar de grupos recortados. */
@container creative-tools (min-width: 200px) and (max-height: 189px) {
  .xs-essentials { display: grid !important; }
  .full-groups { display: none !important; }
}
/* Blindaje: ningún descendiente puede abrir scrollbar (sin scroll). */
.creative-control *, .creative-control *::before, .creative-control *::after {
  scrollbar-width: none !important;
}
.creative-control *::-webkit-scrollbar { display: none !important; }
@container creative-tools (min-width: 340px) and (min-height: 140px) {
  .control-footer.only-l { display: flex !important; }
  .page-row.only-l { display: flex !important; }
  .control-group.only-l { display: grid !important; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
</style>
