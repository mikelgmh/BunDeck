<template>
  <dialog ref="dialog" class="bd-dlg bd-flex" :aria-label="title" data-cy="bd-plugin-settings" style="width: min(560px, 94vw)">
    <div class="bd-dh">
      <h2>{{ title }}</h2>
      <span class="bd-sp"></span>
      <button class="bd-ibtn" :aria-label="t('bd.close')" @click="close">
        <X :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <div class="bd-dtabs" role="tablist" v-if="hasSettings && hasInstructions">
      <button role="tab" :aria-selected="tab === 'settings'" @click="tab = 'settings'">{{ t('bd.pluginSettings') }}</button>
      <button role="tab" :aria-selected="tab === 'instructions'" @click="tab = 'instructions'">{{ t('bd.pluginInstructions') }}</button>
    </div>
    <div class="bd-pb" style="display: flex; flex-direction: column; gap: 12px">
      <p v-if="loadError" class="bd-err" role="alert">{{ loadError }}</p>
      <template v-else-if="tab === 'settings' || !hasInstructions">
        <div v-if="oauth" class="bd-fld" data-cy="bd-oauth-box">
          <label><b>{{ oauthTitle }}</b></label>
          <p class="bd-hint">{{ oauth.notes ?? oauthHint }}</p>
          <p v-if="configured" class="bd-hint" data-cy="bd-oauth-status">✓ {{ oauthConnected }}</p>
          <div class="bd-r2">
            <button class="bd-btn bd-pri" :disabled="loginBusy" data-cy="bd-oauth-connect" @click="connectOAuth">
              {{ configured ? oauthReconnect : oauthConnect }}
            </button>
            <span v-if="loginBusy" class="bd-hint" role="status">{{ oauthWaiting }}</span>
          </div>
          <div v-if="loginBusy && isDiscordOauth" class="bd-hint" data-cy="bd-discord-auth-hint" role="status">
            <p>{{ t('bd.discordAuthorizeHint') }}</p>
            <p v-if="loginAuthorizeUrl">
              <a :href="loginAuthorizeUrl" target="_blank" rel="noopener" data-cy="bd-discord-authorize">{{
                t('bd.discordAuthorizeOpen')
              }}</a>
            </p>
          </div>
          <details v-if="isDiscordOauth" class="bd-hint" data-cy="bd-discord-advanced">
            <summary>{{ t('bd.discordAdvancedTitle') }}</summary>
            <p>{{ t('bd.discordAdvancedBody') }}</p>
          </details>
          <div v-else-if="loginBusy" class="bd-hint" data-cy="bd-spotify-host-hint" role="status">
            <p>{{ t('bd.spotifyHostWindow') }}</p>
            <p>
              {{ t('bd.spotifyRemoteHint') }}
              <a href="https://open.spotify.com" target="_blank" rel="noopener" data-cy="bd-spotify-open"
                >open.spotify.com</a
              >
            </p>
          </div>
          <p v-if="loginError" class="bd-err" role="alert">{{ loginError }}</p>
        </div>
        <p v-if="!hasSettings" class="bd-hint">{{ t('bd.pluginNoSettings') }}</p>
        <template v-else>
          <div v-for="field in fields" :key="field.key" class="bd-fld">
            <label :for="'ps-' + field.key"><b>{{ field.title }}</b></label>
            <p v-if="field.description" class="bd-hint">{{ field.description }}</p>
            <select
              v-if="field.enum"
              :id="'ps-' + field.key"
              class="bd-inp"
              v-model="form[field.key]"
            >
              <option value="">{{ t('bd.chooseOption') }}</option>
              <option v-for="opt in field.enum" :key="String(opt)" :value="opt">{{ fieldLabel(field, opt) }}</option>
            </select>
            <label v-else-if="field.type === 'boolean'" class="bd-sw">
              <input type="checkbox" v-model="form[field.key]" />
              <span></span>
            </label>
            <input
              v-else-if="field.type === 'number' || field.type === 'integer'"
              :id="'ps-' + field.key"
              class="bd-inp"
              type="number"
              :min="field.minimum"
              :max="field.maximum"
              :placeholder="field.placeholder"
              v-model.number="form[field.key]"
            />
            <div v-else class="bd-r2">
              <input
                :id="'ps-' + field.key"
                class="bd-inp"
                :type="field.secret && !revealed[field.key] ? 'password' : 'text'"
                :placeholder="field.placeholder"
                v-model="form[field.key]"
                autocomplete="off"
              />
              <button v-if="field.secret" class="bd-btn" @click="revealed[field.key] = !revealed[field.key]">
                {{ revealed[field.key] ? t('bd.hide') : t('bd.show') }}
              </button>
            </div>
          </div>
          <p v-if="saveError" class="bd-err" role="alert">{{ saveError }}</p>
          <div class="bd-r2">
            <span class="bd-sp"></span>
            <button class="bd-btn bd-pri" :disabled="saving" @click="save">
              {{ saving ? t('bd.installing') : t('bd.save') }}
            </button>
          </div>
        </template>
      </template>
      <pre v-else class="bd-pre">{{ instructions }}</pre>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { X } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

interface Props {
  apiBase: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'saved', pluginId: string): void
  (e: 'notify', message: string): void
}>()

const dialog = ref<HTMLDialogElement | null>(null)
const pluginId = ref('')
const pluginName = ref('')
const tab = ref<'settings' | 'instructions'>('settings')
const schema = ref<any>(null)
const instructions = ref('')
const oauth = ref<any>(null)
const configured = ref(true)
const loginBusy = ref(false)
const loginError = ref('')
const loginAuthorizeUrl = ref('')
let loginTimer: ReturnType<typeof setInterval> | null = null
const form = ref<Record<string, any>>({})
const revealed = ref<Record<string, boolean>>({})
/** Campos secretos según el daemon (contrato v2.2); [] si el daemon es antiguo. */
const secretFields = ref<string[]>([])
const loadError = ref('')
const saveError = ref('')
const saving = ref(false)

const title = computed(() => pluginName.value || pluginId.value)
const hasSettings = computed(() => !!schema.value?.properties && Object.keys(schema.value.properties).length > 0)
const hasInstructions = computed(() => instructions.value.length > 0)

/** OAuth genérico: Discord pide Client ID + popup explícito; Spotify usa el Web Player. */
const isDiscordOauth = computed(() => oauth.value?.provider === 'discord')
const oauthTitle = computed(() => (isDiscordOauth.value ? t('bd.discordConnectTitle') : t('bd.spotifyConnectTitle')))
const oauthHint = computed(() => (isDiscordOauth.value ? t('bd.discordConnectHint') : t('bd.spotifyConnectHint')))
const oauthConnect = computed(() => (isDiscordOauth.value ? t('bd.discordConnect') : t('bd.spotifyConnect')))
const oauthReconnect = computed(() => (isDiscordOauth.value ? t('bd.discordReconnect') : t('bd.spotifyReconnect')))
const oauthWaiting = computed(() => (isDiscordOauth.value ? t('bd.discordWaiting') : t('bd.spotifyWaiting')))
const oauthConnected = computed(() => (isDiscordOauth.value ? t('bd.discordConnected') : t('bd.spotifyConnected')))

const fields = computed(() => {
  const propsMap = schema.value?.properties ?? {}
  const required = new Set<string>(schema.value?.required ?? [])
  return Object.entries<any>(propsMap).map(([key, p]) => ({
    key,
    title: p.title ?? key,
    description: p.description ?? '',
    type: p.type ?? 'string',
    enum: Array.isArray(p.enum) ? p.enum : null,
    options: p.ui?.options ?? null,
    minimum: p.minimum,
    maximum: p.maximum,
    placeholder: p.ui?.placeholder ?? p.examples?.[0] ?? '',
    required: required.has(key),
    secret:
      secretFields.value.includes(key) ||
      p.secret === true ||
      p.format === 'password' ||
      p.ui?.type === 'password' ||
      /token|password|secret|passwd|api[_-]?key/i.test(key + ' ' + (p.title ?? '')),
  }))
})

const fieldLabel = (field: any, opt: any) => {
  const found = (field.options ?? []).find((o: any) => String(o.value) === String(opt))
  return found?.label ?? String(opt)
}

const show = async (pid: string, initialTab: 'settings' | 'instructions' = 'settings') => {
  pluginId.value = pid
  tab.value = initialTab
  loadError.value = ''
  saveError.value = ''
  loginError.value = ''
  loginBusy.value = false
  loginAuthorizeUrl.value = ''
  stopLoginPoll()
  schema.value = null
  instructions.value = ''
  oauth.value = null
  configured.value = true
  form.value = {}
  secretFields.value = []
  try {
    const res = await fetch(`${props.apiBase}/plugins/${encodeURIComponent(pid)}/settings`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    schema.value = data.schema ?? null
    secretFields.value = Array.isArray(data.secretFields) ? data.secretFields : []
    instructions.value = data.instructions ?? ''
    oauth.value = data.oauth ?? null
    configured.value = data.configured ?? true
    pluginName.value = pid
    for (const [k, v] of Object.entries<any>(data.values ?? {})) {
      const prop = schema.value?.properties?.[k]
      form.value[k] = prop?.type === 'number' || prop?.type === 'integer' ? Number(v) : prop?.type === 'boolean' ? v === 'true' : v
    }
    if (!hasSettings.value && hasInstructions.value) tab.value = 'instructions'
    else if (!hasInstructions.value) tab.value = 'settings'
    else tab.value = initialTab
  } catch (e) {
    loadError.value = String((e as Error)?.message ?? e)
  }
  dialog.value?.showModal()
}
const close = () => {
  stopLoginPoll()
  loginBusy.value = false
  dialog.value?.close()
}

/** Login OAuth sin Client ID: pide al host Electrobun que abra el Web Player. */
const stopLoginPoll = () => {
  if (loginTimer) {
    clearInterval(loginTimer)
    loginTimer = null
  }
}

const connectOAuth = async () => {
  loginError.value = ''
  loginBusy.value = true
  loginAuthorizeUrl.value = ''
  try {
    const req = await fetch(`${props.apiBase}/plugins/${encodeURIComponent(pluginId.value)}/login-request`, {
      method: 'POST',
    })
    if (!req.ok) {
      const d = await req.json().catch(() => ({}))
      throw new Error(d.error ?? `HTTP ${req.status}`)
    }
    // Discord devuelve la URL de autorización: abrirla para el permiso explícito.
    try {
      const d = await req.json().catch(() => ({}))
      if (typeof d?.authorizeUrl === 'string' && d.authorizeUrl) {
        loginAuthorizeUrl.value = d.authorizeUrl
        try {
          window.open(d.authorizeUrl, '_blank', 'noopener')
        } catch {
          /* popup bloqueado: queda el enlace visible */
        }
      }
    } catch {
      /* sin authorizeUrl (Spotify): el host abre el Web Player */
    }
    // Poll: el host abre la ventana y el sniffer POSTea token-capture.
    const started = Date.now()
    await new Promise<void>((resolve, reject) => {
      stopLoginPoll()
      loginTimer = setInterval(async () => {
        if (Date.now() - started > 5 * 60_000) {
          stopLoginPoll()
          reject(new Error('timeout'))
          return
        }
        try {
          const res = await fetch(`${props.apiBase}/plugins/${encodeURIComponent(pluginId.value)}/settings`)
          if (!res.ok) return
          const data = await res.json()
          if (data?.configured) {
            stopLoginPoll()
            // Refrescar el formulario con los valores capturados.
            schema.value = data.schema ?? schema.value
            instructions.value = data.instructions ?? instructions.value
            oauth.value = data.oauth ?? oauth.value
            configured.value = true
            for (const [k, v] of Object.entries<any>(data.values ?? {})) {
              const prop = schema.value?.properties?.[k]
              form.value[k] = prop?.type === 'number' || prop?.type === 'integer' ? Number(v) : prop?.type === 'boolean' ? v === 'true' : v
            }
            resolve()
          }
        } catch {
          /* reintentar */
        }
      }, 2000)
    })
    emit('saved', pluginId.value)
    emit('notify', t('bd.pluginSettingsSaved'))
  } catch (e) {
    loginError.value = String((e as Error)?.message ?? e)
  } finally {
    loginBusy.value = false
    stopLoginPoll()
  }
}

const save = async () => {
  saveError.value = ''
  saving.value = true
  try {
    // Normaliza: números vacíos → '' (borra), checkbox → boolean
    const values: Record<string, any> = {}
    for (const f of fields.value) {
      const v = form.value[f.key]
      if (v === undefined || v === null || v === '') values[f.key] = ''
      else values[f.key] = v
    }
    const res = await fetch(`${props.apiBase}/plugins/${encodeURIComponent(pluginId.value)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    emit('saved', pluginId.value)
    emit('notify', t('bd.pluginSettingsSaved'))
    close()
  } catch (e) {
    saveError.value = String((e as Error)?.message ?? e)
  } finally {
    saving.value = false
  }
}

defineExpose({ show, close })
</script>
