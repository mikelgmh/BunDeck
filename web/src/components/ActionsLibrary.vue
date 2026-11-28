<template>
  <div class="space-y-6">
    <!-- Available Actions -->
    <div>
      
      <div v-if="availableActions.length === 0" class="text-[13px] text-base-content/50 px-1">
        No hay acciones disponibles
      </div>
      <div v-else class="grid grid-cols-1 gap-2">
        <div
          v-for="action in availableActions"
          :key="action.type"
          class="rounded-xl border border-base-300 bg-base-100 hover:bg-base-300/60 hover:border-base-content/20 cursor-pointer px-3 py-2.5 transition-[border-color,background-color] duration-150"
          draggable="true"
          @dragstart="handleDragStart($event, action)"
          @click="$emit('action-selected', action.type)"
          @keydown.enter="$emit('action-selected', action.type)"
          tabindex="0"
          role="button"
          :aria-label="action.name"
          data-cy="action-item"
        >
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <component :is="action.icon" :size="16" stroke-width="1.5" class="text-primary" />
            </div>
            <div class="flex-1 min-w-0">
              <h4 class="font-medium text-[13px] leading-tight truncate">{{ action.name }}</h4>
              <p class="text-xs text-base-content/50 mt-0.5 leading-snug line-clamp-2">{{ action.description }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Plugins -->
   <!--  <div>
      <h3 class="text-base font-semibold mb-4">Plugins</h3>
      <div v-if="plugins.length === 0" class="text-sm text-base-content/70">
        No hay plugins instalados
      </div>
      <div v-else class="space-y-2">
        <div
          v-for="plugin in plugins"
          :key="plugin[0]"
          class="card bg-base-300 p-3"
        >
          <div class="flex items-center justify-between">
            <div>
              <div class="font-medium text-sm">{{ plugin[1].manifest.name }}</div>
              <div class="text-xs text-base-content/70">v{{ plugin[1].manifest.version }}</div>
            </div>
            <div :class="['badge badge-sm', plugin[1].enabled ? 'badge-success' : 'badge-error']">
              {{ plugin[1].enabled ? 'Activo' : 'Inactivo' }}
            </div>
          </div>
        </div>
      </div>
    </div> -->
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import * as LucideIcons from 'lucide-vue-next'
import { simpleIcon } from '../composables/useSimpleIcons'
import { usePluginLocale } from '../composables/usePluginLocale'

const { currentLocale, localizeActionField } = usePluginLocale()

interface Props {
  plugins: any[]
  searchQuery?: string
}

interface Emits {
  (e: 'action-selected', actionType: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

// Convert plugin actions to a format suitable for display
const availableActions = computed(() => {
  const actions: Array<{
    type: string
    name: string
    description: string
    icon: any
  }> = []

  // Process each plugin
  props.plugins.forEach((pluginEntry: any) => {
    const [pluginId, pluginData] = pluginEntry

    if (pluginData.actions) {
      // Process each action in the plugin
      pluginData.actions.forEach(([actionId, actionData]: [string, any]) => {
        // Las acciones ocultas (alias heredados) siguen funcionando pero no se listan
        if (actionData?.hidden === true) return
        // Get icon from action data or use a default
        let iconName = actionData.icon || 'Settings'

        const icon = (LucideIcons as any)[iconName] || simpleIcon(iconName) || (LucideIcons as any)['Settings']

        actions.push({
          type: `${pluginId}.${actionId}`,
          name: localizeActionField(actionData, 'name', currentLocale.value, actionId),
          description: localizeActionField(actionData, 'description', currentLocale.value, `Acción ${actionId}`),
          icon
        })
      })
    }
  })

  // Filter by search query if provided
  if (props.searchQuery && props.searchQuery.trim()) {
    const query = props.searchQuery.toLowerCase().trim()
    return actions.filter(action =>
      action.name.toLowerCase().includes(query) ||
      action.description.toLowerCase().includes(query) ||
      action.type.toLowerCase().includes(query)
    )
  }

  return actions
})

// Drag and drop handler
const handleDragStart = (event: DragEvent, action: any) => {
  if (event.dataTransfer) {
    event.dataTransfer.setData('application/json', JSON.stringify({
      type: action.type,
      name: action.name
    }))
    event.dataTransfer.effectAllowed = 'copy'
  }
}
</script>