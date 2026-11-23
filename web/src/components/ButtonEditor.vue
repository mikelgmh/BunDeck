<template>
  <div class="space-y-4" data-cy="button-editor">
    <!-- Contenido -->
    <section aria-labelledby="be-content-title">
      <p id="be-content-title" class="mb-2 text-xs font-medium text-base-content/50">{{ t('buttonEditor.content') }}</p>
      <div class="space-y-3">
      <!-- Icon Picker -->
      <IconPicker
        :model-value="buttonConfig.icon || ''"
        @update:model-value="updateIcon"
      />

      <!-- Text Top -->
      <div class="form-control w-full">
        <label class="label py-1" for="be-text-top">
          <span class="label-text text-[13px] font-medium">{{ t('buttonEditor.textTop') }}</span>
        </label>
        <input
          id="be-text-top"
          :value="buttonConfig.textTop || ''"
          @input="updateTextTop"
          type="text"
          :placeholder="t('buttonEditor.textTopPlaceholder') + '…'"
          autocomplete="off"
          spellcheck="false"
          class="input input-bordered input-sm w-full ld-control px-3 placeholder:text-base-content/40"
          data-cy="text-top-input"
        />
      </div>

      <!-- Text Bottom -->
      <div class="form-control w-full">
        <label class="label py-1" for="be-text-bottom">
          <span class="label-text text-[13px] font-medium">{{ t('buttonEditor.textBottom') }}</span>
        </label>
        <input
          id="be-text-bottom"
          :value="buttonConfig.textBottom || ''"
          @input="updateTextBottom"
          type="text"
          :placeholder="t('buttonEditor.textBottomPlaceholder') + '…'"
          autocomplete="off"
          spellcheck="false"
          class="input input-bordered input-sm w-full ld-control px-3 placeholder:text-base-content/40"
          data-cy="text-bottom-input"
        />
      </div>
      </div>
    </section>

    <!-- Estilo -->
    <section aria-labelledby="be-style-title">
      <p id="be-style-title" class="mb-2 text-xs font-medium text-base-content/50">{{ t('buttonEditor.style') }}</p>
      <div class="space-y-3">
      <!-- Font Size -->
      <div class="form-control w-full">
        <label class="label py-1" for="be-font-size">
          <span class="label-text text-[13px] font-medium">{{ t('buttonEditor.fontSize') }}</span>
        </label>
        <input
          id="be-font-size"
          :value="buttonConfig.fontSize || 14"
          @input="updateFontSize"
          type="number"
          min="8"
          max="48"
          placeholder="14"
          inputmode="numeric"
          class="input input-bordered input-sm w-full ld-control px-3 tabular placeholder:text-base-content/40"
        />
      </div>

      <!-- Colors -->
      <div class="grid grid-cols-2 gap-2">
        <div class="form-control">
          <label class="label py-1" for="be-bg">
            <span class="label-text text-[13px] font-medium">{{ t('buttonEditor.backgroundColor') }}</span>
          </label>
          <input
            id="be-bg"
            :value="buttonConfig.backgroundColor"
            @input="updateBackgroundColor"
            type="color"
            class="input input-bordered input-sm w-full h-8 px-1 py-1 cursor-pointer"
          />
        </div>

        <div class="form-control">
          <label class="label py-1" for="be-fg">
            <span class="label-text text-[13px] font-medium">{{ t('buttonEditor.textColor') }}</span>
          </label>
          <input
            id="be-fg"
            :value="buttonConfig.textColor"
            @input="updateTextColor"
            type="color"
            class="input input-bordered input-sm w-full h-8 px-1 py-1 cursor-pointer"
          />
        </div>
      </div>
      </div>
    </section>

    <!-- Actions Section -->
    <section :aria-label="t('buttonEditor.actions')">
    <div class="flex items-center gap-2 pt-1">
      <span class="text-xs font-medium text-base-content/50">{{ t('buttonEditor.actions') }}</span>
      <div class="flex-1 h-px bg-base-300" aria-hidden="true"></div>
      <span v-if="buttonConfig.actions.length" class="ld-count" aria-live="polite">{{ buttonConfig.actions.length }}</span>
    </div>
    
    <div 
      ref="actionsContainer"
      class="rounded-xl border transition-[border-color,background-color] duration-150"
      :class="{
        'border-base-300 bg-base-100/50': !isDraggingAction,
        'border-dashed border-primary bg-primary/5': isDraggingAction,
      }"
      @dragover.prevent="handleDragOver"
      @dragleave="handleDragLeave"
      @drop.prevent="handleDrop"
      data-cy="drop-zone"
    >
      <!-- Swapy container with slots -->
      <div v-if="buttonConfig.actions.length > 0" class="space-y-2 p-2" data-cy="button-actions">
        <div 
          v-for="(action, index) in buttonConfig.actions" 
          :key="action.id"
          :data-swapy-slot="action.id"
        >
          <div :data-swapy-item="action.id">
            <ActionEditor
              :action="action"
              :index="index"
              :plugins="plugins"
              :availablePages="availablePages"
              @update-parameter="(paramKey, value) => updateActionParameter(index, paramKey, value)"
              @remove="() => removeAction(index)"
            />
          </div>
        </div>
      </div>

      <!-- Drop zone hint -->
      <div v-if="!isDraggingAction" class="border-t border-dashed border-base-content/15 px-3 py-3 text-center text-xs text-base-content/50" :class="{ 'border-t-0': buttonConfig.actions.length === 0 }">
        {{ t('buttonEditor.dragActionsHere') }}
      </div>
      
      <div v-if="isDraggingAction" class="text-center px-3 py-8 text-[13px] font-medium" :class="isDragOver ? 'text-primary' : 'text-base-content/60'">
        {{ t('buttonEditor.dropActionHere') }}
      </div>
    </div>
    </section>

    <!-- Save is automatic, no manual save button needed -->
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18nStore } from '../composables/useI18n'
import ActionEditor from './ActionEditor.vue'
import IconPicker from './IconPicker.vue'
import type { ButtonData } from '../types/streamdeck'
import { createSwapy } from 'swapy'

const { t } = useI18nStore()

const isDragOver = ref(false)
const isDraggingAction = ref(false)
const actionsContainer = ref<HTMLElement | null>(null)
let swapyInstance: any = null

interface Props {
  buttonConfig: ButtonData
  availablePages?: Array<{ id: string; name: string }>
  plugins?: any[]
}

interface Emits {
  (e: 'update:label', value: string): void
  (e: 'update:textTop', value: string): void
  (e: 'update:textBottom', value: string): void
  (e: 'update:fontSize', value: number): void
  (e: 'update:icon', value: string): void
  (e: 'update:emoji', value: string): void
  (e: 'update:backgroundColor', value: string): void
  (e: 'update:textColor', value: string): void
  (e: 'add-action', type: string): void
  (e: 'remove-action', index: number): void
  (e: 'update-action-parameter', actionIndex: number, paramKey: string, value: any): void
  (e: 'reorder-actions', newOrderedActions: any[]): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const updateLabel = (event: Event) => {
  const target = event.target as HTMLInputElement
  emit('update:label', target.value)
}

const updateTextTop = (event: Event) => {
  const target = event.target as HTMLInputElement
  emit('update:textTop', target.value)
}

const updateTextBottom = (event: Event) => {
  const target = event.target as HTMLInputElement
  emit('update:textBottom', target.value)
}

const updateFontSize = (event: Event) => {
  const target = event.target as HTMLInputElement
  emit('update:fontSize', parseInt(target.value) || 14)
}

const updateIcon = (value: string) => {
  emit('update:icon', value)
}

const updateEmoji = (event: Event) => {
  const target = event.target as HTMLInputElement
  emit('update:emoji', target.value)
}

const updateBackgroundColor = (event: Event) => {
  const target = event.target as HTMLInputElement
  emit('update:backgroundColor', target.value)
}

const updateTextColor = (event: Event) => {
  const target = event.target as HTMLInputElement
  emit('update:textColor', target.value)
}

const addAction = (type: string) => {
  emit('add-action', type)
}

const removeAction = (index: number) => {
  emit('remove-action', index)
}

const updateActionParameter = (actionIndex: number, paramKey: string, value: any) => {
  emit('update-action-parameter', actionIndex, paramKey, value)
}

// Drag and drop handlers
const handleDragOver = (event: DragEvent) => {
  event.preventDefault()
  isDragOver.value = true
}

const handleDragLeave = (event: DragEvent) => {
  isDragOver.value = false
}

const handleDrop = (event: DragEvent) => {
  isDragOver.value = false
  isDraggingAction.value = false
  
  if (event.dataTransfer) {
    try {
      const data = JSON.parse(event.dataTransfer.getData('application/json'))
      if (data.type) {
        addAction(data.type)
      }
    } catch (error) {
      console.error('Error parsing dropped data:', error)
    }
  }
}

// Global drag events
const handleGlobalDragStart = (event: DragEvent) => {
  if (event.dataTransfer?.types.includes('application/json')) {
    isDraggingAction.value = true
    if (swapyInstance) {
      swapyInstance.enable(false)
    }
  }
}

const handleGlobalDragEnd = () => {
  isDraggingAction.value = false
  isDragOver.value = false
  if (swapyInstance) {
    swapyInstance.enable(true)
  }
}

// Initialize Swapy
let isSwapping = false
let orderBeforeSwap: string[] = []

const initSwapy = async () => {
  await nextTick()
  if (actionsContainer.value && props.buttonConfig.actions.length > 0) {
    if (swapyInstance) {
      swapyInstance.destroy()
    }
    
    swapyInstance = createSwapy(actionsContainer.value, {
      animation: 'dynamic'
    })
    
    swapyInstance.onSwapStart(() => {
      isSwapping = true
      // Guardar el orden ANTES del swap
      orderBeforeSwap = props.buttonConfig.actions.map(a => a.id)
    })

    swapyInstance.onSwapEnd(async (event: any) => {
      // Usar el slotItemMap de Swapy que contiene el nuevo orden
      if (!event.slotItemMap) {
        isSwapping = false
        return
      }

      // Usar asObject que es un objeto {slotId: itemId}
      let newOrder: string[] = []

      if (event.slotItemMap.asObject) {
        // asObject es un objeto donde las keys son slotIds y los valores son itemIds
        // Como usamos action.id para ambos (slot e item), simplemente tomamos los valores
        newOrder = Object.values(event.slotItemMap.asObject).filter((id: any) => id)
      } else if (event.slotItemMap.asArray && Array.isArray(event.slotItemMap.asArray)) {
        // asArray es un array de objetos {slotId, itemId}
        newOrder = event.slotItemMap.asArray
          .filter((item: any) => item && item.itemId)
          .map((item: any) => item.itemId)
      }

      // Crear array de acciones en el nuevo orden
      const reorderedActions = newOrder
        .map(id => props.buttonConfig.actions.find(a => a.id === id))
        .filter(a => a !== undefined)

      // Verificar si el orden cambió comparando con el orden ANTES del swap
      const hasChanged = newOrder.length > 0 && newOrder.some((id, index) => id !== orderBeforeSwap[index])

      if (hasChanged && reorderedActions.length === props.buttonConfig.actions.length) {
        // NO actualizamos el estado local, solo guardamos
        // Swapy mantiene el orden visual correcto
        emit('reorder-actions', reorderedActions)
      }

      // Marcar como no-swapping DESPUÉS de un delay para permitir que se guarde
      setTimeout(() => {
        isSwapping = false
        orderBeforeSwap = []
      }, 100)
    })
  }
}

// Watch for actions length changes ONLY (not order changes)
watch(() => props.buttonConfig.actions.length, async (newLength, oldLength) => {
  if (!isSwapping && newLength !== oldLength) {
    await nextTick()
    initSwapy()
  }
})

onMounted(() => {
  window.addEventListener('dragstart', handleGlobalDragStart)
  window.addEventListener('dragend', handleGlobalDragEnd)
  initSwapy()
})

onUnmounted(() => {
  window.removeEventListener('dragstart', handleGlobalDragStart)
  window.removeEventListener('dragend', handleGlobalDragEnd)
  if (swapyInstance) {
    swapyInstance.destroy()
  }
})
</script>