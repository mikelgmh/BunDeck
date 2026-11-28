import { ref, computed } from 'vue'
import { getTunnelToken, tunnelApiBase } from './useTunnel'
import { getStoredLanSession } from '../utils/lanInvite'
import { getOrCreateDeviceId } from '../utils/sessionRouting'

export type BdPalette = 'auto' | 'grafito' | 'papel' | 'medianoche' | 'bosque' | 'arena'
export type BdLabelMode = 'a' | 'h' | 'n'

interface BdToast {
  id: number
  message: string
  undo?: () => void
}

const LS_KEY = 'bundeck:ui'
/** Clave de ajustes en el daemon: fuente compartida host ↔ remotos. */
export const UI_APPEARANCE_KEY = 'ui.appearance'

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

// Estado singleton (una sola app)
const prefs = loadPrefs()
const wideEnough = typeof window !== 'undefined' && typeof window.innerWidth === 'number'
  ? window.innerWidth >= 1360
  : true
export const bdPalette = ref<BdPalette>(prefs.palette ?? 'auto')
export const bdLabelMode = ref<BdLabelMode>(prefs.labelMode ?? 'a')
export const bdKeySize = ref<number>(prefs.keySize ?? 76)
export const bdRadius = ref<number>(prefs.radius ?? 16)
export const bdBrightness = ref<number>(prefs.brightness ?? 80)
export const bdAnimations = ref<boolean>(prefs.animations ?? true)
/** Sonido de clic al pulsar (Web Audio, sin assets). Defecto: apagado. */
export const bdClickSound = ref<boolean>(prefs.clickSound ?? false)
/** Vibración al pulsar (navigator.vibrate, sobre todo móvil). Defecto: encendido. */
export const bdHaptic = ref<boolean>(prefs.haptic ?? true)
/** Tiempo de hold para la pulsación larga (ms). Antes 600 fijo en StageBoard. */
export const bdLongPressMs = ref<number>(
  Number.isFinite(+prefs.longPressMs) ? Math.min(1200, Math.max(200, Math.round(+prefs.longPressMs))) : 500,
)
// En pantallas estrechas (<1360px) la biblioteca arranca plegada para que el grid respire.
// OJO: los paneles son layout local de cada pantalla y NO se sincronizan.
export const bdShowLeft = ref<boolean>(prefs.showLeft ?? wideEnough)
export const bdShowRight = ref<boolean>(prefs.showRight ?? true)

const prefersLight =
  typeof window !== 'undefined' && typeof matchMedia !== 'undefined'
    ? matchMedia('(prefers-color-scheme: light)')
    : null
const systemLight = ref(prefersLight?.matches ?? false)
/**
 * `systemLight` del HOST (llega por el servidor). Cuando la paleta es `auto`,
 * los remotos resuelven con este valor en vez del suyo propio: si el `auto`
 * del host cayó en oscuro, el iPad se queda en oscuro aunque su sistema esté
 * en claro. El host siempre usa su propio matchMedia.
 */
const hostSystemLight = ref<boolean | null>(
  typeof prefs.hostSystemLight === 'boolean' ? prefs.hostSystemLight : null
)
/** Marca de la última apariencia aplicada/enviada (evita ecos y pisados). */
let lastSyncAt = Number.isFinite(+prefs.updatedAt) ? +prefs.updatedAt : 0
/** Mientras se aplica un cambio remoto no se re-emite al servidor. */
let applyingRemote = false

/** ¿Somos el host? localhost (o sin ventana = SSR/tests → se trata como host local). */
export function isHostClient(): boolean {
  try {
    if (typeof window === 'undefined') return true
    if (getTunnelToken()) return false
    const h = String(window.location?.hostname ?? '').toLowerCase()
    return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1'
  } catch {
    return true
  }
}

prefersLight?.addEventListener('change', (e) => {
  systemLight.value = e.matches
  // El host difunde también los cambios del SO: con `auto` el remoto debe
  // seguir al host sin que nadie toque los ajustes.
  if (isHostClient()) schedulePush()
})

/**
 * Paleta resuelta: 'auto' → papel/grafito según el sistema.
 * En remotos con `auto`, manda el sistema del HOST (si se conoce).
 */
export const bdResolvedPalette = computed(() => {
  if (bdPalette.value !== 'auto') return bdPalette.value
  const light = !isHostClient() && hostSystemLight.value !== null
    ? hostSystemLight.value
    : systemLight.value
  return light ? 'papel' : 'grafito'
})

function persist() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        palette: bdPalette.value,
        labelMode: bdLabelMode.value,
        keySize: bdKeySize.value,
        radius: bdRadius.value,
        brightness: bdBrightness.value,
        animations: bdAnimations.value,
        clickSound: bdClickSound.value,
        haptic: bdHaptic.value,
        longPressMs: bdLongPressMs.value,
        showLeft: bdShowLeft.value,
        showRight: bdShowRight.value,
        hostSystemLight: hostSystemLight.value,
        updatedAt: lastSyncAt
      })
    )
  } catch {
    /* noop */
  }
  schedulePush()
}

/** Foto sincronizable (sin paneles: layout local de cada pantalla). */
function snapshot(now: number) {
  return {
    palette: bdPalette.value,
    labelMode: bdLabelMode.value,
    keySize: bdKeySize.value,
    radius: bdRadius.value,
    brightness: bdBrightness.value,
    animations: bdAnimations.value,
    clickSound: bdClickSound.value,
    haptic: bdHaptic.value,
    longPressMs: bdLongPressMs.value,
    // El sistema que manda con `auto` es el del HOST. Los remotos nunca
    // pisan este campo con el suyo propio: lo preservan.
    systemLight: isHostClient() ? systemLight.value : hostSystemLight.value,
    updatedAt: now,
    updatedBy: getOrCreateDeviceId(),
  }
}

export type SharedAppearance = ReturnType<typeof snapshot>

let cachedApiPort: number | null = null

async function appearanceApiBase(): Promise<string> {
  if (typeof window !== 'undefined') {
    try {
      const token = getTunnelToken()
      if (token) return tunnelApiBase(token)
      const protocol = window.location.protocol
      const hostname = window.location.hostname
      if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return 'http://localhost:3001/api/v1'
      }
      if (cachedApiPort) return `${protocol}//${hostname}:${cachedApiPort}/api/v1`
      try {
        const res = await fetch(`${protocol}//${hostname}:3001/config`)
        if (res.ok) {
          const cfg = await res.json().catch(() => ({}))
          if (Number.isFinite(+cfg?.apiPort)) cachedApiPort = +cfg.apiPort
        }
      } catch {
        /* puerto por defecto */
      }
      return `${protocol}//${hostname}:${cachedApiPort ?? 3001}/api/v1`
    } catch {
      /* fallback local */
    }
  }
  return 'http://localhost:3001/api/v1'
}

function appearanceHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    if (!getTunnelToken()) {
      const sess = getStoredLanSession()
      if (sess) h['Authorization'] = `Bearer ${sess}`
    }
  } catch {
    /* sin sesión LAN */
  }
  return h
}

let pushTimer: ReturnType<typeof setTimeout> | null = null

/** Emite la apariencia al daemon (debounced, best-effort). */
function schedulePush() {
  if (applyingRemote) return
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    void pushAppearance()
  }, 400)
}

async function pushAppearance(): Promise<void> {
  if (applyingRemote) return
  try {
    const now = Date.now()
    // Solo el host refresca `systemLight` con su matchMedia; el remoto
    // preserva el que ya conoce para no pisar al host con su propio SO.
    if (isHostClient()) hostSystemLight.value = systemLight.value
    const body = snapshot(now)
    lastSyncAt = now
    persistLocal()
    const base = await appearanceApiBase()
    await fetch(`${base}/settings`, {
      method: 'POST',
      headers: appearanceHeaders(),
      body: JSON.stringify({ key: UI_APPEARANCE_KEY, value: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null)
  } catch {
    /* best-effort: el tema local sigue funcionando */
  }
}

function persistLocal() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        palette: bdPalette.value,
        labelMode: bdLabelMode.value,
        keySize: bdKeySize.value,
        radius: bdRadius.value,
        brightness: bdBrightness.value,
        animations: bdAnimations.value,
        clickSound: bdClickSound.value,
        haptic: bdHaptic.value,
        longPressMs: bdLongPressMs.value,
        showLeft: bdShowLeft.value,
        showRight: bdShowRight.value,
        hostSystemLight: hostSystemLight.value,
        updatedAt: lastSyncAt
      })
    )
  } catch {
    /* noop */
  }
}

function parseAppearance(raw: unknown): SharedAppearance | null {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!obj || typeof obj !== 'object') return null
    return obj as SharedAppearance
  } catch {
    return null
  }
}

const VALID_PALETTES: BdPalette[] = ['auto', 'grafito', 'papel', 'medianoche', 'bosque', 'arena']
const VALID_LABELS: BdLabelMode[] = ['a', 'h', 'n']
const num = (v: unknown, min: number, max: number, fb: number): number => {
  const n = + (v as number)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb
}

/**
 * Aplica una apariencia llegada del servidor (boot o broadcast WS).
 * Solo avanza (updatedAt mayor): nunca pisa un cambio local más reciente.
 */
export function applyRemoteAppearance(raw: unknown): boolean {
  const body = parseAppearance(raw)
  if (!body) return false
  const at = Number.isFinite(+body.updatedAt) ? +body.updatedAt : 0
  if (at <= lastSyncAt) return false
  applyingRemote = true
  try {
    if (VALID_PALETTES.includes(body.palette as BdPalette)) bdPalette.value = body.palette as BdPalette
    if (VALID_LABELS.includes(body.labelMode as BdLabelMode)) bdLabelMode.value = body.labelMode as BdLabelMode
    bdKeySize.value = num(body.keySize, 56, 128, bdKeySize.value)
    bdRadius.value = num(body.radius, 8, 32, bdRadius.value)
    bdBrightness.value = num(body.brightness, 0, 100, bdBrightness.value)
    if (typeof body.animations === 'boolean') bdAnimations.value = body.animations
    if (typeof body.clickSound === 'boolean') bdClickSound.value = body.clickSound
    if (typeof body.haptic === 'boolean') bdHaptic.value = body.haptic
    const lp = +(body.longPressMs as number)
    if (Number.isFinite(lp)) bdLongPressMs.value = Math.min(1200, Math.max(200, Math.round(lp)))
    if (typeof body.systemLight === 'boolean') hostSystemLight.value = body.systemLight
    lastSyncAt = at
    persistLocal()
    return true
  } finally {
    applyingRemote = false
  }
}

let syncStarted = false
let refreshInFlight: Promise<void> | null = null
let lastRefreshAt = 0
const RESYNC_MIN_INTERVAL_MS = 2000

/** Solo tests: reinicia el throttle/dedupe del re-sync de apariencia. */
export function __resetAppearanceResyncForTests(): void {
  refreshInFlight = null
  lastRefreshAt = 0
}

/**
 * Sincronización inicial con el daemon: si el servidor ya tiene apariencia
 * (la del host), se adopta; si no, se publica la local para sembrar.
 * Llamar una vez al arrancar la app (BunDeckApp onMounted).
 */
export async function initAppearanceSync(): Promise<void> {
  if (syncStarted) return
  syncStarted = true
  try {
    const base = await appearanceApiBase()
    const res = await fetch(`${base}/settings?key=${encodeURIComponent(UI_APPEARANCE_KEY)}`, {
      headers: appearanceHeaders(),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null)
    if (!res || !res.ok) return
    const data = await res.json().catch(() => null)
    lastRefreshAt = Date.now()
    const applied = applyRemoteAppearance(data?.value)
    if (!applied && (data?.value == null || data?.value === '')) {
      // Servidor virgen: sembrar con lo local (normalmente el host).
      if (isHostClient()) hostSystemLight.value = systemLight.value
      const now = Date.now()
      // No pisar un updatedAt local más nuevo con el arranque.
      if (now > lastSyncAt) {
        lastSyncAt = now
        persistLocal()
        const base2 = await appearanceApiBase()
        await fetch(`${base2}/settings`, {
          method: 'POST',
          headers: appearanceHeaders(),
          body: JSON.stringify({ key: UI_APPEARANCE_KEY, value: JSON.stringify(snapshot(now)) }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => null)
      }
    }
  } catch {
    /* sin daemon: tema local */
  }
}

/**
 * Relee el snapshot `ui.appearance` del daemon y lo aplica si es más nuevo.
 * Pensado para reconexión WS y vuelta de foco/visibilidad: los broadcasts
 * `settings.changed` perdidos durante el corte no se repiten, así que sin
 * este re-sync el tema se queda obsoleto hasta recargar la página.
 * Solo LEE (nunca emite): no puede formar bucles con schedulePush.
 */
export async function refreshAppearanceFromServer(): Promise<void> {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return
  const now = Date.now()
  if (now - lastRefreshAt < RESYNC_MIN_INTERVAL_MS) return
  if (refreshInFlight) {
    try {
      await refreshInFlight
    } catch {
      /* noop */
    }
    return
  }
  lastRefreshAt = now
  // Un push local encolado lleva la foto anterior al corte: tras reconectar
  // el servidor manda y ese push obsoleto debe descartarse para no pisar
  // el tema del host con un updatedAt más nuevo pero contenido viejo.
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  refreshInFlight = (async () => {
    try {
      const base = await appearanceApiBase()
      const res = await fetch(`${base}/settings?key=${encodeURIComponent(UI_APPEARANCE_KEY)}`, {
        headers: appearanceHeaders(),
        signal: AbortSignal.timeout(10000),
      }).catch(() => null)
      if (!res || !res.ok) return
      const data = await res.json().catch(() => null)
      applyRemoteAppearance(data?.value)
    } catch {
      /* best-effort: el tema local sigue funcionando */
    }
  })()
  try {
    await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

export function bdSetPalette(p: BdPalette) {
  bdPalette.value = p
  persist()
}
export function bdSetLabelMode(m: BdLabelMode) {
  bdLabelMode.value = m
  persist()
}
export function bdSetKeySize(v: number) {
  bdKeySize.value = v
  persist()
}
export function bdSetRadius(v: number) {
  bdRadius.value = v
  persist()
}
export function bdSetBrightness(v: number) {
  bdBrightness.value = v
  persist()
}
export function bdSetAnimations(v: boolean) {
  bdAnimations.value = v
  persist()
}
export function bdSetClickSound(v: boolean) {
  bdClickSound.value = v
  persist()
}
export function bdSetHaptic(v: boolean) {
  bdHaptic.value = v
  persist()
}
export function bdSetLongPressMs(v: number) {
  bdLongPressMs.value = Math.min(1200, Math.max(200, Math.round(+v || 500)))
  persist()
}
export function bdSetPanels(l: boolean, r: boolean) {
  bdShowLeft.value = l
  bdShowRight.value = r
  // Layout local de cada pantalla: NO se sincroniza ni debe empujar la
  // apariencia al servidor (ese push con foto vieja pisaba el tema del host
  // tras una reconexión). Solo persiste en localStorage.
  persistLocal()
}

// Toast con Deshacer opcional
const toastId = ref(0)
export const bdToast = ref<BdToast | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

export function bdShowToast(message: string, undo?: () => void, ms = 6000) {
  const text = String(message ?? '')
  // Polling actions can report the same failure repeatedly. Keep the original
  // deadline instead of resetting it on every identical notification.
  if (toastTimer !== null && bdToast.value?.message === text) {
    if (undo && !bdToast.value.undo) {
      bdToast.value = { ...bdToast.value, undo }
    }
    return
  }
  if (toastTimer !== null) clearTimeout(toastTimer)
  const id = ++toastId.value
  const duration = Number.isFinite(ms) ? Math.min(10_000, Math.max(1_000, ms)) : 6000
  bdToast.value = { id, message: text, undo }
  toastTimer = setTimeout(() => {
    // An already-queued timeout from a replaced toast must not clear the
    // handle (or hide the message) belonging to the newer toast.
    if (bdToast.value?.id === id) {
      bdToast.value = null
      toastTimer = null
    }
  }, duration)
}

export function bdHideToast() {
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = null
  bdToast.value = null
}
