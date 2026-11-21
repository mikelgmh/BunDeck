<template>
  <div class="w-72 bg-base-200 border-l border-base-300 flex flex-col h-screen shrink-0" data-cy="actions-sidebar">
    <!-- Header -->
    <div class="px-4 h-12 border-b border-base-300 flex items-center shrink-0">
      <h2 class="text-sm font-semibold tracking-tight">{{ t('actionsSidebar.actionsLibrary') }}</h2>
    </div>
       
    <!-- Search -->
    <div class="px-4 py-3 border-b border-base-300/60">
      <input 
        v-model="searchQuery"
        type="text" 
        :placeholder="t('actionsSidebar.searchActions')"
        class="input input-bordered input-sm w-full ld-control px-3 placeholder:text-base-content/40"
      />
    </div>

    <!-- Actions List -->
    <div class="flex-1 overflow-y-auto px-3 py-3">
      <ActionsLibrary
        :plugins="plugins"
        :search-query="searchQuery"
        @action-selected="$emit('action-selected', $event)"
      />
    </div>

    <!-- Footer -->
    <div class="px-4 py-2.5 border-t border-base-300 shrink-0">
      <div class="ld-count text-center">
        {{ t('actionsSidebar.availableActions', { count: availableActionsCount }) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18nStore } from '../composables/useI18n'
import ActionsLibrary from './ActionsLibrary.vue'

const { t } = useI18nStore()

interface Props {
  plugins: any[]
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'action-selected', actionType: string): void
}>()

const searchQuery = ref('')

// Calculate available actions count
const availableActionsCount = computed(() => {
  let actions: any[] = []

  // Process each plugin
  props.plugins.forEach((pluginEntry: any) => {
    const [pluginId, pluginData] = pluginEntry

    if (pluginData.actions) {
      // Process each action in the plugin
      pluginData.actions.forEach(([actionId, actionData]: [string, any]) => {
        actions.push({
          type: `${pluginId}.${actionId}`,
          name: actionData.name || actionId,
          description: actionData.description || `Acción ${actionId}`
        })
      })
    }
  })

  // Filter by search query if provided
  if (searchQuery.value && searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase().trim()
    actions = actions.filter(action =>
      action.name.toLowerCase().includes(query) ||
      action.description.toLowerCase().includes(query) ||
      action.type.toLowerCase().includes(query)
    )
  }

  return actions.length
})
</script>

<style scoped>
.action-item {
  user-select: none;
}

.action-item:active {
  opacity: 0.7;
  cursor: grabbing;
}
</style>
