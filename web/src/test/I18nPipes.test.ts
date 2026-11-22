import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import es from '../i18n/locales/es.json'
import en from '../i18n/locales/en.json'

/**
 * vue-i18n interpreta `|` como separador de plurales y `{{ }}` como
 * placeholder anidado: un mensaje con `||` o `{{variable}}` revienta al
 * compilar ("Plural must have messages" / "Not allowed nest placeholder") y
 * deja el render del componente congelado. Pasó con `bd.helpOps`,
 * `bd.looksHint` y `bd.helpBuiltins` (pestañas Reglas/Aspecto muertas solo
 * en navegador real; los tests mockean t()) y con `bd.keyCodePlaceholder`
 * y `bd.aboutReview`.
 *
 * Este test compila TODOS los mensajes con el compilador real: si alguien
 * añade otro `|`, `{{ }}` o `@malformado`, falla aquí y no en producción.
 */
function collectKeys(node: unknown, prefix = '', out: string[] = []): string[] {
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (typeof v === 'string') out.push(key)
      else collectKeys(v, key, out)
    }
  }
  return out
}

const i18n = createI18n({
  legacy: false,
  locale: 'es',
  fallbackLocale: 'en',
  messages: { en, es },
})

describe('i18n: todos los mensajes compilan sin errores', () => {
  it.each([
    ['es', es],
    ['en', en],
  ])('compila cada mensaje de %s con el compilador real', (lang, messages) => {
    i18n.global.locale.value = lang as 'es' | 'en'
    const failures: string[] = []
    for (const key of collectKeys(messages)) {
      try {
        // Sin parámetros: los `{nombre}` sueltos avisan pero no lanzan;
        // los `|`, `{{ }}` y `@` problemáticos lanzan al compilar.
        i18n.global.t(key)
      } catch (e) {
        failures.push(`${key}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
      }
    }
    expect(failures).toEqual([])
  })
})
