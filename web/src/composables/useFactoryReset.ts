/**
 * useFactoryReset — restablecimiento total a valores de fábrica.
 *
 * El botón vive en la sección Avanzado de SettingsDialog (vía
 * FactoryResetSection.vue). El daemon borra TODO (perfiles, páginas,
 * botones, variables, ajustes, sesiones…) y restaura la semilla por
 * defecto; aquí solo se limpia el estado local del navegador.
 */
import { LAN_SESSION_KEY } from '../utils/lanInvite'

/** Claves de localStorage que pertenecen a este navegador y deben limpiarse. */
export const FACTORY_RESET_STORAGE_KEYS = [
  'bundeck:ui',
  'bundeck:settings-mock',
  'bundeck:vars',
  'libredeck:vars',
  'bundeck:deck-layouts-v1',
  'bundeck:deck-ui',
  LAN_SESSION_KEY,
]

/** Borra las claves locales del reseteo. Devuelve las eliminadas. */
export function clearFactoryResetLocalStorage(
  storage?: Pick<Storage, 'removeItem'> | null,
): string[] {
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
  const removed: string[] = []
  if (!s) return removed
  for (const k of FACTORY_RESET_STORAGE_KEYS) {
    try {
      s.removeItem(k)
      removed.push(k)
    } catch {
      /* almacenamiento no disponible: seguir */
    }
  }
  return removed
}

export interface FactoryResetSummary {
  success: boolean
  profileId?: string
  profiles?: number
  pages?: number
  buttons?: number
  plugins?: number
}

/** POST /api/v1/admin/reset con confirmación explícita. Lanza si falla. */
export async function requestFactoryReset(apiBase: string): Promise<FactoryResetSummary> {
  const res = await fetch(`${apiBase}/admin/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(body?.error || `HTTP ${res.status}`)
  }
  return body
}

/** Descarga la copia completa (GET /backups/export) antes de borrar. */
export async function downloadFullBackup(apiBase: string): Promise<void> {
  const res = await fetch(`${apiBase}/backups/export`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `HTTP ${res.status}`)
  }
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  const date = new Date().toISOString().slice(0, 10)
  link.download = `libredeck-backup-${date}.json`
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 1000)
}
