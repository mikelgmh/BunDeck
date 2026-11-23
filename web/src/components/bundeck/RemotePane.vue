<template>
  <div data-cy="remote-pane">
    <dialog
      ref="approvalDialog"
      class="bd-dlg bd-remote-approval"
      aria-labelledby="bd-remote-approval-title"
      data-cy="remote-ui-approval-dialog"
      @cancel="dismissApproval"
    >
      <template v-if="activeApproval">
        <div class="bd-remote-approval__body">
          <span class="bd-remote-approval__mark" aria-hidden="true"><Globe :size="20" /></span>
          <div>
            <h2 id="bd-remote-approval-title">{{ t('bd.remoteUiApprovalTitle') }}</h2>
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
          <p v-if="uiError" class="bd-err" role="alert">{{ uiError }}</p>
        </div>
        <div class="bd-remote-approval__actions">
          <button class="bd-btn" data-cy="remote-ui-approval-deny" :disabled="uiLoading" @click="onApprovalDeny">
            {{ t('bd.remoteUiDeny') }}
          </button>
          <button class="bd-btn bd-pri" data-cy="remote-ui-approval-allow" :disabled="uiLoading" @click="onApprovalAllow">
            {{ t('bd.remoteUiApprove') }}
          </button>
        </div>
      </template>
    </dialog>

    <!-- Estado -->
    <h2>{{ t('bd.secRemote') }}</h2>
    <p class="bd-sub">{{ t('bd.remoteSub') }}</p>

    <!-- Sección 1 — Entrar desde internet (UI remota por túnel): la vía principal -->
    <section class="bd-card bd-remote-card" data-cy="remote-ui-section" aria-labelledby="bd-remote-ui-title">
      <h3 id="bd-remote-ui-title" class="bd-remote-heading">
        <Globe :size="18" aria-hidden="true" />
        {{ t('bd.remoteUiTitle') }}
      </h3>
      <p class="bd-sub">{{ t('bd.remoteUiSub') }}</p>

      <div class="bd-srow bd-remote-toggle" data-cy="remote-ui-toggle-row">
        <div>
          <b>{{ t('bd.remoteUiAllow') }}</b>
          <p data-cy="remote-ui-hint">{{ t('bd.remoteUiAllowHint') }}</p>
        </div>
        <div class="bd-ctl" style="display: flex; align-items: center; gap: 8px">
          <span class="bd-mono">{{ uiEnabled ? t('bd.connected') : t('bd.remoteUiOff') }}</span>
          <input
            type="checkbox"
            class="toggle toggle-primary"
            data-cy="remote-ui-toggle"
            :checked="uiEnabled"
            :disabled="uiLoading || uiUnsupported"
            :aria-label="t('bd.remoteUiAllow')"
            @change="onToggleUi"
          />
        </div>
      </div>
      <p v-if="uiUnsupported" class="bd-hint" data-cy="remote-ui-update">{{ t('bd.remoteUiUpdate') }}</p>
      <p class="bd-hint" data-cy="remote-ui-tunnel">
        {{ t('bd.remoteUiTunnel') }}:
        <span class="bd-mono">{{ status?.tunnel?.status ?? '…' }}</span>
        <template v-if="uiEnabled && status?.tunnel && status.tunnel.status !== 'connected'">
          {{ t('bd.remoteUiTunnelDown') }}
        </template>
      </p>

      <template v-if="uiEnabled && !uiUnsupported">
        <!-- Abrir en móvil: código + QR de la url -->
        <div class="bd-srow bd-remote-open-row">
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
        <div v-if="uiCode" class="bd-remote-qr" data-cy="remote-ui-qr">
          <div class="bd-remote-qr__image">
            <img
              v-if="uiCodeDataUrl"
              data-cy="remote-ui-qr-img"
              :src="uiCodeDataUrl"
              :alt="t('bd.remoteUiTitle')"
              width="280"
              height="280"
            />
          </div>
          <div class="bd-remote-qr__content">
            <div class="bd-remote-field">
              <span class="bd-remote-label">{{ t('bd.remoteUiUrlLabel') }}</span>
              <p class="bd-mono bd-remote-url" data-cy="remote-ui-url" :title="uiShareUrl">{{ uiShareUrl }}</p>
            </div>
            <div class="bd-remote-code-row">
              <span class="bd-remote-label">{{ t('bd.remoteUiOneTimeCode') }}</span>
              <code class="bd-remote-one-time-code">{{ uiCode.code }}</code>
            </div>
            <p v-if="!uiExpired" class="bd-remote-expiry" data-cy="remote-ui-exp">
              {{ t('bd.remoteUiExp', { s: fmtMMSS(uiSecsLeft) }) }}
            </p>
            <p v-else class="bd-err" role="alert" data-cy="remote-ui-exp">{{ t('bd.remoteUiExpired') }}</p>
            <div class="bd-ctl bd-remote-qr-actions">
              <button class="bd-btn bd-pri" data-cy="remote-ui-url-copy" @click="onCopyUiUrl">
                {{ urlCopied ? t('bd.remoteUiCopied') : t('bd.remoteUiCopy') }}
              </button>
              <button class="bd-btn bd-dng" :disabled="uiLoading" data-cy="remote-ui-revoke-code" @click="onRevokeUiCode">
                {{ t('bd.remoteUiRevokeCode') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Pendientes -->
        <h4 class="bd-remote-subheading">{{ t('bd.remoteUiPending') }}</h4>
        <p v-if="!uiPending.length" class="bd-hint" data-cy="remote-ui-pending-empty">{{ t('bd.remoteUiNoPending') }}</p>
        <ul v-else class="bd-remote-list" data-cy="remote-ui-pending-list">
          <li v-for="p in uiPending" :key="p.reqId" class="bd-remote-row" data-cy="remote-ui-pending-item">
            <div class="bd-remote-row__info">
              <b class="bd-remote-row__title">{{ p.urlCode }}</b>
              <p class="bd-remote-agent" :title="p.ua || t('bd.remoteUiEmptyUa')">{{ p.ua || t('bd.remoteUiEmptyUa') }}</p>
              <p class="bd-remote-meta"><span class="bd-mono">{{ p.ip }}</span><span>{{ formatDateTime(p.createdAt) }}</span></p>
            </div>
            <div class="bd-remote-row__actions">
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
        <div v-if="uiJustToken" class="bd-remote-token" data-cy="remote-ui-token-once" role="alert">
          <div class="bd-remote-token__heading">
            <div>
              <b>{{ t('bd.remoteUiTokenTitle') }}</b>
              <p class="bd-hint">{{ t('bd.remoteUiTokenWarn') }}</p>
            </div>
            <KeyRound :size="18" aria-hidden="true" />
          </div>
          <p class="bd-mono bd-remote-token-value" data-cy="remote-ui-token-value"><code>{{ uiJustToken }}</code></p>
          <div class="bd-remote-token__actions">
            <button class="bd-btn bd-pri" data-cy="remote-ui-token-copy" @click="onCopyUiToken">
              {{ tokenCopied ? t('bd.remoteUiCopied') : t('bd.remoteUiTokenCopy') }}
            </button>
            <button class="bd-btn" data-cy="remote-ui-token-ok" @click="clearJustToken">
              {{ t('bd.remoteUiTokenOk') }}
            </button>
          </div>
        </div>

        <!-- Sesiones -->
        <h4 class="bd-remote-subheading">{{ t('bd.remoteUiSessions') }}</h4>
        <p v-if="!uiSessions.length" class="bd-hint" data-cy="remote-ui-sessions-empty">{{ t('bd.remoteUiNoSessions') }}</p>
        <ul v-else class="bd-remote-list" data-cy="remote-ui-sessions">
          <li v-for="s in uiSessions" :key="s.tokenPrefix" class="bd-remote-row bd-remote-session" data-cy="remote-ui-session-item">
            <div class="bd-remote-row__info">
              <b class="bd-remote-row__title bd-mono" :title="s.tokenPrefix">{{ s.tokenPrefix }}…</b>
              <p class="bd-remote-agent" :title="s.ua || t('bd.remoteUiEmptyUa')">{{ s.ua || t('bd.remoteUiEmptyUa') }}</p>
              <p class="bd-remote-meta">
                <span class="bd-mono">{{ s.ip }}</span>
                <span>{{ t('bd.remoteUiSessionCreated', { date: formatDateTime(s.createdAt) }) }}</span>
                <span>{{ t('bd.remoteUiSessionExpires', { date: formatDateTime(s.exp) }) }}</span>
              </p>
              <span v-if="s.revoked" class="bd-tag-def">{{ t('bd.remoteUiRevoked') }}</span>
            </div>
            <div class="bd-remote-row__actions">
              <button
                class="bd-remote-revoke"
                :disabled="s.revoked || uiLoading"
                :aria-label="`${t('bd.remoteUiRevoke')} ${s.tokenPrefix}`"
                :title="t('bd.remoteUiRevoke')"
                data-cy="remote-ui-session-revoke"
                :data-prefix="s.tokenPrefix"
                @click="onRevokeSession(s.tokenPrefix)"
              >
                <ShieldOff :size="16" aria-hidden="true" />
                {{ t('bd.remoteUiRevoke') }}
              </button>
            </div>
          </li>
        </ul>
        <p v-if="uiError" class="bd-err" role="alert" data-cy="remote-ui-error">{{ uiError }}</p>
      </template>
    </section>

    <!-- Sección LAN — Invitación para la red local (mismo código que el QR) -->
    <section class="bd-card bd-remote-card" data-cy="remote-lan-section" aria-labelledby="bd-remote-lan-title">
      <h3 id="bd-remote-lan-title" class="bd-remote-heading">
        <Globe :size="18" aria-hidden="true" />
        {{ t('bd.lanInviteTitle') }}
      </h3>
      <p class="bd-sub">{{ t('bd.lanInviteHint') }}</p>

      <div class="bd-srow">
        <div>
          <b>{{ t('bd.lanInviteGenerate') }}</b>
          <p>{{ t('bd.qrHint') }}</p>
        </div>
        <div class="bd-ctl">
          <button class="bd-btn bd-pri" :disabled="lanLoading" data-cy="remote-lan-generate" @click="onLanGenerate">
            {{ t('bd.lanInviteGenerate') }}
          </button>
        </div>
      </div>
      <div v-if="lanInvite && lanLink" class="bd-remote-qr" data-cy="remote-lan-invite">
        <div class="bd-remote-qr__content">
          <div class="bd-remote-field">
            <span class="bd-remote-label">{{ t('bd.lanInviteLinkLabel') }}</span>
            <p class="bd-mono bd-remote-url" data-cy="remote-lan-url" :title="lanLink">{{ lanLink }}</p>
          </div>
          <div class="bd-ctl bd-remote-qr-actions">
            <button class="bd-btn bd-pri" data-cy="remote-lan-copy" @click="onCopyLanLink">
              {{ lanLinkCopied ? t('bd.lanInviteCopied') : t('bd.lanInviteCopy') }}
            </button>
            <button class="bd-btn" :disabled="lanLoading" data-cy="remote-lan-regen" @click="onLanGenerate">
              {{ t('bd.lanInviteRegen') }}
            </button>
            <button class="bd-btn bd-dng" :disabled="lanLoading" data-cy="remote-lan-revoke" @click="onLanRevoke">
              {{ t('bd.lanInviteRevoke') }}
            </button>
          </div>
          <p v-if="!lanExpired" class="bd-remote-expiry" data-cy="remote-lan-exp">
            {{ t('bd.lanInviteExp', { s: fmtMMSS(lanSecsLeft) }) }}
          </p>
          <p v-else class="bd-err" role="alert" data-cy="remote-lan-exp">{{ t('bd.lanInviteExpired') }}</p>
        </div>
      </div>

      <h4 class="bd-remote-subheading">{{ t('bd.lanSessionsTitle') }}</h4>
      <p v-if="!lanSessions.length" class="bd-hint" data-cy="remote-lan-sessions-empty">{{ t('bd.lanSessionsEmpty') }}</p>
      <ul v-else class="bd-remote-list" data-cy="remote-lan-sessions">
        <li v-for="s in lanSessions" :key="s.tokenPrefix" class="bd-remote-row bd-remote-session" data-cy="remote-lan-session-item">
          <div class="bd-remote-row__info">
            <b class="bd-remote-row__title bd-mono" :title="s.tokenPrefix">{{ s.tokenPrefix }}…</b>
            <p class="bd-remote-agent" :title="s.ua || t('bd.remoteUiEmptyUa')">{{ s.ua || t('bd.remoteUiEmptyUa') }}</p>
            <p class="bd-remote-meta">
              <span class="bd-mono">{{ s.ip }}</span>
              <span>{{ t('bd.lanSessionCreated', { date: formatDateTime(s.createdAt) }) }}</span>
              <span>{{ t('bd.lanSessionExpires', { date: formatDateTime(s.exp) }) }}</span>
            </p>
            <span v-if="s.revoked" class="bd-tag-def">{{ t('bd.lanSessionRevoked') }}</span>
          </div>
          <div class="bd-remote-row__actions">
            <button
              class="bd-remote-revoke"
              :disabled="s.revoked || lanLoading"
              :aria-label="`${t('bd.lanSessionRevoke')} ${s.tokenPrefix}`"
              :title="t('bd.lanSessionRevoke')"
              data-cy="remote-lan-session-revoke"
              :data-prefix="s.tokenPrefix"
              @click="onLanRevokeSession(s.tokenPrefix)"
            >
              <ShieldOff :size="16" aria-hidden="true" />
              {{ t('bd.lanSessionRevoke') }}
            </button>
          </div>
        </li>
      </ul>
      <p v-if="lanError" class="bd-err" role="alert" data-cy="remote-lan-error">{{ lanError }}</p>
    </section>

    <!-- Sección 2 — Enlazar otro BunDeck (emparejamiento daemon-daemon E2E) -->
    <section class="bd-card bd-remote-card" data-cy="remote-pair-section" aria-labelledby="bd-remote-pair-title">
      <h3 id="bd-remote-pair-title" class="bd-remote-heading">
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
    <div v-if="pair" class="bd-remote-pair-code" data-cy="remote-pair-code">
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
    <div v-else-if="qr && qrDataUrl" class="bd-remote-qr bd-remote-pair-qr">
      <div class="bd-remote-qr__image">
        <img
          data-cy="remote-qr-img"
          :src="qrDataUrl"
          :alt="t('bd.remoteQrTitle')"
          width="280"
          height="280"
        />
      </div>
      <div class="bd-remote-qr__content">
        <p v-if="!qrExpired" class="bd-remote-expiry" data-cy="remote-qr-exp">
          {{ t('bd.remoteQrExp', { s: fmtMMSS(qrSecsLeft) }) }}
        </p>
        <p v-else class="bd-err" role="alert" data-cy="remote-qr-exp">{{ t('bd.remoteQrExpiredErr') }}</p>
        <div class="bd-remote-field">
          <span class="bd-remote-label">{{ t('bd.remoteFingerprint') }}</span>
          <p class="bd-mono bd-remote-url">{{ qr.fingerprint }}</p>
        </div>
        <div class="bd-ctl bd-remote-qr-actions">
          <button class="bd-btn bd-pri" :disabled="qrLoading" data-cy="remote-qr-regen" @click="onShowQr">
            {{ t('bd.remoteQrRegen') }}
          </button>
        </div>
        <p class="bd-hint">{{ t('bd.remoteQrWarn') }}</p>
      </div>
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
import { ref, computed, onMounted, onUnmounted, reactive, watch, nextTick } from 'vue'
import { useRemote, toggleInList, isValidPairCode, parseRemoteQr, isMobileLike, type RemoteQrPayload, type UiPendingItem } from '../../composables/useRemote'
import { buildLanInviteUrl } from '../../utils/lanInvite'
import { withKioskParam } from '../../composables/useKiosk'
import RemoteQrScan from './RemoteQrScan.vue'
import { Link2, Globe, ShieldOff, KeyRound } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()
const { status, devices, pair, events, loading, error, qr, qrDataUrl, qrUnsupported, qrError, refresh, genCode, fetchQr, acceptCode, revoke, savePolicy, rotate, connectWs, disconnectWs,
  uiEnabled, uiUnsupported, uiLoading, uiError, uiCode, uiCodeDataUrl, uiPending, uiSessions, uiJustToken,
  setUiEnabled, requestUiCode, revokeUiCode, loadUiPending, loadUiSessions, allowPending, denyPending, revokeSession, clearJustToken, onRemoteEvent,
  apiBase, lanInvite, lanSessions, lanLoading, lanError, requestLanInvite, revokeLanInvite, loadLanSessions, revokeLanSession } = useRemote()

const approvalDialog = ref<HTMLDialogElement | null>(null)
const seenApprovalRequests = new Set<string>()
const approvalQueue = ref<string[]>([])
const activeApprovalId = ref('')
const activeApproval = computed<UiPendingItem | null>(() =>
  uiPending.value.find((item) => item.reqId === activeApprovalId.value) ?? null
)

const activateNextApproval = () => {
  if (activeApprovalId.value || !uiEnabled.value) return
  const pendingIds = new Set(uiPending.value.map((item) => item.reqId))
  while (approvalQueue.value.length) {
    const nextId = approvalQueue.value.shift()!
    if (pendingIds.has(nextId)) {
      activeApprovalId.value = nextId
      return
    }
  }
}

watch(uiPending, (pending) => {
  const pendingIds = new Set(pending.map((item) => item.reqId))
  for (const item of pending) {
    if (uiEnabled.value && !seenApprovalRequests.has(item.reqId)) {
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
  const dialog = approvalDialog.value
  if (!dialog) return
  if (requestId) {
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    }
  } else if (dialog.open) {
    if (typeof dialog.close === 'function') dialog.close()
    else dialog.removeAttribute('open')
  }
})

const formatDateTime = (timestamp: number) => new Date(timestamp).toLocaleString()

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
// Enlace para el móvil con ?kiosk=1 (como el QR): el escaneo aterriza en kiosco.
const uiShareUrl = computed(() => (uiCode.value?.url ? withKioskParam(uiCode.value.url) : ''))
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
    // El URL aprobado es de un solo uso. Sustituirlo de inmediato para que
    // el siguiente móvil tenga un enlace vigente en el QR visible.
    await requestUiCode()
  } catch (e) {
    if (!uiError.value) uiError.value = e instanceof Error ? e.message : String(e)
  }
}

const onDeny = async (reqId: string) => {
  try {
    await denyPending(reqId)
  } catch {
    /* noop */
  }
}

const dismissApproval = () => {
  const requestId = activeApprovalId.value
  if (requestId) approvalQueue.value = approvalQueue.value.filter((id) => id !== requestId)
  activeApprovalId.value = ''
}

const resolveApproval = async (allow: boolean) => {
  const requestId = activeApprovalId.value
  if (!requestId) return
  dismissApproval()
  await nextTick()
  if (allow) await onAllow(requestId)
  else await onDeny(requestId)
  activateNextApproval()
}

const onApprovalAllow = () => resolveApproval(true)
const onApprovalDeny = () => resolveApproval(false)

const onRevokeSession = async (prefix: string) => {
  try {
    await revokeSession(prefix)
  } catch {
    /* noop */
  }
}

const onCopyUiUrl = async () => {
  if (!uiShareUrl.value) return
  urlCopied.value = await copyText(uiShareUrl.value)
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

// --- Invitación LAN (red local solo-por-invitación) ---
const lanBase = ref('')
const lanLinkCopied = ref(false)
const lanLink = computed(() =>
  lanInvite.value && lanBase.value ? buildLanInviteUrl(lanBase.value, lanInvite.value.code) : ''
)
const lanSecsLeft = computed(() =>
  lanInvite.value ? Math.max(0, Math.ceil((lanInvite.value.expiresAt - now.value) / 1000)) : 0
)
const lanExpired = computed(() => !!lanInvite.value && lanSecsLeft.value <= 0)

/** Base del enlace: el propio origen si ya es LAN; si el panel está en
 *  localhost, la primera IP LAN del daemon. */
const resolveLanBase = async (): Promise<string> => {
  try {
    const host = window.location.hostname
    if (host && host !== 'localhost' && host !== '127.0.0.1') return window.location.origin
    const res = await fetch(`${apiBase()}/network/ips`)
    if (res.ok) {
      const data = await res.json()
      const ips: string[] = Array.isArray(data?.ips) ? data.ips : []
      if (ips.length > 0) return `${window.location.protocol}//${ips[0]}:${window.location.port}`
    }
  } catch { /* fallback abajo */ }
  return window.location.origin
}

const onLanGenerate = async () => {
  lanLinkCopied.value = false
  try {
    lanBase.value = await resolveLanBase()
    await requestLanInvite()
    now.value = Date.now()
    startQrTick()
    await loadLanSessions()
  } catch {
    /* error expuesto en lanError */
  }
}

const onLanRevoke = async () => {
  try {
    await revokeLanInvite()
    await loadLanSessions()
  } catch { /* noop */ }
  lanLinkCopied.value = false
}

const onLanRevokeSession = async (prefix: string) => {
  try {
    await revokeLanSession(prefix)
  } catch { /* noop */ }
}

const onCopyLanLink = async () => {
  if (!lanLink.value) return
  lanLinkCopied.value = await copyText(lanLink.value)
  if (lanLinkCopied.value) window.setTimeout(() => { lanLinkCopied.value = false }, 2000)
}

onMounted(() => {
  mobileLike.value = isMobileLike()
  refresh().catch(() => {})
  loadLanSessions().catch(() => {})
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
