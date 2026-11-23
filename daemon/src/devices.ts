/**
 * devices.ts — Dispositivos lógicos y compatibilidad página ↔ dispositivo.
 *
 * Módulo PURO (sin imports del daemon): la regla de compatibilidad se usa
 * desde db.ts, api/devices.ts, ws.ts y el driver HW sin ciclos.
 *
 * - `deck` (Stream Deck): solo páginas en cuadrícula (`classic`) con su
 *   tamaño exacto. El tamaño sale del HW detectado primero y, si no se
 *   identifica, del modelo configurado en el dispositivo lógico.
 * - `phone` / `tablet`: aceptan cualquier página (grid o libre).
 */

export type DeviceKind = 'deck' | 'phone' | 'tablet';
export type PageLayout = 'classic' | 'gridstack';

/** Modelos físicos conocidos (tamaño fijo en teclas: cols × rows). */
export interface DeckModel {
  id: string;
  label: string;
  cols: number;
  rows: number;
}

export const DECK_MODELS: DeckModel[] = [
  { id: 'mini', label: 'Stream Deck Mini', cols: 3, rows: 2 },
  { id: 'mk2', label: 'Stream Deck MK.2', cols: 5, rows: 3 },
  { id: 'neo', label: 'Stream Deck Neo', cols: 4, rows: 2 },
  { id: 'xl', label: 'Stream Deck XL', cols: 8, rows: 4 },
];

export const DEFAULT_DECK_MODEL = 'mk2';

/** Fila `devices` (forma estructural; db.ts define la interfaz canónica). */
export interface LogicalDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  /** Modelo DPRE (solo deck). */
  model?: string | null;
  /** Tamaño efectivo en teclas (solo deck; del modelo o personalizado). */
  cols?: number | null;
  rows?: number | null;
  /** Path HID del HW enlazado (opcional, informativo). */
  hw_path?: string | null;
}

/** Vista mínima de una página para comprobar compatibilidad. */
export interface PageView {
  id: string;
  profile_id: string;
  name: string;
  is_folder: number;
  parent_id?: string | null;
  grid_cols?: number | null;
  grid_rows?: number | null;
  data: any;
}

export interface CompatResult {
  ok: boolean;
  /** Motivo legible (p. ej. «está en modo libre y un Stream Deck solo admite cuadrícula»). */
  why?: string;
  /** Motivo corto para el `title`/badge (p. ej. «modo libre», «tamaño 4×3»). */
  short?: string;
}

const DEFAULT_COLS = 5;
const DEFAULT_ROWS = 3;

function parseData(d: any): Record<string, any> {
  let cur: any = d;
  // Tolera doble/triple codificación histórica (capas de JSON.stringify
  // acumuladas al reenviar el TEXT ya serializado en updatePage).
  for (let i = 0; i < 5 && typeof cur === 'string'; i++) {
    const t = cur.trim();
    if (!t) return {};
    try {
      cur = JSON.parse(t);
    } catch {
      return {};
    }
  }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return {};
  return cur;
}

/** `layoutMode` de página: 'gridstack' (libre) o 'classic' (cuadrícula). */
export function parseLayoutMode(pageData: any): PageLayout {
  return parseData(pageData)?.layoutMode === 'gridstack' ? 'gridstack' : 'classic';
}

/**
 * Tamaño efectivo de una página: columnas propias → perfil → defecto 5×3.
 * `profileData` es `profiles.data` (con `gridCols`/`gridRows`).
 */
export function resolvePageSize(
  page: Pick<PageView, 'grid_cols' | 'grid_rows'>,
  profileData?: any,
): { cols: number; rows: number } {
  const pd = parseData(profileData);
  const cols = page.grid_cols ?? pd.gridCols ?? DEFAULT_COLS;
  const rows = page.grid_rows ?? pd.gridRows ?? DEFAULT_ROWS;
  return { cols, rows };
}

export function resolvePageView(page: PageView, profileData?: any): {
  cols: number;
  rows: number;
  layout: PageLayout;
} {
  const { cols, rows } = resolvePageSize(page, profileData);
  return { cols, rows, layout: parseLayoutMode(page.data) };
}

/** Tamaño efectivo de un deck lógico (de su modelo o de cols/rows propios). */
export function resolveDeckSize(device: LogicalDevice): { cols: number; rows: number } | null {
  if (device.kind !== 'deck') return null;
  if (Number.isFinite(device.cols as number) && Number.isFinite(device.rows as number)) {
    return { cols: Number(device.cols), rows: Number(device.rows) };
  }
  const model = DECK_MODELS.find((m) => m.id === device.model)
    ?? DECK_MODELS.find((m) => m.id === DEFAULT_DECK_MODEL)!;
  return { cols: model.cols, rows: model.rows };
}

/**
 * ¿Puede este dispositivo mostrar esta página?
 * `hwGrid` (opcional) es la geometría detectada del HW físico conectado:
 * si se conoce, manda sobre el modelo configurado para los deck.
 */
export function checkPageCompatibility(
  page: PageView,
  device: LogicalDevice,
  profileData?: any,
  hwGrid?: { cols: number; rows: number } | null,
): CompatResult {
  if (device.kind !== 'deck') return { ok: true };
  const view = resolvePageView(page, profileData);
  if (view.layout !== 'classic') {
    return {
      ok: false,
      why: 'está en modo libre y un Stream Deck solo admite cuadrícula',
      short: 'modo libre',
    };
  }
  const want = hwGrid ?? resolveDeckSize(device);
  if (want && (view.cols !== want.cols || view.rows !== want.rows)) {
    return {
      ok: false,
      why: `es de ${view.cols}×${view.rows} y el dispositivo es de ${want.cols}×${want.rows}`,
      short: `tamaño ${view.cols}×${view.rows}`,
    };
  }
  return { ok: true };
}

/**
 * Adivina el modelo DPRE a partir de una geometría detectada
 * (p. ej. la que expone `getGridGeometry()` del driver).
 */
export function guessDeckModel(grid: { cols: number; rows: number } | null | undefined): string | null {
  if (!grid) return null;
  return DECK_MODELS.find((m) => m.cols === grid.cols && m.rows === grid.rows)?.id ?? null;
}

/** ¿Es este deviceId la sesión del hardware físico? */
export function isHardwareDeviceId(deviceId: string): boolean {
  return (
    deviceId === 'streamdeck-local'
    || deviceId.startsWith('streamdeck')
    || deviceId.startsWith('hw:')
    || deviceId.startsWith('hardware:')
  );
}

export interface AssignmentFix {
  /** deviceId → pageId (solo asignaciones válidas tras la reparación). */
  assignments: Record<string, string>;
  /** Asignaciones que hubo que quitar (para toasts/logs). */
  dropped: Array<{ deviceId: string; deviceName: string; pageName: string; reason: string }>;
  /** Dispositivos que quedaron sin pantalla compatible. */
  unassigned: Array<{ deviceId: string; deviceName: string }>;
}

/**
 * Repara las asignaciones de un perfil (puro, testeable):
 * - elimina las que apuntan a dispositivos/páginas inexistentes o incompatibles;
 * - auto-asigna a cada dispositivo sin pantalla la primera página raíz
 *   (no carpeta, sin padre) compatible; si no hay ninguna, queda sin asignar.
 */
export function fixAssignments(opts: {
  pages: PageView[];
  devices: LogicalDevice[];
  assignments: Record<string, string | null>;
  profileData?: any;
  hwGrid?: { cols: number; rows: number } | null;
}): AssignmentFix {
  const { pages, devices, profileData, hwGrid } = opts;
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out: Record<string, string> = {};
  const dropped: AssignmentFix['dropped'] = [];
  const unassigned: AssignmentFix['unassigned'] = [];

  const roots = pages.filter((p) => p.is_folder === 0 && (p.parent_id ?? null) === null);

  for (const d of devices) {
    const current = opts.assignments[d.id] ?? null;
    const page = current ? byId.get(current) : undefined;
    if (page) {
      const c = checkPageCompatibility(page, d, profileData, hwGrid);
      if (c.ok) {
        out[d.id] = page.id;
        continue;
      }
      dropped.push({
        deviceId: d.id,
        deviceName: d.name,
        pageName: page.name,
        reason: c.why ?? 'incompatible',
      });
    }
    const fallback = roots.find((p) => checkPageCompatibility(p, d, profileData, hwGrid).ok);
    if (fallback) {
      out[d.id] = fallback.id;
    } else {
      unassigned.push({ deviceId: d.id, deviceName: d.name });
    }
  }
  return { assignments: out, dropped, unassigned };
}

/**
 * ¿A qué deck lógico debe seguir el HW físico al cambiar asignaciones?
 * (puro, testeable). Reglas:
 * - Solo importan los decks con página pedida no-nula (`changedDeckIds`).
 * - La coincidencia explícita `hw_path` con el path conectado manda.
 * - Si algún deck tiene `hw_path`, un deck sin enlazar no empuja al HW.
 * - Sin enlaces, el deck cambiado cuya geometría coincide con la del HW
 *   (o se desconoce la del HW) es candidato.
 * Devuelve el deviceId o null (no empujar: el HW se queda donde está).
 */
export function pickHwDeckForRepaint(opts: {
  devices: LogicalDevice[];
  changedDeckIds: string[];
  connectedPath: string | null;
  hwGrid: { cols: number; rows: number } | null;
}): string | null {
  const byId = new Map(opts.devices.map((d) => [d.id, d]));
  const changed = opts.changedDeckIds
    .map((id) => byId.get(id))
    .filter((d): d is LogicalDevice => !!d && d.kind === 'deck');
  if (changed.length === 0) return null;
  if (opts.connectedPath) {
    const bound = changed.find((d) => d.hw_path === opts.connectedPath);
    if (bound) return bound.id;
  }
  if (opts.devices.some((d) => d.kind === 'deck' && d.hw_path)) return null;
  const sized = opts.hwGrid
    ? changed.filter((d) => {
        const s = resolveDeckSize(d);
        return s !== null && s.cols === opts.hwGrid!.cols && s.rows === opts.hwGrid!.rows;
      })
    : changed;
  return sized[0]?.id ?? null;
}
