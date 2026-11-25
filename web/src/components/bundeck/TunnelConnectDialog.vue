<template>
  <dialog
    ref="dlg"
    class="bd-dlg bd-tunnel-connect"
    data-cy="tunnel-connect-dialog"
    role="dialog"
    aria-modal="true"
    :aria-label="label"
    @cancel.prevent="$emit('dismiss')"
  >
    <div class="bd-tunnel-connect__body">
      <LoaderCircle :size="22" stroke-width="2" aria-hidden="true" class="bd-spin" />
      <span data-cy="tunnel-connect-label">{{ label }}</span>
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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { LoaderCircle, X } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'
import type { RtcStatus } from '../../composables/useRemoteRtc'

const props = defineProps<{ status: RtcStatus }>()

defineEmits<{
  (e: 'dismiss'): void
}>()

const { t } = useI18nStore()

/** idle = aún sin intento (Conectando); signaling = probando P2P. */
const label = computed(() =>
  props.status === 'signaling' ? t('bd.tunnelTransportProbing') : t('bd.tunnelTransportConnecting')
)

const dlg = ref<HTMLDialogElement | null>(null)

/** Modal real (top layer) donde hay showModal; si no, `open` como
 *  alternativa para que el diálogo siga visible (CSS fixed + z-index). */
onMounted(() => {
  const el = dlg.value
  if (!el) return
  try {
    if (typeof el.showModal === 'function' && !el.open) el.showModal()
    else if (!el.open) el.setAttribute('open', '')
  } catch {
    try {
      el.setAttribute('open', '')
    } catch {
      /* sin dialog: el v-if ya lo desmonta al resolver */
    }
  }
})

onBeforeUnmount(() => {
  try {
    dlg.value?.close()
  } catch {
    /* ya cerrado */
  }
})
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
.bd-tunnel-connect__body > span {
  flex: 1;
  min-width: 0;
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
