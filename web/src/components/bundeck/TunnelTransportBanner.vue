<template>
  <div
    class="bd-tunnel-banner"
    :data-status="status"
    data-cy="tunnel-transport-banner"
    role="status"
  >
    <span class="bd-dot" :class="dotClass" aria-hidden="true"></span>
    <span data-cy="tunnel-transport-label">{{ label }}</span>
    <button
      class="bd-tunnel-x"
      type="button"
      :title="t('bd.tunnelTransportDismiss')"
      :aria-label="t('bd.tunnelTransportDismiss')"
      data-cy="tunnel-transport-dismiss"
      @click="$emit('dismiss')"
    >
      <X :size="16" stroke-width="1.75" aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'
import type { RtcStatus } from '../../composables/useRemoteRtc'

const props = defineProps<{ status: RtcStatus }>()

defineEmits<{
  (e: 'dismiss'): void
}>()

const { t } = useI18nStore()

const label = computed(() =>
  props.status === 'connected'
    ? t('bd.tunnelTransportP2p')
    : props.status === 'fallback'
      ? t('bd.tunnelTransportRelay')
      : t('bd.tunnelTransportProbing')
)

const dotClass = computed(() =>
  props.status === 'connected' ? 'bd-ok' : props.status === 'fallback' ? 'bd-relay' : 'bd-probe'
)
</script>

<style scoped>
.bd-tunnel-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--bd-ln);
  background: var(--bd-sf);
  font-size: 13.5px;
  font-weight: 600;
}
.bd-tunnel-banner .bd-dot {
  margin-right: 0;
  flex: none;
}
.bd-tunnel-banner .bd-dot.bd-probe {
  background: var(--bd-ac);
  animation: bd-tunnel-pulse 1.2s ease-in-out infinite;
}
.bd-tunnel-banner .bd-dot.bd-relay {
  background: #d97706;
}
@keyframes bd-tunnel-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
.bd-tunnel-x {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  padding: 4px;
  border-radius: 8px;
  display: inline-flex;
}
.bd-tunnel-x:hover {
  opacity: 1;
  background: rgba(127, 127, 127, 0.15);
}
</style>
