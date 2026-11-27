<template>
  <div
    class="bd-control-surface"
    :data-component="componentName"
    :data-cy="`bd-control-${componentName}`"
    @click="onSurfaceEvent"
    @pointerdown="onSurfaceEvent"
  >
    <VolumeRange
      v-if="componentName === 'volume-range'"
      :api-base="apiBase"
      :app="legacyApp ?? (action.parameters?.app as string | null | undefined)"
      :label="label || 'Volumen'"
      :readonly="readonly"
    />
    <component
      :is="component"
      v-else-if="component"
      :action="action"
      :api-base="apiBase"
      :label="label"
      :readonly="readonly"
      :position="position"
    />
    <span v-else class="bd-control-unknown">{{ label || action.type }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import VolumeRange from './VolumeRange.vue'
import { controlComponentOf } from '../../composables/useActionPresentation'

interface ControlAction {
  type: string
  parameters?: Record<string, any>
}

const props = withDefaults(defineProps<{
  action: ControlAction
  apiBase?: string
  label?: string
  readonly?: boolean
  legacyApp?: string | null
  /** Posición de la tecla: la reenvía a los widgets (p. ej. NeedsConfig). */
  position?: number | null
}>(), {
  apiBase: '',
  label: '',
  readonly: false,
  legacyApp: null,
  position: null,
})

const components: Record<string, any> = {
  'audio-control': defineAsyncComponent(() => import('./widgets/AudioMixerControl.vue')),
  'media-transport': defineAsyncComponent(() => import('./widgets/MediaTransportControl.vue')),
  'smart-home': defineAsyncComponent(() => import('./widgets/SmartHomeControl.vue')),
  'spotify-player': defineAsyncComponent(() => import('./widgets/SpotifyPlayerControl.vue')),
  'voice-panel': defineAsyncComponent(() => import('./widgets/VoicePanelControl.vue')),
  soundboard: defineAsyncComponent(() => import('./widgets/SoundboardControl.vue')),
  'stream-studio': defineAsyncComponent(() => import('./widgets/StreamStudioControl.vue')),
  'creative-tools': defineAsyncComponent(() => import('./widgets/CreativeToolsControl.vue')),
  'calendar-agenda': defineAsyncComponent(() => import('./widgets/CalendarAgenda.vue')),
  pomodoro: defineAsyncComponent(() => import('./widgets/PomodoroControl.vue')),
  'status-cards': defineAsyncComponent(() => import('./widgets/StatusCards.vue')),
  'workflow-control': defineAsyncComponent(() => import('./widgets/WorkflowControl.vue')),
}

const componentName = computed(() => controlComponentOf(props.action?.type ?? '') ?? '')
const component = computed(() => components[componentName.value] ?? null)

/**
 * La superficie detiene clic/pointerdown SOLO en uso (`readonly=false`):
 * interactuar con el control no debe disparar ni seleccionar la tecla
 * (causa A: superficies que tragaban clicks). En edición (`readonly=true`)
 * los widgets son inertes (deshabilitados) y los eventos burbujean a la
 * tecla `.bd-key-vol`: el clic selecciona y abre el inspector, y el
 * pointerdown llega al handle de GridStack para poder arrastrar.
 */
const onSurfaceEvent = (e: Event) => {
  if (!props.readonly) e.stopPropagation()
}
</script>

<style scoped>
.bd-control-surface {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: inherit;
  color: inherit;
}
.bd-control-unknown {
  align-self: center;
  justify-self: center;
  opacity: .7;
  font-size: 12px;
}
</style>
