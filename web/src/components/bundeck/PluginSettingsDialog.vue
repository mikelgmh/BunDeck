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
          <p v-if="isDiscordOauth && discordChecking" class="bd-hint" role="status" data-cy="bd-discord-state">
            {{ t('bd.discordStatusChecking') }}
          </p>
          <p v-else-if="isDiscordOauth && discordState === 'connected'" class="bd-hint" data-cy="bd-oauth-status">
            ✓ {{ oauthConnected }}
          </p>
          <div
            v-else-if="isDiscordOauth && (discordState === 'discord-closed' || discordState === 'authorized')"
            class="bd-warnbox"
            role="status"
            data-cy="bd-discord-state"
          >
            <p>{{ discordState === 'discord-closed' ? t('bd.discordClosed') : t('bd.discordAuthorized') }}</p>
            <button class="bd-btn" :disabled="discordChecking" data-cy="bd-discord-retry" @click="refreshDiscordLive">
              {{ t('bd.discordRetry') }}
            </button>
          </div>
          <p v-else-if="isDiscordOauth && discordState === 'token-expired'" class="bd-err" role="alert" data-cy="bd-discord-state">
            {{ t('bd.discordExpired') }}
          </p>
          <p v-else-if="isDiscordOauth" class="bd-hint" data-cy="bd-discord-state">{{ t('bd.discordNotConnected') }}</p>
          <p v-else-if="configured" class="bd-hint" data-cy="bd-oauth-status">✓ {{ oauthConnected }}</p>
          <div class="bd-r2">
            <button class="bd-btn bd-pri" :disabled="loginBusy" data-cy="bd-oauth-connect" @click="connectOAuth">
              {{ discordNeedsAuth ? oauthConnect : oauthReconnect }}
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
          <div v-if="isDiscordOauth" class="bd-fld" data-cy="bd-discord-fields">
            <label><b>{{ t('bd.discordSettingsTitle') }}</b></label>
            <p class="bd-hint">{{ t('bd.discordDefaultsNote') }}</p>
            <label :for="'ps-discord-clientId'"><b>{{ t('bd.discordClientId') }}</b></label>
            <input
              id="ps-discord-clientId"
              class="bd-inp"
              type="text"
              :placeholder="DISCORD_DEFAULTS.clientId"
              v-model="form.clientId"
              autocomplete="off"
              data-cy="bd-discord-client-id"
            />
            <label :for="'ps-discord-redirectUri'"><b>{{ t('bd.discordRedirectUri') }}</b></label>
            <input
              id="ps-discord-redirectUri"
              class="bd-inp"
              type="text"
              :placeholder="DISCORD_DEFAULTS.redirectUri"
              v-model="form.redirectUri"
              autocomplete="off"
              data-cy="bd-discord-redirect-uri"
            />
            <label :for="'ps-discord-mode'"><b>{{ t('bd.discordMode') }}</b></label>
            <select id="ps-discord-mode" class="bd-inp" v-model="form.mode" data-cy="bd-discord-mode">
              <option value="">{{ t('bd.discordModeAuto') }} (auto)</option>
              <option value="auto">Auto (RPC + fallback)</option>
              <option value="rpc">{{ t('bd.discordModeRpc') }}</option>
              <option value="hotkey">{{ t('bd.discordModeHotkey') }}</option>
            </select>
            <label :for="'ps-discord-proxyUrl'"><b>{{ t('bd.discordProxyUrl') }}</b></label>
            <input
              id="ps-discord-proxyUrl"
              class="bd-inp"
              type="text"
              :placeholder="DISCORD_DEFAULTS.proxyUrl"
              v-model="form.proxyUrl"
              autocomplete="off"
              data-cy="bd-discord-proxy-url"
            />
            <details class="bd-hint" data-cy="bd-discord-secret">
              <summary>{{ t('bd.discordSecretTitle') }}</summary>
              <p>{{ t('bd.discordSecretBody') }}</p>
              <input
                id="ps-discord-clientSecret"
                class="bd-inp"
                :type="revealed.clientSecret ? 'text' : 'password'"
                placeholder="••••••"
                v-model="form.clientSecret"
                autocomplete="off"
                data-cy="bd-discord-client-secret"
              />
              <button class="bd-btn" @click="revealed.clientSecret = !revealed.clientSecret">
                {{ revealed.clientSecret ? t('bd.hide') : t('bd.show') }}
              </button>
            </details>
          </div>
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
import { ref, computed, onMounted, onUnmounted } from 'vue'
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
/** El diálogo está abierto: el foco de ventana re-sonda (el token puede haber llegado por la pestaña del callback). */
const isOpen = ref(false)
const tab = ref<'settings' | 'instructions'>('settings')
const schema = ref<any>(null)
const instructions = ref('')
const oauth = ref<any>(null)
const configured = ref(false)
/** Estado OAuth de Discord: bundle (`discordStatus`) + sonda en vivo (`discord.status`). */
type DiscordState = 'connected' | 'discord-closed' | 'needs-auth' | 'not-configured' | 'token-expired' | 'authorized' | null
const discordState = ref<DiscordState>(null)
const discordChecking = ref(false)
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
/** Baked-in del daemon (daemon/src/plugins/discord-rpc.ts): se muestran como placeholder; vacío = usar estos. */
const DISCORD_DEFAULTS = {
  clientId: '1575201215791497256',
  redirectUri: 'https://relay.bundeck.app/api/discord/callback',
  proxyUrl: 'https://relay.bundeck.app/api/discord/rpc-token',
} as const
/** Claves que edita la sección dedicada de Discord (no se duplican en el loop genérico). */
const DISCORD_MANAGED_KEYS = new Set(['mode', 'clientId', 'clientSecret', 'redirectUri', 'proxyUrl'])
const oauthTitle = computed(() => (isDiscordOauth.value ? t('bd.discordConnectTitle') : t('bd.spotifyConnectTitle')))
const oauthHint = computed(() => (isDiscordOauth.value ? t('bd.discordConnectHint') : t('bd.spotifyConnectHint')))
const oauthConnect = computed(() => (isDiscordOauth.value ? t('bd.discordConnect') : t('bd.spotifyConnect')))
const oauthReconnect = computed(() => (isDiscordOauth.value ? t('bd.discordReconnect') : t('bd.spotifyReconnect')))
const oauthWaiting = computed(() => (isDiscordOauth.value ? t('bd.discordWaiting') : t('bd.spotifyWaiting')))
const oauthConnected = computed(() => (isDiscordOauth.value ? t('bd.discordConnected') : t('bd.spotifyConnected')))
const discordNeedsAuth = computed(() => {
  if (!isDiscordOauth.value) return !configured.value
  return discordState.value === null || discordState.value === 'needs-auth' || discordState.value === 'not-configured'
})

const fields = computed(() => {
  const propsMap = schema.value?.properties ?? {}
  const required = new Set<string>(schema.value?.required ?? [])
  return Object.entries<any>(propsMap)
    .filter(([key]) => !(isDiscordOauth.value && DISCORD_MANAGED_KEYS.has(key)))
    .map(([key, p]) => ({
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
  configured.value = false
  discordState.value = null
  discordChecking.value = false
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
    configured.value = data.configured ?? false
    pluginName.value = pid
    for (const [k, v] of Object.entries<any>(data.values ?? {})) {
      const prop = schema.value?.properties?.[k]
      form.value[k] = prop?.type === 'number' || prop?.type === 'integer' ? Number(v) : prop?.type === 'boolean' ? v === 'true' : v
    }
    if (isDiscordOauth.value) {
      // Estado real: el bundle trae `discordStatus` (needs-auth /
      // token-expired / authorized sin token nunca miente); la sonda en
      // vivo (`discord.status`, sin lanzar nada) distingue además
      // connected vs discord-closed.
      const bundleStatus = (data as any)?.discordStatus
      discordState.value =
        bundleStatus === 'needs-auth' || bundleStatus === 'not-configured' || bundleStatus === 'token-expired' || bundleStatus === 'authorized'
          ? bundleStatus
          : configured.value
            ? 'authorized'
            : 'needs-auth'
      void refreshDiscordLive()
    }
    if (!hasSettings.value && hasInstructions.value) tab.value = 'instructions'
    else if (!hasInstructions.value) tab.value = 'settings'
    else tab.value = initialTab
  } catch (e) {
    loadError.value = String((e as Error)?.message ?? e)
  }
  isOpen.value = true
  dialog.value?.showModal()
}
/** Al volver el foco a la ventana, el token puede haber llegado por la pestaña del callback: re-sondar. */
const onWindowFocus = () => {
  if (!isOpen.value || !isDiscordOauth.value) return
  void refreshDiscordLive()
}
onMounted(() => {
  try {
    window.addEventListener('focus', onWindowFocus)
  } catch { /* SSR/tests sin window */ }
})
onUnmounted(() => {
  try {
    window.removeEventListener('focus', onWindowFocus)
  } catch { /* noop */ }
})
/** Sonda en vivo del estado Discord (acción `status`, sin lanzar ni mutar nada). */
const refreshDiscordLive = async () => {
  if (!isDiscordOauth.value) return
  discordChecking.value = true
  try {
    const res = await fetch(`${props.apiBase}/plugins/${encodeURIComponent(pluginId.value)}/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status' }),
    })
    if (!res.ok) return
    const data = await res.json().catch(() => ({}))
    const st = (data as any)?.result?.status ?? (data as any)?.status
    if (st === 'connected' || st === 'discord-closed' || st === 'needs-auth' || st === 'token-expired' || st === 'not-configured') {
      discordState.value = st
      if (st === 'connected') configured.value = true
      if (st === 'needs-auth' || st === 'token-expired' || st === 'not-configured') configured.value = false
    }
  } catch {
    /* sin red/sonda: se conserva el estado del bundle */
  } finally {
    discordChecking.value = false
  }
}
const close = () => {
  stopLoginPoll()
  loginBusy.value = false
  isOpen.value = false
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
            const bs = (data as any)?.discordStatus
            if (bs === 'authorized' || bs === 'connected') discordState.value = 'authorized'
            for (const [k, v] of Object.entries<any>(data.values ?? {})) {
              const prop = schema.value?.properties?.[k]
              form.value[k] = prop?.type === 'number' || prop?.type === 'integer' ? Number(v) : prop?.type === 'boolean' ? v === 'true' : v
            }
            // Confirmar en vivo (connected vs discord-closed) tras capturar.
            await refreshDiscordLive()
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
    // Normaliza: números vacíos → '' (borra), checkbox → boolean.
    // Se guardan TODAS las claves del formulario (incluida la sección
    // dedicada de Discord, que no pasa por el loop genérico de `fields`).
    const values: Record<string, any> = {}
    const fieldByKey = new Map(fields.value.map((f) => [f.key, f]))
    for (const [k, v] of Object.entries(form.value)) {
      const f = fieldByKey.get(k)
      if (f && (f.type === 'number' || f.type === 'integer') && (v === undefined || v === null || v === '')) {
        values[k] = ''
        continue
      }
      if (v === undefined || v === null || v === '') values[k] = ''
      else values[k] = v
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
