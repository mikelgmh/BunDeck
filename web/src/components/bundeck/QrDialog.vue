<template>
  <dialog ref="dialog" class="bd-dlg bd-flex bd-qr" :aria-label="t('bd.qrTitle')">
    <div class="bd-dh">
      <h2>{{ t('bd.qrTitle') }}</h2>
      <span class="bd-sp"></span>
      <button class="bd-ibtn" :aria-label="t('bd.close')" @click="close">
        <X :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <div class="bd-pb">
      <div class="bd-qr-tabs">
        <div class="bd-seg" role="group" :aria-label="t('bd.qrTitle')">
          <button
            data-cy="qr-tab-local"
            :aria-pressed="tab === 'local'"
            @click="switchTab('local')"
          >
            {{ t('bd.qrLocal') }}
          </button>
          <button
            data-cy="qr-tab-internet"
            :aria-pressed="tab === 'internet'"
            @click="switchTab('internet')"
          >
            {{ t('bd.qrInternet') }}
          </button>
        </div>
      </div>

      <!-- Local: misma red (solo con invitación) -->
      <template v-if="tab === 'local'">
        <p class="bd-hint" style="text-align: center">{{ t('bd.lanInviteTitle') }}</p>
        <div class="bd-qrbox" role="img" :aria-label="t('bd.qrTitle')">
          <QrcodeVue v-if="!loading && lanDisplayUrl" :value="lanDisplayUrl" :size="280" level="M" render-as="svg" :margin="2" />
          <p v-else-if="loading" class="bd-hint">Cargando…</p>
          <p v-else-if="lanInviteError" class="bd-err" role="alert" style="text-align: center">{{ lanInviteError }}</p>
        </div>
        <p class="bd-hint" style="text-align: center">{{ t('bd.lanInviteHint') }}</p>
        <!-- El enlace lleva LA MISMA invitación que el QR (un único sistema):
          pegarlo en otro PC sin cámara equivale a escanear. -->
        <template v-if="lanInvite">
          <div class="bd-lan-link-row">
            <label class="bd-sr" for="bd-lan-url">{{ t('bd.lanInviteLinkLabel') }}</label>
            <input type="text" id="bd-lan-url" data-cy="lan-invite-link" class="bd-inp bd-mono" readonly :value="lanInvite.url" :title="t('bd.lanInviteLinkLabel')" @focus="($event.target as HTMLInputElement).select()" />
            <button class="bd-btn" data-cy="lan-invite-copy" @click="copyLanLink">{{ linkCopied ? t('bd.lanInviteCopied') : t('bd.lanInviteCopy') }}</button>
          </div>
          <p
            v-if="lanInvite.expiresAt > 0 && !lanInviteExpired"
            class="bd-remote-expiry"
            style="text-align: center"
            data-cy="lan-invite-exp"
          >
            {{ t('bd.lanInviteExp', { s: fmtMMSS(lanInviteSecsLeft) }) }}
          </p>
          <p v-else-if="lanInviteExpired" class="bd-err" role="alert" style="text-align: center" data-cy="lan-invite-exp">
            {{ t('bd.lanInviteExpired') }}
          </p>
          <div class="bd-r2" style="justify-content: center">
            <button class="bd-btn bd-pri" :disabled="lanInviteLoading" data-cy="lan-invite-regen" @click="regenLanInvite">
              {{ t('bd.lanInviteRegen') }}
            </button>
            <button class="bd-btn bd-dng" :disabled="lanInviteLoading" data-cy="lan-invite-revoke" @click="revokeLanInvite">
              {{ t('bd.lanInviteRevoke') }}
            </button>
          </div>
        </template>
        <template v-else-if="!loading && !lanInviteError">
          <div class="bd-r2" style="justify-content: center">
            <button class="bd-btn bd-pri" :disabled="lanInviteLoading" data-cy="lan-invite-generate" @click="regenLanInvite">
              {{ t('bd.lanInviteGenerate') }}
            </button>
          </div>
        </template>
        <!-- Compatibilidad: daemon antiguo sin /lan-invite → URL directa clásica. -->
        <template v-if="lanLegacyUrl">
          <div class="bd-r2">
            <label class="bd-sr" for="bd-qu">{{ t('bd.address') }}</label>
            <input type="text" id="bd-qu" class="bd-inp" readonly :value="lanLegacyUrl" @focus="($event.target as HTMLInputElement).select()" />
            <button class="bd-btn" @click="copy">{{ t('bd.copy') }}</button>
          </div>
        </template>
      </template>

      <!-- Internet: QR de acceso remoto (igual que Ajustes → Acceso remoto) -->
      <template v-else>
        <template v-if="uiUnsupported">
          <p class="bd-hint" style="text-align: center">{{ t('bd.remoteUiUpdate') }}</p>
        </template>
        <template v-else-if="!uiEnabled">
          <p class="bd-hint" style="text-align: center">{{ t('bd.remoteUiAllowHint') }}</p>
          <button class="bd-btn bd-pri bd-wide" :disabled="uiLoading" data-cy="qr-internet-enable" @click="onEnableInternet">
            {{ t('bd.remoteUiAllow') }}
          </button>
          <p v-if="uiError" class="bd-err" role="alert" style="text-align: center">{{ uiError }}</p>
        </template>
        <template v-else>
          <div v-if="uiCodeDataUrl" class="bd-qrbox" role="img" :aria-label="t('bd.remoteUiTitle')">
            <img data-cy="qr-internet-img" :src="uiCodeDataUrl" :alt="t('bd.remoteUiTitle')" width="280" height="280" />
          </div>
          <div v-else class="bd-qrbox" role="img" :aria-label="t('bd.remoteUiTitle')">
            <p v-if="uiLoading" class="bd-hint">Cargando…</p>
            <button v-else class="bd-btn bd-pri" data-cy="qr-internet-generate" @click="onRegen">
              {{ t('bd.remoteUiOpen') }}
            </button>
          </div>
          <p class="bd-hint" style="text-align: center">{{ t('bd.remoteUiOpenHint') }}</p>
          <p v-if="relayCause" class="bd-err" role="alert" style="text-align: center" data-cy="qr-internet-tunnel-down">
            <span v-if="relayCause === 'auth-required'" data-cy="relay-auth-required">{{ t('bd.remoteRelayAuthRequired') }} {{ t('bd.remoteRelayAuthAuto') }}</span>
            <span v-else-if="relayCause === 'invalid-token'" data-cy="relay-invalid-token">{{ t('bd.remoteRelayInvalidToken') }}</span>
            <span v-else-if="relayCause === 'rate-limited'" data-cy="relay-rate-limited">{{ t('bd.remoteRelayRateLimited') }}</span>
            <span v-else-if="relayCause === 'unsupported'" data-cy="relay-unsupported">{{ t('bd.remoteRelayUnsupported') }}</span>
            <span v-else data-cy="relay-unreachable">{{ t('bd.remoteUiTunnelDown') }}</span>
            <button
              v-if="relayCause === 'auth-required' || relayCause === 'invalid-token'"
              class="bd-btn bd-pri"
              style="margin-left: 8px"
              :disabled="uiLoading"
              data-cy="qr-relay-link-now"
              @click="onRelayRetry"
            >
              {{ relayCause === 'auth-required' ? t('bd.remoteRelayLinkNow') : t('bd.remoteRelayRelink') }}
            </button>
            <button
              v-else-if="relayCause === 'rate-limited'"
              class="bd-btn"
              style="margin-left: 8px"
              :disabled="uiLoading"
              data-cy="qr-relay-retry"
              @click="onRelayRetry"
            >
              {{ t('bd.remoteRelayRetry') }}
            </button>
          </p>
          <div v-if="uiCode" class="bd-remote-code-row" style="justify-content: center">
            <span class="bd-remote-label">{{ t('bd.remoteUiOneTimeCode') }}</span>
            <code class="bd-remote-one-time-code">{{ uiCode.code }}</code>
          </div>
          <p
            v-if="uiCode && !uiExpired"
            class="bd-remote-expiry"
            style="text-align: center"
            data-cy="qr-internet-exp"
          >
            {{ t('bd.remoteUiExp', { s: fmtMMSS(uiSecsLeft) }) }}
          </p>
          <p v-else-if="uiCode && uiExpired" class="bd-err" role="alert" style="text-align: center" data-cy="qr-internet-exp">
            {{ t('bd.remoteUiExpired') }}
          </p>
          <!-- Sin cámara: pegar este enlace equivale a escanear el QR. -->
          <div v-if="uiCode" class="bd-lan-link-row">
            <label class="bd-sr" for="bd-qr-internet-url">{{ t('bd.remoteUiUrlLabel') }}</label>
            <input type="text" id="bd-qr-internet-url" data-cy="qr-internet-url" class="bd-inp bd-mono" readonly :value="uiShareUrl" :title="t('bd.remoteUiUrlLabel')" @focus="($event.target as HTMLInputElement).select()" />
          </div>
          <div v-if="uiCode" class="bd-r2" style="justify-content: center">
            <button class="bd-btn" data-cy="qr-internet-copy" @click="onCopyUiUrl">
              {{ urlCopied ? t('bd.remoteUiCopied') : t('bd.remoteUiCopy') }}
            </button>
            <button class="bd-btn bd-pri" :disabled="uiLoading" data-cy="qr-internet-regen" @click="onRegen">
              {{ t('bd.remoteQrRegen') }}
            </button>
          </div>
          <p v-if="uiPending.length" class="bd-hint" style="text-align: center" data-cy="qr-internet-pending">
            {{ t('bd.remoteUiPending') }}: {{ uiPending.length }}
          </p>
          <p v-if="uiError" class="bd-err" role="alert" style="text-align: center">{{ uiError }}</p>
        </template>
      </template>
    </div>
  </dialog>
  <dialog
    ref="approvalDialog"
    class="bd-dlg bd-remote-approval"
    aria-labelledby="bd-qr-approval-title"
    data-cy="qr-internet-approval-dialog"
    @cancel="dismissApproval"
  >
    <template v-if="activeApproval">
      <div class="bd-remote-approval__body">
        <span class="bd-remote-approval__mark" aria-hidden="true"><Globe :size="20" /></span>
        <div>
          <h2 id="bd-qr-approval-title">{{ t('bd.remoteUiApprovalTitle') }}</h2>
          <p class="bd-sub">{{ t('bd.remoteUiApprovalHint') }}</p>
        </div>
        <dl class="bd-remote-approval__details">
          <div>
            <dt>{{ t('bd.remoteUiBrowser') }}</dt>
            <dd class="bd-remote-approval__agent" :title="activeApproval.ua || t('bd.remoteUiEmptyUa')">{{ activeApproval.ua || t('bd.remoteUiEmptyUa') }}</dd>
          </div>
          <div>
            <dt>{{ t('bd.remoteUiIp') }}</dt>
            <dd class="bd-mono">{{ activeApproval.ip }}</dd>
          </div>
          <div>
            <dt>{{ t('bd.remoteUiRequestedAt') }}</dt>
            <dd class="bd-mono">{{ formatDateTime(activeApproval.createdAt) }}</dd>
          </div>
        </dl>
        <p class="bd-hint">{{ t('bd.remoteUiApprovalWarning') }}</p>
        <p class="bd-hint" data-cy="qr-internet-approval-transport">{{ t('bd.remoteUiTransportNotice') }}</p>
        <p v-if="uiError" class="bd-err" role="alert">{{ uiError }}</p>
      </div>
      <div class="bd-remote-approval__actions">
        <button class="bd-btn" data-cy="qr-internet-approval-deny" :disabled="uiLoading" @click="onApprovalDeny">
          {{ t('bd.remoteUiDeny') }}
        </button>
        <button class="bd-btn bd-pri" data-cy="qr-internet-approval-allow" :disabled="uiLoading" @click="onApprovalAllow">
          {{ t('bd.remoteUiApprove') }}
        </button>
      </div>
    </template>
    <template v-else-if="approvedSession">
      <div class="bd-remote-approval__body">
        <span class="bd-remote-approval__mark" aria-hidden="true"><Check :size="20" stroke-width="1.75" /></span>
        <div>
          <h2 id="bd-qr-approval-title">{{ t('bd.remoteUiApprovedTitle') }}</h2>
          <p class="bd-sub" data-cy="qr-internet-approval-approved-ua">{{ approvedSession.ua || t('bd.remoteUiEmptyUa') }}</p>
        </div>
        <label class="bd-fld" style="grid-column: 1 / -1">
          <span class="bd-lb">{{ t('bd.deviceName') }}</span>
          <input
            class="bd-inp"
            data-cy="remote-ui-device-name"
            v-model="deviceNameInput"
            maxlength="80"
            :placeholder="t('bd.deviceName')"
            autocomplete="off"
          />
        </label>
        <p class="bd-hint">{{ t('bd.remoteUiDeviceNameHint') }}</p>
        <p v-if="uiError" class="bd-err" role="alert">{{ uiError }}</p>
      </div>
      <div class="bd-remote-approval__actions">
        <button class="bd-btn bd-pri" data-cy="qr-internet-approval-save" :disabled="!deviceNameInput.trim()" @click="onSaveDeviceName">
          {{ t('bd.save') }}
        </button>
      </div>
    </template>
  </dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { X, Globe, Check } from 'lucide-vue-next'
import QrcodeVue from 'qrcode.vue'
import { useI18nStore } from '../../composables/useI18n'
import { getTunnelToken, tunnelApiBase } from '../../composables/useTunnel'
import { buildLanInviteUrl } from '../../utils/lanInvite'
import { withKioskParam } from '../../composables/useKiosk'
import { deviceDefaultName } from '../../utils/sessionRouting'
import { useRemote } from '../../composables/useRemote'

const { t } = useI18nStore()

interface Emits {
  (e: 'notify', message: string): void
}

const emit = defineEmits<Emits>()

const dialog = ref<HTMLDialogElement | null>(null)
const tab = ref<'local' | 'internet'>('internet')
const networkUrl = ref('')
const loading = ref(true)

// --- Invitación LAN (pestaña Local): el QR y el enlace copiable llevan la
// MISMA URL con el MISMO ?invite= (un único sistema). ---
const lanInvite = ref<{ code: string; url: string; expiresAt: number } | null>(null)
const lanInviteLoading = ref(false)
const lanInviteError = ref('')
const lanLegacyUrl = ref('')
const linkCopied = ref(false)

const lanInviteSecsLeft = computed(() =>
  lanInvite.value ? Math.max(0, Math.ceil((lanInvite.value.expiresAt - now.value) / 1000)) : 0
)
const lanInviteExpired = computed(() => !!lanInvite.value && lanInviteSecsLeft.value <= 0)
/** Lo que codifica el QR local: invitación si la hay, URL directa legacy si no. */
const lanDisplayUrl = computed(() => lanInvite.value?.url || lanLegacyUrl.value || networkUrl.value)

const lanApiBase = () => {
  const tunnelToken = getTunnelToken()
  if (tunnelToken) return tunnelApiBase(tunnelToken)
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  return `${window.location.protocol}//${hostname}:3001/api/v1`
}

const requestLanInvite = async () => {
  lanInviteLoading.value = true
  lanInviteError.value = ''
  try {
    const res = await fetch(`${lanApiBase()}/remote/lan-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (res.status === 404) {
      // Daemon antiguo sin /lan-invite: URL directa clásica (compat).
      lanLegacyUrl.value = networkUrl.value
      lanInvite.value = null
      return null
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const j = await res.json()
        detail = String((j as any)?.error ?? detail)
      } catch { /* noop */ }
      // Gestión solo-anfitrión: el panel debe abrirse en localhost.
      lanInviteError.value = res.status === 403 ? t('bd.lanInviteHostOnly') : detail
      lanInvite.value = null
      return null
    }
    const data = await res.json()
    const base = networkUrl.value.split('?')[0]
    const url = buildLanInviteUrl(base || window.location.origin, String(data.code ?? ''))
    lanInvite.value = { code: String(data.code ?? ''), url, expiresAt: Number(data.expiresAt ?? 0) }
    lanLegacyUrl.value = ''
    now.value = Date.now()
    return lanInvite.value
  } catch (e) {
    lanInviteError.value = e instanceof Error ? e.message : String(e)
    lanInvite.value = null
    return null
  } finally {
    lanInviteLoading.value = false
  }
}

const regenLanInvite = async () => {
  linkCopied.value = false
  await requestLanInvite()
}

const revokeLanInvite = async () => {
  lanInviteLoading.value = true
  try {
    await fetch(`${lanApiBase()}/remote/lan-invite`, { method: 'DELETE' })
  } catch { /* mejor esfuerzo */ }
  finally {
    lanInviteLoading.value = false
  }
  lanInvite.value = null
  linkCopied.value = false
}

const copyLanLink = async () => {
  if (!lanInvite.value?.url) return
  try {
    await navigator.clipboard.writeText(lanInvite.value.url)
    linkCopied.value = true
    window.setTimeout(() => {
      linkCopied.value = false
    }, 2000)
  } catch { /* noop */ }
}

// --- Internet (acceso remoto) ---
const {
  uiEnabled,
  uiUnsupported,
  uiLoading,
  uiError,
  uiCode,
  uiCodeDataUrl,
  uiPending,
  uiSessions,
  status,
  requestUiCode,
  loadUiPending,
  loadUiSessions,
  allowPending,
  denyPending,
  setSessionDeviceName,
  setUiEnabled,
  refresh,
  connectWs,
  disconnectWs,
  onRemoteEvent,
} = useRemote()

const now = ref(Date.now())
let secTimer: number | null = null
let pollTimer: number | null = null
let pollInFlight = false
let initialSessionCount = -1
let regenTimer: number | null = null
const urlCopied = ref(false)
let uiUnsub: (() => void) | null = null

const uiSecsLeft = computed(() =>
  uiCode.value ? Math.max(0, Math.ceil((uiCode.value.expiresAt - now.value) / 1000)) : 0
)
const uiExpired = computed(() => !!uiCode.value && uiSecsLeft.value <= 0)
// Causa del aviso bajo el QR: el `auth` del relay manda sobre el túnel.
// (Lógica espejo de `resolveRelayCause` en useRemote.ts; local para no
// romper los mocks de `useRemote` en tests existentes.)
type RelayWarningCause = 'auth-required' | 'invalid-token' | 'rate-limited' | 'unreachable' | 'unsupported'
const relayCause = computed<RelayWarningCause | null>(() => {
  const relay = (status.value as { relay?: { auth?: unknown } } | null)?.relay
  const auth = typeof relay?.auth === 'string' ? relay.auth : undefined
  if (auth && auth !== 'ok') {
    if (auth === 'auth-required' || auth === 'invalid-token' || auth === 'rate-limited' ||
      auth === 'unsupported' || auth === 'unreachable') return auth
    return 'unreachable'
  }
  const tunnelStatus = (status.value as { tunnel?: { status?: string } } | null)?.tunnel?.status
  if (uiEnabled.value && tunnelStatus && tunnelStatus !== 'connected') return 'unreachable'
  return null
})

// Lo que codifica el QR y se copia: el enlace lleva ?kiosk=1 para que el
// escaneo aterrice en kiosco. Mostrarlo en texto permite conectarse sin
// cámara (igual que la pestaña Local).
const uiShareUrl = computed(() => (uiCode.value?.url ? withKioskParam(uiCode.value.url) : ''))

const fmtMMSS = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`

const startSecTick = () => {
  if (secTimer !== null) return
  secTimer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
}

const stopSecTick = () => {
  if (secTimer !== null) {
    window.clearInterval(secTimer)
    secTimer = null
  }
}

const checkApprovedAndClose = () => {
  // Con la vista de éxito visible el dueño está poniendo el nombre, y
  // mientras el allow sigue en vuelo (approvingReqId) la sesión aún no
  // existe: no cerrar por detrás (poll/otra pestaña) hasta que guarde o
  // cancele. Sin esto, el poll de 5 s cerraba la modal antes de que el
  // token volviera y la vista de éxito no llegaba a mostrarse.
  if (approvedSession.value || approvingReqId) return
  if (initialSessionCount < 0) return
  if (uiSessions.value.length > initialSessionCount) {
    emit('notify', t('bd.qrInternetApproved'))
    close()
  }
}

const pollInternet = async () => {
  if (pollInFlight) return
  if (tab.value !== 'internet' || !dialog.value?.open) return
  pollInFlight = true
  try {
    await loadUiPending().catch(() => {})
    await loadUiSessions().catch(() => {})
    checkApprovedAndClose()
  } finally {
    pollInFlight = false
  }
}

const startPoll = () => {
  stopPoll()
  pollTimer = window.setInterval(() => {
    void pollInternet()
  }, 5000)
}

const stopPoll = () => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

const ensureInternet = async () => {
  try {
    await refresh()
  } catch {
    /* el error queda en uiError / aviso de actualización */
  }
  if (uiUnsupported.value) return
  if (!uiEnabled.value) return
  initialSessionCount = uiSessions.value.length
  if (!uiCode.value || uiExpired.value) {
    try {
      await requestUiCode()
      now.value = Date.now()
      initialSessionCount = uiSessions.value.length
    } catch {
      /* error expuesto en uiError */
      return
    }
  } else if (initialSessionCount < 0) {
    initialSessionCount = uiSessions.value.length
  }
  startSecTick()
  startPoll()
  void pollInternet()
}

const ensureLocal = async () => {
  if (!networkUrl.value) {
    loading.value = true
    try {
      const localIP = await getLocalIP()
      // El escaneo local aterriza ya en kiosco (?kiosk=1).
      networkUrl.value = withKioskParam(`${window.location.protocol}//${localIP}:${window.location.port}`)
    } catch {
      networkUrl.value = withKioskParam(window.location.origin)
    } finally {
      loading.value = false
    }
  }
  // La invitación LAN (QR + enlace copiable) es de un solo uso y 15 min:
  // generar al abrir si no hay o caducó.
  if (!lanInvite.value || lanInviteExpired.value) {
    await requestLanInvite()
  }
  startSecTick()
}

const switchTab = (v: 'local' | 'internet') => {
  tab.value = v
  if (v === 'internet') {
    void ensureInternet()
    activateNextApproval()
  } else {
    dismissApproval()
    void ensureLocal()
  }
}

const onEnableInternet = async () => {
  try {
    await setUiEnabled(true)
    await ensureInternet()
  } catch {
    /* uiUnsupported muestra el aviso; el error queda en uiError */
  }
}

const onRegen = async () => {
  try {
    await requestUiCode()
    now.value = Date.now()
    initialSessionCount = uiSessions.value.length
    startPoll()
  } catch {
    /* noop: error visible en uiError */
  }
}

/** Reintento de vinculación: refresca el estado (el daemon auto-reclama). Nunca muestra tokens. */
const onRelayRetry = async () => {
  try {
    await refresh()
  } catch {
    /* el error queda en el composable */
  }
}

const onCopyUiUrl = async () => {
  if (!uiShareUrl.value) return
  try {
    // El enlace copiado también pide kiosco, como el QR.
    await navigator.clipboard.writeText(uiShareUrl.value)
    urlCopied.value = true
    window.setTimeout(() => {
      urlCopied.value = false
    }, 2000)
  } catch {
    /* noop */
  }
}

const onApprove = async (reqId: string): Promise<string | undefined> => {
  try {
    const token = await allowPending(reqId)
    // El URL aprobado es de un solo uso: sustituirlo de inmediato para que
    // al reabrir no se muestre un QR ya consumido.
    try {
      await requestUiCode()
      now.value = Date.now()
    } catch {
      /* el error queda en uiError */
    }
    return typeof token === 'string' ? token : undefined
  } catch {
    /* noop */
    return undefined
  }
}

const onDeny = async (reqId: string) => {
  try {
    await denyPending(reqId)
  } catch {
    /* noop */
  }
}

// Aviso de aprobación a pantalla completa, como en Ajustes → Acceso remoto:
// modal propia (hermana dentro de .bundeck, sin Teleport para no perder estilos) en lugar de botones bajo el QR.
const approvalDialog = ref<HTMLDialogElement | null>(null)
const seenApprovalRequests = new Set<string>()
const approvalQueue = ref<string[]>([])
const activeApprovalId = ref('')
const activeApproval = computed(
  () => uiPending.value.find((item) => item.reqId === activeApprovalId.value) ?? null
)
// Tras aprobar, el diálogo no se cierra: vista de éxito con input de nombre
// (igual que Ajustes → Acceso remoto, sin chip de transporte/P2P).
const approvedSession = ref<{ prefix: string; ua: string } | null>(null)
const deviceNameInput = ref('')
let approvingReqId = ''

const formatDateTime = (timestamp: number) => new Date(timestamp).toLocaleString()

const activateNextApproval = () => {
  if (activeApprovalId.value) return
  if (tab.value !== 'internet' || !dialog.value?.open) return
  const pendingIds = new Set(uiPending.value.map((item) => item.reqId))
  while (approvalQueue.value.length) {
    const nextId = approvalQueue.value.shift()!
    if (pendingIds.has(nextId)) {
      activeApprovalId.value = nextId
      return
    }
  }
}

const dismissApproval = () => {
  const requestId = activeApprovalId.value
  if (requestId) approvalQueue.value = approvalQueue.value.filter((id) => id !== requestId)
  activeApprovalId.value = ''
  approvedSession.value = null
  approvingReqId = ''
  deviceNameInput.value = ''
  const dlg = approvalDialog.value
  if (dlg && dlg.open && !activeApprovalId.value && !approvedSession.value) {
    try {
      if (typeof dlg.close === 'function') dlg.close()
      else dlg.removeAttribute('open')
    } catch { /* noop */ }
  }
}

// Nombre del dispositivo recién aceptado: el dueño lo confirma con Guardar.
// Se envía a la sesión y luego se cierra como antes (close() + notify).
const onSaveDeviceName = async () => {
  const a = approvedSession.value
  const name = deviceNameInput.value.trim()
  if (a && name) {
    try {
      await setSessionDeviceName(a.prefix, name)
    } catch {
      /* best-effort: el cierre no depende del renombrado */
    }
  }
  emit('notify', t('bd.qrInternetApproved'))
  close()
}

const resolveApproval = async (allow: boolean) => {
  const requestId = activeApprovalId.value
  if (!requestId) return
  if (!allow) {
    dismissApproval()
    await nextTick()
    await onDeny(requestId)
    // El QR denegado ya no vale (el relay conserva el denied y no vuelve
    // a avisar): regenerar para no dejar un QR muerto a la vista.
    try {
      await requestUiCode()
      now.value = Date.now()
    } catch {
      /* el error queda en uiError; el poll reintentará */
    }
    // El contador cae a 0 sin esperar al poll de 5 s (y sin depender del
    // refresco interno de useRemote): la vista ya no lista este reqId.
    try { await loadUiPending() } catch { /* el poll lo reintentará */ }
    activateNextApproval()
    return
  }
  // Aprobar sin cerrar: pasar a la vista de éxito con el nombre sugerido.
  approvingReqId = requestId
  const ua = activeApproval.value?.ua ?? ''
  activeApprovalId.value = ''
  const token = await onApprove(requestId)
  approvingReqId = ''
  if (typeof token === 'string' && token) {
    approvedSession.value = { prefix: token.slice(0, 8), ua }
    try { deviceNameInput.value = deviceDefaultName(ua || '') } catch { deviceNameInput.value = '' }
  } else {
    dismissApproval()
  }
  // Refresco explícito tras decidir: el contador baja a 0 de inmediato y la
  // vista de éxito parte de sesiones vigentes (el guard de
  // checkApprovedAndClose ya contempla approvedSession/approvingReqId).
  try { await loadUiPending() } catch { /* el poll lo reintentará */ }
  if (approvedSession.value) {
    try { await loadUiSessions() } catch { /* la vista de éxito ya es visible */ }
  }
  approvalQueue.value = approvalQueue.value.filter((id) => id !== requestId)
  activateNextApproval()
}

const onApprovalAllow = () => resolveApproval(true)
const onApprovalDeny = () => resolveApproval(false)

watch(uiPending, (pending) => {
  const pendingIds = new Set(pending.map((item) => item.reqId))
  for (const item of pending) {
    if (!seenApprovalRequests.has(item.reqId)) {
      seenApprovalRequests.add(item.reqId)
      approvalQueue.value.push(item.reqId)
    }
  }
  approvalQueue.value = approvalQueue.value.filter((id) => pendingIds.has(id))
  if (activeApprovalId.value && !pendingIds.has(activeApprovalId.value)) activeApprovalId.value = ''
  activateNextApproval()
})

watch(activeApprovalId, async (requestId) => {
  await nextTick()
  const dlg = approvalDialog.value
  if (!dlg) return
  if (requestId) {
    // Nueva solicitud: fuera la vista de éxito anterior.
    approvedSession.value = null
    if (!dlg.open) {
      if (typeof dlg.showModal === 'function') dlg.showModal()
      else dlg.setAttribute('open', '')
    }
  } else if (dlg.open && !approvedSession.value && !approvingReqId) {
    if (typeof dlg.close === 'function') dlg.close()
    else dlg.removeAttribute('open')
  }
})

// Si el QR de internet caduca con la modal abierta, regenerarlo para
// que siempre haya un código vigente que escanear.
watch(uiExpired, (expired) => {
  if (!expired) return
  if (tab.value !== 'internet' || !dialog.value?.open) return
  if (uiUnsupported.value || !uiEnabled.value || uiLoading.value) return
  if (regenTimer !== null) return
  regenTimer = window.setTimeout(() => {
    regenTimer = null
    if (tab.value === 'internet' && dialog.value?.open && uiExpired.value) void onRegen()
  }, 1000)
})

// Si la invitación LAN caduca con la modal abierta, regenerarla para
// que siempre haya un QR/enlace vigente.
watch(lanInviteExpired, (expired) => {
  if (!expired) return
  if (tab.value !== 'local' || !dialog.value?.open) return
  if (lanInviteLoading.value) return
  if (regenTimer !== null) return
  regenTimer = window.setTimeout(() => {
    regenTimer = null
    if (tab.value === 'local' && dialog.value?.open && lanInviteExpired.value) void regenLanInvite()
  }, 1000)
})

// Por si la aprobación llega por otro cliente (p. ej. Ajustes abierto),
// el aumento de sesiones cierra la modal.
watch(
  () => uiSessions.value.length,
  () => checkApprovedAndClose()
)

const getDaemonLanIp = async (): Promise<string | null> => {
  try {
    const tunnelToken = getTunnelToken()
    const daemonBase = tunnelToken
      ? tunnelApiBase(tunnelToken)
      : `${window.location.protocol}//${window.location.hostname}:3001/api/v1`
    const res = await fetch(`${daemonBase}/network/ips`)
    if (!res.ok) return null
    const data = await res.json()
    const ips: string[] = Array.isArray(data?.ips) ? data.ips : []
    const rank = (ip: string) =>
      ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3
    ips.sort((a, b) => rank(a) - rank(b))
    return ips[0] ?? null
  } catch {
    return null
  }
}

const getLocalIP = () => {
  return new Promise<string>((resolve, reject) => {
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      resolve(window.location.hostname)
      return
    }
    getDaemonLanIp().then((daemonIp) => {
      if (daemonIp) {
        resolve(daemonIp)
        return
      }
      const pc = new RTCPeerConnection({ iceServers: [] })
      pc.createDataChannel('')
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const ipMatch = event.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/)
          if (ipMatch && ipMatch[1] !== '127.0.0.1') {
            resolve(ipMatch[1])
            pc.close()
          }
        }
      }
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(reject)
      setTimeout(() => reject(new Error('Timeout getting local IP')), 3000)
    })
  })
}

const show = async () => {
  dialog.value?.showModal()
  startSecTick()
  try {
    connectWs()
  } catch {
    /* sin WS: el poll REST mantiene la lista */
  }
  try {
    if (typeof onRemoteEvent === 'function' && !uiUnsub) {
      uiUnsub = onRemoteEvent((msg) => {
        if (tab.value !== 'internet' || !dialog.value?.open) return
        if (typeof msg?.type === 'string' && msg.type.startsWith('remote.')) void pollInternet()
      })
    }
  } catch {
    /* noop */
  }
  if (tab.value === 'local') {
    await ensureLocal()
    // Precarga del estado remoto en segundo plano para que la pestaña
    // Internet abra sin retardo.
    refresh().catch(() => {})
  } else {
    void ensureInternet()
  }
}
const close = () => {
  stopPoll()
  if (regenTimer !== null) {
    window.clearInterval(regenTimer)
    regenTimer = null
  }
  try {
    uiUnsub?.()
  } catch {
    /* noop */
  }
  uiUnsub = null
  try {
    disconnectWs()
  } catch {
    /* noop */
  }
  stopSecTick()
  activeApprovalId.value = ''
  approvalQueue.value = []
  approvedSession.value = null
  approvingReqId = ''
  deviceNameInput.value = ''
  try {
    if (approvalDialog.value?.open) approvalDialog.value.close()
  } catch {
    /* noop */
  }
  dialog.value?.close()
}

const copy = async () => {
  try {
    await navigator.clipboard.writeText(networkUrl.value)
    emit('notify', t('bd.copied'))
  } catch { /* noop */ }
}

onUnmounted(() => {
  stopPoll()
  stopSecTick()
  if (regenTimer !== null) {
    window.clearTimeout(regenTimer)
    regenTimer = null
  }
  activeApprovalId.value = ''
  approvalQueue.value = []
  try {
    if (approvalDialog.value?.open) approvalDialog.value.close()
  } catch {
    /* noop */
  }
  try {
    uiUnsub?.()
  } catch {
    /* noop */
  }
  uiUnsub = null
  try {
    disconnectWs()
  } catch {
    /* noop */
  }
})

defineExpose({ show, close })
</script>

<style scoped>
.bd-qr-tabs {
  display: flex;
  justify-content: center;
}
.bd-wide {
  width: 100%;
}
</style>
