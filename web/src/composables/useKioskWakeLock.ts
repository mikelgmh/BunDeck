/**
 * useKioskWakeLock — mantener la pantalla encendida en modo kiosco.
 *
 * Dos vías, en este orden:
 *  1. Screen Wake Lock API (`navigator.wakeLock.request('screen')`):
 *     Android/Chrome/Edge e iPadOS Safari 16.4+. Requiere contexto seguro
 *     (HTTPS o localhost); por LAN con `http://192.168.x.x` la mayoría de
 *     navegadores NO la exponen y se pasa a la vía 2.
 *  2. Fallback de vídeo (estilo NoSleep.js) para iPads antiguos / HTTP local:
 *     un `<video>` diminuto en silencio en reproducción continua evita que
 *     iOS suspenda la página. En iOS el `play()` debe nacer de un gesto del
 *     usuario, por eso se reintenta en `pointerdown`/`touchend`.
 *
 * Solo actúa mientras `kiosk` es true; al salir se libera todo.
 */
import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'

export type KioskWakeStatus = 'off' | 'wake-lock' | 'video' | 'unsupported'

/** Vídeo silencioso mínimo (MP4 de NoSleep.js, MIT). Solo MP4: cubre el
 *  fallback de iOS sin cargar el WebM (mucho más pesado). */
export const NO_SLEEP_MP4 =
  'data:video/mp4;base64,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'

/** ¿Existe la Wake Lock API? Inyectable para tests. */
export function isWakeLockSupported(nav?: unknown): boolean {
  try {
    const n =
      nav ?? (typeof navigator !== 'undefined' ? (navigator as unknown) : undefined)
    if (!n || typeof n !== 'object') return false
    return (
      'wakeLock' in (n as object) &&
      typeof (n as { wakeLock?: { request?: unknown } }).wakeLock?.request === 'function'
    )
  } catch {
    return false
  }
}

const NO_SLEEP_VIDEO_ID = 'bd-nosleep-video'

/**
 * Localiza o crea el vídeo invisible del fallback. No lanza: devuelve null
 * sin DOM (SSR/tests sin document).
 */
export function ensureNoSleepVideo(doc?: Document): HTMLVideoElement | null {
  try {
    const d =
      doc ?? (typeof document !== 'undefined' ? document : undefined)
    if (!d) return null
    const found = d.getElementById(NO_SLEEP_VIDEO_ID) as HTMLVideoElement | null
    if (found) return found
    const video = d.createElement('video')
    video.id = NO_SLEEP_VIDEO_ID
    // Visible de 1px y casi transparente: en iOS 15 el truco solo funciona
    // con el vídeo "visible" y sin `muted` (el contenido ya es silencio).
    video.setAttribute('playsinline', '')
    video.setAttribute('aria-hidden', 'true')
    ;(video as HTMLVideoElement & { muted?: boolean }).muted = false
    video.style.cssText =
      'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:.01;pointer-events:none;z-index:0;'
    const src = d.createElement('source')
    src.src = NO_SLEEP_MP4
    src.type = 'video/mp4'
    video.appendChild(src)
    // Como NoSleep.js: con MP4 largo se rebobina en vez de `loop`
    // (iOS 15 ignora el flag `loop` para no dormir).
    video.addEventListener('loadedmetadata', () => {
      try {
        if (video.duration <= 1) {
          video.setAttribute('loop', '')
        } else {
          video.addEventListener('timeupdate', () => {
            try {
              if (video.currentTime > 0.5) video.currentTime = Math.random()
            } catch {
              /* noop */
            }
          })
        }
      } catch {
        /* noop */
      }
    })
    d.body.appendChild(video)
    return video
  } catch {
    return null
  }
}

/**
 * Mantiene la pantalla encendida mientras `kiosk` sea true.
 * Devuelve el estado (para el puntito del kiosco) y control manual.
 */
export function useKioskWakeLock(kiosk: Ref<boolean>) {
  const wakeStatus = ref<KioskWakeStatus>('off')
  let sentinel: { release?: () => Promise<void> | void } | null = null
  let video: HTMLVideoElement | null = null
  let ensuring = false
  let dead = false

  const onRelease = () => {
    sentinel = null
    if (dead) return
    // Si el SO la suelta (ahorro de batería, etc.) y seguimos en kiosco
    // visible, se reintenta una vez con retardo; si falla, cae al vídeo.
    if (wakeStatus.value !== 'off') wakeStatus.value = 'off'
    try {
      if (
        kiosk.value &&
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible'
      ) {
        window.setTimeout(() => {
          if (!dead && kiosk.value && !sentinel) void ensure()
        }, 1000)
      }
    } catch {
      /* noop */
    }
  }

  const requestWake = async (): Promise<boolean> => {
    if (!isWakeLockSupported()) return false
    try {
      const wl = await (navigator as unknown as { wakeLock: { request: (k: string) => Promise<{ release?: () => Promise<void> | void; addEventListener?: (t: string, fn: () => void) => void }> } }).wakeLock.request('screen')
      sentinel = wl
      try {
        wl.addEventListener?.('release', onRelease)
      } catch {
        /* navegadores sin EventTarget en el sentinel */
      }
      wakeStatus.value = 'wake-lock'
      return true
    } catch {
      sentinel = null
      return false
    }
  }

  const startFallback = async (): Promise<boolean> => {
    if (video && !video.paused && wakeStatus.value === 'video') return true
    video = ensureNoSleepVideo() ?? video
    if (!video) {
      wakeStatus.value = 'unsupported'
      return false
    }
    try {
      const p = video.play() as unknown as Promise<void> | undefined
      if (p && typeof (p as Promise<void>).then === 'function') await p
      wakeStatus.value = 'video'
      return true
    } catch {
      wakeStatus.value = 'unsupported'
      return false
    }
  }

  const stopFallback = () => {
    try {
      video?.pause()
    } catch {
      /* noop */
    }
  }

  /** Pide lo mejor disponible. Nunca lanza. */
  const ensure = async (): Promise<KioskWakeStatus> => {
    if (dead || ensuring) return wakeStatus.value
    if (!kiosk.value) return wakeStatus.value
    if (sentinel) return wakeStatus.value
    if (wakeStatus.value === 'video' && video && !video.paused) return wakeStatus.value
    try {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return wakeStatus.value
      }
    } catch {
      /* noop */
    }
    ensuring = true
    try {
      if (await requestWake()) return wakeStatus.value
      await startFallback()
      return wakeStatus.value
    } finally {
      ensuring = false
    }
  }

  const release = () => {
    const s = sentinel
    sentinel = null
    try {
      void s?.release?.()
    } catch {
      /* noop */
    }
    stopFallback()
    if (!dead) wakeStatus.value = 'off'
  }

  // Al entrar/salir de kiosco. `enterKiosk` además llama a `ensure`
  // directo para conservar el gesto del clic (iOS lo exige para el vídeo).
  watch(kiosk, (v) => {
    if (v) void ensure()
    else release()
  })

  const onVisible = () => {
    try {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void ensure()
      }
    } catch {
      /* noop */
    }
  }
  // Primer toque: habilita el fallback de vídeo (iOS bloquea play() sin gesto).
  const onGesture = () => {
    void ensure()
  }

  onMounted(() => {
    try {
      document.addEventListener('visibilitychange', onVisible)
      document.addEventListener('fullscreenchange', onVisible)
      document.addEventListener('pointerdown', onGesture)
      document.addEventListener('touchend', onGesture)
    } catch {
      /* sin document (SSR/tests): noop */
    }
    if (kiosk.value) void ensure()
  })

  onUnmounted(() => {
    dead = true
    try {
      document.removeEventListener('visibilitychange', onVisible)
      document.removeEventListener('fullscreenchange', onVisible)
      document.removeEventListener('pointerdown', onGesture)
      document.removeEventListener('touchend', onGesture)
    } catch {
      /* noop */
    }
    release()
  })

  return { wakeStatus, ensureKioskWake: ensure, releaseKioskWake: release }
}
