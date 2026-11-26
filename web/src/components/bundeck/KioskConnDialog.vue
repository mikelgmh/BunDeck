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
    <div class="bd-dh">
      <span class="kconn-dot" :data-tone="tone" aria-hidden="true"><i /></span>
      <h2 data-cy="kiosk-conn-title">{{ title }}</h2>
      <span class="bd-sp" />
      <button
        class="bd-ibtn"
        type="button"
        :aria-label="t('bd.close')"
        data-cy="kiosk-conn-x"
        @click="$emit('dismiss')"
      >
        <X :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <div class="bd-pb">
      <p class="bd-sub" data-cy="kiosk-conn-state">
        {{ transportLabel }} · {{ wsOk ? t('bd.connected') : t('bd.disconnected') }}
      </p>
      <ul v-if="entries.length" class="klog" data-cy="kiosk-conn-log">
        <li
          v-for="(e, i) in entries"
          :key="i"
          class="krow"
          :data-tone="toneOf(e.kind)"
          data-cy="kiosk-conn-entry"
        >
          <i class="ksym" aria-hidden="true">{{ symbolOf(e.kind) }}</i>
          <span class="ktext">{{ t(connLogKey(e.kind), connLogParams(e)) }}</span>
          <time class="ktime">{{ fmtTime(e.ts) }}</time>
        </li>
      </ul>
      <p v-else class="bd-hint kempty" data-cy="kiosk-conn-empty">{{ t('bd.kioskConnLogEmpty') }}</p>
      <div class="kconn-actions">
        <button class="bd-btn bd-pri" type="button" data-cy="kiosk-conn-close" @click="$emit('dismiss')">{{ t('bd.close') }}</button>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'
import { connLogKey, connLogParams, connLogSymbol, connLogTone, type ConnEntry } from '../../utils/kioskConnLog'

withDefaults(
  defineProps<{
    entries: ConnEntry[]
    transportLabel: string
    wsOk: boolean
    /** Tono del pilotito de cabecera (el mismo `kioskTransport` de la barra). */
    tone?: string
  }>(),
  { tone: 'connecting' },
)

defineEmits<{
  (e: 'dismiss'): void
}>()

const { t } = useI18nStore()

/** Título del diálogo (solo display: qué se ha intentado en esta sesión). */
const title = computed(() => t('bd.kioskConnLogTitle'))

const toneOf = (kind: string): string => connLogTone(kind)
const symbolOf = (kind: string): string => connLogSymbol(kind)

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
  /* Tamaño en el global (bundeck.css): el genérico .bd-dlg fija 640px de alto
     y gana por especificidad al scoping. */
  overflow-y: auto;
}
.bd-kiosk-conn[open] {
  display: block;
}
/* Pilotito de cabecera: mismo código de color que la barra del kiosco. */
.kconn-dot {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: var(--bd-bg, transparent);
  border: 1px solid var(--bd-ln, currentColor);
}
.kconn-dot i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #6b7280;
}
.kconn-dot[data-tone='p2p'] i {
  background: #4ade80;
  box-shadow: 0 0 6px #4ade80;
}
.kconn-dot[data-tone='relay'] i {
  background: #d97706;
  box-shadow: 0 0 6px #d97706;
}
.kconn-dot[data-tone='disconnected'] i {
  background: #ef4444;
  box-shadow: 0 0 6px #ef4444;
}
.kconn-dot[data-tone='probing'] i,
.kconn-dot[data-tone='connecting'] i {
  background: var(--bd-ac, currentColor);
  animation: bd-kiosk-pulse 1.2s ease-in-out infinite;
}
/* Caja de la línea de tiempo (mismo lenguaje que los detalles de aprobación). */
.klog {
  list-style: none;
  margin: 0;
  padding: 6px 14px;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: var(--bd-bg, transparent);
  border: 1px solid var(--bd-ln, currentColor);
  border-radius: 12px;
}
.krow {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 0;
  font-size: 13px;
  line-height: 18px;
}
.krow + .krow {
  border-top: 1px solid var(--bd-ln, currentColor);
}
.ksym {
  font-style: normal;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 1.5px solid currentColor;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1;
  margin-top: -1px;
}
.krow[data-tone='ok'] .ksym {
  color: #4ade80;
}
.krow[data-tone='warn'] .ksym {
  color: #d97706;
}
.krow[data-tone='info'] .ksym {
  color: var(--bd-ac, currentColor);
}
.ktext {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--bd-ink, inherit);
}
.ktime {
  flex: none;
  margin-left: auto;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--bd-mu, inherit);
}
.kempty {
  text-align: center;
}
.kconn-actions {
  display: flex;
  justify-content: flex-end;
}
@keyframes bd-kiosk-pulse {
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .kconn-dot[data-tone='probing'] i,
  .kconn-dot[data-tone='connecting'] i {
    animation: none;
  }
}
</style>
