<template>
  <div data-cy="diagnostics-pane">
    <h2>{{ t('bd.secLogs') }}</h2>
    <p class="bd-sub">{{ t('bd.logsSub') }}</p>

    <section class="bd-settings-group" aria-labelledby="bd-diag-services-title" data-cy="diagnostics-services">
      <h3 id="bd-diag-services-title" class="bd-settings-group__title">{{ t('bd.diagServices') }}</h3>
      <div
        v-for="s in services"
        :key="s.id"
        class="bd-srow"
        :data-cy="`diagnostics-status-${s.id}`"
      >
        <div>
          <b>{{ s.label }}</b>
          <p class="bd-mono" style="word-break: break-all">{{ s.detail }}</p>
        </div>
        <div class="bd-ctl">
          <span
            class="bd-tag-def"
            :style="s.ok ? 'background: var(--bd-ok, #2f9e44); color: #fff' : 'background: var(--bd-err, #e03131); color: #fff'"
          >{{ s.ok ? `OK${s.ms != null ? ` · ${s.ms} ms` : ''}` : t('bd.diagError') }}</span>
        </div>
      </div>
      <p v-if="apiFailed" class="bd-hint" data-cy="diagnostics-lan-hint">{{ t('bd.diagApiHint') }}</p>
      <p v-else-if="!wsConnected" class="bd-hint" data-cy="diagnostics-ws-hint">{{ t('bd.diagWsHint') }}</p>
    </section>

    <section class="bd-settings-group" aria-labelledby="bd-diag-logs-title">
      <h3 id="bd-diag-logs-title" class="bd-settings-group__title">{{ t('bd.diagLogs') }}</h3>
      <div class="bd-srow">
        <div>
          <b>{{ t('bd.diagLevel') }}</b>
        </div>
        <div class="bd-ctl" style="display: flex; gap: 8px; flex-wrap: wrap">
          <select
            class="bd-inp"
            :value="level"
            :aria-label="t('bd.diagLevel')"
            data-cy="diagnostics-level"
            @change="level = ($event.target as HTMLSelectElement).value; loadLogs()"
          >
            <option value="">{{ t('bd.diagAll') }}</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
            <option value="debug">debug</option>
          </select>
          <button class="bd-btn" data-cy="diagnostics-refresh" :disabled="busy" @click="refreshAll">
            {{ t('bd.diagRefresh') }}
          </button>
          <button class="bd-btn" data-cy="diagnostics-copy" @click="copyDiagnostics">
            {{ t('bd.diagCopy') }}
          </button>
        </div>
      </div>
      <p v-if="logsError" class="bd-err" role="alert">{{ logsError }}</p>
      <p v-else-if="!logs.length && !busy" class="bd-hint" data-cy="diagnostics-logs-empty">
        {{ t('bd.diagEmpty') }}
      </p>
      <ul v-else data-cy="diagnostics-logs" class="bd-diag-logs">
        <li v-for="l in logs" :key="`${l.ts}-${l.id ?? l.message}`" data-cy="diagnostics-log" class="bd-diag-log">
          <span class="bd-mono bd-diag-ts">{{ formatTime(l.ts) }}</span>
          <span class="bd-tag-def bd-diag-lv" :data-level="l.level">{{ l.level }}</span>
          <span class="bd-diag-msg">{{ l.message }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18nStore } from '../../composables/useI18n'
import { isTunnelMode } from '../../composables/useTunnel'

const { t } = useI18nStore()

interface Props {
  apiBase: string
  wsUrl?: string
  wsConnected?: boolean
}

interface Emits {
  (e: 'notify', message: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

interface ServiceState {
  id: string
  label: string
  ok: boolean
  detail: string
  ms?: number | null
}

interface LogRow {
  id?: number
  level: string
  message: string
  ts: number
}

const services = ref<ServiceState[]>([])
const logs = ref<LogRow[]>([])
const logsError = ref('')
const level = ref('')
const busy = ref(false)

const apiFailed = computed(() => {
  const api = services.value.find((s) => s.id === 'api')
  return !!api && !api.ok
})

const configUrl = computed(() => props.apiBase.replace(/\/api\/v1\/?$/, '/config'))

const withTimeout = (ms = 8000): AbortSignal => {
  // Por el túnel (internet) cada petición da varios saltos relay↔daemon:
  // con 8 s Safari abortaba ("Fetch is aborted") en las respuestas pesadas.
  const budget = isTunnelMode() ? Math.max(ms, 30000) : ms
  return AbortSignal.timeout(budget)
}

async function timedFetch(url: string, init?: RequestInit): Promise<{ res: Response; ms: number }> {
  const t0 = performance.now()
  const res = await fetch(url, { ...init, signal: withTimeout() })
  return { res, ms: Math.round(performance.now() - t0) }
}

const fmtErr = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function checkApi(): Promise<ServiceState> {
  const label = t('bd.diagApi')
  const url = `${props.apiBase}/test`
  try {
    const { res, ms } = await timedFetch(url)
    if (!res.ok) return { id: 'api', label, ok: false, detail: `${url} → HTTP ${res.status}` }
    return { id: 'api', label, ok: true, detail: url, ms }
  } catch (e) {
    return { id: 'api', label, ok: false, detail: `${url} → ${fmtErr(e)}` }
  }
}

async function checkConfig(): Promise<ServiceState> {
  const label = t('bd.diagConfig')
  try {
    const { res, ms } = await timedFetch(configUrl.value)
    if (!res.ok) return { id: 'config', label, ok: false, detail: `${configUrl.value} → HTTP ${res.status}` }
    const cfg = await res.json()
    return {
      id: 'config', label, ok: true,
      detail: `api:${cfg.apiPort ?? '?'} ws:${cfg.wsPort ?? '?'} frontend:${cfg.frontendPort ?? '?'}`, ms,
    }
  } catch (e) {
    return { id: 'config', label, ok: false, detail: `${configUrl.value} → ${fmtErr(e)}` }
  }
}

function checkWs(): ServiceState {
  const ok = !!props.wsConnected
  return {
    id: 'ws', label: t('bd.diagWs'), ok,
    detail: ok
      ? `${props.wsUrl ?? ''}`
      : `${props.wsUrl ?? ''} — ${t('bd.disconnected')}`,
  }
}

async function checkVersion(): Promise<ServiceState> {
  const label = t('bd.diagVersion')
  try {
    const { res, ms } = await timedFetch(`${props.apiBase}/version`)
    if (!res.ok) return { id: 'version', label, ok: false, detail: `HTTP ${res.status}` }
    const v = await res.json()
    return { id: 'version', label, ok: true, detail: `v${v.version ?? '?'} · ${v.channel ?? ''}`.trim(), ms }
  } catch (e) {
    return { id: 'version', label, ok: false, detail: fmtErr(e) }
  }
}

async function checkProfiles(): Promise<ServiceState> {
  const label = t('bd.diagProfiles')
  try {
    const { res, ms } = await timedFetch(`${props.apiBase}/profiles`)
    if (!res.ok) return { id: 'profiles', label, ok: false, detail: `HTTP ${res.status}` }
    const list = await res.json()
    const n = Array.isArray(list) ? list.length : 0
    return { id: 'profiles', label, ok: true, detail: t('bd.diagCountProfiles', { n }), ms }
  } catch (e) {
    return { id: 'profiles', label, ok: false, detail: fmtErr(e) }
  }
}

async function checkPlugins(): Promise<ServiceState> {
  const label = t('bd.diagPlugins')
  try {
    const { res, ms } = await timedFetch(`${props.apiBase}/plugins/actions`)
    if (!res.ok) return { id: 'plugins', label, ok: false, detail: `HTTP ${res.status}` }
    const list = await res.json()
    const np = Array.isArray(list) ? list.length : 0
    let na = 0
    if (Array.isArray(list)) {
      for (const [, data] of list as Array<[string, any]>) {
        if (Array.isArray((data as any)?.actions)) na += (data as any).actions.length
      }
    }
    return { id: 'plugins', label, ok: true, detail: t('bd.diagCountPlugins', { n: np, m: na }), ms }
  } catch (e) {
    return { id: 'plugins', label, ok: false, detail: fmtErr(e) }
  }
}

async function checkHw(): Promise<ServiceState> {
  const label = t('bd.diagHw')
  try {
    const { res, ms } = await timedFetch(`${props.apiBase}/devices/streamdeck/status`)
    if (!res.ok) return { id: 'hw', label, ok: false, detail: `HTTP ${res.status}` }
    const st = await res.json()
    return {
      id: 'hw', label, ok: true,
      detail: st.isConnected ? `${t('bd.diagHwOn')}${st.grid ? ` · ${st.grid.cols}×${st.grid.rows}` : ''}` : t('bd.diagHwOff'),
      ms,
    }
  } catch (e) {
    return { id: 'hw', label, ok: false, detail: fmtErr(e) }
  }
}

async function checkLan(): Promise<ServiceState> {
  const label = t('bd.diagLan')
  const here = typeof window !== 'undefined' ? window.location.host : ''
  try {
    const { res, ms } = await timedFetch(`${props.apiBase}/network/ips`)
    if (!res.ok) return { id: 'lan', label, ok: false, detail: `HTTP ${res.status} · ${t('bd.diagLanHere')} ${here}` }
    const data = await res.json()
    const ips = Array.isArray(data?.ips) ? data.ips.join(', ') : '—'
    return { id: 'lan', label, ok: true, detail: `${ips} · ${t('bd.diagLanHere')} ${here}`, ms }
  } catch (e) {
    return { id: 'lan', label, ok: false, detail: `${fmtErr(e)} · ${t('bd.diagLanHere')} ${here}` }
  }
}

async function loadLogs(): Promise<void> {
  logsError.value = ''
  try {
    const q = level.value ? `?limit=100&level=${encodeURIComponent(level.value)}` : '?limit=100'
    const { res } = await timedFetch(`${props.apiBase}/logs${q}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = await res.json()
    logs.value = Array.isArray(list) ? list : []
  } catch (e) {
    logsError.value = fmtErr(e)
    logs.value = []
  }
}

async function refreshAll(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const results = await Promise.all([
      checkApi(), checkConfig(), Promise.resolve(checkWs()),
      checkVersion(), checkProfiles(), checkPlugins(), checkHw(), checkLan(),
    ])
    services.value = results
    await loadLogs()
  } finally {
    busy.value = false
  }
}

async function copyDiagnostics(): Promise<void> {
  const summary = {
    when: new Date().toISOString(),
    page: typeof window !== 'undefined' ? window.location.href : '',
    apiBase: props.apiBase,
    wsUrl: props.wsUrl ?? '',
    wsConnected: !!props.wsConnected,
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    services: services.value.map((s) => ({ id: s.id, ok: s.ok, detail: s.detail, ms: s.ms ?? null })),
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(summary, null, 2))
    emit('notify', t('bd.diagCopied'))
  } catch (e) {
    emit('notify', fmtErr(e))
  }
}

const formatTime = (ts: number): string => {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return String(ts)
  }
}

onMounted(() => {
  void refreshAll()
})

defineExpose({ refresh: refreshAll })
</script>

<style scoped>
.bd-diag-logs {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bd-diag-log {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  padding: 4px 0;
}
.bd-diag-ts {
  opacity: 0.7;
  white-space: nowrap;
}
.bd-diag-msg {
  word-break: break-word;
}
</style>
