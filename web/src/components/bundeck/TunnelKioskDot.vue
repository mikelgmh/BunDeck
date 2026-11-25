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

const props = withDefaults(defineProps<{ status: RtcStatus; wsOk?: boolean }>(), {
  wsOk: true,
})

const { t } = useI18nStore()

/** Piloto de conexión en kiosco: idle = Conectando (gris), signaling =
 *  Probando P2P (azul), connected = P2P directo (verde), fallback con WS
 *  vivo = Relay (ámbar), fallback con WS caído = Desconectado (rojo). */
const transport = computed(() => {
  if (props.status === 'connected') return 'p2p'
  if (props.status === 'fallback') return props.wsOk ? 'relay' : 'disconnected'
  return props.status === 'signaling' ? 'probing' : 'connecting'
})

const title = computed(() =>
  transport.value === 'p2p'
    ? t('bd.tunnelTransportP2p')
    : transport.value === 'relay'
      ? t('bd.tunnelTransportRelay')
      : transport.value === 'disconnected'
        ? t('bd.tunnelTransportDisconnected')
        : transport.value === 'connecting'
          ? t('bd.tunnelTransportConnecting')
          : t('bd.tunnelTransportProbing')
)
</script>
