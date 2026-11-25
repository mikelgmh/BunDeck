<template>
  <dialog
    open
    class="bd-dlg bd-tunnel-connect"
    data-cy="tunnel-connect-dialog"
    role="dialog"
    aria-modal="true"
    :aria-label="t('bd.tunnelTransportProbing')"
  >
    <div class="bd-tunnel-connect__body">
      <LoaderCircle :size="22" stroke-width="2" aria-hidden="true" class="bd-spin" />
      <span data-cy="tunnel-connect-label">{{ t('bd.tunnelTransportProbing') }}</span>
      <button
        class="bd-tunnel-x"
        type="button"
        :title="t('bd.tunnelTransportDismiss')"
        :aria-label="t('bd.tunnelTransportDismiss')"
        data-cy="tunnel-connect-dismiss"
        @click="$emit('dismiss')"
      >
        <X :size="16" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { LoaderCircle, X } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'
import type { RtcStatus } from '../../composables/useRemoteRtc'

defineProps<{ status: RtcStatus }>()

defineEmits<{
  (e: 'dismiss'): void
}>()

const { t } = useI18nStore()
</script>

<style scoped>
.bd-tunnel-connect {
  width: min(420px, 94vw);
  height: fit-content;
  max-height: calc(100dvh - 32px);
}
.bd-tunnel-connect__body {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px 24px;
  font-size: 14px;
  font-weight: 600;
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
  flex: none;
}
.bd-tunnel-x:hover {
  opacity: 1;
  background: rgba(127, 127, 127, 0.15);
}
</style>
