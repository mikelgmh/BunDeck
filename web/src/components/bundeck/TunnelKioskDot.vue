<template>
  <span
    class="bd-kiosk-rtc"
    data-cy="bd-kiosk-rtc"
    :data-transport="transport"
    :title="title"
    role="status"
    :aria-label="title"
    aria-hidden="false"
  ><i aria-hidden="true"></i></span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18nStore } from '../../composables/useI18n'
import type { RtcStatus } from '../../composables/useRemoteRtc'

const props = defineProps<{ status: RtcStatus }>()

const { t } = useI18nStore()

const transport = computed(() =>
  props.status === 'connected' ? 'p2p' : props.status === 'fallback' ? 'relay' : 'probing'
)

const title = computed(() =>
  transport.value === 'p2p'
    ? t('bd.tunnelTransportP2p')
    : transport.value === 'relay'
      ? t('bd.tunnelTransportRelay')
      : t('bd.tunnelTransportProbing')
)
</script>
