import { computed } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '../i18n/locales/en.json'
import es from '../i18n/locales/es.json'

/** Locales soportados por la web. Inglés por defecto y como fallback. */
export const SUPPORTED_LOCALES = ['en', 'es'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: SupportedLocale = 'en'
export const FALLBACK_LOCALE = 'en'

const STORAGE_KEY = 'locale'
const SETTING_KEY = 'ui.language'

/** Normaliza un tag BCP-47 («es-ES» → «es») si está soportado. */
export function normalizeLocale(raw: unknown): SupportedLocale | null {
  if (typeof raw !== 'string') return null
  const base = raw.split('-')[0]?.trim().toLowerCase()
  return (SUPPORTED_LOCALES as readonly string[]).includes(base)
    ? (base as SupportedLocale)
    : null
}

/** Idioma del PC: primer candidato de navigator.languages (o language). */
export function detectLocale(): SupportedLocale {
  if (typeof navigator !== 'undefined') {
    const langs = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language]
    for (const lang of langs) {
      const normalized = normalizeLocale(lang)
      if (normalized) return normalized
    }
  }
  return DEFAULT_LOCALE
}

/** Idioma guardado en este navegador (localStorage). */
export function savedLocale(): SupportedLocale | null {
  if (typeof window !== 'undefined') {
    try {
      return normalizeLocale(localStorage.getItem(STORAGE_KEY))
    } catch {
      return null
    }
  }
  return null
}

function applyHtmlLang(locale: string) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
}

// Singleton: una sola instancia de vue-i18n en toda la app.
let i18nInstance: ReturnType<typeof createI18n> | null = null

export function getI18n() {
  return getI18nInstance()
}

function getI18nInstance() {
  if (!i18nInstance) {
    // Prioridad inicial (síncrona, antes del primer render):
    // guardado > detectado-soportado > inglés.
    const initial = savedLocale() ?? detectLocale()
    i18nInstance = createI18n({
      legacy: false,
      locale: initial,
      fallbackLocale: FALLBACK_LOCALE,
      messages: {
        en,
        es
      }
    })
    applyHtmlLang(initial)
  }
  return i18nInstance
}

/** Persiste en el daemon (best-effort): POST /api/v1/settings { key: ui.language }. */
function persistLocaleToDaemon(locale: SupportedLocale, apiBase?: string) {
  if (typeof window === 'undefined' || !apiBase) return
  try {
    void fetch(`${apiBase}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: SETTING_KEY, value: locale })
    }).catch(() => {})
  } catch {
    /* sin daemon: el estado local sigue mandando */
  }
}

export function useI18nStore() {
  const i18n = getI18nInstance()
  const { t, locale, availableLocales } = i18n.global

  const currentLocale = computed(() => locale.value)
  const availableLanguages = computed(() => availableLocales)

  const setLocale = (newLocale: string, apiBase?: string) => {
    const normalized = normalizeLocale(newLocale)
    if (!normalized) return
    locale.value = normalized
    applyHtmlLang(normalized)
    // Guarda en localStorage Y en el daemon (para otros dispositivos).
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, normalized)
      } catch {
        /* almacenamiento no disponible */
      }
    }
    persistLocaleToDaemon(normalized, apiBase)
  }

  const loadSavedLocale = () => {
    // Síncrono, antes del primer render: guardado > detectado > inglés.
    const initial = savedLocale() ?? detectLocale()
    locale.value = initial
    applyHtmlLang(initial)
  }

  /** Completa la prioridad con el valor guardado en el daemon (async). */
  const syncLocaleFromDaemon = async (apiBase?: string) => {
    if (typeof window !== 'undefined' && savedLocale()) return
    if (!apiBase) return
    try {
      const res = await fetch(`${apiBase}/settings?key=${encodeURIComponent(SETTING_KEY)}`)
      if (!res.ok) return
      const normalized = normalizeLocale((await res.json())?.value)
      if (normalized) {
        locale.value = normalized
        applyHtmlLang(normalized)
        if (typeof window !== 'undefined') {
          try {
            localStorage.setItem(STORAGE_KEY, normalized)
          } catch {
            /* almacenamiento no disponible */
          }
        }
      }
    } catch {
      /* sin daemon: se mantiene el idioma detectado */
    }
  }

  return {
    t,
    currentLocale,
    availableLanguages,
    setLocale,
    loadSavedLocale,
    syncLocaleFromDaemon
  }
}
