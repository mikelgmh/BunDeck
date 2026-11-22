<template>
  <dialog ref="dialog" class="bd-dlg bd-flex" :aria-label="t('bd.qrTitle')" style="width: min(420px, 94vw); height: auto">
    <div class="bd-dh">
      <h2>{{ t('bd.qrTitle') }}</h2>
      <span class="bd-sp"></span>
      <button class="bd-ibtn" :aria-label="t('bd.close')" @click="close">
        <X :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <div class="bd-pb">
      <div class="bd-qrbox" role="img" :aria-label="t('bd.qrTitle')">
        <QrcodeVue v-if="!loading" :value="networkUrl" :size="280" level="M" render-as="svg" :margin="2" />
        <p v-else class="bd-hint">Cargando…</p>
      </div>
      <p class="bd-hint" style="text-align: center">{{ t('bd.qrHint') }}</p>
      <div class="bd-r2">
        <label class="bd-sr" for="bd-qu">{{ t('bd.address') }}</label>
        <input type="text" id="bd-qu" class="bd-inp" readonly :value="networkUrl" @focus="($event.target as HTMLInputElement).select()" />
        <button class="bd-btn" @click="copy">{{ t('bd.copy') }}</button>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { X } from 'lucide-vue-next'
import QrcodeVue from 'qrcode.vue'
import { useI18nStore } from '../../composables/useI18n'
import { getTunnelToken, tunnelApiBase } from '../../composables/useTunnel'

const { t } = useI18nStore()

interface Emits {
  (e: 'notify', message: string): void
}

const emit = defineEmits<Emits>()

const dialog = ref<HTMLDialogElement | null>(null)
const networkUrl = ref('')
const loading = ref(true)

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
  loading.value = true
  try {
    const localIP = await getLocalIP()
    networkUrl.value = `${window.location.protocol}//${localIP}:${window.location.port}`
  } catch {
    networkUrl.value = window.location.origin
  } finally {
    loading.value = false
  }
}
const close = () => dialog.value?.close()

const copy = async () => {
  try {
    await navigator.clipboard.writeText(networkUrl.value)
    emit('notify', t('bd.copied'))
  } catch { /* noop */ }
}

defineExpose({ show, close })
</script>
