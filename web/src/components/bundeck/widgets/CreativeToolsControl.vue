<template>
  <section class="creative-control creative-cq" :data-cy="`creative-tools-${editor}`" :aria-label="label || editorName">
    <header class="creative-head">
      <div class="creative-brand">
        <span class="creative-mark" aria-hidden="true"><component :is="editorIcon" :size="17" /></span>
        <div class="creative-heading">
          <strong>{{ label || editorName }}</strong>
          <span>{{ subtitle }}</span>
        </div>
      </div>
      <span v-if="busy" class="current-chip busy-chip"><LoaderCircle :size="13" class="spin" />{{ tr('Ejecutando…', 'Running…') }}</span>
      <span v-else-if="anchorValue" class="current-chip">{{ anchorValue }}</span>
    </header>

    <p v-if="error" class="creative-error" role="alert">{{ error }}</p>

    <template v-if="editor === 'premiere'">
      <div class="control-group">
        <span class="group-title">{{ tr('TRANSPORTE', 'TRANSPORT') }}</span>
        <div class="control-grid">
          <button class="tool-btn" :disabled="readonly || busy" :aria-label="tr('Retroceder', 'Reverse')" @click="run('transport', { operation: 'reverse' })"><Rewind :size="17" /></button>
          <button class="tool-btn tool-btn--main" :disabled="readonly || busy" :aria-label="tr('Reproducir o pausar', 'Play or pause')" @click="run('transport', { operation: 'play-pause' })"><Play :size="17" /></button>
          <button class="tool-btn" :disabled="readonly || busy" :aria-label="tr('Detener shuttle', 'Stop shuttle')" @click="run('transport', { operation: 'shuttle-stop' })"><Square :size="16" /></button>
          <button class="tool-btn" :disabled="readonly || busy" :aria-label="tr('Avanzar', 'Forward')" @click="run('transport', { operation: 'forward' })"><FastForward :size="17" /></button>
          <button class="tool-btn" :disabled="readonly || busy" :aria-label="tr('Fotograma anterior', 'Previous frame')" @click="run('transport', { operation: 'frame-back' })"><SkipBack :size="16" /></button>
          <button class="tool-btn" :disabled="readonly || busy" :aria-label="tr('Fotograma siguiente', 'Next frame')" @click="run('transport', { operation: 'frame-forward' })"><SkipForward :size="16" /></button>
        </div>
      </div>
      <div class="control-group">
        <span class="group-title">{{ tr('JOG / SHUTTLE', 'JOG / SHUTTLE') }}</span>
        <div class="control-grid control-grid--labels">
          <button class="tool-btn" :disabled="readonly || busy" @click="run('jog-shuttle', { mode: 'shuttle-back' })"><Rewind :size="15" />{{ tr('Atrás', 'Back') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('jog-shuttle', { mode: 'shuttle-stop' })"><Square :size="14" />{{ tr('Detener', 'Stop') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('jog-shuttle', { mode: 'shuttle-forward' })"><FastForward :size="15" />{{ tr('Adelante', 'Forward') }}</button>
        </div>
      </div>
      <div class="control-group">
        <span class="group-title">{{ tr('MARCAS Y MARCADORES', 'MARKS & MARKERS') }}</span>
        <div class="control-grid control-grid--labels">
          <button class="tool-btn" :disabled="readonly || busy" @click="run('mark', { point: 'mark-in' })"><CornerDownLeft :size="15" />{{ tr('Entrada', 'In') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('mark', { point: 'mark-out' })"><CornerDownRight :size="15" />{{ tr('Salida', 'Out') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('marker', { operation: 'add-marker' })"><Flag :size="15" />{{ tr('Marcador', 'Marker') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('marker', { operation: 'go-prev-marker' })"><ChevronLeft :size="15" />{{ tr('Anterior', 'Previous') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('marker', { operation: 'go-next-marker' })"><ChevronRight :size="15" />{{ tr('Siguiente', 'Next') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('mark', { point: 'clear-in-out' })"><X :size="15" />{{ tr('Limpiar', 'Clear') }}</button>
        </div>
      </div>
      <div class="control-footer">
        <button class="tool-btn" :disabled="readonly || busy" @click="run('history', { operation: 'undo' })"><Undo2 :size="15" />{{ tr('Deshacer', 'Undo') }}</button>
        <button class="tool-btn" :disabled="readonly || busy" @click="run('save')"><Save :size="15" />{{ tr('Guardar', 'Save') }}</button>
      </div>
    </template>

    <template v-else-if="editor === 'davinci'">
      <div class="control-group">
        <span class="group-title">{{ tr('TRANSPORTE', 'TRANSPORT') }}</span>
        <div class="control-grid">
          <button class="tool-btn" :disabled="readonly || busy" :aria-label="tr('Reproducir hacia atrás', 'Play in reverse')" @click="run('transport', { operation: 'play-reverse' })"><Rewind :size="17" /></button>
          <button class="tool-btn tool-btn--main" :disabled="readonly || busy" :aria-label="tr('Reproducir o pausar', 'Play or pause')" @click="run('transport', { operation: 'play-pause' })"><Play :size="17" /></button>
          <button class="tool-btn" :disabled="readonly || busy" :aria-label="tr('Detener', 'Stop')" @click="run('transport', { operation: 'stop' })"><Square :size="16" /></button>
          <button class="tool-btn" :disabled="readonly || busy" :aria-label="tr('Reproducir hacia adelante', 'Play forward')" @click="run('transport', { operation: 'play-forward' })"><FastForward :size="17" /></button>
          <button class="tool-btn" :disabled="readonly || busy" :aria-label="tr('Fotograma anterior', 'Previous frame')" @click="run('transport', { operation: 'frame-back' })"><SkipBack :size="16" /></button>
          <button class="tool-btn" :disabled="readonly || busy" :aria-label="tr('Fotograma siguiente', 'Next frame')" @click="run('transport', { operation: 'frame-forward' })"><SkipForward :size="16" /></button>
        </div>
      </div>
      <div class="control-group">
        <span class="group-title">{{ tr('EDICIÓN', 'EDITING') }}</span>
        <div class="control-grid control-grid--labels">
          <button class="tool-btn" :disabled="readonly || busy" @click="run('edit', { operation: 'cut' })"><Scissors :size="15" />{{ tr('Cortar', 'Cut') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('edit', { operation: 'copy' })"><Copy :size="15" />{{ tr('Copiar', 'Copy') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('edit', { operation: 'paste' })"><Clipboard :size="15" />{{ tr('Pegar', 'Paste') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('edit', { operation: 'blade' })"><Slice :size="15" />{{ tr('Cuchilla', 'Blade') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('edit', { operation: 'delete' })"><Trash2 :size="15" />{{ tr('Eliminar', 'Delete') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('marker', { operation: 'add-marker' })"><Flag :size="15" />{{ tr('Marcador', 'Marker') }}</button>
        </div>
      </div>
      <div class="control-footer">
        <label class="render-hotkey"><span>{{ tr('Atajo de render', 'Render shortcut') }}</span><input v-model="renderHotkey" :disabled="readonly || busy" :placeholder="tr('Ej. ctrl+f12', 'e.g. ctrl+f12')" /></label>
        <button class="tool-btn" :disabled="readonly || busy || !renderHotkey.trim()" @click="run('render-start', { hotkey: renderHotkey.trim() })"><Clapperboard :size="15" />{{ tr('Render', 'Render') }}</button>
        <button class="tool-btn" :disabled="readonly || busy" @click="run('save-project')"><Save :size="15" />{{ tr('Guardar', 'Save') }}</button>
      </div>
      <div class="page-row" :aria-label="tr('Cambiar página de DaVinci', 'Switch DaVinci page')">
        <button v-for="page in davinciPages" :key="page" class="page-btn" :disabled="readonly || busy" :aria-label="`${tr('Página', 'Page')} ${pageName(page)}`" @click="run('switch-page', { page })">{{ pageName(page) }}</button>
      </div>
    </template>

    <template v-else-if="editor === 'photoshop'">
      <div class="brush-control">
        <span class="group-title">{{ tr('TAMAÑO DE PINCEL', 'BRUSH SIZE') }}</span>
        <div class="brush-buttons">
          <button class="tool-btn brush-btn" :disabled="readonly || busy" :aria-label="tr('Reducir tamaño del pincel', 'Decrease brush size')" @click="run('brush-size', { direction: 'decrease' })"><Minus :size="18" /></button>
          <span class="brush-glyph" aria-hidden="true"><Brush :size="23" /></span>
          <button class="tool-btn brush-btn" :disabled="readonly || busy" :aria-label="tr('Aumentar tamaño del pincel', 'Increase brush size')" @click="run('brush-size', { direction: 'increase' })"><Plus :size="18" /></button>
        </div>
      </div>
      <div class="control-group">
        <span class="group-title">{{ tr('HERRAMIENTAS', 'TOOLS') }}</span>
        <div class="tool-list">
          <button v-for="tool in photoshopTools" :key="tool.id" class="tool-btn tool-choice" :class="{ selected: anchorValue === tool.id }" :disabled="readonly || busy" @click="run('tool-select', { tool: tool.id })">
            <component :is="tool.icon" :size="16" /><span>{{ tool.label }}</span><kbd>{{ tool.key }}</kbd>
          </button>
        </div>
      </div>
      <div class="control-group">
        <span class="group-title">{{ tr('CAPAS E HISTORIAL', 'LAYERS & HISTORY') }}</span>
        <div class="control-grid control-grid--labels">
          <button class="tool-btn" :disabled="readonly || busy" @click="run('layer-ops', { op: 'new' })"><Layers2 :size="15" />{{ tr('Nueva capa', 'New layer') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('layer-ops', { op: 'duplicate' })"><Copy :size="15" />{{ tr('Duplicar', 'Duplicate') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('layer-ops', { op: 'merge-down' })"><Combine :size="15" />{{ tr('Combinar', 'Merge down') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('history', { operation: 'undo' })"><Undo2 :size="15" />{{ tr('Deshacer', 'Undo') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('history', { operation: 'redo' })"><Redo2 :size="15" />{{ tr('Rehacer', 'Redo') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('save-export', { operation: 'save' })"><Save :size="15" />{{ tr('Guardar', 'Save') }}</button>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="control-group">
        <span class="group-title">{{ tr('VISTA 3D', '3D VIEW') }}</span>
        <div class="control-grid control-grid--labels">
          <button v-for="view in blenderViews" :key="view.id" class="tool-btn" :class="{ selected: anchorValue === view.id }" :disabled="readonly || busy" @click="run('viewport', { view: view.id })"><component :is="view.icon" :size="16" />{{ view.label }}</button>
        </div>
      </div>
      <div class="control-group">
        <span class="group-title">{{ tr('RENDER', 'RENDER') }}</span>
        <div class="control-grid control-grid--labels">
          <button class="tool-btn tool-btn--main" :disabled="readonly || busy" @click="run('render', { operation: 'render-image' })"><Image :size="16" />{{ tr('Imagen', 'Image') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('render', { operation: 'render-animation' })"><Film :size="16" />{{ tr('Animación', 'Animation') }}</button>
          <button class="tool-btn" :disabled="readonly || busy" @click="run('render', { operation: 'cancel-render' })"><X :size="16" />{{ tr('Cancelar', 'Cancel') }}</button>
        </div>
      </div>
      <div class="control-footer">
        <button class="tool-btn" :disabled="readonly || busy" @click="run('save', { operation: 'save' })"><Save :size="15" />{{ tr('Guardar', 'Save') }}</button>
        <button class="tool-btn" :disabled="readonly || busy" @click="run('save', { operation: 'save-incremental' })"><Files :size="15" />{{ tr('Incremental', 'Incremental') }}</button>
      </div>
    </template>

    <span class="sr-status" role="status" aria-live="polite">{{ busy ? tr('Ejecutando…', 'Running…') : error }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Blend, Box, Brush, ChevronLeft, ChevronRight, Clapperboard, Clipboard, Combine,
  Copy, CornerDownLeft, CornerDownRight, FastForward, Files, Film, Flag, Image,
  Layers2, LoaderCircle, Minus, Plus, Play, Redo2, Rewind, Save, Scissors, Slice, SkipBack,
  SkipForward, Square, Trash2, Undo2, X,
} from 'lucide-vue-next'
import { executeWidgetAction } from '../../../composables/useWidgetAction'
import { useI18nStore } from '../../../composables/useI18n'

interface Props {
  action: { type: string; parameters: Record<string, any> }
  apiBase: string
  label?: string
  readonly?: boolean
}

const props = withDefaults(defineProps<Props>(), { label: '', readonly: false })
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
  { id: 'camera', label: tr('Cámara', 'Camera'), icon: Image },
  { id: 'toggle-perspective', label: tr('Orto / Persp.', 'Ortho / persp.'), icon: Blend },
  { id: 'frame-all', label: tr('Encuadrar', 'Frame all'), icon: Box },
  { id: 'shade-solid', label: tr('Sombreado', 'Shading'), icon: Blend },
])

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
  overflow: auto;
  container-type: size;
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
.creative-head, .creative-brand, .control-footer, .brush-buttons, .page-row { display: flex; align-items: center; }
.creative-head { justify-content: space-between; gap: 8px; flex: none; }
.creative-brand { min-width: 0; gap: 9px; }
.creative-mark { display: grid; place-items: center; width: 31px; height: 31px; flex: none; color: var(--creative-accent); background: color-mix(in srgb, var(--creative-accent) 12%, transparent); border-radius: 9px; }
.creative-heading { display: grid; gap: 2px; min-width: 0; }
.creative-heading strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1.08em; }
.creative-heading span, .group-title { color: var(--bd-mu, #a3a5a8); font-size: .78em; }
.current-chip { max-width: 36%; overflow: hidden; padding: 4px 7px; color: var(--creative-accent); background: color-mix(in srgb, var(--creative-accent) 10%, transparent); border-radius: 7px; text-overflow: ellipsis; white-space: nowrap; font: 500 .82em var(--bd-mono, ui-monospace, monospace); }
.busy-chip { display: inline-flex; align-items: center; gap: 5px; }
.control-group { display: grid; gap: 6px; min-width: 0; }
.group-title { font-size: .72em; letter-spacing: .07em; }
.control-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 5px; }
.control-grid--labels { grid-template-columns: repeat(auto-fit, minmax(min(74px, 30%), 1fr)); }
.tool-btn { display: inline-flex; min-width: 0; min-height: 34px; align-items: center; justify-content: center; gap: 5px; padding: 5px 7px; border: 1px solid var(--bd-ln, #3b3d40); border-radius: 8px; color: var(--bd-ink, #ece9e2); background: var(--bd-bg, #242629); font: inherit; cursor: pointer; transition: border-color 120ms ease, background 120ms ease, transform 120ms ease; }
.tool-btn:hover:not(:disabled), .page-btn:hover:not(:disabled) { border-color: var(--creative-accent); }
.tool-btn:active:not(:disabled) { transform: translateY(1px); }
.tool-btn:focus-visible, .page-btn:focus-visible, .render-hotkey input:focus-visible { outline: 2px solid var(--creative-accent); outline-offset: 2px; }
.tool-btn:disabled, .page-btn:disabled { opacity: .48; cursor: not-allowed; }
.tool-btn--main { border-color: color-mix(in srgb, var(--creative-accent) 65%, var(--bd-ln, #3b3d40)); background: color-mix(in srgb, var(--creative-accent) 16%, var(--bd-bg, #242629)); }
.tool-btn.selected { color: var(--creative-accent); border-color: var(--creative-accent); }
.control-footer { flex-wrap: wrap; gap: 5px; }
.control-footer > .tool-btn { flex: 1; }
.page-row { flex-wrap: wrap; gap: 4px; }
.page-btn { min-width: 0; flex: 1; padding: 5px 6px; border: 1px solid var(--bd-ln, #3b3d40); border-radius: 7px; color: var(--bd-ink, #ece9e2); background: var(--bd-bg, #242629); font: 500 .76em var(--bd-mono, ui-monospace, monospace); text-transform: capitalize; cursor: pointer; }
.brush-control { display: grid; gap: 6px; }
.brush-buttons { justify-content: space-between; gap: 8px; }
.brush-btn { width: 42px; height: 38px; }
.brush-glyph { display: grid; place-items: center; width: 48px; height: 38px; color: var(--creative-accent); }
.tool-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); gap: 5px; }
.tool-choice { justify-content: flex-start; }
.tool-choice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-choice kbd { margin-left: auto; padding: 1px 4px; border: 1px solid var(--bd-ln, #3b3d40); border-radius: 4px; color: var(--bd-mu, #a3a5a8); font: 500 .8em var(--bd-mono, ui-monospace, monospace); }
.render-hotkey { display: grid; flex: 1; min-width: 100px; gap: 3px; color: var(--bd-mu, #a3a5a8); font-size: .76em; }
.render-hotkey input { width: 100%; min-width: 0; box-sizing: border-box; height: 30px; padding: 0 7px; border: 1px solid var(--bd-ln, #3b3d40); border-radius: 7px; color: var(--bd-ink, #ece9e2); background: var(--bd-bg, #242629); font: inherit; }
.creative-error { margin: 0; padding: 7px 9px; border-left: 2px solid var(--bd-danger, #e5484d); color: var(--bd-danger, #ff8b84); background: color-mix(in srgb, var(--bd-danger, #e5484d) 9%, transparent); overflow-wrap: anywhere; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.sr-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@container (max-width: 240px) {
  .creative-control { padding: 7px; gap: 6px; }
  .creative-mark { width: 25px; height: 25px; }
  .creative-heading span { display: none; }
  .control-grid { gap: 3px; }
  .tool-btn { min-height: 30px; padding: 4px; }
  .tool-choice { font-size: .9em; }
  .tool-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container (min-aspect-ratio: 1.4) {
  .creative-control { gap: 7px; }
  .control-grid--labels { grid-template-columns: repeat(auto-fit, minmax(78px, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
</style>
