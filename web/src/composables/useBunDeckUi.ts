import { ref, computed } from 'vue'

export type BdPalette = 'auto' | 'grafito' | 'papel' | 'medianoche' | 'bosque' | 'arena'
export type BdLabelMode = 'a' | 'h' | 'n'

interface BdToast {
  id: number
  message: string
  undo?: () => void
}

const LS_KEY = 'bundeck:ui'

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
/** Tiempo de hold para la pulsación larga (ms). Antes 600 fijo en StageBoard. */
export const bdLongPressMs = ref<number>(
  Number.isFinite(+prefs.longPressMs) ? Math.min(1200, Math.max(200, Math.round(+prefs.longPressMs))) : 500,
)
// En pantallas estrechas (<1360px) la biblioteca arranca plegada para que el grid respire.
export const bdShowLeft = ref<boolean>(prefs.showLeft ?? wideEnough)
export const bdShowRight = ref<boolean>(prefs.showRight ?? true)

const prefersLight =
  typeof window !== 'undefined' && typeof matchMedia !== 'undefined'
    ? matchMedia('(prefers-color-scheme: light)')
    : null
const systemLight = ref(prefersLight?.matches ?? false)
prefersLight?.addEventListener('change', (e) => {
  systemLight.value = e.matches
})

/** Paleta resuelta: 'auto' → papel/grafito según el sistema */
export const bdResolvedPalette = computed(() =>
  bdPalette.value === 'auto' ? (systemLight.value ? 'papel' : 'grafito') : bdPalette.value
)

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
        longPressMs: bdLongPressMs.value,
        showLeft: bdShowLeft.value,
        showRight: bdShowRight.value
      })
    )
  } catch {
    /* noop */
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
export function bdSetLongPressMs(v: number) {
  bdLongPressMs.value = Math.min(1200, Math.max(200, Math.round(+v || 500)))
  persist()
}
export function bdSetPanels(l: boolean, r: boolean) {
  bdShowLeft.value = l
  bdShowRight.value = r
  persist()
}

// Toast con Deshacer opcional
const toastId = ref(0)
export const bdToast = ref<BdToast | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

export function bdShowToast(message: string, undo?: () => void, ms = 6000) {
  if (toastTimer) clearTimeout(toastTimer)
  bdToast.value = { id: ++toastId.value, message, undo }
  toastTimer = setTimeout(() => {
    bdToast.value = null
  }, ms)
}

export function bdHideToast() {
  if (toastTimer) clearTimeout(toastTimer)
  bdToast.value = null
}
