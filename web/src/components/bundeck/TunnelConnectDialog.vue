<template>
  <dialog
    ref="dlg"
    id="kconnDlg"
    class="bd-dlg bd-tunnel-connect"
    data-cy="tunnel-connect-dialog"
    role="dialog"
    aria-modal="true"
    :aria-label="label"
    @cancel.prevent="$emit('dismiss')"
  >
    <div class="kpad">
      <div class="kspin-wrap" aria-hidden="true">
        <div class="kspin-ring bd-spin"></div>
      </div>
      <div class="khead">
        <h2 class="ktitle" data-cy="tunnel-connect-label">{{ label }}</h2>
        <p class="cap">{{ subtitle }}</p>
      </div>
      <ul class="ksteps">
        <li v-for="(s, i) in steps" :key="i" class="kstep" :class="s.state">
          <i aria-hidden="true">{{ symbol(s.state) }}</i>
          <span>{{ s.text }}<em v-if="s.note" class="knote"> — {{ s.note }}</em></span>
        </li>
      </ul>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18nStore } from '../../composables/useI18n'
import type { RtcStatus } from '../../composables/useRemoteRtc'

const props = defineProps<{ status: RtcStatus }>()

defineEmits<{
  (e: 'dismiss'): void
}>()

const { t } = useI18nStore()

/** Título según el estado REAL: idle = aún sin intento; signaling = probando P2P. */
const label = computed(() => {
  if (props.status === 'signaling') return t('bd.tunnelTransportProbing')
  if (props.status === 'connected') return t('bd.tunnelTransportP2p')
  if (props.status === 'fallback') return t('bd.tunnelTransportRelay')
  return t('bd.tunnelTransportConnecting')
})

const subtitle = computed(() => {
  if (props.status === 'signaling') return t('bd.tunnelConnectSubProbing')
  if (props.status === 'connected') return t('bd.tunnelConnectSubOk')
  if (props.status === 'fallback') return t('bd.tunnelConnectSubRelay')
  return t('bd.tunnelConnectSubSearching')
})

type StepState = 'done' | 'act' | 'fail' | 'pend'

interface KStep {
  text: string
  state: StepState
  note?: string
}

/** Pasos según el estado REAL de la prop `status` (sin temporizadores). */
const steps = computed<KStep[]>(() => {
  const discover = t('bd.tunnelConnectStepDiscover')
  const p2p = t('bd.tunnelTransportP2p')
  const relay = t('bd.tunnelConnectStepRelay')
  if (props.status === 'signaling')
    return [
      { text: discover, state: 'done' },
      { text: p2p, state: 'act', note: t('bd.tunnelConnectLanNote') },
      { text: relay, state: 'pend' },
    ]
  if (props.status === 'connected')
    return [
      { text: discover, state: 'done' },
      { text: p2p, state: 'done' },
      { text: relay, state: 'pend' },
    ]
  if (props.status === 'fallback')
    return [
      { text: discover, state: 'done' },
      { text: p2p, state: 'fail', note: t('bd.tunnelConnectNatBlocked') },
      { text: relay, state: 'act' },
    ]
  return [
    { text: discover, state: 'act' },
    { text: p2p, state: 'pend' },
    { text: relay, state: 'pend' },
  ]
})

const symbol = (s: StepState) => (s === 'done' ? '✓' : s === 'fail' ? '!' : s === 'act' ? '●' : '○')

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
  width: min(420px, calc(100vw - 32px));
  height: fit-content;
  max-height: calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  inset: 0;
  margin: auto;
  text-align: center;
  color: var(--bd-ink, inherit);
  background: var(--bd-sf, Canvas);
  border: 1px solid var(--bd-ln, currentColor);
  border-radius: 16px;
  overflow-y: auto;
}
.bd-tunnel-connect[open] {
  display: block;
  height: auto;
}
.bd-tunnel-connect::backdrop {
  background: rgba(0, 0, 0, 0.55);
}
.kpad {
  box-sizing: border-box;
  width: 100%;
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.kspin-wrap {
  display: flex;
  justify-content: center;
}
.kspin-ring {
  width: 44px;
  height: 44px;
  border-radius: 999px;
  border: 3px solid var(--bd-ln, rgba(127, 127, 127, 0.35));
  border-top-color: var(--bd-ac, currentColor);
  animation: kconn-rot 0.85s linear infinite;
}
@keyframes kconn-rot {
  to {
    transform: rotate(360deg);
  }
}
.khead {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.ktitle {
  margin: 0 0 4px;
  font-size: 18px;
  line-height: 24px;
  font-weight: 600;
}
.cap {
  margin: 0;
  font-size: 13px;
  color: var(--bd-mu, inherit);
}
.ksteps {
  list-style: none;
  margin: 0;
  padding: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}
.kstep {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--bd-mu, inherit);
}
.kstep.act {
  color: var(--bd-ink, inherit);
  font-weight: 500;
}
.kstep.done {
  color: #6fcf97;
}
.kstep.fail {
  color: #f59e0b;
}
.kstep i {
  font-style: normal;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border: 1.5px solid currentColor;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1;
}
.kstep.act i {
  animation: kconn-pulse 1.2s ease-in-out infinite;
}
@keyframes kconn-pulse {
  50% {
    opacity: 0.45;
  }
}
.knote {
  font-style: normal;
  opacity: 0.8;
}
@media (max-width: 480px) {
  .kpad {
    padding: 24px 20px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .kspin-ring,
  .kstep.act i {
    animation: none;
  }
}
</style>
