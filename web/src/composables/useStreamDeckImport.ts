/**
 * Importar perfiles Stream Deck (Elgato) como perfiles nuevos de LibreDeck.
 *
 * El daemon expone:
 * - GET  /api/v1/streamdeck/detect → { profiles: [{ uuid, name, deviceType, source, path, updatedAt }] }
 * - POST /api/v1/streamdeck/validate { uuid } → plan (dry-run, sin escribir)
 * - POST /api/v1/streamdeck/import { uuid?, dryRun? } o multipart `file`
 *   (.streamDeckProfile) → importa creando «{Nombre} (importado)»
 */

export interface DetectedSDProfile {
  uuid: string
  name: string
  deviceType: string | number | null
  source: string
  path: string
  updatedAt: number | null
}

export interface SDImportCounts {
  native: number
  bridge: number
  placeholder: number
  buttons: number
}

export interface SDImportResult {
  dryRun: boolean
  profileId: string | null
  profileName: string | null
  name: string
  counts: SDImportCounts
  warnings: string[]
  profiles: Array<{ uuid: string; name: string; grid: { cols: number; rows: number; model: string } }>
}

export function isStreamDeckProfileFile(name: string): boolean {
  return /\.(streamdeckprofile|zip)$/i.test(name ?? '')
}

/** Resumen legible del plan para la UI (nativo / bridge / pendientes). */
export function summarizeImportPlan(result: Pick<SDImportResult, 'counts' | 'warnings'>): {
  total: number
  native: number
  bridge: number
  pending: number
  warnings: number
} {
  const c = result.counts ?? { native: 0, bridge: 0, placeholder: 0, buttons: 0 }
  return {
    total: c.buttons ?? 0,
    native: c.native ?? 0,
    bridge: c.bridge ?? 0,
    pending: c.placeholder ?? 0,
    warnings: result.warnings?.length ?? 0,
  }
}

export async function fetchDetectedProfiles(apiBase: string): Promise<DetectedSDProfile[]> {
  const res = await fetch(`${apiBase}/streamdeck/detect`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `HTTP ${res.status}`)
  }
  const body = await res.json()
  return Array.isArray(body?.profiles) ? body.profiles : []
}

export async function validateStreamDeckImport(apiBase: string, uuid: string): Promise<SDImportResult> {
  const res = await fetch(`${apiBase}/streamdeck/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return body as SDImportResult
}

export async function importDetectedProfiles(
  apiBase: string,
  uuids: string[],
  opts?: { dryRun?: boolean },
): Promise<SDImportResult[]> {
  const out: SDImportResult[] = []
  for (const uuid of uuids) {
    const res = await fetch(`${apiBase}/streamdeck/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid, dryRun: !!opts?.dryRun }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
    out.push(body as SDImportResult)
  }
  return out
}

export async function importStreamDeckFile(apiBase: string, file: File): Promise<SDImportResult> {
  if (!isStreamDeckProfileFile(file.name)) {
    throw new Error('invalid-file')
  }
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${apiBase}/streamdeck/import`, { method: 'POST', body: form })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return body as SDImportResult
}
