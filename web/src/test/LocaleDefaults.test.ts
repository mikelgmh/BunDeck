import { describe, it, expect } from 'vitest'
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  normalizeLocale,
  detectLocale,
} from '../composables/useI18n'
import { localizeActionField } from '../composables/usePluginLocale'

/**
 * i18n por defecto inglés + detección del idioma del PC.
 * Prioridad: guardado > detectado-soportado > inglés.
 */
describe('locale por defecto y detección', () => {
  it('inglés por defecto, soportados en+es, fallback en', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(FALLBACK_LOCALE).toBe('en')
    expect([...SUPPORTED_LOCALES]).toEqual(['en', 'es'])
  })

  it('normalizeLocale: parte antes de -, minúsculas, whitelist', () => {
    expect(normalizeLocale('es-ES')).toBe('es')
    expect(normalizeLocale('ES')).toBe('es')
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('EN')).toBe('en')
    expect(normalizeLocale('fr')).toBeNull()
    expect(normalizeLocale('de-DE')).toBeNull()
    expect(normalizeLocale('')).toBeNull()
    expect(normalizeLocale(null)).toBeNull()
    expect(normalizeLocale(undefined)).toBeNull()
  })

  it('detectLocale: primer idioma soportado de navigator.languages', () => {
    const nav = globalThis.navigator as any
    const origLanguages = nav.languages
    const origLanguage = nav.language
    try {
      Object.defineProperty(nav, 'languages', { value: ['fr-FR', 'es-ES'], configurable: true })
      expect(detectLocale()).toBe('es')
      Object.defineProperty(nav, 'languages', { value: ['de', 'fr'], configurable: true })
      Object.defineProperty(nav, 'language', { value: 'en-US', configurable: true })
      expect(detectLocale()).toBe('en')
    } finally {
      Object.defineProperty(nav, 'languages', { value: origLanguages, configurable: true })
      Object.defineProperty(nav, 'language', { value: origLanguage, configurable: true })
    }
  })

  it('localizeActionField: locale → en → valor actual', () => {
    const action = {
      name: 'Nombre ES',
      description: 'Desc ES',
      i18n: {
        es: { name: 'Nombre ES', description: 'Desc ES' },
        en: { name: 'EN name', description: 'EN desc' },
      },
    }
    expect(localizeActionField(action, 'name', 'es')).toBe('Nombre ES')
    expect(localizeActionField(action, 'name', 'en')).toBe('EN name')
    expect(localizeActionField(action, 'description', 'en')).toBe('EN desc')
    // Sin dict: valor actual.
    expect(localizeActionField({ name: 'Solo' } as any, 'name', 'en')).toBe('Solo')
    expect(localizeActionField(null, 'name', 'en', 'FB')).toBe('FB')
    // Sin entrada en locale: cae a en.
    expect(localizeActionField({ name: 'Base', i18n: { en: { name: 'EN' } } } as any, 'name', 'es')).toBe('EN')
  })
})
