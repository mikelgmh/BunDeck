<template>
  <div data-cy="remote-pane">
    <!-- Estado -->
    <h2>{{ t('bd.secRemote') }}</h2>
    <p class="bd-sub">{{ t('bd.remoteSub') }}</p>

    <div class="bd-srow" data-cy="remote-status">
      <div>
        <b>{{ t('bd.remoteStatus') }}</b>
        <p class="bd-mono">
          {{ status?.deviceId?.slice(0, 8) ?? '…' }} · {{ status?.fingerprint ?? '…' }}
        </p>
      </div>
      <div class="bd-ctl">
        <span class="bd-badge" :data-state="relayState">{{ relayLabel }}</span>
      </div>
    </div>
    <p v-if="relayState === 'disabled'" class="bd-hint">{{ t('bd.remoteDisabled') }}</p>

    <!-- Sección 1 — Enlazar otro BunDeck (emparejamiento daemon-daemon E2E) -->
    <section class="bd-card" style="margin-top: 12px" data-cy="remote-pair-section" aria-labelledby="bd-remote-pair-title">
      <h3 id="bd-remote-pair-title" style="display: flex; align-items: center; gap: 8px">
        <Link2 :size="18" aria-hidden="true" />
        {{ t('bd.remotePairTitle') }}
      </h3>
      <p class="bd-sub">{{ t('bd.remotePairSub') }}</p>
      <p class="bd-hint">{{ t('bd.remoteE2eNote') }}</p>

    <!-- Generar código -->
    <div class="bd-srow">
      <div>
        <b>{{ t('bd.remoteGenCode') }}</b>
        <p>{{ t('bd.remotePairHint') }}</p>
      </div>
      <div class="bd-ctl">
        <button class="bd-btn bd-pri" :disabled="loading" data-cy="remote-gen-code" @click="onGenCode">
          {{ t('bd.remoteGenCode') }}
        </button>
      </div>
    </div>
    <div v-if="pair" class="bd-code" data-cy="remote-pair-code">
      <span class="bd-code-num">{{ pair.code }}</span>
      <span class="bd-mono">{{ pair.fingerprint }}</span>
    </div>

    <!-- Emparejar por QR (host: mostrar) -->
    <div class="bd-srow">
      <div>
        <b>{{ t('bd.remoteQrTitle') }}</b>
        <p>{{ t('bd.remoteQrHint') }}</p>
      </div>
      <div class="bd-ctl">
        <button class="bd-btn bd-pri" :disabled="qrLoading" data-cy="remote-qr-show" @click="onShowQr">
          {{ t('bd.remoteQrShow') }}
        </button>
      </div>
    </div>
    <p v-if="qrUnsupported" class="bd-hint">{{ t('bd.remoteQrUpdate') }}</p>
    <div v-else-if="qr && qrDataUrl" class="bd-qr">
      <img
        data-cy="remote-qr-img"
        :src="qrDataUrl"
        :alt="t('bd.remoteQrTitle')"
        width="280"
        height="280"
      />
      <p v-if="!qrExpired" class="bd-mono" data-cy="remote-qr-exp">
        {{ t('bd.remoteQrExp', { s: fmtMMSS(qrSecsLeft) }) }}
      </p>
      <p v-else class="bd-err" role="alert" data-cy="remote-qr-exp">{{ t('bd.remoteQrExpiredErr') }}</p>
      <div class="bd-ctl">
        <button class="bd-btn" :disabled="qrLoading" data-cy="remote-qr-regen" @click="onShowQr">
          {{ t('bd.remoteQrRegen') }}
        </button>
      </div>
      <p class="bd-hint">{{ t('bd.remoteQrWarn') }}</p>
    </div>
    <p v-else-if="qrShowError" class="bd-err" role="alert">{{ qrShowError }}</p>

    <!-- Escanear QR (joiner: cámara o pegado manual) -->
    <div class="bd-srow">
      <div>
        <b>{{ t('bd.remoteScan') }}</b>
        <p>{{ t('bd.remoteScanHint') }}</p>
      </div>
      <div class="bd-ctl">
        <button
          class="bd-btn"
          :class="{ 'bd-pri': mobileLike }"
          data-cy="remote-scan-btn"
          @click="openScan"
        >
          {{ t('bd.remoteScan') }}
        </button>
      </div>
    </div>
    <RemoteQrScan v-if="scanOpen" @decoded="onScanDecoded" @close="scanOpen = false" />
    <div v-if="scanned" class="bd-scan-sum" data-cy="remote-scan-summary">
      <p>
        <b>{{ t('bd.remoteScannedTitle') }}</b>
      </p>
      <p class="bd-mono">{{ scanned.dev.slice(0, 8) }} · {{ scanned.fp }}</p>
      <p class="bd-mono">{{ scanned.relay || '—' }}</p>
      <p v-if="scanRelayMismatch" class="bd-hint">{{ t('bd.remoteRelayMismatch') }}</p>
      <div class="bd-form">
        <input
          v-model="scanName"
          class="bd-inp"
          :placeholder="t('bd.remoteNamePh')"
          :aria-label="t('bd.remoteNamePh')"
          data-cy="remote-scan-name"
        />
        <button
          class="bd-btn bd-pri"
          :disabled="scanConfirming"
          data-cy="remote-scan-confirm"
          @click="onScanConfirm"
        >
          {{ t('bd.remoteScanConfirm') }}
        </button>
      </div>
    </div>
    <p v-if="scanError" class="bd-err" role="alert">{{ scanError }}</p>

    <!-- Aceptar código -->
    <div class="bd-srow bd-col">
      <div>
        <b>{{ t('bd.remoteAccept') }}</b>
      </div>
      <div class="bd-form">
        <input
          v-model="accept.code"
          class="bd-inp bd-mi"
          inputmode="numeric"
          maxlength="6"
          :placeholder="t('bd.remoteCodePh')"
          :aria-label="t('bd.remoteCodePh')"
          data-cy="remote-accept-code"
        />
        <input
          v-model="accept.deviceId"
          class="bd-inp"
          spellcheck="false"
          :placeholder="t('bd.remoteDevicePh')"
          :aria-label="t('bd.remoteDevicePh')"
          data-cy="remote-accept-device"
        />
        <input
          v-model="accept.pubKey"
          class="bd-inp"
          spellcheck="false"
          :placeholder="t('bd.remotePubPh')"
          :aria-label="t('bd.remotePubPh')"
          data-cy="remote-accept-pubkey"
        />
        <input
          v-model="accept.name"
          class="bd-inp"
          :placeholder="t('bd.remoteNamePh')"
          :aria-label="t('bd.remoteNamePh')"
          data-cy="remote-accept-name"
        />
        <button class="bd-btn bd-pri" :disabled="loading" data-cy="remote-accept-btn" @click="onAccept">
          {{ t('bd.remoteAccept') }}
        </button>
        <span v-if="acceptError" class="bd-err" role="alert">{{ acceptError }}</span>
      </div>
    </div>

    <!-- Dispositivos -->
    <h3>{{ t('bd.remoteDevices') }}</h3>
    <p v-if="!devices.length" class="bd-hint">{{ t('bd.remoteNoDevices') }}</p>
    <div v-for="d in devices" :key="d.deviceId" class="bd-pr" data-cy="remote-device">
      <div style="min-width: 0">
        <b>{{ d.name }}</b>
        <p class="bd-mono" :title="d.deviceId">{{ d.deviceId.slice(0, 8) }} · {{ d.pubKeyPrefix }}</p>
        <span v-if="d.revoked" class="bd-tag-def">{{ t('bd.remoteRevoked') }}</span>
      </div>
      <div class="bd-pol">
        <label v-for="a in policyActions" :key="a" class="bd-check">
          <input
            type="checkbox"
            :checked="draftPolicy(d).includes(a)"
            :disabled="d.revoked"
            :data-cy="`remote-policy-${a}`"
            :aria-label="`${a} (${d.name})`"
            @change="onTogglePolicy(d, a)"
          />
          <span class="bd-mono">{{ a }}</span>
        </label>
      </div>
      <div style="display: flex; gap: 8px">
        <button
          class="bd-btn"
          :disabled="d.revoked"
          :data-cy="`remote-save-${d.deviceId}`"
          @click="onSavePolicy(d)"
        >
          {{ t('bd.remoteSavePolicy') }}
        </button>
        <button
          class="bd-btn bd-dng"
          :disabled="d.revoked"
          data-cy="remote-revoke"
          @click="onRevoke(d.deviceId)"
        >
          {{ t('bd.remoteRevoke') }}
        </button>
      </div>
    </div>

    <!-- Rotar claves -->
    <div class="bd-srow">
      <div>
        <b>{{ t('bd.remoteRotate') }}</b>
        <p>{{ t('bd.remoteRotateHint') }}</p>
      </div>
      <div class="bd-ctl">
        <button class="bd-btn bd-dng" :disabled="loading" data-cy="remote-rotate" @click="onRotate">
          {{ t('bd.remoteRotate') }}
        </button>
      </div>
    </div>

      <p class="bd-hint">{{ t('bd.remotePairNeedBoth') }}</p>
    </section>

    <!-- Sección 2 — Entrar desde internet (UI remota por túnel) -->
    <section class="bd-card" style="margin-top: 12px" data-cy="remote-ui-section" aria-labelledby="bd-remote-ui-title">
      <h3 id="bd-remote-ui-title" style="display: flex; align-items: center; gap: 8px">
        <Globe :size="18" aria-hidden="true" />
        {{ t('bd.remoteUiTitle') }}
      </h3>
      <p class="bd-sub">{{ t('bd.remoteUiSub') }}</p>

      <div class="bd-srow" data-cy="remote-ui-toggle-row">
        <div>
          <b>{{ t('bd.remoteUiAllow') }}</b>
          <p data-cy="remote-ui-hint">{{ t('bd.remoteUiAllowHint') }}</p>
        </div>
        <div class="bd-ctl">
          <label class="bd-check">
            <input
              type="checkbox"
              data-cy="remote-ui-toggle"
              :checked="uiEnabled"
              :disabled="uiLoading || uiUnsupported"
              :aria-label="t('bd.remoteUiAllow')"
              @change="onToggleUi"
            />
            <span class="bd-mono">{{ uiEnabled ? t('bd.connected') : t('bd.remoteUiOff') }}</span>
          </label>
        </div>
      </div>
      <p v-if="uiUnsupported" class="bd-hint" data-cy="remote-ui-update">{{ t('bd.remoteUiUpdate') }}</p>

      <template v-if="uiEnabled && !uiUnsupported">
        <!-- Abrir en móvil: código + QR de la url -->
        <div class="bd-srow">
          <div>
            <b>{{ t('bd.remoteUiOpen') }}</b>
            <p>{{ t('bd.remoteUiOpenHint') }}</p>
          </div>
          <div class="bd-ctl">
            <button class="bd-btn bd-pri" :disabled="uiLoading" data-cy="remote-ui-open" @click="onOpenMobile">
              {{ t('bd.remoteUiOpen') }}
            </button>
          </div>
        </div>
        <div v-if="uiCode" class="bd-qr" data-cy="remote-ui-qr">
          <img
            v-if="uiCodeDataUrl"
            data-cy="remote-ui-qr-img"
            :src="uiCodeDataUrl"
            :alt="t('bd.remoteUiTitle')"
            width="280"
            height="280"
          />
          <p class="bd-mono" data-cy="remote-ui-url" :title="uiCode.url">{{ uiCode.url }}</p>
          <p class="bd-mono">{{ uiCode.code }}</p>
          <p v-if="!uiExpired" class="bd-mono" data-cy="remote-ui-exp">
            {{ t('bd.remoteUiExp', { s: fmtMMSS(uiSecsLeft) }) }}
          </p>
          <p v-else class="bd-err" role="alert" data-cy="remote-ui-exp">{{ t('bd.remoteUiExpired') }}</p>
          <div class="bd-ctl">
            <button class="bd-btn" data-cy="remote-ui-url-copy" @click="onCopyUiUrl">
              {{ urlCopied ? t('bd.remoteUiCopied') : t('bd.remoteUiCopy') }}
            </button>
            <button class="bd-btn bd-dng" :disabled="uiLoading" data-cy="remote-ui-revoke-code" @click="onRevokeUiCode">
              {{ t('bd.remoteUiRevokeCode') }}
            </button>
          </div>
        </div>

        <!-- Pendientes -->
        <h4>{{ t('bd.remoteUiPending') }}</h4>
        <p v-if="!uiPending.length" class="bd-hint" data-cy="remote-ui-pending-empty">{{ t('bd.remoteUiNoPending') }}</p>
        <ul v-else class="bd-log" data-cy="remote-ui-pending-list">
          <li v-for="p in uiPending" :key="p.reqId" class="bd-pr" data-cy="remote-ui-pending-item">
            <div style="min-width: 0">
              <b class="bd-mono">{{ p.urlCode }}</b>
              <p class="bd-mono" :title="p.reqId">{{ p.ua || t('bd.remoteUiEmptyUa') }} · {{ p.ip }}</p>
              <p class="bd-mono">{{ new Date(p.createdAt).toLocaleTimeString() }}</p>
            </div>
            <div style="display: flex; gap: 8px">
              <button
                class="bd-btn bd-pri"
                :disabled="uiLoading"
                data-cy="remote-ui-allow"
                :data-req="p.reqId"
                @click="onAllow(p.reqId)"
              >
                {{ t('bd.remoteUiApprove') }}
              </button>
              <button
                class="bd-btn"
                :disabled="uiLoading"
                data-cy="remote-ui-deny"
                :data-req="p.reqId"
                @click="onDeny(p.reqId)"
              >
                {{ t('bd.remoteUiDeny') }}
              </button>
            </div>
          </li>
        </ul>
        <div v-if="uiJustToken" class="bd-code" data-cy="remote-ui-token-once" role="alert">
          <b>{{ t('bd.remoteUiTokenTitle') }}</b>
          <p class="bd-hint">{{ t('bd.remoteUiTokenWarn') }}</p>
          <p class="bd-mono" data-cy="remote-ui-token-value">{{ uiJustToken }}</p>
          <div class="bd-ctl">
            <button class="bd-btn" data-cy="remote-ui-token-copy" @click="onCopyUiToken">
              {{ tokenCopied ? t('bd.remoteUiCopied') : t('bd.remoteUiTokenCopy') }}
            </button>
            <button class="bd-btn" data-cy="remote-ui-token-ok" @click="clearJustToken">
              {{ t('bd.remoteUiTokenOk') }}
            </button>
          </div>
        </div>

        <!-- Sesiones -->
        <h4>{{ t('bd.remoteUiSessions') }}</h4>
        <p v-if="!uiSessions.length" class="bd-hint" data-cy="remote-ui-sessions-empty">{{ t('bd.remoteUiNoSessions') }}</p>
        <ul v-else class="bd-log" data-cy="remote-ui-sessions">
          <li v-for="s in uiSessions" :key="s.tokenPrefix" class="bd-pr" data-cy="remote-ui-session-item">
            <div style="min-width: 0">
              <b class="bd-mono" :title="s.tokenPrefix">{{ s.tokenPrefix }}…</b>
              <p class="bd-mono">{{ s.ua || t('bd.remoteUiEmptyUa') }} · {{ s.ip }}</p>
              <p class="bd-mono">{{ new Date(s.createdAt).toLocaleString() }} → {{ new Date(s.exp).toLocaleString() }}</p>
              <span v-if="s.revoked" class="bd-tag-def">{{ t('bd.remoteUiRevoked') }}</span>
            </div>
            <div style="display: flex; gap: 8px">
              <button
                class="bd-btn bd-dng"
                :disabled="s.revoked || uiLoading"
                data-cy="remote-ui-session-revoke"
                :data-prefix="s.tokenPrefix"
                @click="onRevokeSession(s.tokenPrefix)"
              >
                {{ t('bd.remoteUiRevoke') }}
              </button>
            </div>
          </li>
        </ul>
        <p v-if="uiError" class="bd-err" role="alert" data-cy="remote-ui-error">{{ uiError }}</p>
      </template>
    </section>

    <!-- Actividad -->
    <h3>{{ t('bd.remoteLog') }}</h3>
    <p v-if="!events.length" class="bd-hint">{{ t('bd.remoteNoLog') }}</p>
    <ul v-else class="bd-log" data-cy="remote-log">
      <li v-for="e in events" :key="`${e.ts}-${e.kind}`">
        <span class="bd-mono">{{ new Date(e.ts).toLocaleTimeString() }}</span>
        <b>{{ e.kind }}</b>
        <span v-if="e.from" class="bd-mono">{{ e.from.slice(0, 8) }}</span>
        <span>{{ e.detail }}</span>
      </li>
    </ul>
    <p v-if="error" class="bd-err" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive } from 'vue'
import { useRemote, toggleInList, isValidPairCode, parseRemoteQr, isMobileLike, type RemoteQrPayload } from '../../composables/useRemote'
import RemoteQrScan from './RemoteQrScan.vue'
import { Link2, Globe } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()
const { status, devices, pair, events, loading, error, qr, qrDataUrl, qrUnsupported, qrError, refresh, genCode, fetchQr, acceptCode, revoke, savePolicy, rotate, connectWs, disconnectWs,
  uiEnabled, uiUnsupported, uiLoading, uiError, uiCode, uiCodeDataUrl, uiPending, uiSessions, uiJustToken,
  setUiEnabled, requestUiCode, revokeUiCode, loadUiPending, loadUiSessions, allowPending, denyPending, revokeSession, clearJustToken, onRemoteEvent } = useRemote()

const accept = reactive({ code: '', deviceId: '', pubKey: '', name: '' })
const acceptError = ref('')
const drafts = reactive<Record<string, string[]>>({})

// --- QR host (mostrar) ---
const qrLoading = ref(false)
const qrShowError = ref('')
const now = ref(Date.now())
let qrTimer: number | null = null
const mobileLike = ref(false)

const qrSecsLeft = computed(() =>
  qr.value ? Math.max(0, Math.ceil((qr.value.expiresAt - now.value) / 1000)) : 0
)
const qrExpired = computed(() => !!qr.value && qrSecsLeft.value <= 0)

const fmtMMSS = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`

const startQrTick = () => {
  if (qrTimer !== null) window.clearInterval(qrTimer)
  qrTimer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
}

const onShowQr = async () => {
  qrLoading.value = true
  qrShowError.value = ''
  try {
    await fetchQr()
    now.value = Date.now()
    startQrTick()
  } catch (e) {
    // 404 (daemon sin /qr): solo el aviso de actualización, sin ruido en el error global.
    if (!qrUnsupported.value) {
      qrShowError.value = qrError.value || (e instanceof Error ? e.message : String(e))
    }
  } finally {
    qrLoading.value = false
  }
}

// --- UI remota vía relay ---
const urlCopied = ref(false)
const tokenCopied = ref(false)
let uiPollTimer: number | null = null
let uiUnsub: (() => void) | null = null

const uiSecsLeft = computed(() =>
  uiCode.value ? Math.max(0, Math.ceil((uiCode.value.expiresAt - now.value) / 1000)) : 0
)
const uiExpired = computed(() => !!uiCode.value && uiSecsLeft.value <= 0)

const copyText = async (text: string) => {
  try {
    const nav = navigator as Navigator & { clipboard?: { writeText: (s: string) => Promise<void> } }
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fallback abajo */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    return true
  } catch {
    return false
  }
}

const onToggleUi = async (ev: Event) => {
  const checked = (ev.target as HTMLInputElement).checked
  try {
    if (checked) {
      await setUiEnabled(true)
      startQrTick()
      startUiPoll()
    } else {
      // Revocable en 1 clic: apagar limpia código/pendientes/sesiones locales y avisa al daemon.
      await setUiEnabled(false)
      stopUiPoll()
    }
  } catch {
    // 404 → uiUnsupported muestra el aviso; el error queda en uiError.
    ;(ev.target as HTMLInputElement).checked = uiEnabled.value
  }
}

const onOpenMobile = async () => {
  urlCopied.value = false
  try {
    await requestUiCode()
    now.value = Date.now()
    startQrTick()
  } catch {
    /* error expuesto en uiError / aviso de actualización */
  }
}

const onRevokeUiCode = async () => {
  // Seguridad: confirmar antes de revocar el código vigente si hay pendientes.
  if (uiPending.value.length > 0) {
    try {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(t('bd.remoteUiRevokeConfirm', { n: uiPending.value.length }))
        : true
      if (!ok) return
    } catch {
      /* sin confirm disponible: seguir revocando */
    }
  }
  try {
    await revokeUiCode()
  } catch {
    /* noop */
  }
}

const onAllow = async (reqId: string) => {
  tokenCopied.value = false
  try {
    await allowPending(reqId)
  } catch {
    /* noop */
  }
}

const onDeny = async (reqId: string) => {
  try {
    await denyPending(reqId)
  } catch {
    /* noop */
  }
}

const onRevokeSession = async (prefix: string) => {
  try {
    await revokeSession(prefix)
  } catch {
    /* noop */
  }
}

const onCopyUiUrl = async () => {
  if (!uiCode.value?.url) return
  urlCopied.value = await copyText(uiCode.value.url)
  if (urlCopied.value) window.setTimeout(() => { urlCopied.value = false }, 2000)
}

const onCopyUiToken = async () => {
  if (!uiJustToken.value) return
  tokenCopied.value = await copyText(uiJustToken.value)
  if (tokenCopied.value) window.setTimeout(() => { tokenCopied.value = false }, 2000)
}

const startUiPoll = () => {
  stopUiPoll()
  uiPollTimer = window.setInterval(async () => {
    if (!uiEnabled.value || uiUnsupported.value) return
    try {
      await loadUiPending()
    } catch { /* daemon antiguo o error transitorio */ }
    try {
      await loadUiSessions()
    } catch { /* noop */ }
  }, 5000)
}

const stopUiPoll = () => {
  if (uiPollTimer !== null) {
    window.clearInterval(uiPollTimer)
    uiPollTimer = null
  }
}

// --- QR joiner (escanear / pegar) ---
const scanOpen = ref(false)
const scanned = ref<RemoteQrPayload | null>(null)
const scanError = ref('')
const scanName = ref('')
const scanConfirming = ref(false)

const scanRelayMismatch = computed(() => {
  if (!scanned.value) return false
  const local = String(status.value?.relay?.url ?? '')
  return !!scanned.value.relay && scanned.value.relay !== local
})

const qrParseErrorKey = (kind: string) => {
  if (kind === 'version') return 'bd.remoteScanVersion'
  if (kind === 'fingerprint') return 'bd.remoteScanFpBad'
  if (kind === 'expired') return 'bd.remoteQrExpiredErr'
  return 'bd.remoteScanBad'
}

const openScan = () => {
  scanError.value = ''
  scanned.value = null
  scanOpen.value = true
}

const onScanDecoded = (text: string) => {
  scanOpen.value = false
  const r = parseRemoteQr(text)
  if (!r.ok) {
    scanned.value = null
    scanError.value = t(qrParseErrorKey(r.error))
    return
  }
  scanError.value = ''
  scanned.value = r.payload
}

const onScanConfirm = async () => {
  if (!scanned.value) return
  scanConfirming.value = true
  scanError.value = ''
  try {
    await acceptCode(scanned.value.code, scanned.value.dev, scanned.value.pub, scanName.value.trim())
    scanned.value = null
    scanName.value = ''
  } catch (e) {
    scanError.value = e instanceof Error ? e.message : String(e)
  } finally {
    scanConfirming.value = false
  }
}

const relayState = computed(() => String(status.value?.relay?.status ?? 'unknown'))
const relayLabel = computed(() => {
  const s = relayState.value
  if (s === 'connected') return t('bd.remoteConnected')
  if (s === 'connecting') return t('bd.remoteConnecting')
  if (s === 'disabled') return t('bd.remoteDisabledShort')
  if (s === 'disconnected') return t('bd.remoteDisconnected')
  return s
})
const policyActions = computed(() => status.value?.policy ?? [])

const draftPolicy = (d: { deviceId: string; allowedActions: string[] }) =>
  drafts[d.deviceId] ?? d.allowedActions

const onGenCode = async () => {
  try {
    await genCode()
  } catch (e) {
    /* error ya expuesto en el composable */
  }
}

const onAccept = async () => {
  acceptError.value = ''
  if (!isValidPairCode(accept.code)) {
    acceptError.value = t('bd.remoteCodePh')
    return
  }
  try {
    await acceptCode(accept.code, accept.deviceId.trim(), accept.pubKey.trim(), accept.name.trim())
    accept.code = ''
    accept.deviceId = ''
    accept.pubKey = ''
    accept.name = ''
  } catch (e) {
    acceptError.value = e instanceof Error ? e.message : String(e)
  }
}

const onTogglePolicy = (d: { deviceId: string; allowedActions: string[] }, action: string) => {
  drafts[d.deviceId] = toggleInList(draftPolicy(d), action)
}

const onSavePolicy = async (d: { deviceId: string }) => {
  try {
    await savePolicy(d.deviceId, drafts[d.deviceId] ?? devices.value.find((x) => x.deviceId === d.deviceId)?.allowedActions ?? [])
    delete drafts[d.deviceId]
  } catch (e) {
    /* error expuesto en el composable */
  }
}

const onRevoke = async (deviceId: string) => {
  try {
    await revoke(deviceId)
    delete drafts[deviceId]
  } catch (e) {
    /* noop */
  }
}

const onRotate = async () => {
  try {
    await rotate()
  } catch (e) {
    /* noop */
  }
}

onMounted(() => {
  mobileLike.value = isMobileLike()
  refresh().catch(() => {})
  connectWs()
  // En vivo: poll 5s + WS topic `remote` (si el composable lo soporta).
  startUiPoll()
  try {
    if (typeof onRemoteEvent === 'function') {
      uiUnsub = onRemoteEvent((msg) => {
        if (!uiEnabled.value || uiUnsupported.value) return
        if (typeof msg?.type === 'string' && msg.type.startsWith('remote.')) {
          loadUiPending().catch(() => {})
          loadUiSessions().catch(() => {})
        }
      })
    }
  } catch {
    /* sin WS: el poll REST mantiene la lista */
  }
})

onUnmounted(() => {
  disconnectWs()
  stopUiPoll()
  try {
    uiUnsub?.()
  } catch { /* noop */ }
  uiUnsub = null
  if (qrTimer !== null) {
    window.clearInterval(qrTimer)
    qrTimer = null
  }
})
</script>
