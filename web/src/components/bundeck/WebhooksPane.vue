<template>
  <div class="bd-webhooks bd-wh" data-cy="bd-webhooks">
    <div class="bd-warnbox" role="note">
      <ShieldAlert :size="20" stroke-width="1.75" aria-hidden="true" />
      <p>{{ t('bd.webhooksLocalOnly') }}</p>
    </div>

    <div class="bd-r2 bd-wh-toolbar">
      <div class="bd-dsearch bd-wh-search">
        <Search :size="16" stroke-width="1.75" aria-hidden="true" />
        <input
          v-model="query"
          type="search"
          class="bd-inp"
          :placeholder="t('bd.webhooksSearch')"
          :aria-label="t('bd.webhooksSearch')"
          data-cy="bd-webhooks-search"
        />
      </div>
      <button class="bd-btn bd-pri" data-cy="bd-webhook-new" @click="startCreate">
        <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.webhookNew') }}
      </button>
    </div>

    <p v-if="error" class="bd-err" role="alert">{{ error }}</p>
    <p v-if="loading" class="bd-hint">{{ t('bd.loading') }}</p>

    <!-- Formulario crear/editar -->
    <div v-if="draft" class="bd-mcp bd-wh-form" data-cy="bd-webhook-form">
      <div class="bd-wh-form-top">
        <label class="bd-sr" for="bd-wh-name">{{ t('bd.webhookName') }}</label>
        <input
          id="bd-wh-name"
          v-model="draft.name"
          type="text"
          class="bd-inp bd-wh-field-name"
          :placeholder="t('bd.webhookNamePh')"
          data-cy="bd-webhook-name"
        />
        <label class="bd-sr" for="bd-wh-method">{{ t('bd.webhookMethod') }}</label>
        <select id="bd-wh-method" v-model="draft.method" class="bd-inp bd-wh-field-method" data-cy="bd-webhook-method">
          <option v-for="m in methods" :key="m" :value="m">{{ m }}</option>
        </select>
        <label class="bd-sw" :title="t('bd.webhookEnabled')">
          <input type="checkbox" v-model="draft.enabled" :aria-label="t('bd.webhookEnabled')" data-cy="bd-webhook-enabled" /><span></span>
        </label>
      </div>

      <div class="bd-wh-acts">
        <div class="bd-wh-acts-head">
          <b>{{ t('bd.webhookActions') }}</b>
          <span v-if="draft.actions.length" class="bd-hint">{{ t('bd.webhookActionsCount', { n: draft.actions.length }) }}</span>
        </div>
        <p v-if="!draft.actions.length" class="bd-hint">{{ t('bd.webhookNoActions') }}</p>
        <div v-for="(a, i) in draft.actions" :key="i" class="bd-wh-act" :data-cy="`bd-webhook-action-${i}`">
          <div class="bd-wh-act-top">
            <kbd class="bd-kbd">{{ a.type }}</kbd>
            <span class="bd-sp"></span>
            <button class="bd-ibtn" :aria-label="t('bd.webhookRemoveAction')" :title="t('bd.webhookRemoveAction')" @click="draft.actions.splice(i, 1)">
              <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
          <label class="bd-sr" :for="`bd-wh-p-${i}`">{{ t('bd.webhookParams') }}</label>
          <input
            :id="`bd-wh-p-${i}`"
            :value="a.paramsJson"
            type="text"
            class="bd-inp bd-mi"
            spellcheck="false"
            :placeholder="t('bd.webhookParams')"
            :data-cy="`bd-webhook-params-${i}`"
            @input="draft.actions[i].paramsJson = ($event.target as HTMLInputElement).value"
          />
          <span v-if="paramsError(i)" class="bd-err">{{ t('bd.webhookBadParams') }}</span>
        </div>
      </div>

      <div class="bd-r2 bd-wh-foot">
        <button class="bd-btn" data-cy="bd-webhook-add-action" @click="palette?.show()">
          <Plus :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.webhookAddAction') }}
        </button>
        <span class="bd-sp"></span>
        <button class="bd-btn" @click="draft = null">{{ t('bd.webhookCancel') }}</button>
        <button class="bd-btn bd-pri" data-cy="bd-webhook-save" :disabled="!draft.name.trim() || hasParamsError" @click="saveDraft">
          {{ draft.id ? t('bd.webhookSave') : t('bd.webhookCreate') }}
        </button>
      </div>
    </div>

    <!-- Lista -->
    <div v-if="!webhooks.length && !loading" class="bd-drop" data-cy="bd-webhooks-empty">
      <Webhook :size="28" stroke-width="1.5" aria-hidden="true" />
      <p>{{ t('bd.webhookNoHooks') }}</p>
    </div>
    <p v-else-if="!filtered.length && !loading" class="bd-hint" data-cy="bd-webhooks-nomatch">{{ t('bd.webhookNoMatch', { q: query.trim() }) }}</p>
    <div v-else class="bd-wh-list">
      <div v-for="w in filtered" :key="w.id" class="bd-mcp bd-wh-card" :data-cy="`bd-webhook-item-${w.id}`">
        <div class="bd-wh-head">
          <div class="bd-wh-title">
            <b class="bd-wh-name">{{ w.name }}</b>
            <p class="bd-hint bd-wh-meta">
              <kbd class="bd-kbd">{{ w.method }}</kbd>
              <span>{{ t('bd.webhookActionsCount', { n: (w.actions ?? []).length }) }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ t('bd.webhookTriggerCount', { n: w.trigger_count ?? 0 }) }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ lastFiredLabel(w) }}</span>
            </p>
            <p v-if="w.enabled !== 1" class="bd-hint bd-wh-off">{{ t('bd.webhookDisabledNote') }}</p>
          </div>
          <label class="bd-sw" :title="t('bd.webhookEnabled')">
            <input
              type="checkbox"
              :checked="w.enabled === 1"
              :aria-label="`${t('bd.webhookEnabled')}: ${w.name}`"
              :data-cy="`bd-webhook-toggle-${w.id}`"
              @change="toggleEnabled(w, ($event.target as HTMLInputElement).checked)"
            /><span></span>
          </label>
        </div>
        <div class="bd-r2 bd-wh-urlrow">
          <label class="bd-sr" :for="`bd-wh-url-${w.id}`">{{ t('bd.webhookUrl') }}</label>
          <input
            :id="`bd-wh-url-${w.id}`"
            type="text"
            class="bd-inp bd-mono bd-wh-url"
            readonly
            :value="fullUrl(w)"
            :data-cy="`bd-webhook-url-${w.id}`"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <button class="bd-btn" :data-cy="`bd-webhook-copy-${w.id}`" @click="copyUrl(w)">
            <Copy :size="16" stroke-width="1.75" aria-hidden="true" />{{ copiedId === w.id ? t('bd.webhookCopied') : t('bd.webhookCopy') }}
          </button>
        </div>
        <div class="bd-r2 bd-wh-actions">
          <button class="bd-btn" :data-cy="`bd-webhook-test-${w.id}`" :disabled="testingId === w.id" @click="testWebhook(w)">
            <Play :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.webhookTest') }}
          </button>
          <button class="bd-btn" :data-cy="`bd-webhook-regen-${w.id}`" @click="regenToken(w)">
            <RefreshCw :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.webhookRegenerate') }}
          </button>
          <button class="bd-btn" :data-cy="`bd-webhook-edit-${w.id}`" @click="startEdit(w)">{{ t('bd.webhookEdit') }}</button>
          <span class="bd-sp"></span>
          <button
            v-if="confirmDeleteId !== w.id"
            class="bd-btn bd-dng"
            :data-cy="`bd-webhook-delete-${w.id}`"
            @click="confirmDeleteId = w.id"
          >
            <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.webhookDelete') }}
          </button>
          <button v-else class="bd-btn bd-dng" :data-cy="`bd-webhook-delete-confirm-${w.id}`" @click="deleteWebhook(w)">
            {{ t('bd.webhookConfirmDelete', { name: w.name }) }}
          </button>
        </div>
      </div>
    </div>

    <ActionCommandPalette
      ref="palette"
      :plugins="props.plugins"
      :detailed="props.detailed"
      @pick="onPickAction"
      @close="() => {}"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, defineAsyncComponent } from 'vue'
import { Plus, Trash2, Copy, Play, RefreshCw, Search, ShieldAlert, Webhook } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'

const ActionCommandPalette = defineAsyncComponent(() => import('./ActionCommandPalette.vue'))

const { t } = useI18nStore()

interface Props {
  apiBase: string
  plugins?: any[]
  detailed?: any[]
}

interface Emits {
  (e: 'notify', message: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

interface DraftAction {
  type: string
  paramsJson: string
}

interface Draft {
  id: string | null
  name: string
  method: string
  enabled: boolean
  actions: DraftAction[]
}

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const webhooks = ref<any[]>([])
const lanIps = ref<string[]>([])
const loading = ref(false)
const error = ref('')
const query = ref('')
const draft = ref<Draft | null>(null)
const testingId = ref<string | null>(null)
const confirmDeleteId = ref<string | null>(null)
const copiedId = ref<string | null>(null)
const palette = ref<{ show: () => void } | null>(null)

const norm = (s: string) =>
  (s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const filtered = computed(() => {
  const q = norm(query.value.trim())
  if (!q) return webhooks.value
  return webhooks.value.filter((w) => norm(`${w.name} ${w.method}`).includes(q))
})

function paramsError(i: number): boolean {
  const raw = draft.value?.actions[i]?.paramsJson ?? ''
  if (!raw.trim()) return false
  try {
    const p = JSON.parse(raw)
    return !p || typeof p !== 'object' || Array.isArray(p)
  } catch {
    return true
  }
}
const hasParamsError = computed(() => {
  if (!draft.value) return false
  return draft.value.actions.some((_, i) => paramsError(i))
})

/** Base LAN para las URLs: primera IP del daemon (nunca localhost si hay LAN). */
const lanBase = computed(() => {
  try {
    const u = new URL(props.apiBase)
    const host = lanIps.value[0] ?? u.hostname
    return `${u.protocol}//${host}:${u.port || '3001'}`
  } catch {
    return 'http://127.0.0.1:3001'
  }
})
const fullUrl = (w: any) => `${lanBase.value}/api/v1/webhooks/${w.token}`

function lastFiredLabel(w: any): string {
  if (!w.last_triggered_at) return t('bd.webhookNeverFired')
  try {
    return t('bd.webhookLastFired', { when: new Date(w.last_triggered_at).toLocaleString() })
  } catch {
    return t('bd.webhookNeverFired')
  }
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${props.apiBase}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = String((await res.json())?.error ?? res.status)
    } catch {
      detail = `HTTP ${res.status}`
    }
    throw new Error(detail)
  }
  return res.json()
}

async function reload(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [list, ips] = await Promise.all([
      api('/webhooks'),
      api('/network/ips').catch(() => ({ ips: [] })),
    ])
    webhooks.value = Array.isArray(list) ? list : []
    lanIps.value = Array.isArray((ips as any)?.ips) ? (ips as any).ips : []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function startCreate(): void {
  draft.value = { id: null, name: '', method: 'POST', enabled: true, actions: [] }
}

function startEdit(w: any): void {
  draft.value = {
    id: w.id,
    name: w.name,
    method: w.method ?? 'POST',
    enabled: w.enabled !== 0,
    actions: (w.actions ?? []).map((a: any) => ({
      type: String(a.type),
      paramsJson: a.parameters && Object.keys(a.parameters).length ? JSON.stringify(a.parameters) : '',
    })),
  }
}

function onPickAction(type: string): void {
  if (!draft.value) return
  if (draft.value.actions.length >= 32) return
  draft.value.actions.push({ type, paramsJson: '' })
}

async function saveDraft(): Promise<void> {
  const d = draft.value
  if (!d || !d.name.trim() || hasParamsError.value) {
    if (d && !d.name.trim()) emit('notify', t('bd.webhookNameRequired'))
    return
  }
  const actions = d.actions.map((a) => {
    let parameters: Record<string, any> = {}
    if (a.paramsJson.trim()) {
      try {
        parameters = JSON.parse(a.paramsJson)
      } catch {
        parameters = {}
      }
    }
    return { type: a.type, parameters }
  })
  try {
    if (d.id) {
      await api(`/webhooks/${encodeURIComponent(d.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: d.name.trim(), method: d.method, enabled: d.enabled, actions }),
      })
    } else {
      await api('/webhooks', {
        method: 'POST',
        body: JSON.stringify({ name: d.name.trim(), method: d.method, enabled: d.enabled, actions }),
      })
    }
    draft.value = null
    await reload()
  } catch (e) {
    emit('notify', e instanceof Error ? e.message : String(e))
  }
}

async function toggleEnabled(w: any, on: boolean): Promise<void> {
  try {
    const next = await api(`/webhooks/${encodeURIComponent(w.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: on }),
    })
    const i = webhooks.value.findIndex((x) => x.id === w.id)
    if (i >= 0) webhooks.value[i] = next
  } catch (e) {
    emit('notify', e instanceof Error ? e.message : String(e))
    await reload()
  }
}

async function testWebhook(w: any): Promise<void> {
  testingId.value = w.id
  try {
    const r = await api(`/webhooks/${encodeURIComponent(w.id)}/test`, { method: 'POST' })
    emit('notify', t('bd.webhookTestOk', { ok: r.executed ?? 0, failed: r.failed ?? 0 }))
    await reload()
  } catch (e) {
    emit('notify', t('bd.webhookTestFail', { error: e instanceof Error ? e.message : String(e) }))
  } finally {
    testingId.value = null
  }
}

async function regenToken(w: any): Promise<void> {
  try {
    const next = await api(`/webhooks/${encodeURIComponent(w.id)}/regenerate`, { method: 'POST' })
    const i = webhooks.value.findIndex((x) => x.id === w.id)
    if (i >= 0) webhooks.value[i] = next
    emit('notify', t('bd.webhookRegenerated'))
  } catch (e) {
    emit('notify', e instanceof Error ? e.message : String(e))
  }
}

async function deleteWebhook(w: any): Promise<void> {
  confirmDeleteId.value = null
  try {
    await api(`/webhooks/${encodeURIComponent(w.id)}`, { method: 'DELETE' })
    webhooks.value = webhooks.value.filter((x) => x.id !== w.id)
    if (draft.value?.id === w.id) draft.value = null
  } catch (e) {
    emit('notify', e instanceof Error ? e.message : String(e))
  }
}

async function copyUrl(w: any): Promise<void> {
  const url = fullUrl(w)
  try {
    await navigator.clipboard.writeText(url)
  } catch {
    // Fallback: selecciona el input para copia manual.
    try {
      const el = document.getElementById(`bd-wh-url-${w.id}`) as HTMLInputElement | null
      el?.focus()
      el?.select()
    } catch { /* noop */ }
  }
  copiedId.value = w.id
  emit('notify', t('bd.webhookCopied'))
}

onMounted(() => {
  void reload()
})

defineExpose({ reload })
</script>

<style scoped>
/* Aire entre bloques (warn, toolbar, form, lista) */
.bd-wh { display: flex; flex-direction: column; gap: 16px; }
/* Toolbar: buscador flexible + botón, con wrap en estrecho */
.bd-wh-toolbar { flex-wrap: wrap; }
.bd-wh-search { flex: 1 1 220px; min-width: 0; }
/* Lista de tarjetas con aire (antes: bordes pegados) */
.bd-wh-list { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.bd-wh-card { gap: 12px; }
/* Cabecera: nombre destacado + meta secundaria + toggle */
.bd-wh-head { display: flex; align-items: flex-start; gap: 12px; }
.bd-wh-title { flex: 1; min-width: 0; }
.bd-wh-name { display: block; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-wh-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 4px 0 0; }
.bd-wh-off { margin: 4px 0 0; }
.bd-wh-head .bd-sw { flex: none; margin-top: 2px; }
/* URL secundaria: input mono flexible + botón copiar fijo */
.bd-wh-urlrow { flex-wrap: wrap; }
.bd-wh-url { font-size: 12px; }
/* Acciones con wrap en móvil */
.bd-wh-actions { flex-wrap: wrap; row-gap: 8px; }
/* Formulario: cabecera con wrap */
.bd-wh-form-top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.bd-wh-field-name { flex: 2 1 200px; min-width: 0; }
.bd-wh-field-method { flex: 0 1 auto; }
/* Acciones del borrador como sub-paneles con aire */
.bd-wh-acts { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.bd-wh-acts-head { display: flex; align-items: baseline; gap: 8px; }
.bd-wh-acts-head .bd-hint { margin: 0; }
.bd-wh-act { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--bd-ln); border-radius: 10px; }
.bd-wh-act-top { display: flex; align-items: center; gap: 8px; }
.bd-wh-foot { flex-wrap: wrap; row-gap: 8px; }
</style>
