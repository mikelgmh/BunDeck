<template>
  <dialog
    ref="dialog"
    class="bd-dlg bd-conflict"
    :aria-label="t('bd.sdConflictTitle')"
    data-cy="streamdeck-conflict-dialog"
    @cancel.prevent
  >
    <div class="bd-pb" style="align-items: center; text-align: center">
      <div class="bd-warn-ic" aria-hidden="true">
        <TriangleAlert :size="28" stroke-width="1.75" />
      </div>
      <h2>{{ t('bd.sdConflictTitle') }}</h2>
      <p class="bd-hint" style="font-size: 14px; color: var(--bd-ink)">
        {{ t('bd.sdConflictMessage') }}
      </p>
      <p v-if="processLabel" class="bd-hint" data-cy="streamdeck-conflict-processes">
        {{ processLabel }}
      </p>
      <p class="bd-hint">{{ t('bd.sdConflictHint') }}</p>
      <p v-if="closeError" class="bd-hint" style="color: var(--bd-danger, #e5484d)" data-cy="streamdeck-conflict-error">
        {{ closeError }}
      </p>
      <div style="display: flex; gap: 8px; width: 100%; margin-top: 12px">
        <button
          class="btn bd-btn"
          :disabled="checking"
          data-cy="streamdeck-conflict-recheck"
          @click="recheck"
        >
          {{ checking ? t('bd.sdConflictChecking') : t('bd.sdConflictRecheck') }}
        </button>
        <button
          class="btn bd-btn bd-pri"
          style="flex: 1"
          :disabled="closing || checking"
          data-cy="streamdeck-conflict-close-app"
          autofocus
          @click="closeApp"
        >
          {{ closing ? t('bd.sdConflictClosing') : t('bd.sdConflictClose') }}
        </button>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { TriangleAlert } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'
import {
  fetchStreamDeckStatus,
  requestCloseOfficialApp,
  shouldShowConflictDialog,
  type ConflictProcessInfo,
} from '../../composables/useStreamDeckConflict'

const { t } = useI18nStore()
const dialog = ref<HTMLDialogElement | null>(null)

const processes = ref<ConflictProcessInfo[]>([])
const checking = ref(false)
const closing = ref(false)
const closeError = ref('')
const visible = ref(false)

const POLL_MS = 5000
let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false

const processLabel = computed(() => {
  if (processes.value.length === 0) return ''
  return processes.value
    .map((p) => (typeof p.pid === 'number' ? `${p.name} (pid ${p.pid})` : p.name))
    .join(', ')
})

function syncDialog(show: boolean) {
  visible.value = show
  const el = dialog.value
  if (!el) return
  try {
    if (show && !el.open) el.showModal()
    else if (!show && el.open) el.close()
  } catch {
    /* diálogo aún no montado */
  }
}

async function refresh() {
  if (inFlight) return
  inFlight = true
  checking.value = true
  try {
    const status = await fetchStreamDeckStatus()
    const list = Array.isArray(status?.conflict?.processes)
      ? (status.conflict.processes as ConflictProcessInfo[])
      : []
    processes.value = list
    if (!shouldShowConflictDialog(status)) {
      // El usuario la cerró a mano (o el botón la mató): liberar la UI.
      closeError.value = ''
      syncDialog(false)
    } else {
      syncDialog(true)
    }
  } catch {
    // Sin daemon a mano no se bloquea: se reintenta en el siguiente tick.
  } finally {
    checking.value = false
    inFlight = false
  }
}

async function recheck() {
  closeError.value = ''
  await refresh()
}

async function closeApp() {
  closeError.value = ''
  closing.value = true
  try {
    const res = await requestCloseOfficialApp()
    processes.value = res.remaining ?? []
    if (res.remaining && res.remaining.length > 0) {
      // Sigue viva: no se permite continuar; se mantiene el diálogo.
      closeError.value = t('bd.sdConflictStillOpen')
      syncDialog(true)
    } else {
      // Cerrada: verificación final antes de liberar (por si el HID sigue
      // ocupado o el proceso renació).
      await refresh()
    }
  } catch {
    closeError.value = t('bd.sdConflictStillOpen')
    syncDialog(true)
  } finally {
    closing.value = false
  }
}

onMounted(() => {
  // Bloqueante de verdad: sin cierre por backdrop ni por Escape
  // (@cancel.prevent). Solo se cierra cuando el proceso desaparece.
  void refresh()
  timer = setInterval(() => void refresh(), POLL_MS)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  timer = null
})

defineExpose({ refresh, closeApp })
</script>
