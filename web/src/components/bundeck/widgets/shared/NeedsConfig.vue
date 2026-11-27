<template>
  <button
    type="button"
    class="bd-needs-config"
    data-cy="bd-needs-config"
    :aria-label="ariaLabel"
    :title="ariaLabel"
    @click.stop="onClick"
  >
    <Settings :size="13" stroke-width="2" aria-hidden="true" />
    <TriangleAlert :size="13" stroke-width="2" aria-hidden="true" class="bd-needs-config-warn" />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Settings, TriangleAlert } from 'lucide-vue-next'
import {
  useOpenActionSettings,
  type OpenActionSettingsResult,
} from '../../../../composables/useOpenActionSettings'
import { useI18nStore } from '../../../../composables/useI18n'

/**
 * Badge "sin configurar" común a los 13 controles de superficie.
 *
 * Cuándo mostrarlo: el widget lo pinta con `v-if="!isConfigured"` donde
 * `isConfigured` lo define cada acción (p. ej. `entityId` vacío en
 * SmartHome/HomeAssistant, sin `videoId` en YouTube, sin `host` en OBS…).
 * Cada widget documenta su propia condición; este componente solo pinta.
 *
 * Posición: absoluta arriba-derecha de la tecla. Requiere que la raíz del
 * widget tenga `position: relative` (o cualquier ancestro posicionado
 * dentro de la tecla). No intercepta el resto de clics (es un botón
 * pequeño en la esquina).
 *
 * Al pulsar: `useOpenActionSettings().openActionSettings({ actionType,
 * position })` → evento `bundeck:open-action-settings` que BunDeckApp
 * convierte en selección de tecla + drawer derecho abierto; en remoto sin
 * drawer abre la web de bundeck (ver el composable). Emite `opened` con el
 * resultado para tests/telemetría.
 */

interface Props {
  /** Tipo de acción (`pid.aid`), informativo para el listener del drawer. */
  actionType?: string
  /** Posición de la tecla (la prop `position` que reenvía ControlSurface). */
  position?: number | null
  /** URL de la UI de bundeck para el fallback remoto (hook preparado). */
  remoteUrl?: string
  /** Texto accesible. Defecto i18n. */
  label?: string
}

const props = withDefaults(defineProps<Props>(), {
  actionType: '',
  position: null,
  remoteUrl: '',
  label: '',
})

const emit = defineEmits<{
  (e: 'opened', result: OpenActionSettingsResult): void
}>()

const { t } = useI18nStore()
const { openActionSettings } = useOpenActionSettings()

const ariaLabel = computed(() => props.label || t('bd.widgetNeedsConfig'))

const onClick = () => {
  const result = openActionSettings({
    actionType: props.actionType || undefined,
    position: props.position,
    remoteUrl: props.remoteUrl || undefined,
  })
  emit('opened', result)
}
</script>

<style scoped>
.bd-needs-config {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 5px;
  border: 1px solid var(--bd-ln, #34363b);
  border-radius: 8px;
  color: var(--bd-mu, #9b9da1);
  background: var(--bd-sf, #191a1d);
  cursor: pointer;
  line-height: 1;
}
.bd-needs-config:hover {
  color: inherit;
  border-color: var(--bd-ac, #e0a84a);
}
.bd-needs-config:focus-visible {
  outline: 2px solid var(--bd-ac, #e0a84a);
  outline-offset: 2px;
}
.bd-needs-config-warn {
  color: var(--bd-warn, #e0a84a);
  animation: bd-needs-config-blink 1.2s ease-in-out infinite;
}
@keyframes bd-needs-config-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bd-needs-config-warn {
    animation: none;
  }
}
</style>
