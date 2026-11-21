<template>
  <div :class="[
    'flex flex-col relative',
    props.mode === 'edit' ? 'flex-1 px-6 py-4 items-center justify-center gap-4' : 'h-full w-full items-center justify-center'
  ]">
    <!-- Exit Deck Mode Button - Only in Deck Mode -->
    <button
      v-if="props.mode === 'deck'"
      @click="$emit('mode-change', 'edit')"
      class="absolute top-4 right-4 z-50 btn btn-circle btn-ghost btn-sm border border-base-content/10"
      :title="t('streamDeckGrid.exitDeckMode')"
      :aria-label="t('streamDeckGrid.exitDeckMode')"
    >
      <Edit :size="16" stroke-width="1.5" aria-hidden="true" />
    </button>

    <div
      ref="container"
      data-swapy-container
      :class="[
        'grid rounded-2xl border',
        props.mode === 'edit' ? 'bg-base-200 border-base-300' : 'bg-transparent border-transparent',
        props.mode === 'edit' ? 'gap-2 p-4' : 'gap-0 p-0'
      ]"
      :style="props.mode === 'edit' ? { 
        gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
        gridTemplateRows: `repeat(${gridRows}, 1fr)` 
      } : {
        '--cell-size': cellSize,
        gridTemplateColumns: `repeat(${gridCols}, var(--cell-size))`,
        gridTemplateRows: `repeat(${gridRows}, var(--cell-size))`,
        gap: '10px',
        margin: '20px auto'
      }"
    >
      <div
        v-for="index in (gridCols * gridRows)"
        :key="`slot-${index - 1}`"
        :data-swapy-slot="`slot-${index - 1}`"
        :class="[
          'slot-container flex items-center justify-center',
          props.mode === 'edit' ? 'w-20 h-20' : 'w-full h-full'
        ]"
        @contextmenu.prevent.stop="showContextMenu($event, index - 1)"
      >
        <div 
          :data-swapy-item="getButton(index - 1) ? `item-${getButton(index - 1)!.id}` : `empty-${index - 1}`"
          class="w-full h-full"
        >
          <button
            @click="props.mode === 'deck' ? $emit('button-execute', index - 1) : $emit('button-click', index - 1)"
            @dblclick="props.mode === 'edit' ? $emit('button-execute', index - 1) : null"
            :class="[
              'deck-button',
              'w-full h-full relative',
              'flex flex-col items-center justify-center',
              props.mode === 'edit' ? 'gap-1 p-2' : 'gap-2 p-3',
              selectedButton === (index - 1) ? 'selected' : '',
              props.mode === 'edit' ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
              executingButtons.includes(index - 1) ? 'executing' : '',
            ]"
            :style="getButtonStyle(index - 1)"
            :data-cy="`button-slot`"
          >
            <!-- Content for buttons with data -->
            <template v-if="getButton(index - 1)">
              <!-- Top Text -->
              <div 
                v-if="getButtonData(index - 1)?.textTop"
                :class="[
                  'font-medium text-center leading-tight w-full truncate px-1',
                  props.mode === 'edit' ? 'text-xs' : 'text-sm'
                ]"
                :style="{ fontSize: (getButtonData(index - 1)?.fontSize || (props.mode === 'edit' ? 13 : 16)) + 'px' }"
              >
                {{ getButtonData(index - 1).textTop }}
              </div>
              
              <!-- Icon (lucide) or Dynamic Value -->
              <div class="flex items-center justify-center text-base-content/90">
                <!-- Show dynamic value if available (any plugin with dynamic actions) -->
                <span v-if="getButtonData(index - 1)?.dynamicValue" :class="[
                  'font-mono tabular',
                  props.mode === 'edit' ? 'text-base' : 'text-lg'
                ]">
                  {{ getButtonData(index - 1).dynamicValue }}
                </span>
                <!-- Otherwise show icon -->
                <component 
                  v-else-if="getButtonData(index - 1)?.icon" 
                  :is="getLucideIcon(getButtonData(index - 1)?.icon)"
                  :size="props.mode === 'edit' ? 28 : 40"
                  :stroke-width="1.5"
                />
                <Zap v-else :size="props.mode === 'edit' ? 22 : 32" stroke-width="1.5" class="opacity-30" />
              </div>
              
              <!-- Bottom Text -->
              <div 
                v-if="getButtonData(index - 1)?.textBottom"
                :class="[
                  'font-medium text-center leading-tight w-full truncate',
                  props.mode === 'edit' ? 'text-xs' : 'text-sm'
                ]"
                :style="{ fontSize: (getButtonData(index - 1)?.fontSize || (props.mode === 'edit' ? 13 : 16)) + 'px' }"
              >
                {{ getButtonData(index - 1).textBottom }}
              </div>
              
              <!-- Action Count -->
              <div 
                v-if="getButtonData(index - 1)?.actions?.length" 
                class="ld-count absolute top-1.5 right-2"
              >
                {{ getButtonData(index - 1)?.actions?.length || 0 }}
              </div>
            </template>
            
            <!-- Content for empty slots -->
            <template v-else>
              <!-- Show live preview if this slot is selected and has content -->
              <template v-if="selectedButton === (index - 1) && (buttonConfig.textTop || buttonConfig.textBottom || buttonConfig.label || buttonConfig.icon || buttonConfig.emoji || buttonConfig.actions.length)">
                <!-- Top Text -->
                <div 
                  v-if="buttonConfig.textTop"
                  :class="[
                    'font-medium text-center leading-tight w-full',
                    props.mode === 'edit' ? 'text-xs' : 'text-sm'
                  ]"
                  :style="{ fontSize: (buttonConfig.fontSize || (props.mode === 'edit' ? 14 : 18)) + 'px' }"
                >
                  {{ buttonConfig.textTop }}
                </div>
                
                <!-- Icon or Emoji -->
                <!-- Icon -->
                <div class="flex items-center justify-center text-base-content/90">
                  <component 
                    v-if="buttonConfig.icon" 
                    :is="getLucideIcon(buttonConfig.icon)"
                    :size="props.mode === 'edit' ? 28 : 40"
                    :stroke-width="1.5"
                  />
                  <Zap v-else :size="props.mode === 'edit' ? 22 : 32" stroke-width="1.5" class="opacity-30" />
                </div>
                
                <!-- Bottom Text -->
                <div 
                  v-if="buttonConfig.textBottom"
                  :class="[
                    'font-medium text-center leading-tight w-full truncate',
                    props.mode === 'edit' ? 'text-xs' : 'text-sm'
                  ]"
                  :style="{ fontSize: (buttonConfig.fontSize || (props.mode === 'edit' ? 13 : 16)) + 'px' }"
                >
                  {{ buttonConfig.textBottom }}
                </div>
                
                <div 
                  v-if="buttonConfig.actions?.length" 
                  class="ld-count absolute top-1.5 right-2"
                >
                  {{ buttonConfig.actions.length }}
                </div>
              </template>
              
              <!-- Default empty state -->
              <template v-else>
                <div class="opacity-30">
                  <Plus :size="props.mode === 'edit' ? 20 : 28" stroke-width="1.5" />
                </div>
                <div class="ld-count">{{ index }}</div>
              </template>
            </template>
          </button>
        </div>
      </div>
    </div>
    
    <!-- Context Menu -->
    <ContextMenu
      :show="contextMenu.show"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :items="contextMenuItems"
      @item-click="handleContextMenuItem"
      @close="hideContextMenu"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { createSwapy, type Swapy } from 'swapy'
import { Plus, Play, Trash2, Minus, Edit, Zap } from 'lucide-vue-next'
import * as LucideIcons from 'lucide-vue-next'
import ContextMenu from './ContextMenu.vue'
import { useI18nStore } from '../composables/useI18n'
import type { ButtonData, ButtonEntity } from '../types/streamdeck'

const { t } = useI18nStore()

interface Props {
  gridCols: number
  gridRows: number
  selectedButton: number | null
  executingButtons: number[]
  buttonConfig: ButtonData
  getButton: (position: number) => ButtonEntity | undefined
  getButtonData: (position: number) => any
  getButtonStyle: (position: number) => any
  mode: 'edit' | 'deck'
}

interface Emits {
  (e: 'button-click', position: number): void
  (e: 'button-execute', position: number): void
  (e: 'button-delete', position: number): void
  (e: 'swap', event: any): void
  (e: 'grid-size-change', deltaX: number, deltaY: number): void
  (e: 'mode-change', mode: 'edit' | 'deck'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

// Computed cell size for deck mode to ensure square buttons and fit screen
const cellSize = computed(() => `min(calc((100vw - 10px * (${props.gridCols} - 1)) / ${props.gridCols}), calc((100vh - 40px - 10px * (${props.gridRows} - 1)) / ${props.gridRows}))`)

// Swapy instance
const container = ref<HTMLElement | null>(null)
const swapy = ref<Swapy | null>(null)

// Watch mode changes to enable/disable Swapy
watch(() => props.mode, (newMode) => {
  if (newMode === 'edit' && !swapy.value) {
    initializeSwapy()
  } else if (newMode === 'deck' && swapy.value) {
    swapy.value.destroy()
    swapy.value = null
  }
})

// Context menu state
const contextMenu = ref({
  show: false,
  x: 0,
  y: 0,
  position: -1
})

// Context menu items
const contextMenuItems = computed(() => {
  const button = props.getButton(contextMenu.value.position)
  
  if (button) {
    // Menu for existing buttons
    return [
      {
        id: 'execute',
        label: t('streamDeckGrid.press'),
        icon: Play,
        danger: false
      },
      {
        id: 'delete',
        label: t('streamDeckGrid.delete'),
        icon: Trash2,
        danger: true
      }
    ]
  } else {
    // Menu for empty slots
    return [
      {
        id: 'create',
        label: t('streamDeckGrid.createButton'),
        icon: Plus,
        danger: false
      }
    ]
  }
})

// Get Lucide icon component by name
const getLucideIcon = (iconName: string) => {
  const icons = LucideIcons as Record<string, any>
  return icons[iconName] || Plus
}

// Show context menu
const showContextMenu = (event: MouseEvent, position: number) => {
  event.preventDefault()
  
  contextMenu.value = {
    show: true,
    x: event.clientX,
    y: event.clientY,
    position
  }
}

// Hide context menu
const hideContextMenu = () => {
  contextMenu.value.show = false
}

// Handle context menu item click
const handleContextMenuItem = (item: any) => {
  switch (item.id) {
    case 'execute':
      emit('button-execute', contextMenu.value.position)
      break
    case 'delete':
      emit('button-delete', contextMenu.value.position)
      break
    case 'create':
      emit('button-click', contextMenu.value.position)
      break
  }
  hideContextMenu()
}

// Close context menu on Escape key
const handleEscapeKey = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && contextMenu.value.show) {
    hideContextMenu()
  }
}

// Initialize Swapy
const initializeSwapy = () => {
  if (container.value) {
    swapy.value = createSwapy(container.value, {
      animation: 'dynamic'
    })

    // Usar onSwapEnd en lugar de onSwap para emitir solo cuando termina el drag
    swapy.value.onSwapEnd(event => {
      console.log('🔄 Swap ended', event)
      emit('swap', event)
    })
  }
}

// Tras un swap, el estado ya está sincronizado (handleSwap) y Vue re-renderiza
// los items en sus nuevas posiciones: hay que re-vincular Swapy al DOM nuevo
// para que el siguiente drag parta del mapa correcto.
const resyncSwapy = () => {
  if (props.mode !== 'edit') return
  swapy.value?.destroy()
  swapy.value = null
  initializeSwapy()
}

onMounted(() => {
  if (props.mode === 'edit') {
    initializeSwapy()
  }
  document.addEventListener('keydown', handleEscapeKey)
  window.addEventListener('libredeck:swapy-resync', resyncSwapy)
})

onUnmounted(() => {
  swapy.value?.destroy()
  document.removeEventListener('keydown', handleEscapeKey)
  window.removeEventListener('libredeck:swapy-resync', resyncSwapy)
})
</script>

<style scoped>
/* Swapy drag & drop styles */
.slot-container {
  position: relative;
  transition: opacity 120ms cubic-bezier(0.2, 0, 0, 1);
}
</style>

<style>
/* Global Swapy styles - must be unscoped */
[data-swapy-item] {
  cursor: grab;
}

[data-swapy-item]:active {
  cursor: grabbing;
}

[data-swapy-item].swapy-item-dragging {
  opacity: 0.9 !important;
  z-index: 1000 !important;
  box-shadow: 0 8px 20px rgb(0 0 0 / 0.35) !important;
  transition: none !important;
}

[data-swapy-slot].swapy-slot-over {
  background: rgb(79 140 255 / 0.08) !important;
  outline: 1px dashed rgb(79 140 255 / 0.5) !important;
  outline-offset: -1px;
  border-radius: 14px !important;
}

[data-swapy-container] {
  position: relative;
}

[data-swapy-slot] {
  border-radius: 14px;
  transition: opacity 120ms cubic-bezier(0.2, 0, 0, 1);
  position: relative;
}

/* Dragging cursor for the entire container */
[data-swapy-container].swapy-container-dragging {
  cursor: grabbing;
}

/* Disable transitions during drag to prevent visual glitches */
[data-swapy-container].swapy-container-dragging .slot-container {
  transition: none !important;
}

[data-swapy-container].swapy-container-dragging .deck-button {
  transition: none !important;
}

/* Improve visual feedback during drag */
[data-swapy-slot]:not(.swapy-slot-over) {
  opacity: 1;
}

.swapy-container-dragging [data-swapy-slot]:not(.swapy-slot-over) {
  opacity: 0.6;
}
</style>