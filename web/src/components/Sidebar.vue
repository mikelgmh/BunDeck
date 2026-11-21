<template>
  <div class="w-72 bg-base-200 border-r border-base-300 flex flex-col shrink-0">
    <!-- Header -->
    <div class="px-4 h-12 border-b border-base-300 flex items-center gap-2.5 shrink-0">
      <div class="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0">
        <Grid3x3 :size="15" stroke-width="2" class="text-primary-content" />
      </div>
      <div class="min-w-0">
        <h1 class="text-sm font-semibold leading-tight tracking-tight">LibreDeck</h1>
        <div class="flex items-center gap-1.5 text-xs leading-tight">
          <div :class="['w-1.5 h-1.5 rounded-full shrink-0', connectionStatus]"></div>
          <span class="text-base-content/60 truncate">{{ connectionText }}</span>
        </div>
      </div>
    </div>

    <!-- Button Configuration -->
    <div class="flex-1 px-4 py-4 overflow-y-auto">
      <div v-if="selectedButton !== null">
        <div class="mb-3 flex items-baseline justify-between">
          <h3 class="text-sm font-semibold tracking-tight tabular">
            {{ t('sidebar.button') }} {{ selectedButton + 1 }}
          </h3>
          <span class="ld-keycap">⌘{{ selectedButton + 1 }}</span>
        </div>
          
        <ButtonEditor
          :buttonConfig="buttonConfig"
          :availablePages="availablePages"
          :plugins="plugins"
          @update:label="$emit('update-button-label', $event)"
          @update:textTop="$emit('update-button-text-top', $event)"
          @update:textBottom="$emit('update-button-text-bottom', $event)"
          @update:fontSize="$emit('update-button-font-size', $event)"
          @update:icon="$emit('update-button-icon', $event)"
          @update:emoji="$emit('update-button-emoji', $event)"
          @update:backgroundColor="$emit('update-button-background-color', $event)"
          @update:textColor="$emit('update-button-text-color', $event)"
          @add-action="$emit('add-action', $event)"
          @remove-action="$emit('remove-action', $event)"
          @update-action-parameter="(...args) => $emit('update-action-parameter', args)"
          @reorder-actions="(newOrderedActions) => $emit('reorder-actions', newOrderedActions)"
        />
      </div>

      <!-- Empty state (when no button selected) -->
      <div v-else class="flex flex-col items-center justify-center h-full text-center py-16">
        <div class="w-10 h-10 rounded-xl bg-base-300 flex items-center justify-center mb-3">
          <MousePointer :size="18" stroke-width="1.5" class="text-base-content/60" />
        </div>
        <p class="text-sm text-base-content/60 font-medium">{{ t('sidebar.selectButton') }}</p>
        <p class="text-xs text-base-content/40 mt-1">{{ t('sidebar.selectButtonHint') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Grid3x3, MousePointer } from 'lucide-vue-next'
import { useI18nStore } from '../composables/useI18n'
import ButtonEditor from './ButtonEditor.vue'
import type { ProfileData, ButtonData } from '../types/streamdeck'

const { t } = useI18nStore()

interface Props {
  connectionStatus: string
  connectionText: string
  profiles: ProfileData[]
  selectedProfile: string
  selectedButton: number | null
  buttonConfig: ButtonData
  plugins: any[]
  availablePages?: Array<{ id: string; name: string }>
}

interface Emits {
  (e: 'profile-changed', profileId: string): void
  (e: 'profile-created', name: string): Promise<void>
  (e: 'update-button-label', value: string): void
  (e: 'update-button-text-top', value: string): void
  (e: 'update-button-text-bottom', value: string): void
  (e: 'update-button-font-size', value: number): void
  (e: 'update-button-icon', value: string): void
  (e: 'update-button-emoji', value: string): void
  (e: 'update-button-background-color', value: string): void
  (e: 'update-button-text-color', value: string): void
  (e: 'add-action', type: string): void
  (e: 'remove-action', index: number): void
  (e: 'update-action-parameter', args: [number, string, any]): void
  (e: 'reorder-actions', newOrderedActions: any[]): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()
</script>
