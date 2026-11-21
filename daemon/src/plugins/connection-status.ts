/**
 * Estado de configuración de plugins (a prueba de futuro).
 *
 * Regla genérica: un plugin "requiere configuración" si su manifest
 * declara `settingsSchema.required` con al menos un campo. Un plugin
 * está "configurado" cuando todos esos campos tienen valor no vacío
 * en los ajustes guardados (`plugin.<id>.<campo>`).
 *
 * No hay lista hardcodeada de plugins: cualquier plugin futuro que
 * declare `required` entra automáticamente en el gating del drawer.
 * Si un plugin necesita lógica custom (p. ej. OAuth con validación
 * extra), puede añadir `manifest.requiresConfiguration` explícito o
 * implementar su propio chequeo; este módulo es el fallback genérico.
 */

export interface ConfiguredStatus {
  /** true si no requiere nada o si todo lo requerido tiene valor. */
  configured: boolean
  /** Campos required sin valor (vacío si configured). */
  missing: string[]
  /** true si el manifest declara required no vacío. */
  requiresConfiguration: boolean
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
}

/**
 * Extrae los campos required del settingsSchema de un manifest.
 * Soporta `settingsSchema` y legacy `ui.settingsSchema`.
 */
export function getRequiredSettings(manifest: any): string[] {
  const schema = manifest?.settingsSchema ?? manifest?.ui?.settingsSchema ?? null
  if (!schema || !Array.isArray(schema.required)) return []
  return schema.required.filter((k: unknown) => typeof k === 'string' && k.length > 0)
}

/**
 * Determina si un plugin está configurado dados su manifest y sus valores.
 * `values` es el mapa plano `Record<campo, string>` de getPluginSettings.
 */
export function getPluginConfiguredStatus(manifest: any, values: Record<string, any> | null | undefined): ConfiguredStatus {
  // Override explícito futuro: manifest.requiresConfiguration = false
  // desactiva el gating aunque haya required (p. ej. plugin con defaults válidos).
  if (manifest && typeof manifest.requiresConfiguration === 'boolean' && manifest.requiresConfiguration === false) {
    return { configured: true, missing: [], requiresConfiguration: false }
  }
  const required = getRequiredSettings(manifest)
  if (required.length === 0) {
    return { configured: true, missing: [], requiresConfiguration: false }
  }
  const vals = values ?? {}
  const missing = required.filter((k) => isEmptyValue(vals[k]))
  return { configured: missing.length === 0, missing, requiresConfiguration: true }
}
