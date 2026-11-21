<template>
  <div class="bd-scan" role="dialog" :aria-label="t('bd.remoteScan')">
    <video
      ref="videoEl"
      data-cy="remote-scan-video"
      class="bd-scan-video"
      autoplay
      playsinline
      muted
    />
    <p v-if="camError" class="bd-err" role="alert">{{ camError }}</p>
    <div class="bd-form">
      <label class="bd-sr" for="bd-scan-paste">{{ t('bd.remoteScanPastePh') }}</label>
      <textarea
        id="bd-scan-paste"
        v-model="paste"
        class="bd-inp"
        rows="3"
        spellcheck="false"
        :placeholder="t('bd.remoteScanPastePh')"
        data-cy="remote-scan-paste"
      />
      <div class="bd-scan-row">
        <button class="bd-btn" :disabled="!paste.trim()" data-cy="remote-scan-validate" @click="onValidatePaste">
          {{ t('bd.remoteScanValidate') }}
        </button>
        <button class="bd-btn" data-cy="remote-scan-cancel" @click="close">
          {{ t('bd.remoteScanCancel') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18nStore } from '../../composables/useI18n'

const emit = defineEmits<{
  (e: 'decoded', text: string): void
  (e: 'close'): void
}>()

const { t } = useI18nStore()

const videoEl = ref<HTMLVideoElement | null>(null)
const paste = ref('')
const camError = ref('')

let stream: MediaStream | null = null
let timer: number | null = null
let stopped = false
let jsqrMod: { default: (data: Uint8ClampedArray, w: number, h: number) => { data: string } | null } | null = null

const stopTracks = () => {
  try {
    stream?.getTracks().forEach((tr) => {
      try {
        tr.stop()
      } catch {
        /* noop */
      }
    })
  } catch {
    /* sin stream: nada que liberar */
  }
  stream = null
}

const stop = () => {
  stopped = true
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  stopTracks()
}

const close = () => {
  stop()
  emit('close')
}

const schedule = (fn: () => void, ms = 400) => {
  if (stopped) return
  timer = window.setTimeout(fn, ms)
}

/** Un solo intento de decodificación sobre el frame actual del vídeo. */
const tryDecodeFrame = async (detector: { detect: (v: unknown) => Promise<Array<{ rawValue?: string }>> } | null): Promise<boolean> => {
  const video = videoEl.value
  if (!video) return false
  if (detector) {
    try {
      const found = await detector.detect(video)
      const raw = found?.[0]?.rawValue
      if (raw) {
        emit('decoded', String(raw))
        return true
      }
    } catch {
      /* sigue intentando en el siguiente tick */
    }
    return false
  }
  // Fallback sin BarcodeDetector: jsqr sobre el frame (dynamic import, un chunk aparte).
  try {
    if (!jsqrMod) jsqrMod = await import('jsqr')
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return false
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings)
    if (!ctx) return false
    ctx.drawImage(video, 0, 0, w, h)
    const img = ctx.getImageData(0, 0, w, h)
    const out = jsqrMod.default(img.data, w, h)
    if (out?.data) {
      emit('decoded', String(out.data))
      return true
    }
  } catch {
    /* jsqr no disponible o frame ilegible: reintentar */
  }
  return false
}

const loop = async (detector: { detect: (v: unknown) => Promise<Array<{ rawValue?: string }>> } | null) => {
  if (stopped) return
  const done = await tryDecodeFrame(detector)
  if (done) {
    stop()
    return
  }
  schedule(() => loop(detector))
}

const start = async () => {
  stopped = false
  try {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!md?.getUserMedia) throw new Error('no-camera')
    stream = await md.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    const video = videoEl.value
    if (video && stream) {
      try {
        ;(video as HTMLVideoElement).srcObject = stream as MediaStream
      } catch {
        /* jsdom: srcObject puede no existir; el stream se libera igual al cerrar */
      }
      try {
        const p = video.play?.()
        if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {})
      } catch {
        /* autoplay bloqueado: el loop decodifica igual cuando haya frames */
      }
    }
  } catch {
    // Sin cámara o permiso denegado: mensaje claro + pegado manual (textarea siempre visible).
    camError.value = t('bd.remoteScanNoCam')
    return
  }
  // BarcodeDetector nativo solo si declara soporte de qr_code; si no, fallback jsqr.
  let detector: { detect: (v: unknown) => Promise<Array<{ rawValue?: string }>> } | null = null
  try {
    const BD = (window as unknown as Record<string, unknown>).BarcodeDetector as
      | (new (opts?: { formats?: string[] }) => { detect: (v: unknown) => Promise<Array<{ rawValue?: string }>> })
      | undefined
    if (typeof BD !== 'undefined') {
      const BDWithFormats = BD as unknown as { getSupportedFormats?: () => Promise<string[]> }
      if (typeof BDWithFormats.getSupportedFormats === 'function') {
        const formats = await BDWithFormats.getSupportedFormats()
        if (Array.isArray(formats) && !formats.includes('qr_code')) throw new Error('no-qr-format')
      }
      detector = new BD({ formats: ['qr_code'] })
    }
  } catch {
    detector = null
  }
  schedule(() => loop(detector))
}

const onValidatePaste = () => {
  const text = paste.value.trim()
  if (!text) return
  stop()
  emit('decoded', text)
}

onMounted(() => {
  start().catch(() => {
    camError.value = t('bd.remoteScanNoCam')
  })
})

onUnmounted(() => {
  stop()
})

defineExpose({ stop })
</script>

<style scoped>
.bd-scan-video {
  width: 100%;
  max-height: 260px;
  border-radius: 8px;
  background: #000;
  object-fit: cover;
}
.bd-scan-row {
  display: flex;
  gap: 8px;
}
</style>
