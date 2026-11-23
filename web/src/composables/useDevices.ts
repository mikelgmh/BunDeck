/**
 * useDevices — Dispositivos lógicos y pantallas por perfil.
 *
 * - Tipos + regla pura checkPageCompatibility (espejo de daemon/src/devices.ts).
 * - Store: lista de dispositivos, asignaciones del perfil actual y estado
 *   del HW físico detectado (para el "detectar primero" del tamaño del deck).
 */
import { ref } from 'vue'

export type DeviceKind = 'deck' | 'phone' | 'tablet' | 'browser'
export type DevicePageLayout = 'classic' | 'gridstack'

/** Origen del dispositivo (la UI ya no crea dispositivos a mano). */
export type DeviceSource = 'hardware' | 'browser' | 'manual'

export interface LogicalDevice {
  id: string
  name: string
  kind: DeviceKind
  model: string | null
  cols: number | null
  rows: number | null
  hw_path: string | null
  created_at?: number
  updated_at?: number
  /** Tamaño efectivo resuelto por el daemon (GET individual). */
  effectiveSize?: { cols: number; rows: number } | null
  /** ¿Conectado ahora por WS? (lista unificada del daemon). */
  online?: boolean
  /** Origen: hardware detectado, navegador aceptado o fila heredada. */
  source?: DeviceSource
  lastSeen?: number | null
}

export interface DeckModel {
  id: string
  label: string
  cols: number
  rows: number
}

export const DECK_MODELS: DeckModel[] = [
  { id: 'mini', label: 'Stream Deck Mini', cols: 3, rows: 2 },
  { id: 'mk2', label: 'Stream Deck MK.2', cols: 5, rows: 3 },
  { id: 'neo', label: 'Stream Deck Neo', cols: 4, rows: 2 },
  { id: 'xl', label: 'Stream Deck XL', cols: 8, rows: 4 },
]

export const DEFAULT_DECK_MODEL = 'mk2'

export interface CompatView {
  id: string
  name: string
  is_folder: number
  parent_id?: string | null
  grid_cols?: number | null
  grid_rows?: number | null
  data: any
}

export interface CompatResult {
  ok: boolean
  why?: string
  short?: string
}

const DEFAULT_COLS = 5
const DEFAULT_ROWS = 3

function parseData(d: any): Record<string, any> {
  let cur: any = d
  // Tolera doble/triple codificación histórica (updatePage reenviaba el
  // TEXT ya serializado y cada guardado añadía una capa de JSON.stringify).
  for (let i = 0; i < 5 && typeof cur === 'string'; i++) {
    const t = cur.trim()
    if (!t) return {}
    try {
      cur = JSON.parse(t)
    } catch {
      return {}
    }
  }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return {}
  return cur
}

export function parseLayoutMode(pageData: any): DevicePageLayout {
  return parseData(pageData)?.layoutMode === 'gridstack' ? 'gridstack' : 'classic'
}

export function resolvePageSize(
  page: Pick<CompatView, 'grid_cols' | 'grid_rows'>,
  profileData?: any
): { cols: number; rows: number } {
  const pd = parseData(profileData)
  return {
    cols: page.grid_cols ?? pd.gridCols ?? DEFAULT_COLS,
    rows: page.grid_rows ?? pd.gridRows ?? DEFAULT_ROWS,
  }
}

export function resolveDeckSize(device: LogicalDevice): { cols: number; rows: number } | null {
  if (device.kind !== 'deck') return null
  if (Number.isFinite(device.cols as number) && Number.isFinite(device.rows as number)) {
    return { cols: Number(device.cols), rows: Number(device.rows) }
  }
  const model = DECK_MODELS.find((m) => m.id === device.model)
    ?? DECK_MODELS.find((m) => m.id === DEFAULT_DECK_MODEL)!
  return { cols: model.cols, rows: model.rows }
}

export function checkPageCompatibility(
  page: CompatView,
  device: LogicalDevice,
  profileData?: any,
  hwGrid?: { cols: number; rows: number } | null
): CompatResult {
  if (device.kind !== 'deck') return { ok: true }
  if (parseLayoutMode(page.data) !== 'classic') {
    return { ok: false, why: 'free-mode', short: 'free-mode' }
  }
  const view = resolvePageSize(page, profileData)
  const want = hwGrid ?? resolveDeckSize(device)
  if (want && (view.cols !== want.cols || view.rows !== want.rows)) {
    return { ok: false, why: 'size', short: `size ${view.cols}×${view.rows}` }
  }
  return { ok: true }
}

export function guessDeckModel(grid: { cols: number; rows: number } | null | undefined): string | null {
  if (!grid) return null
  return DECK_MODELS.find((m) => m.cols === grid.cols && m.rows === grid.rows)?.id ?? null
}

/** Primera página raíz (no carpeta, sin padre) compatible para un dispositivo. */
export function firstCompatibleRoot(
  pages: CompatView[],
  device: LogicalDevice,
  profileData?: any,
  hwGrid?: { cols: number; rows: number } | null
): CompatView | null {
  const roots = pages.filter((p) => p.is_folder === 0 && (p.parent_id ?? null) === null)
  return roots.find((p) => checkPageCompatibility(p, device, profileData, hwGrid).ok) ?? null
}

export interface HwStatus {
  connected: boolean
  grid: { cols: number; rows: number } | null
  modelGuess: string | null
}

export function useDevices(apiBase: () => string) {
  const devices = ref<LogicalDevice[]>([])
  const assignments = ref<Record<string, string>>({})
  const hwStatus = ref<HwStatus>({ connected: false, grid: null, modelGuess: null })
  const loading = ref(false)

  const req = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
    if (!res.ok) {
      // Conservar el cuerpo para propagar `details` (el PUT 422 devuelve
      // { error, details: [{ deviceId, pageId, reason }] } y el toast lo necesita).
      let detail = ''
      let body: any = null
      try {
        const txt = await res.text()
        try {
          body = JSON.parse(txt)
          detail = String(body?.error ?? txt)
        } catch {
          detail = txt
        }
      } catch { /* noop */ }
      const err: any = new Error(detail || `${path}: ${res.status}`)
      err.status = res.status
      if (body && Array.isArray((body as any)?.details)) {
        err.details = (body as any).details
      } else if (detail) {
        try {
          const d2 = JSON.parse(detail) as any
          if (Array.isArray(d2?.details)) err.details = d2.details
        } catch { /* noop */ }
      }
      throw err
    }
    return res.json().catch(() => ({}))
  }

  const loadDevices = async () => {
    devices.value = await req('/devices')
    return devices.value
  }

  const loadHwStatus = async () => {
    try {
      const st = await req('/devices/streamdeck/status')
      hwStatus.value = {
        connected: !!st.isConnected,
        grid: st.grid ?? null,
        modelGuess: st.modelGuess ?? null,
      }
    } catch {
      hwStatus.value = { connected: false, grid: null, modelGuess: null }
    }
    return hwStatus.value
  }

  const loadAssignments = async (profileId: string) => {
    const body = await req(`/profiles/${encodeURIComponent(profileId)}/assignments`)
    assignments.value = body.assignments ?? {}
    return { assignments: assignments.value as Record<string, string>, repaired: body.repaired }
  }

  const saveAssignments = async (profileId: string, map: Record<string, string | null>) => {
    const body = await req(`/profiles/${encodeURIComponent(profileId)}/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: map }),
    })
    assignments.value = body.assignments ?? {}
    return body
  }

  const createDevice = async (input: { name: string; kind: DeviceKind; model?: string | null; cols?: number | null; rows?: number | null }) => {
    const created = await req('/devices', { method: 'POST', body: JSON.stringify(input) })
    devices.value = [...devices.value, created]
    return created as LogicalDevice
  }

  const updateDevice = async (id: string, patch: Partial<Pick<LogicalDevice, 'name' | 'kind' | 'model' | 'cols' | 'rows' | 'hw_path'>>) => {
    const body = await req(`/devices/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) })
    await loadDevices()
    return body
  }

  const deleteDevice = async (id: string) => {
    const body = await req(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' })
    devices.value = devices.value.filter((d) => d.id !== id)
    return body as { success: boolean; snapshot: any }
  }

  /** Deshacer borrado: re-crea el dispositivo con su id y restaura asignaciones. */
  const restoreDevice = async (snapshot: { device: LogicalDevice; assignments: Array<{ profileId: string; pageId: string | null }> }) => {
    const d = snapshot.device
    await req('/devices', {
      method: 'POST',
      body: JSON.stringify({
        id: d.id, name: d.name, kind: d.kind, model: d.model,
        cols: d.cols, rows: d.rows, hw_path: d.hw_path,
      }),
    })
    for (const a of snapshot.assignments ?? []) {
      if (!a.pageId) continue
      try {
        // Delta: solo el dispositivo restaurado. Enviar el mapa completo
        // arrastra asignaciones rancias de otros dispositivos y el PUT 422
        // las rechaza en bloque aunque esta sea válida.
        await req(`/profiles/${encodeURIComponent(a.profileId)}/assignments`, {
          method: 'PUT',
          body: JSON.stringify({ assignments: { [d.id]: a.pageId } }),
        })
      } catch { /* la página pudo desaparecer: se ignora */ }
    }
    await loadDevices()
  }

  return {
    devices,
    assignments,
    hwStatus,
    loading,
    loadDevices,
    loadHwStatus,
    loadAssignments,
    saveAssignments,
    createDevice,
    updateDevice,
    deleteDevice,
    restoreDevice,
  }
}
