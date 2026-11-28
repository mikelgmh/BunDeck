/**
 * Nombres/descripciones de acciones de plugin según el idioma efectivo.
 *
 * Cada acción puede traer `i18n: { es: { name, description }, en: ... }`
 * (ver daemon/src/plugins/plugin-i18n.ts). Cadena de fallback:
 * locale → en → valor actual (name/description planos).
 */
import { ref } from 'vue'
import { useI18nStore } from './useI18n'

/** Duplicado local de DEFAULT_LOCALE: no se importa de useI18n para
 *  no romper los mocks parciales de tests (solo mockean useI18nStore). */
const DEFAULT_PLUGIN_LOCALE = 'en'

export type PluginLocale = 'en' | 'es'

function pickLocale(adata: any, field: 'name' | 'description', locale: string): string | undefined {
  const dict = adata?.i18n
  if (dict && typeof dict === 'object') {
    const hit = dict[locale]?.[field]
    if (typeof hit === 'string' && hit) return hit
    const en = dict.en?.[field]
    if (typeof en === 'string' && en) return en
  }
  return undefined
}

export function localizeActionField(
  adata: any,
  field: 'name' | 'description',
  locale: string,
  fallback = ''
): string {
  return pickLocale(adata, field, locale) ?? (typeof adata?.[field] === 'string' ? adata[field] : fallback)
}

export function usePluginLocale() {
  // Tolerante con los mocks de tests (solo `t`): sin currentLocale se
  // usa el idioma por defecto sin reactividad.
  let currentLocale: { value: string };
  try {
    const store = useI18nStore() as unknown as { currentLocale?: { value: string } };
    currentLocale = store?.currentLocale ?? ref(DEFAULT_PLUGIN_LOCALE);
  } catch {
    currentLocale = ref(DEFAULT_PLUGIN_LOCALE);
  }

  const actionName = (adata: any, fallback = ''): string =>
    localizeActionField(adata, 'name', currentLocale.value, fallback)

  const actionDescription = (adata: any, fallback = ''): string =>
    localizeActionField(adata, 'description', currentLocale.value, fallback)

  return {
    currentLocale,
    actionName,
    actionDescription,
    localizeActionField,
  }
}
