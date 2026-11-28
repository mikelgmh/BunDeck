// Fuente única de i18n: el singleton vive en useI18n.ts.
// Este módulo solo lo re-exporta para no mantener dos instancias.
import { getI18n } from '../composables/useI18n'

const i18n = getI18n()

export default i18n
