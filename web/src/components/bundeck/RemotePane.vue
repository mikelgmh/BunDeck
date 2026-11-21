<template>
  <div data-cy="remote-pane">
    <!-- Estado -->
    <h2>{{ t('bd.secRemote') }}</h2>
    <p class="bd-sub">{{ t('bd.remoteSub') }}</p>
    <p class="bd-hint">{{ t('bd.remoteE2eNote') }}</p>

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
import { useRemote, toggleInList, isValidPairCode } from '../../composables/useRemote'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()
const { status, devices, pair, events, loading, error, refresh, genCode, acceptCode, revoke, savePolicy, rotate, connectWs, disconnectWs } = useRemote()

const accept = reactive({ code: '', deviceId: '', pubKey: '', name: '' })
const acceptError = ref('')
const drafts = reactive<Record<string, string[]>>({})

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
  refresh().catch(() => {})
  connectWs()
})

onUnmounted(() => {
  disconnectWs()
})
</script>
