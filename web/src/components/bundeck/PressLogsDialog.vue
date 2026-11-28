<template>
  <dialog ref="dialog" class="bd-dlg bd-flex bd-press-logs" :aria-label="title" data-cy="bd-press-logs-dialog">
    <div class="bd-dh">
      <h2>{{ title }}</h2>
      <span class="bd-sp"></span>
      <button class="bd-ibtn" :aria-label="t('bd.close')" @click="close">
        <X :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <div class="bd-pb">
      <div class="bd-pl-filters" role="group" :aria-label="title">
        <label class="bd-fld">
          <span class="bd-lb">{{ t('bd.pressLogsPressType') }}</span>
          <select class="bd-inp" :value="pressType" data-cy="bd-press-logs-filter-type" @change="pressType = ($event.target as HTMLSelectElement).value; gotoPage(0)">
            <option value="">{{ t('bd.pressLogsAll') }}</option>
            <option value="short">{{ t('bd.pressLogsPtShort') }}</option>
            <option value="double">{{ t('bd.pressLogsPtDouble') }}</option>
            <option value="triple">{{ t('bd.pressLogsPtTriple') }}</option>
            <option value="long">{{ t('bd.pressLogsPtLong') }}</option>
            <option value="touch-start">{{ t('bd.pressLogsPtTouchStart') }}</option>
            <option value="touch-end">{{ t('bd.pressLogsPtTouchEnd') }}</option>
          </select>
        </label>
        <label class="bd-fld">
          <span class="bd-lb">{{ t('bd.pressLogsSuccess') }}</span>
          <select class="bd-inp" :value="success" data-cy="bd-press-logs-filter-status" @change="success = ($event.target as HTMLSelectElement).value; gotoPage(0)">
            <option value="">{{ t('bd.pressLogsAll') }}</option>
            <option value="true">OK</option>
            <option value="false">{{ t('bd.pressLogsResultFail') }}</option>
          </select>
        </label>
        <label class="bd-fld">
          <span class="bd-lb">{{ t('bd.pressLogsDevice') }}</span>
          <input
            type="text"
            class="bd-inp bd-mono"
            :value="deviceId"
            :placeholder="t('bd.pressLogsDevicePh')"
            :aria-label="t('bd.pressLogsDevice')"
            @input="deviceId = ($event.target as HTMLInputElement).value"
            @change="gotoPage(0)"
          />
        </label>
        <label class="bd-fld">
          <span class="bd-lb">{{ t('bd.pressLogsLimit') }}</span>
          <select class="bd-inp" :value="String(limit)" data-cy="bd-press-logs-limit" @change="limit = +($event.target as HTMLSelectElement).value; gotoPage(0)">
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </label>
        <div class="bd-pl-actions">
          <button class="bd-btn" :disabled="loading" data-cy="bd-press-logs-refresh" @click="reload">
            {{ t('bd.pressLogsRefresh') }}
          </button>
        </div>
      </div>

      <p v-if="error" class="bd-err" role="alert">{{ error }}</p>
      <p v-else-if="!loading && !items.length" class="bd-hint" data-cy="bd-press-logs-empty">
        {{ t('bd.pressLogsEmpty') }}
      </p>
      <table v-else class="bd-pl-table">
        <thead>
          <tr>
            <th>{{ t('bd.pressLogsWhen') }}</th>
            <th v-if="!effButtonId">{{ t('bd.pressLogsButton') }}</th>
            <th>{{ t('bd.pressLogsDevice') }}</th>
            <th>{{ t('bd.pressLogsAction') }}</th>
            <th>{{ t('bd.pressLogsResult') }}</th>
            <th>{{ t('bd.pressLogsDuration') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in items" :key="`${l.ts}-${l.id ?? l.runId ?? ''}`" data-cy="bd-press-log-item">
            <td class="bd-mono">{{ fmtWhen(l.ts) }}</td>
            <td v-if="!effButtonId" class="bd-mono">{{ shortId(l.buttonId) }}</td>
            <td class="bd-mono">{{ l.deviceName ?? shortId(l.deviceId) }}</td>
            <td class="bd-mono">{{ l.actionType ?? '' }}</td>
            <td>
              <span v-if="l.success === false" class="bd-err">{{ l.error || t('bd.pressLogsResultFail') }}</span>
              <span v-else>OK</span>
            </td>
            <td class="bd-mono">{{ l.durationMs ?? '' }}</td>
          </tr>
        </tbody>
      </table>

      <div class="bd-pl-pager" data-cy="bd-press-logs-pager">
        <button class="bd-btn" :disabled="loading || page <= 0" data-cy="bd-press-logs-prev" @click="gotoPage(page - 1)">
          {{ t('bd.pressLogsPrev') }}
        </button>
        <span class="bd-pl-page" data-cy="bd-press-logs-page">
          {{ t('bd.pressLogsPage', { page: page + 1, pages: pageCount, total }) }}
        </span>
        <button class="bd-btn" :disabled="loading || page + 1 >= pageCount" data-cy="bd-press-logs-next" @click="gotoPage(page + 1)">
          {{ t('bd.pressLogsNext') }}
        </button>
        <span class="bd-pl-spacer"></span>
        <button class="bd-btn bd-dng" :disabled="loading || !items.length" data-cy="bd-press-logs-clear" @click="clearLogs">
          {{ t('bd.pressLogsClear') }}
        </button>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { X } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

export interface PressLog {
  id?: string | number
  ts: number
  buttonId?: string | null
  pageId?: string | null
  profileId?: string | null
  position?: number | null
  pressType?: string | null
  deviceId?: string | null
  deviceName?: string | null
  source?: string | null
  actionType?: string | null
  actionIndex?: number | null
  actionId?: string | null
  runId?: string | null
  success?: boolean | null
  error?: string | null
  durationMs?: number | null
}

interface Props {
  apiBase: string
  buttonId?: string | null
  actionType?: string | null
  buttonLabel?: string | null
}

const props = withDefaults(defineProps<Props>(), {
  buttonId: null,
  actionType: null,
  buttonLabel: null,
})

const dialog = ref<HTMLDialogElement | null>(null)

// Copias internas: el padre fija props y llama a show(); show() también
// acepta overrides para abrir el diálogo con otro filtro sin remontar.
const effButtonId = ref<string | null>(props.buttonId ?? null)
const effActionType = ref<string | null>(props.actionType ?? null)
const effLabel = ref<string | null>(props.buttonLabel ?? null)

watch(
  () => [props.buttonId, props.actionType, props.buttonLabel] as const,
  ([b, a, l]) => {
    effButtonId.value = b ?? null
    effActionType.value = a ?? null
    effLabel.value = l ?? null
  }
)

const items = ref<PressLog[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
const pressType = ref('')
const success = ref('')
const deviceId = ref('')
const limit = ref(50)
const page = ref(0)

const title = computed(() => {
  if (effActionType.value) return t('bd.actionLogsTitle', { type: effActionType.value })
  if (effLabel.value) return t('bd.pressLogsTitleBtn', { name: effLabel.value })
  return t('bd.pressLogsTitle')
})
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / Math.max(1, limit.value))))

const shortId = (v: unknown): string => {
  const s = String(v ?? '')
  return s.length > 8 ? s.slice(0, 8) : s || '—'
}
const fmtWhen = (ts: number): string => {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return String(ts)
  }
}

const basePath = (): string => {
  // Con botón Y acción se usa el índice global con ambos filtros
  // (el endpoint de botón no filtra por tipo de acción).
  if (effButtonId.value && effActionType.value) return `${props.apiBase}/press-logs`
  if (effButtonId.value) return `${props.apiBase}/buttons/${encodeURIComponent(effButtonId.value)}/logs`
  if (effActionType.value) return `${props.apiBase}/actions/logs`
  return `${props.apiBase}/press-logs`
}

const buildQuery = (offset: number): string => {
  const q = new URLSearchParams()
  q.set('limit', String(limit.value))
  q.set('offset', String(offset))
  if (pressType.value) q.set('pressType', pressType.value)
  if (success.value) q.set('success', success.value)
  if (deviceId.value.trim()) q.set('deviceId', deviceId.value.trim())
  const base = basePath()
  if (base.endsWith('/press-logs')) {
    if (effButtonId.value) q.set('buttonId', effButtonId.value)
    if (effActionType.value) q.set('actionType', effActionType.value)
  } else if (base.endsWith('/actions/logs')) {
    if (effActionType.value) q.set('actionType', effActionType.value)
  }
  return `?${q.toString()}`
}

const fetchList = async (offset: number): Promise<{ items: PressLog[]; total: number }> => {
  const res = await fetch(`${basePath()}${buildQuery(offset)}`, {
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const j = await res.json()
      detail = String((j as any)?.error ?? detail)
    } catch { /* noop */ }
    throw new Error(detail)
  }
  const data = await res.json()
  return {
    items: Array.isArray((data as any)?.items) ? (data as any).items : [],
    total: Number((data as any)?.total ?? 0),
  }
}

const fetchPage = async (p: number): Promise<void> => {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchList(p * limit.value)
    items.value = data.items
    total.value = data.total
    page.value = Math.min(p, Math.max(0, Math.ceil(data.total / Math.max(1, limit.value)) - 1))
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    items.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

const reload = async () => {
  await fetchPage(page.value)
}

const gotoPage = async (p: number) => {
  page.value = Math.max(0, p)
  await fetchPage(page.value)
}

const clearLogs = async () => {
  if (!window.confirm(t('bd.pressLogsClearConfirm') as string)) return
  loading.value = true
  error.value = ''
  try {
    // El DELETE solo acepta filtros de ámbito (buttonId/actionType/before):
    // enviar limit/offset/success/pressType/deviceId los ignoraría el
    // daemon y borraría MÁS de lo visible. Aquí solo va el ámbito.
    const q = new URLSearchParams()
    const base = basePath()
    if (base.endsWith('/press-logs')) {
      if (effButtonId.value) q.set('buttonId', effButtonId.value)
      if (effActionType.value) q.set('actionType', effActionType.value)
    }
    const suffix = q.toString() ? `?${q.toString()}` : ''
    const res = await fetch(`${base}${suffix}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    page.value = 0
    await fetchPage(0)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const show = async (overrides?: {
  buttonId?: string | null
  actionType?: string | null
  buttonLabel?: string | null
}) => {
  if (overrides) {
    if ('buttonId' in overrides) effButtonId.value = overrides.buttonId ?? null
    if ('actionType' in overrides) effActionType.value = overrides.actionType ?? null
    if ('buttonLabel' in overrides) effLabel.value = overrides.buttonLabel ?? null
  }
  dialog.value?.showModal()
  page.value = 0
  await fetchPage(0)
}
const close = () => {
  dialog.value?.close()
}

// En vivo: el resumen por pulsación que escribe el daemon en `logs`
// (meta.buttonId) llega por `libredeck:log-created`; si casa con el ámbito
// abierto se recarga con debounce para no tormentear la API.
let liveTimer: ReturnType<typeof setTimeout> | null = null
const onLiveLog = (e: Event) => {
  if (!dialog.value?.open) return
  const meta = (e as CustomEvent).detail?.meta ?? {}
  const id = typeof meta?.buttonId === 'string' ? meta.buttonId : null
  if (effButtonId.value && id !== effButtonId.value) return
  if (liveTimer) return
  liveTimer = setTimeout(() => {
    liveTimer = null
    void reload()
  }, 600)
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('libredeck:log-created', onLiveLog as EventListener)
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('libredeck:log-created', onLiveLog as EventListener)
  }
  if (liveTimer) clearTimeout(liveTimer)
})

defineExpose({ show, close })
</script>

<style scoped>
.bd-press-logs {
  width: min(720px, 94vw);
}
.bd-pl-filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
  align-items: end;
}
.bd-pl-filters .bd-fld {
  margin: 0;
}
/* La columna de acciones no lleva etiqueta: se alinea abajo con los inputs
   (sin el antiguo apaño de `&nbsp;`, que descuadraba alturas y baselines). */
.bd-pl-actions {
  display: flex;
  align-items: flex-end;
  min-height: 100%;
}
.bd-pl-actions .bd-btn {
  width: 100%;
}
.bd-pl-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.bd-pl-page {
  font-size: 12px;
  opacity: 0.75;
  white-space: nowrap;
}
.bd-pl-spacer {
  flex: 1;
}
.bd-pl-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.bd-pl-table th,
.bd-pl-table td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  vertical-align: baseline;
}
.bd-pl-table th {
  opacity: 0.7;
  font-weight: 600;
}
</style>
