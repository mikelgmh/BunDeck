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
          <p class="bd-hint" data-cy="remote-ui-transport-notice">{{ t('bd.remoteUiTransportNotice') }}</p>
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
      <template v-else-if="approvedSession">
        <div class="bd-remote-approval__body">
          <span class="bd-remote-approval__mark" aria-hidden="true"><Check :size="20" stroke-width="1.75" /></span>
          <div>
            <h2 id="bd-remote-approval-title">{{ t('bd.remoteUiApprovedTitle') }}</h2>
            <p class="bd-sub" data-cy="remote-ui-approved-ua">{{ approvedSession.ua || t('bd.remoteUiEmptyUa') }}</p>
          </div>
          <p class="bd-hint">
            <span class="bd-tag-def" :data-transport="approvedTransport" data-cy="remote-ui-approved-transport"><LoaderCircle v-if="approvedTransport === 'connecting'" :size="12" class="bd-spin" aria-hidden="true" />{{ approvedTransportLabel }}</span>
          </p>
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
          <button class="bd-btn bd-pri" data-cy="remote-ui-approval-close" :disabled="!deviceNameInput.trim()" @click="onSaveDeviceName">{{ t('bd.save') }}</button>
        </div>
      </template>
    </dialog>

    <!-- Estado -->
    <h2>{{ t('bd.secRemote') }}</h2>
    <p class="bd-sub">{{ t('bd.remoteSub') }}</p>

    <!-- Relay público configurable -->
    <section class="bd-card bd-remote-card" data-cy="remote-relay-section" aria-labelledby="bd-remote-relay-title">
      <h3 id="bd-remote-relay-title" class="bd-remote-heading">
        <Globe :size="18" aria-hidden="true" />
        {{ t('bd.remoteRelayTitle') }}
      </h3>
      <p class="bd-sub">{{ t('bd.remoteRelaySub') }}</p>
      <p class="bd-hint" data-cy="remote-relay-current">
        {{ status?.relay?.url || t('bd.remoteDisabledShort') }} · {{ status?.relay?.status ?? '…' }}
      </p>
      <p v-if="relayEnvOverride" class="bd-hint" data-cy="remote-relay-env">{{ t('bd.remoteRelayEnvHint') }}</p>
      <div class="bd-form" role="radiogroup" :aria-label="t('bd.remoteRelayTitle')">
        <label class="bd-check">
          <input
            type="radio"
            name="remote-relay-mode"
            value="public"
            v-model="relayMode"
            data-cy="remote-relay-public"
          />
          <span>{{ t('bd.remoteRelayPublic') }}</span>
        </label>
        <label class="bd-check">
          <input
            type="radio"
            name="remote-relay-mode"
            value="custom"
            v-model="relayMode"
            data-cy="remote-relay-custom"
          />
          <span>{{ t('bd.remoteRelayCustom') }}</span>
        </label>
        <label class="bd-check">
          <input
            type="radio"
            name="remote-relay-mode"
            value="off"
            v-model="relayMode"
            data-cy="remote-relay-off"
          />
          <span>{{ t('bd.remoteRelayOff') }}</span>
        </label>
      </div>
      <div v-if="relayMode === 'custom'" class="bd-form">
        <input
          v-model="relayInput"
          class="bd-inp"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('bd.remoteRelayUrlPh')"
          :aria-label="t('bd.remoteRelayCustom')"
          data-cy="remote-relay-url"
        />
      </div>
      <p class="bd-hint">{{ t('bd.remoteRelayReconnect') }}</p>
      <p v-if="relayFormError" class="bd-err" role="alert" data-cy="remote-relay-error">{{ relayFormError }}</p>
      <div class="bd-ctl bd-remote-qr-actions">
        <button class="bd-btn bd-pri" :disabled="relayLoading" data-cy="remote-relay-save" @click="onSaveRelay">
          {{ t('bd.remoteRelaySave') }}
        </button>
        <button class="bd-btn" :disabled="relayLoading" data-cy="remote-relay-reset" @click="onResetRelay">
          {{ t('bd.remoteRelayReset') }}
        </button>
      </div>
    </section>

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
              <p v-if="s.deviceName" class="bd-remote-meta" data-cy="remote-ui-session-device">
                <span>{{ t('bd.deviceName') }}: <b>{{ s.deviceName }}</b></span>
              </p>
              <p class="bd-remote-meta">
                <span class="bd-mono">{{ s.ip }}</span>
                <span>{{ t('bd.remoteUiSessionCreated', { date: formatDateTime(s.createdAt) }) }}</span>
                <span>{{ s.exp ? t('bd.remoteUiSessionExpires', { date: formatDateTime(s.exp) }) : t('bd.remoteUiSessionNeverExpires') }}</span>
              </p>
              <p class="bd-remote-meta">
                <span
                  class="bd-tag-def"
                  :data-transport="transportOf(s.tokenPrefix)"
                  :title="t('bd.remoteUiTransportTitle')"
                  data-cy="remote-ui-session-transport"
                >{{ transportLabel(transportOf(s.tokenPrefix)) }}</span>
              </p>
              <span v-if="s.revoked" class="bd-tag-def">{{ t('bd.remoteUiRevoked') }}</span>
            </div>
            <div class="bd-remote-row__actions">
              <template v-if="renamingPrefix === s.tokenPrefix">
                <input
                  class="bd-inp"
                  data-cy="remote-ui-session-name-input"
                  v-model="renamingName"
                  maxlength="80"
                  :placeholder="t('bd.deviceName')"
                  :aria-label="t('bd.deviceName')"
                  @keydown.enter.prevent="onRenameSession(s.tokenPrefix)"
                  @keydown.escape.prevent="cancelRenameSession"
                />
                <button
                  class="bd-btn bd-pri"
                  data-cy="remote-ui-session-name-save"
                  :disabled="!renamingName.trim()"
                  @click="onRenameSession(s.tokenPrefix)"
                >
                  {{ t('bd.save') }}
                </button>
                <button
                  class="bd-btn"
                  data-cy="remote-ui-session-name-cancel"
                  @click="cancelRenameSession"
                >
                  {{ t('bd.cancel') }}
                </button>
              </template>
              <template v-else>
                <button
                  class="bd-btn"
                  :disabled="s.revoked || uiLoading"
                  :aria-label="`${t('bd.remoteUiRename')} ${s.tokenPrefix}`"
                  :title="t('bd.remoteUiRename')"
                  data-cy="remote-ui-session-rename"
                  :data-prefix="s.tokenPrefix"
                  @click="startRenameSession(s)"
                >
                  <Pencil :size="16" aria-hidden="true" />
                  {{ t('bd.remoteUiRename') }}
                </button>
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
              </template>
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

      <h4 class="bd-remote-subheading">{{ t('bd.browsersTitle') }}</h4>
      <p class="bd-sub">{{ t('bd.browsersSub') }}</p>
      <p v-if="!knownBrowsers.length" class="bd-hint" data-cy="remote-browsers-empty">{{ t('bd.browsersEmpty') }}</p>
      <ul v-else class="bd-remote-list" data-cy="remote-browsers">
        <li v-for="b in knownBrowsers" :key="b.id" class="bd-remote-row" data-cy="remote-browser-item">
          <div class="bd-remote-row__info">
            <b class="bd-remote-row__title"><i class="bd-dot" :class="{ 'bd-ok': !!b.online }" :title="b.online ? t('bd.deviceOnline') : t('bd.deviceOffline')" aria-hidden="true"></i>{{ b.name }}</b>
            <p class="bd-remote-meta"><span>{{ browserKindLabel(b) }}</span><span>{{ b.online ? t('bd.deviceOnline') : t('bd.deviceOffline') }}</span></p>
            <span v-if="b.id === ownDeviceId" class="bd-tag-def">{{ t('bd.browserThis') }}</span>
          </div>
          <div v-if="b.id !== ownDeviceId" class="bd-remote-row__actions">
            <button
              class="bd-remote-revoke"
              :title="t('bd.deviceForget')"
              :aria-label="`${t('bd.deviceForget')}: ${b.name}`"
              data-cy="remote-browser-forget"
              :data-id="b.id"
              @click="onForgetBrowser(b.id)"
            >
              <Trash2 :size="16" aria-hidden="true" />
              {{ t('bd.deviceForget') }}
            </button>
          </div>
        </li>
      </ul>
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
import { useRemote, toggleInList, isValidPairCode, parseRemoteQr, isMobileLike, isValidRelayUrlInput, type RemoteQrPayload, type UiPendingItem } from '../../composables/useRemote'
import { buildLanInviteUrl } from '../../utils/lanInvite'
import { withKioskParam } from '../../composables/useKiosk'
import RemoteQrScan from './RemoteQrScan.vue'
import { useDevices, type LogicalDevice } from '../../composables/useDevices'
import { getOrCreateDeviceId, deviceDefaultName } from '../../utils/sessionRouting'
import { Link2, Globe, ShieldOff, KeyRound, Trash2, Check, LoaderCircle, Pencil } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()
const { status, devices, pair, events, loading, error, qr, qrDataUrl, qrUnsupported, qrError, refresh, genCode, fetchQr, acceptCode, revoke, savePolicy, rotate, connectWs, disconnectWs,
  uiEnabled, uiUnsupported, uiLoading, uiError, uiCode, uiCodeDataUrl, uiPending, uiSessions, uiJustToken,
  setUiEnabled, requestUiCode, revokeUiCode, loadUiPending, loadUiSessions, allowPending, denyPending, revokeSession, setSessionDeviceName, clearJustToken, onRemoteEvent,
  setRelayUrl, relayUrl, relayEnvOverride, relayLoading,
  apiBase, lanInvite, lanSessions, lanLoading, lanError, requestLanInvite, revokeLanInvite, loadLanSessions, revokeLanSession } = useRemote()

/** Relay público por defecto (espejo del daemon `DEFAULT_PUBLIC_RELAY_URL`). */
const DEFAULT_PUBLIC_RELAY_URL = 'wss://relay.bundeck.app'

// --- Relay configurable (radios público/personalizado/desactivado + URL) ---
const relayMode = ref<'public' | 'custom' | 'off'>('public')
const relayInput = ref('')
const relayFormError = ref('')

/** Refleja la URL efectiva en el formulario (sin pisar lo que se edita). */
const syncRelayForm = (url?: string | null) => {
  const effective = typeof url === 'string' ? url : (relayUrl.value || status.value?.relay?.url || '')
  if (!effective) {
    relayMode.value = 'off'
    relayInput.value = ''
  } else if (effective === DEFAULT_PUBLIC_RELAY_URL) {
    relayMode.value = 'public'
    relayInput.value = ''
  } else {
    relayMode.value = 'custom'
    relayInput.value = effective
  }
  relayFormError.value = ''
}

watch(() => status.value?.relay?.url, (url) => {
  try {
    const focused = typeof document !== 'undefined' ? document.activeElement : null
    if (focused && typeof (focused as Element).getAttribute === 'function' &&
      (focused as Element).getAttribute('data-cy') === 'remote-relay-url') return
  } catch { /* sin DOM: sincronizar igualmente */ }
  syncRelayForm(url ?? undefined)
})

const onSaveRelay = async () => {
  relayFormError.value = ''
  try {
    if (relayMode.value === 'public') {
      await setRelayUrl(null)
    } else if (relayMode.value === 'off') {
      await setRelayUrl('off')
    } else {
      const candidate = relayInput.value.trim()
      if (!isValidRelayUrlInput(candidate)) {
        relayFormError.value = t('bd.remoteRelayInvalid')
        return
      }
      await setRelayUrl(candidate)
    }
    syncRelayForm()
  } catch (e) {
    relayFormError.value = e instanceof Error ? e.message : String(e)
  }
}

const onResetRelay = async () => {
  relayFormError.value = ''
  try {
    await setRelayUrl(null)
    syncRelayForm()
  } catch (e) {
    relayFormError.value = e instanceof Error ? e.message : String(e)
  }
}

const approvalDialog = ref<HTMLDialogElement | null>(null)
const seenApprovalRequests = new Set<string>()
const approvalQueue = ref<string[]>([])
const activeApprovalId = ref('')
// Transporte real por sesión (prefijo → 'p2p' | 'relay'). Por defecto relay:
// todo el tráfico pasa por él hasta que el DataChannel P2P avisa.
const sessionTransports = ref<Record<string, 'p2p' | 'relay'>>({})
const transportOf = (prefix: string): 'p2p' | 'relay' => sessionTransports.value[prefix] ?? 'relay'
const transportLabel = (tr: 'p2p' | 'relay'): string =>
  tr === 'p2p' ? t('bd.remoteUiTransportP2p') : t('bd.remoteUiTransportRelay')
const activeApproval = computed<UiPendingItem | null>(() =>
  uiPending.value.find((item) => item.reqId === activeApprovalId.value) ?? null
)
// Tras aprobar, el diálogo no se cierra: muestra la vista de éxito con el
// transporte real en vivo (P2P cuando llega `remote.rtc-connected`, Relay si
// pasan ~15 s sin P2P). El transporte no se conoce antes de aprobar porque
// la negociación P2P la inicia el navegador ya en su sesión.
const approvedSession = ref<{ prefix: string; ua: string } | null>(null)
const approvedAt = ref(0)
/** Nombre propuesto para el dispositivo recién aceptado (editable). */
const deviceNameInput = ref('')
let approvingReqId = ''
const APPROVED_RELAY_AFTER_MS = 15000
const approvedTransport = computed<'connecting' | 'p2p' | 'relay'>(() => {
  const a = approvedSession.value
  if (!a) return 'relay'
  if (sessionTransports.value[a.prefix] === 'p2p') return 'p2p'
  if (now.value - approvedAt.value > APPROVED_RELAY_AFTER_MS) return 'relay'
  return 'connecting'
})
const approvedTransportLabel = computed(() =>
  approvedTransport.value === 'connecting' ? t('bd.remoteUiApprovedConnecting') : transportLabel(approvedTransport.value)
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
    // Nueva solicitud: fuera la vista de éxito anterior.
    approvedSession.value = null
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    }
  } else if (dialog.open && !approvedSession.value && !approvingReqId) {
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

const onAllow = async (reqId: string): Promise<string | undefined> => {
  tokenCopied.value = false
  try {
    const token = await allowPending(reqId)
    // El URL aprobado es de un solo uso. Sustituirlo de inmediato para que
    // el siguiente móvil tenga un enlace vigente en el QR visible.
    await requestUiCode()
    return typeof token === 'string' ? token : undefined
  } catch (e) {
    if (!uiError.value) uiError.value = e instanceof Error ? e.message : String(e)
    return undefined
  }
}

const onDeny = async (reqId: string) => {
  try {
    await denyPending(reqId)
    // El QR denegado ya no vale: regenerar para no dejar un QR muerto.
    try {
      await requestUiCode()
    } catch {
      /* el error queda en uiError */
    }
  } catch {
    /* noop */
  }
}

const dismissApproval = () => {
  const requestId = activeApprovalId.value
  if (requestId) approvalQueue.value = approvalQueue.value.filter((id) => id !== requestId)
  activeApprovalId.value = ''
  approvedSession.value = null
  approvingReqId = ''
  deviceNameInput.value = ''
  const dialog = approvalDialog.value
  if (dialog && dialog.open) {
    try {
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
    } catch { /* noop */ }
  }
}

// Nombre del dispositivo recién aceptado: el dueño lo confirma con
// Guardar (antes Cerrar). Se envía a la sesión (el móvil lo adopta al
// arrancar) y se aplica de inmediato si el dispositivo ya conectó.
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
  dismissApproval()
}

const resolveApproval = async (allow: boolean) => {
  const requestId = activeApprovalId.value
  if (!requestId) return
  if (!allow) {
    dismissApproval()
    await nextTick()
    await onDeny(requestId)
    activateNextApproval()
    return
  }
  // Aprobar sin cerrar: el diálogo pasa a la vista de éxito con el transporte
  // real en vivo (el P2P se negocia después, desde la sesión del navegador).
  approvingReqId = requestId
  const ua = activeApproval.value?.ua ?? ''
  activeApprovalId.value = ''
  const token = await onAllow(requestId)
  approvingReqId = ''
  if (typeof token === 'string' && token) {
    approvedSession.value = { prefix: token.slice(0, 8), ua }
    approvedAt.value = Date.now()
    // Sugerencia con modelo + navegador que vio el relay ("iPad Safari").
    try { deviceNameInput.value = deviceDefaultName(ua || '') } catch { deviceNameInput.value = '' }
    startQrTick()
  } else {
    dismissApproval()
  }
  approvalQueue.value = approvalQueue.value.filter((id) => id !== requestId)
  activateNextApproval()
}

const onApprovalAllow = () => resolveApproval(true)
const onApprovalDeny = () => resolveApproval(false)

const onRevokeSession = async (prefix: string) => {
  try {
    await revokeSession(prefix)
    await loadBrowsers()
  } catch {
    /* noop */
  }
}

// Renombrar dispositivo desde la fila de sesión (usa el mismo endpoint
// que el nombrado al aprobar: renombra el dispositivo vinculado y guarda
// el nombre en la sesión).
const renamingPrefix = ref<string | null>(null)
const renamingName = ref('')
const startRenameSession = (s: { tokenPrefix: string; deviceName?: string | null; ua: string }) => {
  renamingPrefix.value = s.tokenPrefix
  try {
    renamingName.value = s.deviceName ?? deviceDefaultName(s.ua || '') ?? ''
  } catch {
    renamingName.value = s.deviceName ?? ''
  }
}
const cancelRenameSession = () => {
  renamingPrefix.value = null
  renamingName.value = ''
}
const onRenameSession = async (prefix: string) => {
  const name = renamingName.value.trim()
  if (!name) return
  try {
    await setSessionDeviceName(prefix, name)
  } catch {
    /* el error queda en uiError */
  }
  cancelRenameSession()
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

// --- Navegadores conocidos (gestión local: olvidar revoca y borra) ---
const devStore = useDevices(apiBase)
const ownDeviceId = getOrCreateDeviceId()
const knownBrowsers = computed<LogicalDevice[]>(() =>
  (Array.isArray(devStore.devices.value) ? devStore.devices.value : []).filter((d) => d.kind !== 'deck')
)
const browserKindLabel = (d: LogicalDevice) =>
  d.kind === 'phone' ? t('bd.deviceKindPhone')
  : d.kind === 'tablet' ? t('bd.deviceKindTablet')
  : t('bd.deviceKindBrowser')
const loadBrowsers = async () => {
  try {
    await devStore.loadDevices()
  } catch { /* sin daemon */ }
}
const onForgetBrowser = async (id: string) => {
  try {
    await devStore.deleteDevice(id)
    await loadBrowsers()
  } catch { /* noop */ }
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
    await loadBrowsers()
  } catch { /* noop */ }
}

const onCopyLanLink = async () => {
  if (!lanLink.value) return
  lanLinkCopied.value = await copyText(lanLink.value)
  if (lanLinkCopied.value) window.setTimeout(() => { lanLinkCopied.value = false }, 2000)
}

onMounted(() => {
  mobileLike.value = isMobileLike()
  refresh().catch(() => {}).finally(() => { syncRelayForm() })
  loadLanSessions().catch(() => {})
  loadBrowsers().catch(() => {})
  connectWs()
  // En vivo: poll 5s + WS topic `remote` (si el composable lo soporta).
  startUiPoll()
  try {
    if (typeof onRemoteEvent === 'function') {
      uiUnsub = onRemoteEvent((msg) => {
        if (!uiEnabled.value || uiUnsupported.value) return
        const type = typeof msg?.type === 'string' ? msg.type : ''
        const payload = (msg as { payload?: { tokenPrefix?: unknown } })?.payload
        const prefix = typeof payload?.tokenPrefix === 'string' ? payload.tokenPrefix : ''
        if (type === 'rtc-connected' || type === 'remote.rtc-connected') {
          if (prefix) sessionTransports.value = { ...sessionTransports.value, [prefix]: 'p2p' }
          loadUiSessions().catch(() => {})
          return
        }
        if (type === 'rtc-closed' || type === 'remote.rtc-closed') {
          if (prefix) sessionTransports.value = { ...sessionTransports.value, [prefix]: 'relay' }
          loadUiSessions().catch(() => {})
          return
        }
        if (type.startsWith('remote.')) {
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
