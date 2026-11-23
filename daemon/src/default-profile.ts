/**
 * Perfil por defecto `default`.
 *
 * - Se crea automáticamente (con 5 pantallas) si no existe.
 * - SÍ se puede eliminar: al borrarlo se marca `default.dismissed=1` y no
 *   vuelve a crearse solo (se respeta la decisión del usuario). Si el usuario
 *   crea otro perfil llamado `default`, se vuelve a gestionar.
 * - Pantallas (una por tamaño de Stream Deck + panel libre):
 *   1. `Deck 5x3` (classic 5×3) — multimedia + streaming.
 *   2. `Mini 3x2` (classic 3×2) — esencial audio.
 *   3. `Neo 4x2` (classic 4×2) — productividad.
 *   4. `XL 8x4` (classic 8×4) — centro de control.
 *   5. `Panel libre` (gridstack 8×4) — demos con widgets grandes.
 * - Paleta única y armónica (pizarras e índigos apagados; el icono Lucide va
 *   en blanco). El color codifica la FUNCIÓN, no la página:
 *   transporte=índigo, volumen=teal, mutear=rosa apagado, productividad=pizarra,
 *   web=acero, sistema=navegación=violeta, streaming=ciruela, tiempo=ámbar.
 * - Idempotente: solo crea lo que falta y solo siembra botones en páginas
 *   vacías (no pisa ediciones del usuario).
 */
import type { DatabaseService } from './db';

export const DEFAULT_PROFILE_ID = 'default';
export const DEFAULT_DECK_PAGE_ID = 'default-page-deck';
export const DEFAULT_MINI_PAGE_ID = 'default-page-mini';
export const DEFAULT_NEO_PAGE_ID = 'default-page-neo';
export const DEFAULT_XL_PAGE_ID = 'default-page-xl';
export const DEFAULT_FREE_PAGE_ID = 'default-page-libre';
export const DEFAULT_DISMISSED_KEY = 'default.dismissed';
/** Ajuste que marca la migración de marcas heredadas a `si:` (una sola vez). */
export const DEFAULT_BRANDICONS_MIGRATION_KEY = 'default.brandicons_si_v1';

/** Paleta armónica: tonos apagados de la misma familia (pizarra/índigo). */
export const DEFAULT_PALETTE = {
  transport: '#3f4a8a', // índigo apagado — transporte multimedia
  volume: '#2a7d7a', // teal apagado — volumen
  mute: '#96344a', // rosa apagado — silenciar (uso puntual)
  work: '#35425e', // pizarra azulada — productividad
  web: '#2f5d8a', // acero — enlaces web
  system: '#5b4a9e', // violeta apagado — sistema y navegación
  stream: '#6e3a68', // ciruela — streaming
  time: '#8a6d2f', // ámbar apagado — tiempo/calendario
} as const;

type Action = { type: string; pluginId: string; parameters: Record<string, any> };

function btn(
  label: string,
  icon: string,
  backgroundColor: string,
  actions: Action[],
  extra: Record<string, any> = {},
): any {
  return {
    label,
    // La UI prioriza: dynamicValue > imagen > icon (Lucide) > emoji.
    icon,
    emoji: '',
    textTop: '',
    textBottom: '',
    backgroundColor,
    textColor: '#ffffff',
    actions,
    ...extra,
  };
}

const mm = (action: string): Action => ({ type: 'multimedia.multimedia', pluginId: 'multimedia', parameters: { action } });
const hk = (keys: string): Action => ({ type: 'hotkey.hotkey', pluginId: 'hotkey', parameters: { keys } });
const url = (u: string): Action => ({ type: 'browser.open-url', pluginId: 'browser', parameters: { url: u } });
const go = (pageId: string, pageName: string): Action => ({ type: 'page.page', pluginId: 'page', parameters: { pageId, pageName } });

function deckButtons(freePageId: string): Array<{ position: number; data: any }> {
  const P = DEFAULT_PALETTE;
  return [
    { position: 0, data: btn('Play', 'Play', P.transport, [mm('playpause')]) },
    { position: 1, data: btn('Siguiente', 'SkipForward', P.transport, [mm('next')]) },
    { position: 2, data: btn('Anterior', 'SkipBack', P.transport, [mm('previous')]) },
    { position: 3, data: btn('Vol +', 'Volume2', P.volume, [mm('volumeup')]) },
    { position: 4, data: btn('Vol −', 'Volume1', P.volume, [mm('volumedown')]) },
    { position: 5, data: btn('Mutear', 'VolumeX', P.mute, [mm('mute')]) },
    { position: 6, data: btn('YouTube', 'si:youtube', P.web, [url('https://www.youtube.com')]) },
    { position: 7, data: btn('Spotify', 'si:spotify', P.web, [url('https://open.spotify.com')]) },
    { position: 8, data: btn('Twitch', 'si:twitch', P.stream, [url('https://dashboard.twitch.tv')]) },
    { position: 9, data: btn('Copiar', 'Copy', P.work, [hk('ctrl+c')]) },
    { position: 10, data: btn('Pegar', 'ClipboardPaste', P.work, [hk('ctrl+v')]) },
    { position: 11, data: btn('Deshacer', 'Undo2', P.work, [hk('ctrl+z')]) },
    { position: 12, data: btn('Recorte', 'Scissors', P.system, [hk('win+shift+s')]) },
    { position: 13, data: btn('Bloquear', 'Lock', P.system, [hk('win+l')]) },
    { position: 14, data: btn('Panel libre', 'ArrowLeftRight', P.system, [go(freePageId, 'Panel libre')]) },
  ];
}

function miniButtons(): Array<{ position: number; data: any }> {
  const P = DEFAULT_PALETTE;
  return [
    { position: 0, data: btn('Play', 'Play', P.transport, [mm('playpause')]) },
    { position: 1, data: btn('Siguiente', 'SkipForward', P.transport, [mm('next')]) },
    { position: 2, data: btn('Anterior', 'SkipBack', P.transport, [mm('previous')]) },
    { position: 3, data: btn('Vol +', 'Volume2', P.volume, [mm('volumeup')]) },
    { position: 4, data: btn('Vol −', 'Volume1', P.volume, [mm('volumedown')]) },
    { position: 5, data: btn('Mutear', 'VolumeX', P.mute, [mm('mute')]) },
  ];
}

function neoButtons(freePageId: string): Array<{ position: number; data: any }> {
  const P = DEFAULT_PALETTE;
  return [
    { position: 0, data: btn('Copiar', 'Copy', P.work, [hk('ctrl+c')]) },
    { position: 1, data: btn('Pegar', 'ClipboardPaste', P.work, [hk('ctrl+v')]) },
    { position: 2, data: btn('Cortar', 'Scissors', P.work, [hk('ctrl+x')]) },
    { position: 3, data: btn('Deshacer', 'Undo2', P.work, [hk('ctrl+z')]) },
    { position: 4, data: btn('Recorte', 'AppWindow', P.system, [hk('win+shift+s')]) },
    { position: 5, data: btn('Bloquear', 'Lock', P.system, [hk('win+l')]) },
    { position: 6, data: btn('Calendario', 'Calendar', P.time, [url('https://calendar.google.com')]) },
    { position: 7, data: btn('Panel libre', 'ArrowLeftRight', P.system, [go(freePageId, 'Panel libre')]) },
  ];
}

function xlButtons(pages: { deck: string; mini: string; neo: string; free: string }): Array<{ position: number; data: any }> {
  const P = DEFAULT_PALETTE;
  return [
    // Fila 0: transporte + volumen
    { position: 0, data: btn('Play', 'Play', P.transport, [mm('playpause')]) },
    { position: 1, data: btn('Siguiente', 'SkipForward', P.transport, [mm('next')]) },
    { position: 2, data: btn('Anterior', 'SkipBack', P.transport, [mm('previous')]) },
    { position: 3, data: btn('Detener', 'Square', P.transport, [mm('stop')]) },
    { position: 4, data: btn('Vol +', 'Volume2', P.volume, [mm('volumeup')]) },
    { position: 5, data: btn('Vol −', 'Volume1', P.volume, [mm('volumedown')]) },
    { position: 6, data: btn('Mutear', 'VolumeX', P.mute, [mm('mute')]) },
    { position: 7, data: btn('Spotify', 'si:spotify', P.web, [url('https://open.spotify.com')]) },
    // Fila 1: productividad
    { position: 8, data: btn('Copiar', 'Copy', P.work, [hk('ctrl+c')]) },
    { position: 9, data: btn('Pegar', 'ClipboardPaste', P.work, [hk('ctrl+v')]) },
    { position: 10, data: btn('Cortar', 'Scissors', P.work, [hk('ctrl+x')]) },
    { position: 11, data: btn('Deshacer', 'Undo2', P.work, [hk('ctrl+z')]) },
    { position: 12, data: btn('Rehacer', 'Redo2', P.work, [hk('ctrl+y')]) },
    { position: 13, data: btn('Recorte', 'AppWindow', P.system, [hk('win+shift+s')]) },
    { position: 14, data: btn('Bloquear', 'Lock', P.system, [hk('win+l')]) },
    {
      position: 15,
      data: btn('Escribe', 'Keyboard', P.work,
        [{ type: 'type-text.type', pluginId: 'type-text', parameters: { text: '¡Hola desde LibreDeck!' } }]),
    },
    // Fila 2: web y streaming
    { position: 16, data: btn('YouTube', 'si:youtube', P.web, [url('https://www.youtube.com')]) },
    { position: 17, data: btn('Twitch Studio', 'si:twitch', P.stream, [url('https://dashboard.twitch.tv')]) },
    { position: 18, data: btn('Correo', 'Mail', P.web, [url('https://mail.google.com')]) },
    { position: 19, data: btn('Calendario', 'Calendar', P.time, [url('https://calendar.google.com')]) },
    { position: 20, data: btn('El tiempo', 'CloudSun', P.time, [url('https://www.eltiempo.es')]) },
    { position: 21, data: btn('GitHub', 'Github', P.web, [url('https://github.com')]) },
    { position: 22, data: btn('Buscar', 'Search', P.work, [hk('win+s')]) },
    {
      position: 23,
      data: btn('Copia+Pega', 'Layers', P.work, [{
        type: 'multiaction.run-sequence',
        pluginId: 'multiaction',
        parameters: {
          actions: [
            { pluginId: 'hotkey', actionId: 'hotkey', params: { keys: 'ctrl+c' } },
            { pluginId: 'hotkey', actionId: 'hotkey', params: { keys: 'ctrl+v' }, delayMs: 300 },
          ],
        },
      }]),
    },
    // Fila 3: sistema + navegación entre pantallas
    { position: 24, data: btn('Escritorio', 'Monitor', P.system, [hk('win+d')]) },
    { position: 25, data: btn('Ventanas', 'AppWindow', P.system, [hk('alt+tab')]) },
    { position: 26, data: btn('Deck 5x3', 'LayoutGrid', P.system, [go(pages.deck, 'Deck 5x3')]) },
    { position: 27, data: btn('Mini 3x2', 'LayoutGrid', P.system, [go(pages.mini, 'Mini 3x2')]) },
    { position: 28, data: btn('Neo 4x2', 'LayoutGrid', P.system, [go(pages.neo, 'Neo 4x2')]) },
    { position: 29, data: btn('Panel libre', 'ArrowLeftRight', P.system, [go(pages.free, 'Panel libre')]) },
    { position: 30, data: btn('Silenciar micro', 'MicOff', P.mute, [mm('mute')]) },
    { position: 31, data: btn('Ver Twitch', 'si:twitch', P.stream, [url('https://www.twitch.tv')]) },
  ];
}

function freeWidgets(deckPageId: string): Array<{ x: number; y: number; w: number; h: number; data: any }> {
  const P = DEFAULT_PALETTE;
  return [
    {
      x: 0, y: 0, w: 2, h: 2,
      data: btn('STREAM', 'Clapperboard', P.stream, [url('https://dashboard.twitch.tv')],
        { textTop: 'EN VIVO', textBottom: 'Twitch' }),
    },
    { x: 2, y: 0, w: 2, h: 1, data: btn('Play', 'Play', P.transport, [mm('playpause')]) },
    { x: 4, y: 0, w: 1, h: 1, data: btn('Sig', 'SkipForward', P.transport, [mm('next')]) },
    { x: 5, y: 0, w: 1, h: 1, data: btn('Ant', 'SkipBack', P.transport, [mm('previous')]) },
    { x: 6, y: 0, w: 2, h: 1, data: btn('Vol +', 'Volume2', P.volume, [mm('volumeup')]) },
    { x: 2, y: 1, w: 2, h: 1, data: btn('Spotify', 'si:spotify', P.web, [url('https://open.spotify.com')]) },
    { x: 4, y: 1, w: 2, h: 1, data: btn('YouTube', 'si:youtube', P.web, [url('https://www.youtube.com')]) },
    { x: 6, y: 1, w: 2, h: 1, data: btn('Vol −', 'Volume1', P.volume, [mm('volumedown')]) },
    {
      x: 0, y: 2, w: 2, h: 1,
      data: btn('Escribe', 'Keyboard', P.work,
        [{ type: 'type-text.type', pluginId: 'type-text', parameters: { text: '¡Hola desde LibreDeck!' } }],
        { textBottom: '¡Hola!' }),
    },
    {
      x: 2, y: 2, w: 2, h: 1,
      data: btn('Copia+Pega', 'Layers', P.work, [{
        type: 'multiaction.run-sequence',
        pluginId: 'multiaction',
        parameters: {
          actions: [
            { pluginId: 'hotkey', actionId: 'hotkey', params: { keys: 'ctrl+c' } },
            { pluginId: 'hotkey', actionId: 'hotkey', params: { keys: 'ctrl+v' }, delayMs: 300 },
          ],
        },
      }]),
    },
    { x: 4, y: 2, w: 2, h: 1, data: btn('Bloquear', 'Lock', P.system, [hk('win+l')]) },
    { x: 6, y: 2, w: 2, h: 1, data: btn('Recorte', 'Scissors', P.system, [hk('win+shift+s')]) },
    {
      x: 0, y: 3, w: 4, h: 1,
      data: btn('Volver al Deck', 'ArrowLeftRight', P.system, [go(deckPageId, 'Deck 5x3')]),
    },
    { x: 4, y: 3, w: 4, h: 1, data: btn('El tiempo', 'CloudSun', P.time, [url('https://www.eltiempo.es')]) },
  ];
}

function ensurePage(
  db: DatabaseService,
  profileId: string,
  id: string,
  name: string,
  order: number,
  cols: number,
  rows: number,
  layoutMode: 'classic' | 'gridstack',
  description: string,
): string {
  let page = db.getPage(id);
  if (!page) {
    const sameName = db.getPagesByProfile(profileId).find((p) => p.name === name);
    if (sameName) return sameName.id;
    db.createPage({
      id,
      profile_id: profileId,
      name,
      order_idx: order,
      is_folder: 0,
      grid_cols: cols,
      grid_rows: rows,
      data: { layoutMode, description },
    } as any);
    page = db.getPage(id);
  }
  return page!.id;
}

function seedClassic(db: DatabaseService, pageId: string, buttons: Array<{ position: number; data: any }>): boolean {
  if (db.getButtonsByPage(pageId).length > 0) return false;
  for (const b of buttons) {
    db.createButtonWidget({
      id: `${pageId}-btn-${String(b.position).padStart(2, '0')}`,
      page_id: pageId,
      position: b.position,
      kind: 'action_button',
      data: b.data,
    });
  }
  return true;
}

export function ensureDefaultProfile(db: DatabaseService): {
  profileId: string; deckPageId: string; miniPageId: string; neoPageId: string; xlPageId: string; freePageId: string; seeded: boolean;
} | null {
  // 1) Perfil `default` (id o nombre). Sin él y con veto del usuario: respetar el borrado.
  let profile = db.getProfile(DEFAULT_PROFILE_ID)
    ?? db.getProfiles().find((p) => p.name.toLowerCase() === 'default')
    ?? null;
  if (!profile) {
    if (db.getSetting(DEFAULT_DISMISSED_KEY) === '1') return null;
    profile = db.createProfile({
      id: DEFAULT_PROFILE_ID,
      name: 'default',
      data: {
        isDefault: true,
        description: 'Perfil por defecto de LibreDeck',
        gridCols: 5,
        gridRows: 3,
      },
    });
  } else if (db.getSetting(DEFAULT_DISMISSED_KEY) === '1') {
    // El usuario lo trajo de vuelta (o lo renombró a `default`): levantar el veto.
    db.deleteSetting(DEFAULT_DISMISSED_KEY);
  }
  // El perfil canónico (id `default`) siempre se llama `default`.
  if (profile.id === DEFAULT_PROFILE_ID && profile.name !== 'default') {
    db.updateProfile(profile.id, { name: 'default' });
    profile = db.getProfile(profile.id)!;
  }
  const profileId = profile.id;
  let seeded = false;

  // 2) Páginas (ids estables → idempotente).
  const deckPageId = ensurePage(db, profileId, DEFAULT_DECK_PAGE_ID, 'Deck 5x3', 0, 5, 3, 'classic', 'Pantalla para Stream Deck de 5×3: multimedia y streaming');
  const miniPageId = ensurePage(db, profileId, DEFAULT_MINI_PAGE_ID, 'Mini 3x2', 1, 3, 2, 'classic', 'Pantalla para Stream Deck Mini (3×2): esencial audio');
  const neoPageId = ensurePage(db, profileId, DEFAULT_NEO_PAGE_ID, 'Neo 4x2', 2, 4, 2, 'classic', 'Pantalla para Stream Deck Neo (4×2): productividad');
  const xlPageId = ensurePage(db, profileId, DEFAULT_XL_PAGE_ID, 'XL 8x4', 3, 8, 4, 'classic', 'Pantalla para Stream Deck XL (8×4): centro de control');
  const freePageId = ensurePage(db, profileId, DEFAULT_FREE_PAGE_ID, 'Panel libre', 4, 8, 4, 'gridstack', 'Panel libre con demos y widgets grandes');

  // 3) Botones: solo en páginas vacías (no pisar ediciones).
  try { seeded = seedClassic(db, deckPageId, deckButtons(freePageId)) || seeded; } catch { /* mejor esfuerzo */ }
  try { seeded = seedClassic(db, miniPageId, miniButtons()) || seeded; } catch { /* mejor esfuerzo */ }
  try { seeded = seedClassic(db, neoPageId, neoButtons(freePageId)) || seeded; } catch { /* mejor esfuerzo */ }
  try { seeded = seedClassic(db, xlPageId, xlButtons({ deck: deckPageId, mini: miniPageId, neo: neoPageId, free: freePageId })) || seeded; } catch { /* mejor esfuerzo */ }
  try {
    if (db.getButtonsByPage(freePageId).length === 0) {
      let pos = 0;
      for (const w of freeWidgets(deckPageId)) {
        db.createButtonWidget({
          id: `${freePageId}-w-${pos}`,
          page_id: freePageId,
          position: pos++,
          kind: 'action_button',
          x: w.x, y: w.y, w: w.w, h: w.h,
          data: w.data,
        });
      }
      seeded = true;
    }
  } catch { /* mejor esfuerzo */ }

  // 3b) Reparación de tamaños (regresión stepper→perfil): las pantallas
  // semilla siempre tuvieron tamaño propio por página; las BDs anteriores a
  // las columnas grid_* (o el POST que ignoraba grid_cols/grid_rows) las
  // dejaron en NULL = heredar del perfil, y el stepper guardaba en el
  // perfil. Solo se rellenan los NULL con el tamaño de diseño: nunca se
  // pisa un tamaño explícito del usuario.
  try {
    const seedSizes: Array<[string, number, number]> = [
      [deckPageId, 5, 3],
      [miniPageId, 3, 2],
      [neoPageId, 4, 2],
      [xlPageId, 8, 4],
      [freePageId, 8, 4],
    ];
    for (const [pid, cols, rows] of seedSizes) {
      const pg = db.getPage(pid);
      if (!pg) continue;
      const patch: { grid_cols?: number | null; grid_rows?: number | null } = {};
      if (pg.grid_cols == null) patch.grid_cols = cols;
      if (pg.grid_rows == null) patch.grid_rows = rows;
      if (patch.grid_cols !== undefined || patch.grid_rows !== undefined) {
        db.updatePage(pid, patch);
      }
    }
  } catch { /* mejor esfuerzo */ }

  // 3c) Migración de marcas al catálogo Simple Icons (`si:`): los seeds
  // antiguos usaban iconos Lucide de marca (`Youtube`/`Twitch`, eliminados
  // de Lucide y por eso invisibles en el HW) o el genérico `Music` para
  // Spotify. Solo toca botones con la firma exacta del seed (etiqueta de
  // serie + icono heredado): si el usuario personalizó algo, se respeta.
  // Idempotente por ajuste (`default.brandicons_si_v1`).
  try {
    if (db.getSetting(DEFAULT_BRANDICONS_MIGRATION_KEY) !== '1') {
      const targetByLabel: Record<string, string> = {
        YouTube: 'si:youtube',
        Twitch: 'si:twitch',
        'Twitch Studio': 'si:twitch',
        'Ver Twitch': 'si:twitch',
        Spotify: 'si:spotify',
      };
      const legacyIcons = new Set(['Youtube', 'Twitch', 'Music']);
      for (const page of db.getPagesByProfile(profileId)) {
        for (const btn of db.getButtonsByPage(page.id)) {
          const data = (btn as any)?.data as any;
          const target = typeof data?.label === 'string' ? targetByLabel[data.label] : undefined;
          if (!target || data.icon === target || !legacyIcons.has(data.icon)) continue;
          db.updateButton(btn.id, { ...data, icon: target });
          seeded = true;
        }
      }
      db.setSetting(DEFAULT_BRANDICONS_MIGRATION_KEY, '1');
    }
  } catch { /* mejor esfuerzo */ }

  // 4) Perfil actual: si no hay ninguno, el default es lo que ve el usuario.
  try {
    if (!db.getSetting('current.profile_id')) db.setSetting('current.profile_id', profileId);
  } catch { /* noop */ }

  // 5) Dispositivos de ejemplo por tamaño (si faltan) y asignaciones
  //    por defecto (solo donde falten): cada deck muestra su pantalla.
  try {
    const now = Date.now();
    const has = new Set(db.listDevices().map((d) => d.id));
    const wantDevices: Array<{ id: string; name: string; kind: string; model: string | null; cols: number | null; rows: number | null }> = [
      { id: 'dev-deck-mini', name: 'Stream Deck Mini', kind: 'deck', model: 'mini', cols: 3, rows: 2 },
      { id: 'dev-deck-neo', name: 'Stream Deck Neo', kind: 'deck', model: 'neo', cols: 4, rows: 2 },
      { id: 'dev-deck-xl', name: 'Stream Deck XL', kind: 'deck', model: 'xl', cols: 8, rows: 4 },
    ];
    for (const d of wantDevices) {
      if (!has.has(d.id)) {
        db.createDevice({ ...d, hw_path: null } as any);
        void now;
      }
    }
    const current = db.getAssignments(profileId);
    const defaults: Record<string, string> = {
      'dev-deck-mk2': deckPageId,
      'dev-deck-mini': miniPageId,
      'dev-deck-neo': neoPageId,
      'dev-deck-xl': xlPageId,
      'dev-phone': freePageId,
      'dev-tablet': freePageId,
    };
    for (const [deviceId, pageId] of Object.entries(defaults)) {
      if (!current[deviceId] && db.getDevice(deviceId)) db.setAssignment(profileId, deviceId, pageId);
    }
  } catch { /* mejor esfuerzo */ }

  return { profileId, deckPageId, miniPageId, neoPageId, xlPageId, freePageId, seeded };
}
