<template>
  <div class="bd-srow" data-setting="reset">
    <div><b>{{ t('bd.resetSettings') }}</b><p>{{ t('bd.resetSettingsHint') }}</p></div>
    <div class="bd-ctl">
      <button
        class="bd-btn bd-dng"
        data-cy="bd-reset-open"
        :disabled="stage === 'busy'"
        @click="stage = 'confirm'"
      >
        {{ t('bd.resetBtn') }}
      </button>
    </div>
  </div>
  <div
    v-if="stage !== 'idle'"
    class="bd-reset-confirm"
    data-cy="bd-reset-confirm-box"
    role="alertdialog"
    :aria-label="t('bd.resetConfirmTitle')"
  >
    <p>
      <b>{{ t('bd.resetConfirmTitle') }}</b>
    </p>
    <p class="bd-cap">{{ t('bd.resetConfirmBody') }}</p>
    <label v-if="stage === 'confirm' || stage === 'error'" class="bd-reset-ack">
      <input type="checkbox" v-model="ack" data-cy="bd-reset-ack" />
      <span>{{ t('bd.resetAck') }}</span>
    </label>
    <p v-if="stage === 'error'" class="bd-err" data-cy="bd-reset-error" aria-live="assertive">
      {{ t('bd.resetFailed', { msg: errorMsg }) }}
    </p>
    <div class="bd-reset-actions">
      <button
        class="bd-btn"
        data-cy="bd-reset-download"
        :disabled="stage === 'busy' || downloading"
        :aria-busy="downloading"
        @click="downloadCopy"
      >
        <Download :size="16" stroke-width="1.75" aria-hidden="true" />
        {{ downloading ? t('bd.backupExporting') : t('bd.resetDownloadBackup') }}
      </button>
      <button
        v-if="stage === 'confirm' || stage === 'error'"
        class="bd-btn bd-dng"
        data-cy="bd-reset-confirm"
        :disabled="!ack || isBusy"
        :aria-busy="isBusy"
        @click="confirmReset"
      >
        {{ isBusy ? t('bd.resetBusy') : t('bd.resetConfirmBtn') }}
      </button>
      <button
        class="bd-btn"
        data-cy="bd-reset-cancel"
        :disabled="stage === 'busy'"
        @click="cancel"
      >
        {{ t('bd.resetCancel') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Download } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'
import {
  clearFactoryResetLocalStorage,
  downloadFullBackup,
  requestFactoryReset,
} from '../../composables/useFactoryReset'

const { t } = useI18nStore()

const props = defineProps<{ apiBase: string }>()
const emit = defineEmits<{
  (e: 'notify', message: string): void
  (e: 'reset-done'): void
}>()

type Stage = 'idle' | 'confirm' | 'busy' | 'error'
const stage = ref<Stage>('idle')
const isBusy = computed(() => stage.value === 'busy')
const ack = ref(false)
const errorMsg = ref('')
const downloading = ref(false)

const cancel = () => {
  if (stage.value === 'busy') return
  stage.value = 'idle'
  ack.value = false
  errorMsg.value = ''
}

const downloadCopy = async () => {
  if (downloading.value) return
  downloading.value = true
  try {
    await downloadFullBackup(props.apiBase)
    emit('notify', t('bd.backupExported'))
  } catch (error) {
    emit('notify', `${t('bd.backupExportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    downloading.value = false
  }
}

const confirmReset = async () => {
  if (!ack.value || stage.value === 'busy') return
  stage.value = 'busy'
  errorMsg.value = ''
  try {
    await requestFactoryReset(props.apiBase)
    clearFactoryResetLocalStorage()
    emit('notify', t('bd.resetDone'))
    emit('reset-done')
    stage.value = 'idle'
    ack.value = false
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : String(error)
    stage.value = 'error'
  }
}

defineExpose({ stage })
</script>
