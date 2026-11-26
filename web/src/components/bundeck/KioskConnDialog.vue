<template>
  <dialog
    ref="dlg"
    class="bd-dlg bd-kiosk-conn"
    data-cy="kiosk-conn-dialog"
    role="dialog"
    aria-modal="true"
    :aria-label="title"
    @cancel.prevent="$emit('dismiss')"
  >
    <div class="kpad">
      <div class="khead">
        <h2 class="ktitle" data-cy="kiosk-conn-title">{{ title }}</h2>
        <p class="cap" data-cy="kiosk-conn-state">{{ transportLabel }} · {{ wsOk ? t('bd.connected') : t('bd.disconnected') }}</p>
      </div>
      <ul v-if="entries.length" class="ksteps">
        <li v-for="(e, i) in entries" :key="i" class="kstep" data-cy="kiosk-conn-entry">
          <time class="ktime">{{ fmtTime(e.ts) }}</time>
          <span>{{ t(connLogKey(e.kind), connLogParams(e)) }}</span>
        </li>
      </ul>
      <p v-else class="cap" data-cy="kiosk-conn-empty">{{ t('bd.kioskConnLogEmpty') }}</p>
      <div class="kconn-actions">
        <button class="bd-btn bd-pri" type="button" data-cy="kiosk-conn-close" @click="$emit('dismiss')">{{ t('bd.close') }}</button>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18nStore } from '../../composables/useI18n'
import { connLogKey, connLogParams, type ConnEntry } from '../../utils/kioskConnLog'

defineProps<{
  entries: ConnEntry[]
  transportLabel: string
  wsOk: boolean
}>()

defineEmits<{
  (e: 'dismiss'): void
}>()

const { t } = useI18nStore()

/** Título del diálogo (solo display: qué se ha intentado en esta sesión). */
const title = computed(() => t('bd.kioskConnLogTitle'))

/** Hora corta de cada intento; si el ts es raro, se muestra tal cual. */
const fmtTime = (ts: number): string => {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return String(ts)
  }
}

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
.bd-kiosk-conn {
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
.bd-kiosk-conn[open] {
  display: block;
  height: auto;
}
.bd-kiosk-conn::backdrop {
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
  max-height: 40dvh;
  overflow-y: auto;
}
.kstep {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  color: var(--bd-mu, inherit);
}
.ktime {
  flex: none;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}
.kconn-actions {
  display: flex;
  justify-content: center;
  width: 100%;
}
@media (max-width: 480px) {
  .kpad {
    padding: 24px 20px;
  }
}
</style>
