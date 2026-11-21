import { describe, it, expect } from 'bun:test';

// T5 puro: replica la lógica REAL de web/src/composables/useStreamDeck.ts
// (addAction / getDefaultActionParameters / saveButtonConfig / hasContent)
// y del driver/API (press ejecuta acciones del botón en orden;
// POST /buttons no tiene constraint UNIQUE -> duplicados posibles).
// Sin imports de '../db', '../action-runner' ni '../plugin-loader'.

// --- Réplicas exactas del frontend (useStreamDeck.ts) ---

function getDefaultActionParameters(type: string) {
  switch (type) {
    case 'shell':
      return { command: '' };
    case 'http':
      return { url: '', method: 'GET' };
    case 'hotkey':
      return { keys: '' };
    case 'multimedia':
      return { action: 'playpause' };
    case 'page':
      return { pageId: '', pageName: '' };
    case 'open-url':
      return { url: '' };
    case 'pc-vitals.monitor':
      return { component: 'cpu', metric: 'usage', updateInterval: 1000 };
    default:
      return {};
  }
}

type PluginEntry = [string, { actions: [string, unknown][] }];

// Búsqueda idéntica a addAction(type) en useStreamDeck.ts
function resolvePluginId(type: string, plugins: PluginEntry[]): string | null {
  let pluginId: string | null = null;
  for (const plugin of plugins) {
    const [pid, pluginData] = plugin;
    if (type.includes('.')) {
      const [pluginPrefix, actionId] = type.split('.');
      if (pid === pluginPrefix && pluginData.actions && pluginData.actions.some((action: any) => action[0] === actionId)) {
        pluginId = pid;
        break;
      }
    } else {
      if (pluginData.actions && pluginData.actions.some((action: any) => action[0] === type)) {
        pluginId = pid;
        break;
      }
    }
  }
  return pluginId;
}

interface ButtonConfig {
  label: string;
  textTop: string;
  textBottom: string;
  emoji: string;
  icon: string;
  actions: any[];
}

function emptyConfig(): ButtonConfig {
  return { label: '', textTop: '', textBottom: '', emoji: '', icon: '', actions: [] };
}

// Condición idéntica a saveButtonConfig (y selectButton/driver):
// label||textTop||textBottom||emoji||icon||actions.length>0
function hasContent(cfg: ButtonConfig): boolean {
  return Boolean(
    cfg.label?.trim() ||
    cfg.textTop?.trim() ||
    cfg.textBottom?.trim() ||
    cfg.emoji?.trim() ||
    cfg.icon?.trim() ||
    cfg.actions.length > 0
  );
}

// addAction(type) real: resuelve pluginId + parámetros por defecto
function addAction(cfg: ButtonConfig, type: string, plugins: PluginEntry[]): ButtonConfig {
  const pluginId = resolvePluginId(type, plugins);
  const newAction = {
    id: Date.now().toString(),
    type,
    pluginId,
    parameters: getDefaultActionParameters(type),
  };
  return { ...cfg, actions: [...cfg.actions, newAction] };
}

function removeAction(cfg: ButtonConfig, index: number): ButtonConfig {
  return { ...cfg, actions: cfg.actions.filter((_, i) => i !== index) };
}

// Decisión de saveButtonConfig real:
// existing ? (hasContent ? update : delete) : (hasContent ? create : noop)
function decideSave(existing: boolean, cfg: ButtonConfig): 'create' | 'update' | 'delete' | 'noop' {
  const hc = hasContent(cfg);
  if (existing) return hc ? 'update' : 'delete';
  return hc ? 'create' : 'noop';
}

// --- Réplicas del backend/driver (in-memory, sin UNIQUE en position) ---

interface StoredButton {
  id: string;
  page_id: string;
  position: number;
  data: ButtonConfig;
}

// POST /api/v1/buttons: crea fila con position explícita, sin chequear duplicados
// (schema daemon/src/db.ts: buttons sin UNIQUE sobre (page_id, position)).
function createButtonRow(store: StoredButton[], row: StoredButton): StoredButton {
  store.push(row);
  return row;
}

function findByPosition(store: StoredButton[], position: number): StoredButton | undefined {
  return store.find((b) => b.position === position);
}

// executeButton real (frontend) / press del driver: ejecuta en orden las
// acciones del botón de esa posición, secuencialmente con await.
async function pressPosition(
  store: StoredButton[],
  position: number,
  executor: (action: any) => Promise<void> | void
): Promise<void> {
  const button = findByPosition(store, position);
  if (!button?.data?.actions?.length) return;
  for (const action of button.data.actions) {
    await executor(action);
  }
}

// Fixture de plugins con el formato real de GET /api/v1/plugins/actions:
// [ [pluginId, { actions: [[shortId, def], ...] }], ... ]
const pluginsFixture: PluginEntry[] = [
  ['shell', { actions: [['shell', {}]] }],
  ['http', { actions: [['http', {}]] }],
  ['hotkey', { actions: [['hotkey', {}]] }],
  ['multimedia', { actions: [['multimedia', {}]] }],
  ['page', { actions: [['page', {}]] }],
  ['browser', { actions: [['open-url', {}]] }],
  ['pc-vitals', { actions: [['monitor', {}]] }],
];

describe('T5 button add actions (puro)', () => {
  it('1. resuelve pluginId por prefijo: pc-vitals.monitor -> pc-vitals', () => {
    expect(resolvePluginId('pc-vitals.monitor', pluginsFixture)).toBe('pc-vitals');
  });

  it("1. resuelve 'shell' al plugin que lo expone y desconocido -> null", () => {
    expect(resolvePluginId('shell', pluginsFixture)).toBe('shell');
    expect(resolvePluginId('open-url', pluginsFixture)).toBe('browser');
    expect(resolvePluginId('nope.unknown-action', pluginsFixture)).toBeNull();
    expect(resolvePluginId('tipo-que-no-existe', pluginsFixture)).toBeNull();
  });

  it('2. getDefaultActionParameters para cada tipo conocido y default {}', () => {
    expect(getDefaultActionParameters('shell')).toEqual({ command: '' });
    expect(getDefaultActionParameters('http')).toEqual({ url: '', method: 'GET' });
    expect(getDefaultActionParameters('hotkey')).toEqual({ keys: '' });
    expect(getDefaultActionParameters('multimedia')).toEqual({ action: 'playpause' });
    expect(getDefaultActionParameters('page')).toEqual({ pageId: '', pageName: '' });
    expect(getDefaultActionParameters('open-url')).toEqual({ url: '' });
    expect(getDefaultActionParameters('pc-vitals.monitor')).toEqual({
      component: 'cpu',
      metric: 'usage',
      updateInterval: 1000,
    });
    expect(getDefaultActionParameters('whatever')).toEqual({});
    expect(getDefaultActionParameters('')).toEqual({});
  });

  it('3. anadir 1 accion a boton vacio lo vuelve "con contenido" (creable/guardable)', () => {
    const before = emptyConfig();
    expect(hasContent(before)).toBe(false);
    expect(decideSave(false, before)).toBe('noop');

    const after = addAction(before, 'shell', pluginsFixture);
    expect(after.actions).toHaveLength(1);
    expect(after.actions[0].type).toBe('shell');
    expect(after.actions[0].pluginId).toBe('shell');
    expect(hasContent(after)).toBe(true);
    expect(decideSave(false, after)).toBe('create');
    expect(decideSave(true, after)).toBe('update');
  });

  it('4. acciones en LOS 15 botones (pos 0..14): cada press ejecuta solo las suyas', async () => {
    const store: StoredButton[] = [];
    for (let pos = 0; pos < 15; pos++) {
      let cfg = emptyConfig();
      cfg = addAction(cfg, 'shell', pluginsFixture);
      // Marcar cada acción con su posición para distinguirlas
      cfg.actions[0] = { ...cfg.actions[0], parameters: { command: `cmd-${pos}` } };
      createButtonRow(store, { id: `btn-${pos}`, page_id: 'page-1', position: pos, data: cfg });
    }
    expect(store).toHaveLength(15);

    for (let pos = 0; pos < 15; pos++) {
      const executed: string[] = [];
      await pressPosition(store, pos, (a) => void executed.push(a.parameters.command));
      expect(executed).toEqual([`cmd-${pos}`]);
    }
  });

  it('5. boton con multiples acciones: se ejecutan todas y en orden (A->B->C)', async () => {
    const store: StoredButton[] = [];
    let cfg = emptyConfig();
    cfg = addAction(cfg, 'shell', pluginsFixture);
    cfg = addAction(cfg, 'http', pluginsFixture);
    cfg = addAction(cfg, 'hotkey', pluginsFixture);
    cfg.actions[0] = { ...cfg.actions[0], tag: 'A' };
    cfg.actions[1] = { ...cfg.actions[1], tag: 'B' };
    cfg.actions[2] = { ...cfg.actions[2], tag: 'C' };
    createButtonRow(store, { id: 'btn-multi', page_id: 'page-1', position: 7, data: cfg });

    const order: string[] = [];
    await pressPosition(store, 7, (a) => void order.push(a.tag));
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('6. dos botones en la MISMA position son posibles a nivel BD (falta UNIQUE): find devuelve el primero, el otro queda huerfano', () => {
    const store: StoredButton[] = [];
    let cfg1 = addAction(emptyConfig(), 'shell', pluginsFixture);
    let cfg2 = addAction(emptyConfig(), 'http', pluginsFixture);
    createButtonRow(store, { id: 'btn-first', page_id: 'page-1', position: 3, data: cfg1 });
    createButtonRow(store, { id: 'btn-second', page_id: 'page-1', position: 3, data: cfg2 });

    // La BD lo permite: hay 2 filas con position=3 (sin constraint UNIQUE en schema).
    expect(store.filter((b) => b.position === 3)).toHaveLength(2);

    // El lookup por posición (getButton/find) solo ve el primero: el segundo es invisible/huérfano.
    const found = findByPosition(store, 3);
    expect(found?.id).toBe('btn-first');
    const orphan = store.find((b) => b.id === 'btn-second');
    expect(orphan).toBeDefined();
    expect(found?.id).not.toBe(orphan?.id);
  });

  it('7. quitar la unica accion de un boton solo-con-acciones lo vacia (hasContent=false -> se borraria al guardar)', () => {
    let cfg = emptyConfig();
    cfg = addAction(cfg, 'shell', pluginsFixture);
    expect(hasContent(cfg)).toBe(true);

    cfg = removeAction(cfg, 0);
    expect(cfg.actions).toHaveLength(0);
    expect(hasContent(cfg)).toBe(false);
    expect(decideSave(true, cfg)).toBe('delete');
    expect(decideSave(false, cfg)).toBe('noop');
  });
});
