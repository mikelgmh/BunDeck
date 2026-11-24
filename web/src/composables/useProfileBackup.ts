/**
 * Exportar / importar perfiles como backups portables.
 *
 * El daemon ya expone:
 * - GET  /api/v1/backups/profiles/:id/export → BackupObject (perfil+páginas+botones+assets)
 * - POST /api/v1/backups/validate { backup } → { valid, errors, ... }
 * - POST /api/v1/backups/restore { backup, sections, mode } → importa
 *
 * La importación siempre se hace como COPIA con ids nuevos para no
 * sobrescribir el perfil existente en modo `merge` (ver backup.ts:
 * restoreBackup actualiza por id si ya existe).
 */

export interface ProfileBackupObject {
  format: string
  version: number
  appVersion?: string
  createdAt?: number
  data: {
    profiles: Array<{ id: string; name: string; data?: unknown }>
    pages?: Array<{ id: string; profile_id: string; name: string; [k: string]: unknown }>
    buttons?: Array<{ id: string; page_id: string; position: number; [k: string]: unknown }>
    assets?: Array<unknown>
    [k: string]: unknown
  }
}

export const PROFILE_BACKUP_FORMAT = 'libredeck-backup'

export function safeProfileFilename(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'perfil'
  )
}

export function newBackupId(): string {
  try {
    const c = (globalThis as any)?.crypto
    if (c?.randomUUID) return c.randomUUID()
  } catch {
    /* fallback abajo */
  }
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** Validación ligera en cliente (el daemon revalida de verdad en /validate). */
export function isProfileBackup(obj: any): obj is ProfileBackupObject {
  if (!obj || typeof obj !== 'object') return false
  if (obj.format !== PROFILE_BACKUP_FORMAT) return false
  if (typeof obj.version !== 'number') return false
  const data = (obj as any).data
  if (!data || typeof data !== 'object') return false
  if (!Array.isArray(data.profiles) || data.profiles.length < 1) return false
  return data.profiles.every((p: any) => p && typeof p.id === 'string' && typeof p.name === 'string')
}

function remapPageRefsDeep(node: unknown, pageIdMap: Map<string, string>): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const v of node) remapPageRefsDeep(v, pageIdMap)
    return
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'pageId' && typeof v === 'string' && pageIdMap.has(v)) {
      ;(node as Record<string, unknown>)[k] = pageIdMap.get(v)
    } else if (v && typeof v === 'object') {
      remapPageRefsDeep(v, pageIdMap)
    }
  }
}

/**
 * Clona un backup de perfil asignando ids nuevos a perfil/páginas/botones
 * y reescribiendo `profile_id`, `page_id` y referencias internas `pageId`
 * (acciones de carpeta, reglas, pressActions…).
 * Si se pasa `newName`, renombra el (primer) perfil.
 */
export function cloneBackupAsCopy(backup: ProfileBackupObject, opts?: { newName?: string }): ProfileBackupObject {
  const clone = JSON.parse(JSON.stringify(backup)) as ProfileBackupObject
  const data = clone.data
  const profiles = data.profiles ?? []
  const pages = (data.pages ?? []) as Array<{ id: string; profile_id: string; name: string; [k: string]: unknown }>
  const buttons = (data.buttons ?? []) as Array<{ id: string; page_id: string; [k: string]: unknown }>

  const profileIdMap = new Map<string, string>()
  for (const p of profiles) {
    const next = newBackupId()
    profileIdMap.set(p.id, next)
    p.id = next
  }
  if (opts?.newName && profiles[0]) profiles[0].name = opts.newName

  const pageIdMap = new Map<string, string>()
  for (const pg of pages) {
    const next = newBackupId()
    pageIdMap.set(pg.id, next)
    pg.id = next
    const mapped = profileIdMap.get(String(pg.profile_id))
    if (mapped) pg.profile_id = mapped
  }
  for (const b of buttons) {
    b.id = newBackupId()
    const mapped = pageIdMap.get(String(b.page_id))
    if (mapped) b.page_id = mapped
    remapPageRefsDeep((b as any).data, pageIdMap)
  }
  return clone
}

export async function fetchProfileBackup(apiBase: string, profileId: string): Promise<ProfileBackupObject> {
  const res = await fetch(`${apiBase}/backups/profiles/${encodeURIComponent(profileId)}/export`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `HTTP ${res.status}`)
  }
  const obj = await res.json()
  if (!isProfileBackup(obj)) throw new Error('invalid-backup')
  return obj
}

export function triggerJsonDownload(obj: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 1000)
}

export async function validateProfileBackup(
  apiBase: string,
  backup: unknown
): Promise<{ valid: boolean; errors?: string[]; [k: string]: unknown }> {
  const res = await fetch(`${apiBase}/backups/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup }),
  })
  const body = await res.json().catch(() => ({}))
  return { valid: res.ok && body?.valid !== false, ...body }
}

export async function restoreProfileBackup(
  apiBase: string,
  backup: ProfileBackupObject
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase}/backups/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      backup,
      sections: ['profiles', 'pages', 'buttons', 'assets'],
      mode: 'merge',
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = Array.isArray(body?.errors) ? body.errors.join('; ') : body?.error
    throw new Error(msg || `HTTP ${res.status}`)
  }
  return body
}
