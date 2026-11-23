import { Database } from 'bun:sqlite';
import { getVersion } from './version';
import { fixAssignments } from './devices';

let db: Database;

export interface Profile {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  data: any; // JSON metadata, layout info
}

export interface Page {
  id: string;
  profile_id: string;
  name: string;
  order_idx: number;
  is_folder: number; // 1 = folder, 0 = page
  /** Fase 1: carpeta padre para anidar (pages con is_folder=1). NULL = raíz del perfil. */
  parent_id?: string | null;
  grid_cols?: number | null;
  grid_rows?: number | null;
  data: any; // JSON layout, grid config
}

export interface Button {
  id: string;
  page_id: string;
  position: number;
  data: any; // JSON: actions, icon, label, state
  /** Fase 1: los botones SON widgets. Un botón legacy (sin widget_type)
   *  se lee como widget `action_button`. */
  widget_type?: string | null;
  x?: number | null;
  y?: number | null;
  w?: number | null;
  h?: number | null;
  parent_widget_id?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
}

/**
 * Fase 1: vista widget de un botón (fila `buttons`).
 * Compat: todo botón legacy (widget_type NULL, x/y NULL) se expone como
 * `{ kind: 'action_button', x: position % cols, y: floor(position / cols), w: 1, h: 1 }`.
 * (Distinto de `Widget`, el catálogo global id/name/kind/data.)
 */
export interface ButtonWidget {
  id: string;
  page_id: string;
  kind: string; // 'action_button' | 'folder' | 'label' | ...
  x: number;
  y: number;
  w: number;
  h: number;
  position: number; // orden legacy (API v1)
  parent_widget_id: string | null;
  data: any;
}

/** Fase 1: disparador que arranca un flow. */
export interface Trigger {
  id: string;
  flow_id: string;
  kind: string; // 'button_press' | 'hotkey' | 'schedule' | 'webhook' | 'profile_enter' | ...
  config: any; // JSON según kind
  enabled: number;
  created_at: number;
  updated_at: number;
}

/** Fase 1: ejecución de un flow vinculada a flows (fila de flow_runs). */
export interface FlowExecution {
  id: string;
  flow_id: string | null;
  trigger_id: string | null;
  kind: string;
  label: string;
  status: string; // 'running' | 'finished' | 'error' | ...
  started_at: number;
  finished_at: number | null;
  output: any; // JSON resultado resumido
  error: string | null;
}

/** Fase 1: sesión de un cliente (panel web, móvil, hardware). */
export interface ClientSession {
  id: string;
  client_id: string; // identificador del cliente/dispositivo
  profile_id: string | null;
  page_id: string | null;
  status: string; // 'active' | 'idle' | 'disconnected'
  connected_at: number;
  last_seen_at: number;
  user_agent: string | null;
  ip: string | null;
  meta: any; // JSON extra (capacidades, viewport...)
}

/** Ancho de rejilla legacy para derivar x/y de `position`. */
export const LEGACY_GRID_COLS = 8;

export interface Plugin {
  id: string;
  name: string;
  version: string;
  manifest: any; // JSON manifest
  enabled: number; // 1 = enabled, 0 = disabled
  installed_at: number;
  updated_at?: number;
  // Ciclo de vida marketplace/actualizaciones (migración 2, opcionales)
  source_type?: string | null; // 'builtin' | 'zip' | 'git' | 'marketplace' | 'directory'
  origin?: string | null; // URL repo / zip, o 'builtin'
  ref?: string | null; // rama/tag/commit solicitado
  commit?: string | null; // commit instalado (git)
  checksum?: string | null; // sha256 del paquete/carpeta
  status?: string | null; // 'active' | 'error' | 'disabled'
  last_error?: string | null;
  previous_version?: string | null;
  previous_manifest?: any | null;
}

export interface Asset {
  id: string;
  path: string;
  hash: string;
  size: number;
  created_at: number;
}

export interface Variable {
  name: string;
  type: string | null;
  value: any; // JSON
  updated_at: number;
}

export interface Flow {
  id: string;
  name: string;
  data: any; // JSON { steps: [...], description? }
  created_at: number;
  updated_at?: number | null;
}

export interface Automation {
  id: string;
  name: string;
  enabled: number; // 1 = enabled, 0 = disabled
  trigger: any; // JSON
  data: any; // JSON { actions: [...], ... }
  created_at: number;
  updated_at?: number | null;
}

export interface Widget {
  id: string;
  name: string;
  kind: string | null;
  data: any; // JSON
  created_at: number;
  updated_at?: number | null;
}

export interface LogEntry {
  id?: number;
  level: string;
  message: string;
  meta: any; // JSON additional data
  ts: number;
}

export interface Setting {
  key: string;
  value: string;
}

/** Vista persistida de un dispositivo/cliente (sesión independiente). */
export interface DeviceSession {
  device_id: string;
  name: string | null;
  kind: string | null; // 'browser' | 'hardware' | 'relay' | ...
  profile_id: string | null;
  page_id: string | null;
  startup_profile_id: string | null;
  updated_at: number;
}

/** Dispositivo lógico: Stream Deck físico/lógico, móvil o tablet. */
export interface LogicalDevice {
  id: string;
  name: string;
  kind: string; // 'deck' | 'phone' | 'tablet'
  /** Modelo DPRE para deck (mini|mk2|neo|xl). NULL en phone/tablet. */
  model: string | null;
  /** Tamaño efectivo del deck (NULL = el del modelo). */
  cols: number | null;
  rows: number | null;
  /** Path HID del HW enlazado (opcional, informativo). */
  hw_path: string | null;
  created_at: number;
  updated_at: number;
}

/** Qué pantalla de un perfil muestra un dispositivo (page_id NULL = sin pantalla). */
export interface ProfileAssignment {
  profile_id: string;
  device_id: string;
  page_id: string | null;
  updated_at: number;
}

export interface VariableRow {
  name: string;
  scope: string; // 'global' | 'widget' | 'script' | 'automation'
  scope_id: string; // '' para global
  type: string; // 'text' | 'numeric' | 'bool' | 'color'
  value: string; // serializado como texto
  unavailable: number; // 1 = fuente no disponible
  bindings: string | null; // JSON { read?, write? } o null
  updated_at: number;
}

import { getDataDir, getDbPath, ensureDataDirectories } from './paths';

const SQL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT -- JSON
  );

  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    name TEXT NOT NULL,
    order_idx INTEGER DEFAULT 0,
    is_folder INTEGER DEFAULT 0, -- 1 = folder, 0 = page
    parent_id TEXT, -- Fase 1: carpeta padre (pages.id con is_folder=1), NULL = raíz
    grid_cols INTEGER, -- Fase 1: NULL = hereda del perfil/data
    grid_rows INTEGER,
    data TEXT, -- JSON
    FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS buttons (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    data TEXT, -- JSON
    -- Fase 1: los botones son widgets redimensionables.
    widget_type TEXT DEFAULT 'action_button',
    x INTEGER, -- NULL = derivado de position (legacy)
    y INTEGER,
    w INTEGER DEFAULT 1,
    h INTEGER DEFAULT 1,
    parent_widget_id TEXT, -- widget contenedor (p.ej. carpeta-widget)
    created_at INTEGER,
    updated_at INTEGER,
    FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    manifest TEXT, -- JSON
    enabled INTEGER DEFAULT 1,
    installed_at INTEGER NOT NULL,
    updated_at INTEGER,
    source_type TEXT,
    origin TEXT,
    ref TEXT,
    commit_sha TEXT,
    checksum TEXT,
    status TEXT,
    last_error TEXT,
    previous_version TEXT,
    previous_manifest TEXT
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    hash TEXT,
    size INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    meta TEXT, -- JSON
    ts INTEGER NOT NULL
  );

  -- Motor de flujos persistente (migración 6; IF NOT EXISTS = idempotente).
  -- OJO: flows/automations ya existen con otro esquema (Fase 1); el motor
  -- de nodos usa tablas propias flow_scripts/flow_automations.
  CREATE TABLE IF NOT EXISTS flow_scripts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL, -- JSON: {inputs, timeout, nodes}
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flow_automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL, -- JSON: {enabled, trigger, scriptId, nodes, inputs, scope}
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flow_vars (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL, -- 'num' | 'bool' | 'txt'
    value TEXT NOT NULL, -- JSON
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flow_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL, -- running|finished|error|cancelled|interrupted
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT
  );

  -- Variables tipadas persistentes (servicio daemon de variables):
  -- scopes global/widget/script/automation; scope_id vacío para global.
  CREATE TABLE IF NOT EXISTS variables (
    name TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    scope_id TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'text',
    value TEXT NOT NULL DEFAULT '',
    unavailable INTEGER NOT NULL DEFAULT 0,
    bindings TEXT, -- JSON { read?, write? } o null
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, scope_id, name)
  );

  CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT, -- JSON { steps: [{type, parameters}] , description? }
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    trigger TEXT, -- JSON { kind, ... }
    data TEXT, -- JSON { actions: [...], ... }
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS widgets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT,
    data TEXT, -- JSON
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  );

  -- Índices para mejor performance
  CREATE INDEX IF NOT EXISTS idx_pages_profile_id ON pages(profile_id);
  -- NOTA Fase 1: idx_pages_parent_id lo crea la migración 5 (parent_id llega
  -- por ALTER; aquí fallaría en DBs antiguas con "no such column").
  CREATE INDEX IF NOT EXISTS idx_buttons_page_id ON buttons(page_id);
  -- NOTA: los índices de triggers/flow_runs/client_sessions se crean DESPUÉS
  -- de sus tablas, al final del schema (si se crean antes, db.exec falla en
  -- DBs nuevas con SQLITE_ERROR y el daemon no arranca).
  -- NOTA: el UNIQUE(page_id, position) NO va en el schema base.
  -- Lo crea la migración 3 DESPUÉS de reubicar duplicados existentes.
  -- (Si se crea aquí, db.exec falla con SQLITE_CONSTRAINT_UNIQUE en DBs
  --  antiguas con posiciones duplicadas, antes de que la migración pueda
  --  repararlas, y el daemon no arranca.)
  CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);

  -- Sesiones por dispositivo/cliente (vistas independientes profile/page).
  CREATE TABLE IF NOT EXISTS device_sessions (
    device_id TEXT PRIMARY KEY,
    name TEXT,
    kind TEXT,
    profile_id TEXT,
    page_id TEXT,
    startup_profile_id TEXT,
    updated_at INTEGER NOT NULL
  );

  -- Fase 1: triggers que arrancan un flow (la tabla flows ya existe).
  CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    config TEXT, -- JSON según kind
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(flow_id) REFERENCES flows(id) ON DELETE CASCADE
  );

  -- Fase 1: historial de ejecuciones (columnas base las crea el motor de
  -- flujos; la migración 5 añade flow_id/trigger_id/output). No se redefine
  -- aquí: el primer CREATE TABLE IF NOT EXISTS del fichero es el que vale.

  -- Fase 1: sesiones por cliente (panel web, móvil, hardware).
  CREATE TABLE IF NOT EXISTS client_sessions (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    profile_id TEXT,
    page_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    connected_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent TEXT,
    ip TEXT,
    meta TEXT -- JSON extra
  );

  -- Índices diferidos (sus tablas ya existen aquí; ver NOTA arriba).
  CREATE INDEX IF NOT EXISTS idx_triggers_flow_id ON triggers(flow_id);
  CREATE INDEX IF NOT EXISTS idx_client_sessions_client_id ON client_sessions(client_id);

  -- Dispositivos lógicos (Stream Deck / móvil / tablet) y qué pantalla
  -- de cada perfil muestra cada uno (asignaciones por perfil).
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'phone', -- 'deck' | 'phone' | 'tablet'
    model TEXT, -- modelo DPRE para deck (mini|mk2|neo|xl), NULL en phone/tablet
    cols INTEGER, -- tamaño efectivo del deck (NULL = del modelo)
    rows INTEGER,
    hw_path TEXT, -- path HID del HW enlazado (opcional, informativo)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profile_assignments (
    profile_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    page_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, device_id),
    FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
    FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assignments_profile ON profile_assignments(profile_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_device ON profile_assignments(device_id);
`;

export async function initDatabase() {
  // Ensure all data directories exist with proper permissions
  await ensureDataDirectories();
  
  const dataDir = getDataDir();
  const dbPath = getDbPath();

  db = new Database(dbPath);

  // Ejecutar schema
  db.exec(SQL_SCHEMA);

  // Run migrations
  runMigrations(db);

  // Insertar configuración por defecto
  const defaultSettings = [
    { key: 'app.version', value: '0.1.0' },
    { key: 'api.port', value: '3001' },
    { key: 'ws.port', value: '3003' },
    { key: 'security.cors_origins', value: 'http://localhost:4321,http://127.0.0.1:4321' },
    { key: 'current.profile_id', value: '' },
    { key: 'current.page_id', value: '' }
  ];

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const setting of defaultSettings) {
    insertSetting.run(setting.key, setting.value);
  }
  // La versión efectiva de la app la define root package.json (getVersion()).
  // El seed '0.1.0' es solo default para DBs nuevas; aquí se actualiza al
  // arrancar para no dejar versiones rancias en DBs existentes.
  try {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(getVersion(), 'app.version');
  } catch { /* mejor esfuerzo: la app sigue sin versión en DB */ }

  // Instalar plugins integrados
  await installBuiltInPlugins(db);

  // Dispositivos lógicos de ejemplo (sin ninguno, la barra de Dispositivos
  // de la UI se oculta y la función es invisible). Solo la primera vez:
  // si el usuario los borra, no vuelven solos al reiniciar.
  try {
    const seeded = db.prepare("SELECT value FROM settings WHERE key = 'devices.seeded_v1'").get() as { value: string } | undefined;
    if (!seeded) {
      const nowSeed = Date.now();
      const seedDevice = db.prepare(
        'INSERT OR IGNORE INTO devices (id, name, kind, model, cols, rows, hw_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      seedDevice.run('dev-deck-mk2', 'Stream Deck MK.2', 'deck', 'mk2', 5, 3, null, nowSeed, nowSeed);
      seedDevice.run('dev-phone', 'Móvil', 'phone', null, null, null, null, nowSeed, nowSeed);
      seedDevice.run('dev-tablet', 'Tablet', 'tablet', null, null, null, null, nowSeed, nowSeed);
      db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('devices.seeded_v1', '1');
    }
  } catch { /* mejor esfuerzo: la app sigue sin ejemplos */ }

  console.log('Database initialized at:', dbPath);
}

function runMigrations(db: Database) {
  console.log('🔄 Running database migrations...');

  // Migration 1: Add is_folder column to pages table
  try {
    const result = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pages'").get() as { sql: string } | undefined;
    if (result && !result.sql.includes('is_folder')) {
      console.log('📝 Adding is_folder column to pages table...');
      db.exec('ALTER TABLE pages ADD COLUMN is_folder INTEGER DEFAULT 0');
      console.log('✅ Migration 1 completed: Added is_folder column');
    } else {
      console.log('ℹ️ Migration 1 skipped: is_folder column already exists');
    }
  } catch (error) {
    console.error('❌ Migration 1 failed:', error);
  }

  // Migration 2: plugin lifecycle columns (marketplace / actualizaciones)
  try {
    const prow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='plugins'").get() as { sql: string } | undefined;
    const psql = prow?.sql ?? '';
    const ensureCol = (col: string, ddl: string) => {
      if (!psql.includes(col)) {
        try { db.exec(`ALTER TABLE plugins ADD COLUMN ${ddl}`); console.log(`📝 Migration 2: added plugins.${col}`); }
        catch (e) { console.error(`❌ Migration 2 failed for ${col}:`, e); }
      }
    };
    ensureCol('updated_at', 'updated_at INTEGER');
    ensureCol('source_type', 'source_type TEXT');
    ensureCol('origin', 'origin TEXT');
    ensureCol('ref', 'ref TEXT');
    ensureCol('commit_sha', 'commit_sha TEXT');
    ensureCol('checksum', 'checksum TEXT');
    ensureCol('status', 'status TEXT');
    ensureCol('last_error', 'last_error TEXT');
    ensureCol('previous_version', 'previous_version TEXT');
    ensureCol('previous_manifest', 'previous_manifest TEXT');
  } catch (error) {
    console.error('❌ Migration 2 failed:', error);
  }

  // Migration 3: evitar posiciones duplicadas de botones dentro de una página.
  // 1) Reubica duplicados existentes a posiciones libres (conserva datos).
  // 2) Crea índice UNIQUE (page_id, position) para que no vuelvan a ocurrir.
  try {
    const dupGroups = db.prepare(`
      SELECT page_id, position, COUNT(*) as c FROM buttons
      GROUP BY page_id, position HAVING c > 1
    `).all() as { page_id: string; position: number; c: number }[];
    if (dupGroups.length > 0) {
      console.log(`📝 Migration 3: found ${dupGroups.length} grupos con posición duplicada, reubicando...`);
      const relocate = db.transaction(() => {
        for (const g of dupGroups) {
          const rows = db.prepare(
            'SELECT id FROM buttons WHERE page_id = ? AND position = ? ORDER BY rowid'
          ).all(g.page_id, g.position) as { id: string }[];
          // La primera fila conserva su posición; el resto va a posiciones libres
          const used = new Set(
            (db.prepare('SELECT position FROM buttons WHERE page_id = ?').all(g.page_id) as { position: number }[])
              .map(r => r.position)
          );
          let candidate = 0;
          for (let i = 1; i < rows.length; i++) {
            while (used.has(candidate)) candidate++;
            db.prepare('UPDATE buttons SET position = ? WHERE id = ?').run(candidate, rows[i].id);
            used.add(candidate);
            console.log(`📝 Migration 3: botón ${rows[i].id} reubicado a posición ${candidate}`);
          }
        }
      });
      relocate();
      console.log('✅ Migration 3: duplicados reubicados');
    } else {
      console.log('ℹ️ Migration 3: sin posiciones duplicadas');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_buttons_page_position ON buttons(page_id, position)');
    console.log('✅ Migration 3 completed: UNIQUE(page_id, position)');
  } catch (error) {
    console.error('❌ Migration 3 failed:', error);
  }

  // Migration 4a: tabla de variables tipadas con scopes (servicio daemon).
  // (Hay otros bloques "Migration 4" para device_sessions y flows/widgets;
  //  todos usan IF NOT EXISTS y son independientes entre sí.)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS variables (
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      scope_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'text',
      value TEXT NOT NULL DEFAULT '',
      unavailable INTEGER NOT NULL DEFAULT 0,
      bindings TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, scope_id, name)
    )`);
    console.log('✅ Migration 4 completed: variables table');
  } catch (error) {
    console.error('❌ Migration 4 failed:', error);
  }

  // Migration 4: tabla de sesiones por dispositivo (vista profile/page propia
  // por cliente: browser/HW/relay). IF NOT EXISTS → idempotente en DBs nuevas.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS device_sessions (
      device_id TEXT PRIMARY KEY,
      name TEXT,
      kind TEXT,
      profile_id TEXT,
      page_id TEXT,
      startup_profile_id TEXT,
      updated_at INTEGER NOT NULL
    )`);
    console.log('✅ Migration 4 completed: device_sessions');
  } catch (error) {
    console.error('❌ Migration 4 failed:', error);
  }

  // Migration 4: tablas de widgets/flows/automatizaciones/variables.
  // (Para DBs nuevas ya las crea SQL_SCHEMA; aquí solo faltantes.)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS variables (
        name TEXT PRIMARY KEY,
        type TEXT,
        value TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        trigger TEXT,
        data TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT,
        data TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );
    `);
    console.log('✅ Migration 4 completed: variables/flows/automations/widgets');
  } catch (error) {
    console.error('❌ Migration 4 failed:', error);
  }

  // Migration 5 (Fase 1): perfiles → carpetas anidadas → widgets
  // redimensionables + triggers/flows + sesiones por cliente.
  // - pages.parent_id / grid_cols / grid_rows (carpetas anidadas; NULL = raíz).
  // - buttons.widget_type / x / y / w / h / parent_widget_id / created_at /
  //   updated_at (el botón legacy se lee como widget `action_button`).
  // - flow_runs.flow_id / trigger_id / output (extiende la tabla del motor).
  // - tablas nuevas: triggers, client_sessions.
  try {
    const pagesSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='pages'"
    ).get() as { sql: string } | undefined)?.sql ?? '';
    const buttonsSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='buttons'"
    ).get() as { sql: string } | undefined)?.sql ?? '';
    const ensurePagesCol = (col: string, ddl: string) => {
      if (!pagesSql.includes(col)) {
        try { db.exec(`ALTER TABLE pages ADD COLUMN ${ddl}`); console.log(`📝 Migration 5: added pages.${col}`); }
        catch (e) { console.error(`❌ Migration 5 failed for pages.${col}:`, e); }
      }
    };
    const ensureButtonsCol = (col: string, ddl: string) => {
      if (!buttonsSql.includes(col)) {
        try { db.exec(`ALTER TABLE buttons ADD COLUMN ${ddl}`); console.log(`📝 Migration 5: added buttons.${col}`); }
        catch (e) { console.error(`❌ Migration 5 failed for buttons.${col}:`, e); }
      }
    };
    ensurePagesCol('parent_id', 'parent_id TEXT');
    ensurePagesCol('grid_cols', 'grid_cols INTEGER');
    ensurePagesCol('grid_rows', 'grid_rows INTEGER');
    ensureButtonsCol('widget_type', "widget_type TEXT DEFAULT 'action_button'");
    ensureButtonsCol('x', 'x INTEGER');
    ensureButtonsCol('y', 'y INTEGER');
    ensureButtonsCol('w', 'w INTEGER DEFAULT 1');
    ensureButtonsCol('h', 'h INTEGER DEFAULT 1');
    ensureButtonsCol('parent_widget_id', 'parent_widget_id TEXT');
    ensureButtonsCol('created_at', 'created_at INTEGER');
    ensureButtonsCol('updated_at', 'updated_at INTEGER');

    // Extiende flow_runs del motor de flujos (si la tabla aún no existe en
    // DBs intermedias, el CREATE de abajo la crea ya completa).
    const flowRunsSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='flow_runs'"
    ).get() as { sql: string } | undefined)?.sql ?? '';
    const ensureFlowRunCol = (col: string, ddl: string) => {
      if (!flowRunsSql.includes(col)) {
        try { db.exec(`ALTER TABLE flow_runs ADD COLUMN ${ddl}`); console.log(`📝 Migration 5: added flow_runs.${col}`); }
        catch (e) { console.error(`❌ Migration 5 failed for flow_runs.${col}:`, e); }
      }
    };
    ensureFlowRunCol('flow_id', 'flow_id TEXT');
    ensureFlowRunCol('trigger_id', 'trigger_id TEXT');
    ensureFlowRunCol('output', 'output TEXT');

    // Backfill: los botones legacy son widgets action_button 1x1 con
    // timestamps (la vista ButtonWidget deriva x/y de position si son NULL).
    try {
      const now = Date.now();
      db.exec(
        `UPDATE buttons SET widget_type = 'action_button' WHERE widget_type IS NULL;` +
        `UPDATE buttons SET w = 1 WHERE w IS NULL;` +
        `UPDATE buttons SET h = 1 WHERE h IS NULL;` +
        `UPDATE buttons SET created_at = ${now} WHERE created_at IS NULL;` +
        `UPDATE buttons SET updated_at = ${now} WHERE updated_at IS NULL;`
      );
    } catch (e) {
      console.error('❌ Migration 5 backfill failed:', e);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        config TEXT,
        enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(flow_id) REFERENCES flows(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS flow_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT,
        flow_id TEXT,
        trigger_id TEXT,
        output TEXT,
        FOREIGN KEY(flow_id) REFERENCES flows(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS client_sessions (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        profile_id TEXT,
        page_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        connected_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        user_agent TEXT,
        ip TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pages_parent_id ON pages(parent_id);
      CREATE INDEX IF NOT EXISTS idx_triggers_flow_id ON triggers(flow_id);
      CREATE INDEX IF NOT EXISTS idx_flow_runs_flow_id ON flow_runs(flow_id);
      CREATE INDEX IF NOT EXISTS idx_client_sessions_client_id ON client_sessions(client_id);
    `);
    console.log('✅ Migration 5 completed: nested folders + widgets + triggers/flow_runs/client_sessions');
  } catch (error) {
    console.error('❌ Migration 5 failed:', error);
  }

  // Migration 6: tablas propias del motor de flujos (no colisionan con las
  // tablas `flows`/`automations` de Fase 1, de esquema distinto).
  // En DBs nuevas ya las crea el schema base; aquí solo se cubren DBs
  // antiguas que se crearon con un schema sin estas tablas.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS flow_scripts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flow_automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flow_vars (
        name TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flow_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT
      );
    `);
    console.log('✅ Migration 6 completed: tablas del motor de flujos');
  } catch (error) {
    console.error('❌ Migration 6 failed:', error);
  }

  // Migration 7: dispositivos lógicos + asignaciones pantalla-por-perfil.
  // En DBs nuevas ya las crea el schema base; aquí solo se cubren DBs
  // antiguas. IF NOT EXISTS = idempotente.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'phone',
        model TEXT,
        cols INTEGER,
        rows INTEGER,
        hw_path TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_assignments (
        profile_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        page_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, device_id),
        FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
        FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE,
        FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assignments_profile ON profile_assignments(profile_id);
      CREATE INDEX IF NOT EXISTS idx_assignments_device ON profile_assignments(device_id);
    `);
    console.log('✅ Migration 7 completed: devices + profile_assignments');
  } catch (error) {
    console.error('❌ Migration 7 failed:', error);
  }

  console.log('✅ Database migrations completed');
}

async function installBuiltInPlugins(db: Database) {
  console.log('🔌 Installing built-in plugins...');

  // Import built-in plugins statically to avoid dynamic import issues
  const { ShellPlugin, HttpPlugin, HotkeyPlugin, TypeTextPlugin, MultimediaPlugin, OpenAppPlugin, PagePlugin, UtilityPlugin, BrowserPlugin, PCVitalsPlugin, ObsPlugin, HomeAssistantPlugin, SpotifyPlugin, DiscordPlugin, TwitchPlugin, YoutubePlugin, SoundboardPlugin, VoicemodPlugin, VoicemeeterPlugin, ShadowplayPlugin, WebcamPlugin, PhotoshopPlugin, PremierePlugin, DavinciPlugin, BlenderPlugin, MidiOscPlugin, SteamPlugin, MinecraftPlugin, HueExtraPlugin, GoveePlugin, AudioMixerPlugin, WindowManagerPlugin, MeetingsPlugin, SlackPlugin, CalendarPlugin, TimerPlugin, ClipboardPlugin, FlowControlPlugin, MultiactionPlugin, ProfileAutoPlugin, WeatherPlugin, EmailPlugin } = await import('./plugins/index');

  const builtInPlugins = [
    { id: 'shell', class: ShellPlugin },
    { id: 'http', class: HttpPlugin },
    { id: 'hotkey', class: HotkeyPlugin },
    { id: 'type-text', class: TypeTextPlugin },
    { id: 'multimedia', class: MultimediaPlugin },
    { id: 'open-app', class: OpenAppPlugin },
    { id: 'page', class: PagePlugin },
    { id: 'utility', class: UtilityPlugin },
    { id: 'browser', class: BrowserPlugin },
    { id: 'pc-vitals', class: PCVitalsPlugin },
    { id: 'obs', class: ObsPlugin },
    { id: 'homeassistant', class: HomeAssistantPlugin },
    { id: 'spotify', class: SpotifyPlugin },
    { id: 'discord', class: DiscordPlugin },
    { id: 'twitch', class: TwitchPlugin },
    { id: 'youtube', class: YoutubePlugin },
    { id: 'soundboard', class: SoundboardPlugin },
    { id: 'voicemod', class: VoicemodPlugin },
    { id: 'voicemeeter', class: VoicemeeterPlugin },
    { id: 'shadowplay', class: ShadowplayPlugin },
    { id: 'webcam', class: WebcamPlugin },
    { id: 'photoshop', class: PhotoshopPlugin },
    { id: 'premiere', class: PremierePlugin },
    { id: 'davinci', class: DavinciPlugin },
    { id: 'blender', class: BlenderPlugin },
    { id: 'midi-osc', class: MidiOscPlugin },
    { id: 'steam', class: SteamPlugin },
    { id: 'minecraft', class: MinecraftPlugin },
    { id: 'hue-extra', class: HueExtraPlugin },
    { id: 'govee', class: GoveePlugin },
    { id: 'audio-mixer', class: AudioMixerPlugin },
    { id: 'window-manager', class: WindowManagerPlugin },
    { id: 'meetings', class: MeetingsPlugin },
    { id: 'slack', class: SlackPlugin },
    { id: 'calendar', class: CalendarPlugin },
    { id: 'timer', class: TimerPlugin },
    { id: 'clipboard', class: ClipboardPlugin },
    { id: 'flow', class: FlowControlPlugin },
    { id: 'multiaction', class: MultiactionPlugin },
    { id: 'profile-auto', class: ProfileAutoPlugin },
    { id: 'weather', class: WeatherPlugin },
    { id: 'email', class: EmailPlugin }
  ];

  const insertIgnore = db.prepare(`
    INSERT OR IGNORE INTO plugins (id, name, version, manifest, enabled, installed_at, updated_at, source_type, origin, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'builtin', 'builtin', 'active')
  `);
  const updateIfNewer = db.prepare(`
    UPDATE plugins SET name = ?, version = ?, manifest = ?, updated_at = ?, status = 'active' WHERE id = ? AND version != ?
  `);
  const getVersion = db.prepare('SELECT version, enabled FROM plugins WHERE id = ?');

  for (const pluginInfo of builtInPlugins) {
    try {
      const pluginInstance = new pluginInfo.class({ log: () => {} });
      const manifest = pluginInstance.getManifest();

      const existing = getVersion.get(manifest.id) as { version: string; enabled: number } | undefined;
      if (!existing) {
        insertIgnore.run(manifest.id, manifest.name, manifest.version, JSON.stringify(manifest), 1, Date.now(), Date.now());
        console.log(`✅ Installed built-in plugin: ${manifest.name} v${manifest.version}`);
      } else if (existing.version !== manifest.version) {
        // Actualizar solo si versión cambió, preservando enabled
        updateIfNewer.run(manifest.name, manifest.version, JSON.stringify(manifest), Date.now(), manifest.id, manifest.version);
        console.log(`🔄 Updated built-in plugin: ${manifest.name} ${existing.version} → ${manifest.version}`);
      } else {
        // Solo actualizar manifest si cambió sin bump (ej. permisos)
        db.prepare('UPDATE plugins SET manifest = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(manifest), Date.now(), manifest.id);
      }
    } catch (error) {
      console.error(`❌ Failed to install built-in plugin ${pluginInfo.id}:`, error);
    }
  }

  console.log('✅ Built-in plugins installation completed');
}

// Funciones de utilidad para acceso a datos

export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

function safeParseManifest(text: string): any {
  try { return JSON.parse(text); }
  catch { return { id: 'unknown', name: 'unknown', version: '0.0.0', permissions: [], actions: [] }; }
}

function parseJsonSafe(text: any): any {
  if (text === null || text === undefined) return {};
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); }
  catch { return {}; }
}

function parseVariableValue(text: any): any {
  if (text === null || text === undefined) return null;
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); }
  catch { return text; }
}

function normalizeFlowRow(r: any): Flow {
  return {
    id: r.id,
    name: r.name,
    data: parseJsonSafe(r.data),
    created_at: r.created_at,
    updated_at: r.updated_at ?? null,
  };
}

function normalizeAutomationRow(r: any): Automation {
  return {
    id: r.id,
    name: r.name,
    enabled: Number(r.enabled ?? 1),
    trigger: parseJsonSafe(r.trigger),
    data: parseJsonSafe(r.data),
    created_at: r.created_at,
    updated_at: r.updated_at ?? null,
  };
}

function normalizeWidgetRow(r: any): Widget {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind ?? null,
    data: parseJsonSafe(r.data),
    created_at: r.created_at,
    updated_at: r.updated_at ?? null,
  };
}

// Funciones de utilidad para acceso a datos
export class DatabaseService {
  private db: Database;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Checkpoint WAL para que el backup de db.sqlite sea consistente.
   * Best-effort: lo llama POST /api/v1/admin/prepare-update antes de un
   * update gestionado. Nunca lanza.
   */
  checkpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // noop: no bloquear el update por esto
    }
  }

  // Settings
  getSetting(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    const result = stmt.get(key) as { value: string } | undefined;
    return result?.value || null;
  }

  setSetting(key: string, value: string): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    stmt.run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  /** Todos los ajustes como mapa clave → valor (para MCP list_settings). */
  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // ---- Motor de flujos: scripts reutilizables ----

  listFlowScripts(): Array<{ id: string; name: string; inputs?: string[]; timeout?: number; nodes: any[]; created_at: number; updated_at: number }> {
    const rows = this.db.prepare('SELECT * FROM flow_scripts ORDER BY updated_at DESC').all() as any[];
    return rows.map((r) => ({ id: r.id, name: r.name, ...(this.safeParseFlowData(r.data)), created_at: r.created_at, updated_at: r.updated_at }));
  }

  getFlowScript(id: string): { id: string; name: string; inputs?: string[]; timeout?: number; nodes: any[]; created_at: number; updated_at: number } | null {
    const r = this.db.prepare('SELECT * FROM flow_scripts WHERE id = ?').get(id) as any;
    if (!r) return null;
    return { id: r.id, name: r.name, ...(this.safeParseFlowData(r.data)), created_at: r.created_at, updated_at: r.updated_at };
  }

  saveFlowScript(s: { id: string; name: string; inputs?: string[]; timeout?: number; nodes: any[] }): void {
    const now = Date.now();
    const existing = this.db.prepare('SELECT created_at FROM flow_scripts WHERE id = ?').get(s.id) as any;
    const created = existing?.created_at ?? now;
    this.db.prepare(
      'INSERT OR REPLACE INTO flow_scripts (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(s.id, s.name, JSON.stringify({ inputs: s.inputs ?? [], timeout: s.timeout, nodes: s.nodes ?? [] }), created, now);
  }

  deleteFlowScript(id: string): void {
    this.db.prepare('DELETE FROM flow_scripts WHERE id = ?').run(id);
  }

  private safeParseFlowData(text: string): any {
    try {
      const v = JSON.parse(text);
      return v && typeof v === 'object' ? v : { nodes: [] };
    } catch { return { nodes: [] }; }
  }

  // ---- Motor de flujos: automatizaciones globales (tabla propia
  // `flow_automations`; no confundir con `automations` de Fase 1) ----

  listFlowAutomations(): Array<{ id: string; name: string; enabled: boolean; trigger: any; scriptId?: string; nodes?: any[]; inputs?: any; scope?: any; created_at: number; updated_at: number }> {
    const rows = this.db.prepare('SELECT * FROM flow_automations ORDER BY updated_at DESC').all() as any[];
    return rows.map((r) => ({ id: r.id, name: r.name, ...(this.safeParseFlowData(r.data)), created_at: r.created_at, updated_at: r.updated_at }));
  }

  getFlowAutomation(id: string): { id: string; name: string; enabled: boolean; trigger: any; scriptId?: string; nodes?: any[]; inputs?: any; scope?: any; created_at: number; updated_at: number } | null {
    const r = this.db.prepare('SELECT * FROM flow_automations WHERE id = ?').get(id) as any;
    if (!r) return null;
    return { id: r.id, name: r.name, ...(this.safeParseFlowData(r.data)), created_at: r.created_at, updated_at: r.updated_at };
  }

  saveFlowAutomation(a: { id: string; name: string; enabled?: boolean; trigger: any; scriptId?: string; nodes?: any[]; inputs?: any; scope?: any }): void {
    const now = Date.now();
    const existing = this.db.prepare('SELECT created_at FROM flow_automations WHERE id = ?').get(a.id) as any;
    const created = existing?.created_at ?? now;
    this.db.prepare(
      'INSERT OR REPLACE INTO flow_automations (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(a.id, a.name, JSON.stringify({
      enabled: a.enabled !== false,
      trigger: a.trigger,
      scriptId: a.scriptId,
      nodes: a.nodes ?? [],
      inputs: a.inputs ?? {},
      scope: a.scope,
    }), created, now);
  }

  deleteFlowAutomation(id: string): void {
    this.db.prepare('DELETE FROM flow_automations WHERE id = ?').run(id);
  }

  // ---- Motor de flujos: variables globales ----

  listFlowVars(): Array<{ name: string; type: 'num' | 'bool' | 'txt'; value: any }> {
    const rows = this.db.prepare('SELECT * FROM flow_vars ORDER BY name').all() as any[];
    return rows.map((r) => ({ name: r.name, type: r.type, value: this.safeParseVarValue(r.value) }));
  }

  getFlowVar(name: string): { name: string; type: 'num' | 'bool' | 'txt'; value: any } | null {
    const r = this.db.prepare('SELECT * FROM flow_vars WHERE name = ?').get(name) as any;
    if (!r) return null;
    return { name: r.name, type: r.type, value: this.safeParseVarValue(r.value) };
  }

  setFlowVar(v: { name: string; type: 'num' | 'bool' | 'txt'; value: any }): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO flow_vars (name, type, value, updated_at) VALUES (?, ?, ?, ?)'
    ).run(v.name, v.type, JSON.stringify(v.value ?? null), Date.now());
  }

  deleteFlowVar(name: string): void {
    this.db.prepare('DELETE FROM flow_vars WHERE name = ?').run(name);
  }

  private safeParseVarValue(text: string): any {
    try { return JSON.parse(text); } catch { return text; }
  }

  // ---- Motor de flujos: historial de ejecuciones ----

  createFlowRun(r: { id: string; kind: string; label: string; status: string; started_at: number; finished_at?: number; error?: string }): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO flow_runs (id, kind, label, status, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(r.id, r.kind, r.label, r.status, r.started_at, r.finished_at ?? null, r.error ?? null);
  }

  updateFlowRun(id: string, patch: Partial<{ kind: string; label: string; status: string; finished_at: number; error: string }>): void {
    const parts: string[] = [];
    const vals: any[] = [];
    if (patch.kind !== undefined) { parts.push('kind = ?'); vals.push(patch.kind); }
    if (patch.label !== undefined) { parts.push('label = ?'); vals.push(patch.label); }
    if (patch.status !== undefined) { parts.push('status = ?'); vals.push(patch.status); }
    if (patch.finished_at !== undefined) { parts.push('finished_at = ?'); vals.push(patch.finished_at); }
    if (patch.error !== undefined) { parts.push('error = ?'); vals.push(patch.error); }
    if (!parts.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE flow_runs SET ${parts.join(', ')} WHERE id = ?`).run(...vals);
  }

  listFlowRuns(limit: number = 100): Array<{ id: string; kind: string; label: string; status: string; started_at: number; finished_at?: number; error?: string }> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit) || 100));
    return this.db.prepare('SELECT * FROM flow_runs ORDER BY started_at DESC LIMIT ?').all(n) as any[];
  }

  // Variables tipadas persistentes (servicio daemon de variables).
  // `value` se guarda serializado como TEXT; la coerción vive en
  // variables/types.ts. `bindings` es JSON ({ read?, write? }) o null.
  listVariableRows(scope?: string, scopeId?: string): VariableRow[] {
    let sql = 'SELECT * FROM variables';
    const params: any[] = [];
    const where: string[] = [];
    if (scope !== undefined) { where.push('scope = ?'); params.push(scope); }
    if (scopeId !== undefined) { where.push('scope_id = ?'); params.push(scopeId); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY scope, scope_id, name';
    return this.db.prepare(sql).all(...params) as VariableRow[];
  }

  getVariableRow(name: string, scope: string = 'global', scopeId: string = ''): VariableRow | null {
    const row = this.db.prepare(
      'SELECT * FROM variables WHERE scope = ? AND scope_id = ? AND name = ?'
    ).get(scope, scopeId, name) as VariableRow | undefined;
    return row ?? null;
  }

  setVariableRow(row: Omit<VariableRow, 'updated_at'> & { updated_at?: number }): void {
    this.db.prepare(`
      INSERT INTO variables (name, scope, scope_id, type, value, unavailable, bindings, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, scope_id, name) DO UPDATE SET
        type = excluded.type,
        value = excluded.value,
        unavailable = excluded.unavailable,
        bindings = excluded.bindings,
        updated_at = excluded.updated_at
    `).run(
      row.name, row.scope, row.scope_id, row.type, row.value,
      row.unavailable ? 1 : 0, row.bindings ?? null, row.updated_at ?? Date.now()
    );
  }

  deleteVariableRow(name: string, scope: string = 'global', scopeId: string = ''): boolean {
    const r = this.db.prepare(
      'DELETE FROM variables WHERE scope = ? AND scope_id = ? AND name = ?'
    ).run(scope, scopeId, name);
    return (r as any)?.changes > 0;
  }

  // Profiles
  getProfiles(): Profile[] {
    const stmt = this.db.prepare('SELECT * FROM profiles ORDER BY updated_at DESC');
    return stmt.all() as Profile[];
  }

  getProfile(id: string): Profile | null {
    const stmt = this.db.prepare('SELECT * FROM profiles WHERE id = ?');
    return stmt.get(id) as Profile || null;
  }

  createProfile(profile: Omit<Profile, 'created_at' | 'updated_at'>): Profile {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO profiles (id, name, created_at, updated_at, data) 
      VALUES (?, ?, ?, ?, ?)
    `);

    const fullProfile: Profile = {
      ...profile,
      created_at: now,
      updated_at: now
    };

    stmt.run(profile.id, profile.name, now, now, JSON.stringify(profile.data));
    return fullProfile;
  }

  updateProfile(id: string, updates: Partial<Profile>): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE profiles 
      SET name = COALESCE(?, name), 
          data = COALESCE(?, data), 
          updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      updates.name || null,
      updates.data ? JSON.stringify(updates.data) : null,
      now,
      id
    );
  }

  deleteProfile(id: string): void {
    const stmt = this.db.prepare('DELETE FROM profiles WHERE id = ?');
    stmt.run(id);
    // Limpieza manual (las FK son documentales: SQLite no las aplica sin PRAGMA).
    this.db.prepare('DELETE FROM profile_assignments WHERE profile_id = ?').run(id);
  }

  // ---- Dispositivos lógicos + asignaciones por perfil ----

  listDevices(): LogicalDevice[] {
    return this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as LogicalDevice[];
  }

  /** Todas las asignaciones con pantalla (para backups). */
  listAllAssignments(): Array<{ profile_id: string; device_id: string; page_id: string }> {
    return this.db.prepare(
      'SELECT profile_id, device_id, page_id FROM profile_assignments WHERE page_id IS NOT NULL'
    ).all() as Array<{ profile_id: string; device_id: string; page_id: string }>;
  }

  getDevice(id: string): LogicalDevice | null {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as LogicalDevice || null;
  }

  createDevice(device: Omit<LogicalDevice, 'created_at' | 'updated_at'>): LogicalDevice {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO devices (id, name, kind, model, cols, rows, hw_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      device.id, device.name, device.kind, device.model ?? null,
      device.cols ?? null, device.rows ?? null, device.hw_path ?? null, now, now,
    );
    return { ...device, created_at: now, updated_at: now } as LogicalDevice;
  }

  updateDevice(id: string, updates: Partial<Pick<LogicalDevice, 'name' | 'kind' | 'model' | 'cols' | 'rows' | 'hw_path'>>): LogicalDevice | null {
    const setParts: string[] = [];
    const values: any[] = [];
    for (const k of ['name', 'kind', 'model', 'cols', 'rows', 'hw_path'] as const) {
      if (updates[k] !== undefined) {
        setParts.push(`${k} = ?`);
        values.push(updates[k]);
      }
    }
    if (setParts.length > 0) {
      setParts.push('updated_at = ?');
      values.push(Date.now());
      values.push(id);
      this.db.prepare(`UPDATE devices SET ${setParts.join(', ')} WHERE id = ?`).run(...values);
    }
    return this.getDevice(id);
  }

  deleteDevice(id: string): void {
    this.db.prepare('DELETE FROM profile_assignments WHERE device_id = ?').run(id);
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  /** deviceId → pageId (solo filas con página asignada). */
  getAssignments(profileId: string): Record<string, string> {
    const rows = this.db.prepare(
      'SELECT device_id, page_id FROM profile_assignments WHERE profile_id = ? AND page_id IS NOT NULL'
    ).all(profileId) as Array<{ device_id: string; page_id: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.device_id] = r.page_id;
    return out;
  }

  /** Fija (o quita con pageId null) la pantalla de un dispositivo en un perfil. */
  setAssignment(profileId: string, deviceId: string, pageId: string | null): void {
    this.db.prepare(`
      INSERT INTO profile_assignments (profile_id, device_id, page_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, device_id) DO UPDATE SET page_id = excluded.page_id, updated_at = excluded.updated_at
    `).run(profileId, deviceId, pageId, Date.now());
  }

  clearAssignment(profileId: string, deviceId: string): void {
    this.db.prepare('DELETE FROM profile_assignments WHERE profile_id = ? AND device_id = ?').run(profileId, deviceId);
  }

  /**
   * Repara las asignaciones de un perfil: quita las inválidas (dispositivo
   * o página inexistente, página incompatible) y auto-asigna la primera
   * raíz compatible a cada dispositivo sin pantalla. Devuelve el detalle
   * para que la API lo difunda (toasts/deshacer en el frontend).
   */
  repairAssignments(profileId: string): import('./devices').AssignmentFix {
    const profile = this.getProfile(profileId);
    const pages = this.getPagesByProfile(profileId).map((p) => ({
      id: p.id,
      profile_id: p.profile_id,
      name: p.name,
      is_folder: p.is_folder,
      parent_id: p.parent_id ?? null,
      grid_cols: p.grid_cols ?? null,
      grid_rows: p.grid_rows ?? null,
      data: p.data,
    }));
    const devices = this.listDevices().map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind as 'deck' | 'phone' | 'tablet',
      model: d.model,
      cols: d.cols,
      rows: d.rows,
    }));
    const current = this.getAssignments(profileId);
    const fixed = fixAssignments({ pages, devices, assignments: current, profileData: profile?.data });
    // Persistir: reescribir las asignaciones del perfil con el resultado.
    this.db.prepare('DELETE FROM profile_assignments WHERE profile_id = ?').run(profileId);
    for (const [deviceId, pageId] of Object.entries(fixed.assignments)) {
      this.setAssignment(profileId, deviceId, pageId);
    }
    return fixed;
  }

  // Pages
  getPagesByProfile(profileId: string): Page[] {
    const stmt = this.db.prepare('SELECT * FROM pages WHERE profile_id = ? ORDER BY order_idx');
    const pages = stmt.all(profileId) as Page[];
    
    // Remove duplicates by name, keeping the first occurrence
    const seenNames = new Set<string>();
    return pages.filter(page => {
      if (seenNames.has(page.name)) {
        return false;
      }
      seenNames.add(page.name);
      return true;
    });
  }

  getPage(id: string): Page | null {
    const stmt = this.db.prepare('SELECT * FROM pages WHERE id = ?');
    return stmt.get(id) as Page || null;
  }

  createPage(page: Page): void {
    // Check if a page with the same name already exists in this profile
    const existingStmt = this.db.prepare('SELECT id FROM pages WHERE profile_id = ? AND name = ?');
    const existing = existingStmt.get(page.profile_id, page.name);
    
    if (existing) {
      throw new Error(`A page with the name "${page.name}" already exists in this profile`);
    }

    // Fase 1: valida el padre (misma profile, sin ciclos) antes de insertar.
    if (page.parent_id !== undefined && page.parent_id !== null) {
      this.assertValidPageParent(page.parent_id, page.profile_id, page.id);
    }
    
    const stmt = this.db.prepare(`
      INSERT INTO pages (id, profile_id, name, order_idx, is_folder, parent_id, grid_cols, grid_rows, data) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      page.id, page.profile_id, page.name, page.order_idx, page.is_folder || 0,
      page.parent_id ?? null, page.grid_cols ?? null, page.grid_rows ?? null,
      JSON.stringify(page.data)
    );
  }

  updatePage(id: string, updates: Partial<Pick<Page, 'name' | 'order_idx' | 'is_folder' | 'data' | 'parent_id' | 'grid_cols' | 'grid_rows'>>): void {
    const setParts = [];
    const values = [];

    if (updates.name !== undefined) {
      // Check if another page with the same name already exists in this profile
      const existingStmt = this.db.prepare('SELECT profile_id FROM pages WHERE id = ?');
      const currentPage = existingStmt.get(id) as { profile_id: string } | undefined;
      
      if (currentPage) {
        const duplicateStmt = this.db.prepare('SELECT id FROM pages WHERE profile_id = ? AND name = ? AND id != ?');
        const duplicate = duplicateStmt.get(currentPage.profile_id, updates.name, id);
        
        if (duplicate) {
          throw new Error(`A page with the name "${updates.name}" already exists in this profile`);
        }
      }
      
      setParts.push('name = ?');
      values.push(updates.name);
    }

    if (updates.order_idx !== undefined) {
      setParts.push('order_idx = ?');
      values.push(updates.order_idx);
    }

    if (updates.is_folder !== undefined) {
      setParts.push('is_folder = ?');
      values.push(updates.is_folder);
    }

    if (updates.parent_id !== undefined) {
      // Mover a raíz (null) o a otra carpeta: valida mismo perfil y sin ciclos.
      const self = this.db.prepare('SELECT profile_id FROM pages WHERE id = ?').get(id) as { profile_id: string } | undefined;
      if (!self) throw new Error(`Página no encontrada: ${id}`);
      if (updates.parent_id !== null) {
        this.assertValidPageParent(updates.parent_id, self.profile_id, id);
      }
      setParts.push('parent_id = ?');
      values.push(updates.parent_id);
    }

    if (updates.grid_cols !== undefined) {
      setParts.push('grid_cols = ?');
      values.push(updates.grid_cols);
    }

    if (updates.grid_rows !== undefined) {
      setParts.push('grid_rows = ?');
      values.push(updates.grid_rows);
    }

    if (updates.data !== undefined) {
      setParts.push('data = ?');
      values.push(JSON.stringify(updates.data));
    }

    if (setParts.length === 0) return;

    const sql = `UPDATE pages SET ${setParts.join(', ')} WHERE id = ?`;
    values.push(id);

    const stmt = this.db.prepare(sql);
    stmt.run(...values);
  }

  deletePage(id: string): void {
    const stmt = this.db.prepare('DELETE FROM pages WHERE id = ?');
    stmt.run(id);
    // Las asignaciones que apuntaban a esta página quedan sin pantalla.
    this.db.prepare('DELETE FROM profile_assignments WHERE page_id = ?').run(id);
  }

  // ---- Fase 1: carpetas anidadas (pages con is_folder=1 + parent_id) ----
  // El perfil es la raíz; parent_id NULL = nivel raíz del perfil.

  /** Hijas directas de una carpeta (o de la raíz si parentId es null). */
  getChildPages(profileId: string, parentId: string | null): Page[] {
    const stmt = parentId === null
      ? this.db.prepare('SELECT * FROM pages WHERE profile_id = ? AND parent_id IS NULL ORDER BY order_idx')
      : this.db.prepare('SELECT * FROM pages WHERE profile_id = ? AND parent_id = ? ORDER BY order_idx');
    const rows = (parentId === null ? stmt.all(profileId) : stmt.all(profileId, parentId)) as Page[];
    return rows;
  }

  /**
   * Valida que `parentId` pueda ser padre de `childId` dentro de `profileId`:
   * existe, pertenece al mismo perfil y no crea ciclos. Lanza Error si no.
   */
  assertValidPageParent(parentId: string, profileId: string, childId: string): void {
    if (parentId === childId) throw new Error('Una página no puede ser su propia carpeta padre');
    const parent = this.db.prepare('SELECT id, profile_id FROM pages WHERE id = ?').get(parentId) as { id: string; profile_id: string } | undefined;
    if (!parent) throw new Error(`Carpeta padre no encontrada: ${parentId}`);
    if (parent.profile_id !== profileId) throw new Error('La carpeta padre pertenece a otro perfil');
    // Camina hacia arriba desde el padre: si alcanza childId hay ciclo.
    let cursor: string | null = parentId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === childId) throw new Error('Mover aquí crearía un ciclo de carpetas');
      if (seen.has(cursor)) break; // grafo corrupto: no colgar
      seen.add(cursor);
      const row = this.db.prepare('SELECT parent_id FROM pages WHERE id = ?').get(cursor) as { parent_id: string | null } | undefined;
      cursor = row?.parent_id ?? null;
    }
  }

  /** Mueve una página/carpeta a otra carpeta (o a la raíz con null). */
  setPageParent(id: string, parentId: string | null): void {
    const self = this.getPage(id);
    if (!self) throw new Error(`Página no encontrada: ${id}`);
    if (parentId !== null) this.assertValidPageParent(parentId, self.profile_id, id);
    this.db.prepare('UPDATE pages SET parent_id = ? WHERE id = ?').run(parentId, id);
  }

  /** Árbol de páginas/carpetas de un perfil (hijos anidados en `children`). */
  getPageTree(profileId: string): Array<Page & { children: Array<Page & { children: any[] }> }> {
    const all = this.db.prepare('SELECT * FROM pages WHERE profile_id = ? ORDER BY order_idx').all(profileId) as Page[];
    const byParent = new Map<string | null, Page[]>();
    for (const p of all) {
      const key = p.parent_id ?? null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(p);
    }
    // Huerfanos (padre inexistente): se cuelgan de la raíz para no perderlos.
    const known = new Set(all.map(p => p.id));
    for (const p of all) {
      if (p.parent_id !== null && p.parent_id !== undefined && !known.has(p.parent_id)) {
        byParent.get(null)!.push(p);
      }
    }
    const build = (parentId: string | null): any[] =>
      (byParent.get(parentId) ?? [])
        .filter(p => parentId !== null || p.parent_id === null || p.parent_id === undefined || !known.has(p.parent_id as string))
        .map(p => ({ ...p, children: build(p.id) }));
    return build(null);
  }

  // ---- Fase 1: botones como widgets redimensionables ----
  // La fila `buttons` ES el widget. Compat API v1: `position` se conserva
  // y los endpoints /api/v1/buttons* no cambian.

  private parseButtonRow(button: any): Button {
    return {
      ...button,
      widget_type: button.widget_type ?? 'action_button',
      w: button.w ?? 1,
      h: button.h ?? 1,
      data: typeof button.data === 'string' ? JSON.parse(button.data) : button.data,
    };
  }

  /**
   * Vista widget de una fila de botón. Un botón legacy (x/y NULL) deriva
   * su geometría de `position` en una rejilla de LEGACY_GRID_COLS columnas.
   */
  toButtonWidget(button: Button): ButtonWidget {
    const x = button.x ?? (button.position % LEGACY_GRID_COLS);
    const y = button.y ?? Math.floor(button.position / LEGACY_GRID_COLS);
    return {
      id: button.id,
      page_id: button.page_id,
      kind: button.widget_type ?? 'action_button',
      x, y,
      w: button.w ?? 1,
      h: button.h ?? 1,
      position: button.position,
      parent_widget_id: button.parent_widget_id ?? null,
      data: button.data,
    };
  }

  /** Todos los widgets (botones) de una página, con geometría resuelta. */
  getButtonWidgetsByPage(pageId: string): ButtonWidget[] {
    return this.getButtonsByPage(pageId).map(b => this.toButtonWidget(b));
  }

  private assertWidgetGeometry(w?: number | null, h?: number | null, x?: number | null, y?: number | null): void {
    for (const [k, v] of [['w', w], ['h', h]] as const) {
      if (v !== undefined && v !== null && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 32)) {
        throw new Error(`Dimensión de widget inválida: ${k}=${v} (entero 1..32)`);
      }
    }
    for (const [k, v] of [['x', x], ['y', y]] as const) {
      if (v !== undefined && v !== null && (!Number.isInteger(v) || (v as number) < 0)) {
        throw new Error(`Posición de widget inválida: ${k}=${v} (entero >= 0)`);
      }
    }
  }

  /** Siguiente position libre en una página (max + 1, o 0 si vacía). */
  nextButtonPosition(pageId: string): number {
    const row = this.db.prepare('SELECT MAX(position) as m FROM buttons WHERE page_id = ?').get(pageId) as { m: number | null } | undefined;
    return (row?.m ?? -1) + 1;
  }

  /**
   * Crea un botón-widget. Si no se da `position`, ocupa el siguiente slot
   * libre (compat con el UNIQUE(page_id, position) de la migración 3).
   */
  createButtonWidget(input: {
    id: string; page_id: string; position?: number; kind?: string;
    x?: number | null; y?: number | null; w?: number | null; h?: number | null;
    parent_widget_id?: string | null; data?: any;
  }): Button {
    if (!input.id || typeof input.id !== 'string') throw new Error('id requerido (string)');
    if (!input.page_id || typeof input.page_id !== 'string') throw new Error('page_id requerido (string)');
    const page = this.getPage(input.page_id);
    if (!page) throw new Error(`Página no encontrada: ${input.page_id}`);
    this.assertWidgetGeometry(input.w, input.h, input.x, input.y);
    const now = Date.now();
    const position = input.position ?? this.nextButtonPosition(input.page_id);
    if (!Number.isInteger(position) || position < 0) throw new Error(`position inválida: ${input.position}`);
    this.db.prepare(`
      INSERT INTO buttons (id, page_id, position, data, widget_type, x, y, w, h, parent_widget_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.page_id, position, JSON.stringify(input.data ?? {}),
      input.kind ?? 'action_button', input.x ?? null, input.y ?? null,
      input.w ?? 1, input.h ?? 1, input.parent_widget_id ?? null, now, now
    );
    return this.getButton(input.id)!;
  }

  /** Actualiza geometría/tipo/datos/posición de un botón-widget. */
  updateButtonWidget(id: string, updates: {
    kind?: string; x?: number | null; y?: number | null; w?: number | null; h?: number | null;
    parent_widget_id?: string | null; data?: any; position?: number; page_id?: string;
  }): Button {
    const existing = this.getButton(id);
    if (!existing) throw new Error(`Botón no encontrado: ${id}`);
    this.assertWidgetGeometry(updates.w, updates.h, updates.x, updates.y);
    if (updates.page_id !== undefined && updates.page_id !== existing.page_id) {
      const dest = this.getPage(updates.page_id);
      if (!dest) throw new Error(`Página destino no encontrada: ${updates.page_id}`);
    }
    if (updates.position !== undefined && (!Number.isInteger(updates.position) || updates.position < 0)) {
      throw new Error(`position inválida: ${updates.position}`);
    }
    const setParts: string[] = [];
    const values: any[] = [];
    const push = (col: string, v: any) => { setParts.push(`${col} = ?`); values.push(v); };
    if (updates.kind !== undefined) push('widget_type', updates.kind);
    if (updates.x !== undefined) push('x', updates.x);
    if (updates.y !== undefined) push('y', updates.y);
    if (updates.w !== undefined) push('w', updates.w);
    if (updates.h !== undefined) push('h', updates.h);
    if (updates.parent_widget_id !== undefined) push('parent_widget_id', updates.parent_widget_id);
    if (updates.data !== undefined) push('data', JSON.stringify(updates.data));
    if (updates.position !== undefined) push('position', updates.position);
    if (updates.page_id !== undefined) push('page_id', updates.page_id);
    push('updated_at', Date.now());
    values.push(id);
    this.db.prepare(`UPDATE buttons SET ${setParts.join(', ')} WHERE id = ?`).run(...values);
    return this.getButton(id)!;
  }

  /** Borra un botón-widget. Devuelve true si existía. */
  deleteButtonWidget(id: string): boolean {
    const r = this.db.prepare('DELETE FROM buttons WHERE id = ?').run(id);
    return Number((r as any)?.changes ?? 0) > 0;
  }

  // ---- Fase 1: triggers de flows (la tabla `flows` ya existe) ----

  private normalizeTriggerRow(r: any): Trigger {
    return {
      id: r.id,
      flow_id: r.flow_id,
      kind: r.kind,
      config: typeof r.config === 'string' ? parseJsonSafe(r.config) : (r.config ?? {}),
      enabled: r.enabled ?? 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  createTrigger(t: { id: string; flow_id: string; kind: string; config?: any; enabled?: number }): Trigger {
    if (!t.id || typeof t.id !== 'string') throw new Error('id requerido (string)');
    if (!t.flow_id || typeof t.flow_id !== 'string') throw new Error('flow_id requerido (string)');
    if (!t.kind || typeof t.kind !== 'string') throw new Error('kind requerido (string)');
    if (!this.getFlow(t.flow_id)) throw new Error(`Flow no encontrado: ${t.flow_id}`);
    const now = Date.now();
    this.db.prepare('INSERT INTO triggers (id, flow_id, kind, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.flow_id, t.kind, JSON.stringify(t.config ?? {}), t.enabled ?? 1, now, now);
    return this.getTrigger(t.id)!;
  }

  getTrigger(id: string): Trigger | null {
    const r = this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as any;
    return r ? this.normalizeTriggerRow(r) : null;
  }

  listTriggersByFlow(flowId: string): Trigger[] {
    const rows = this.db.prepare('SELECT * FROM triggers WHERE flow_id = ? ORDER BY created_at').all(flowId) as any[];
    return rows.map(r => this.normalizeTriggerRow(r));
  }

  updateTrigger(id: string, updates: { kind?: string; config?: any; enabled?: number }): Trigger {
    const existing = this.getTrigger(id);
    if (!existing) throw new Error(`Trigger no encontrado: ${id}`);
    const kind = updates.kind !== undefined ? updates.kind : existing.kind;
    if (!kind || typeof kind !== 'string') throw new Error('kind inválido');
    const config = updates.config !== undefined ? updates.config : existing.config;
    const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled;
    this.db.prepare('UPDATE triggers SET kind = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(kind, JSON.stringify(config ?? {}), enabled, Date.now(), id);
    return this.getTrigger(id)!;
  }

  deleteTrigger(id: string): boolean {
    const r = this.db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
    return Number((r as any)?.changes ?? 0) > 0;
  }

  /**
   * Crea un flow con sus triggers de forma ATÓMICA (una transacción).
   * Si algún trigger falla (p.ej. kind vacío), nada se persiste (rollback).
   */
  createFlowWithTriggers(flow: { id: string; name: string; data?: any }, triggers: Array<{ id: string; kind: string; config?: any; enabled?: number }>): { flow: Flow; triggers: Trigger[] } {
    const tx = this.db.transaction(() => {
      const created = this.createFlow(flow);
      const createdTriggers: Trigger[] = [];
      for (const t of triggers ?? []) {
        createdTriggers.push(this.createTrigger({ ...t, flow_id: created.id }));
      }
      return { flow: created, triggers: createdTriggers };
    });
    return tx();
  }

  // ---- Fase 1: historial de ejecuciones de flows ----
  // Reutiliza la tabla `flow_runs` del motor de flujos (columnas base:
  // kind/label/status/started_at/finished_at/error) extendida en la
  // migración 5 con flow_id/trigger_id/output para vincular al flow.

  private normalizeFlowExecutionRow(r: any): FlowExecution {
    return {
      id: r.id,
      flow_id: r.flow_id ?? null,
      trigger_id: r.trigger_id ?? null,
      kind: r.kind,
      label: r.label,
      status: r.status,
      started_at: r.started_at,
      finished_at: r.finished_at ?? null,
      output: typeof r.output === 'string' ? parseJsonSafe(r.output) : (r.output ?? {}),
      error: r.error ?? null,
    };
  }

  startFlowExecution(run: { id: string; flow_id: string; trigger_id?: string | null; label?: string }): FlowExecution {
    if (!this.getFlow(run.flow_id)) throw new Error(`Flow no encontrado: ${run.flow_id}`);
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO flow_runs (id, kind, label, status, started_at, flow_id, trigger_id, output) VALUES (?, 'flow', ?, 'running', ?, ?, ?, ?)"
    ).run(run.id, run.label ?? run.flow_id, now, run.flow_id, run.trigger_id ?? null, JSON.stringify({}));
    return this.getFlowExecution(run.id)!;
  }

  finishFlowExecution(id: string, status: 'finished' | 'error', output?: any, error?: string | null): FlowExecution {
    const existing = this.getFlowExecution(id);
    if (!existing) throw new Error(`Ejecución no encontrada: ${id}`);
    this.db.prepare('UPDATE flow_runs SET status = ?, finished_at = ?, output = ?, error = ? WHERE id = ?')
      .run(status, Date.now(), JSON.stringify(output ?? {}), error ?? null, id);
    return this.getFlowExecution(id)!;
  }

  getFlowExecution(id: string): FlowExecution | null {
    const r = this.db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as any;
    return r ? this.normalizeFlowExecutionRow(r) : null;
  }

  listFlowExecutions(flowId: string, limit: number = 50): FlowExecution[] {
    const rows = this.db.prepare('SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY started_at DESC LIMIT ?').all(flowId, limit) as any[];
    return rows.map(r => this.normalizeFlowExecutionRow(r));
  }

  // ---- Fase 1: sesiones por cliente ----
  // Complementa a `device_sessions` (vista persistente por dispositivo):
  // client_sessions registra conexiones con presencia (heartbeat) y permite
  // listar/expulsar clientes conectados a este daemon.

  private normalizeClientSessionRow(r: any): ClientSession {
    return {
      id: r.id,
      client_id: r.client_id,
      profile_id: r.profile_id ?? null,
      page_id: r.page_id ?? null,
      status: r.status,
      connected_at: r.connected_at,
      last_seen_at: r.last_seen_at,
      user_agent: r.user_agent ?? null,
      ip: r.ip ?? null,
      meta: typeof r.meta === 'string' ? parseJsonSafe(r.meta) : (r.meta ?? {}),
    };
  }

  registerClientSession(s: {
    id: string; client_id: string; profile_id?: string | null; page_id?: string | null;
    user_agent?: string | null; ip?: string | null; meta?: any;
  }): ClientSession {
    if (!s.id || typeof s.id !== 'string') throw new Error('id requerido (string)');
    if (!s.client_id || typeof s.client_id !== 'string') throw new Error('client_id requerido (string)');
    const now = Date.now();
    this.db.prepare(`INSERT INTO client_sessions
      (id, client_id, profile_id, page_id, status, connected_at, last_seen_at, user_agent, ip, meta)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
      .run(s.id, s.client_id, s.profile_id ?? null, s.page_id ?? null, now, now, s.user_agent ?? null, s.ip ?? null, JSON.stringify(s.meta ?? {}));
    return this.getClientSession(s.id)!;
  }

  getClientSession(id: string): ClientSession | null {
    const r = this.db.prepare('SELECT * FROM client_sessions WHERE id = ?').get(id) as any;
    return r ? this.normalizeClientSessionRow(r) : null;
  }

  listClientSessions(status?: string): ClientSession[] {
    const rows = status === undefined
      ? this.db.prepare('SELECT * FROM client_sessions ORDER BY last_seen_at DESC').all() as any[]
      : this.db.prepare('SELECT * FROM client_sessions WHERE status = ? ORDER BY last_seen_at DESC').all(status) as any[];
    return rows.map(r => this.normalizeClientSessionRow(r));
  }

  /** Presencia: marca actividad y opcionalmente la vista actual. */
  heartbeatClientSession(id: string, view?: { profile_id?: string | null; page_id?: string | null }): ClientSession {
    const existing = this.getClientSession(id);
    if (!existing) throw new Error(`Sesión no encontrada: ${id}`);
    const profile_id = view?.profile_id !== undefined ? view.profile_id : existing.profile_id;
    const page_id = view?.page_id !== undefined ? view.page_id : existing.page_id;
    this.db.prepare("UPDATE client_sessions SET last_seen_at = ?, profile_id = ?, page_id = ?, status = 'active' WHERE id = ?")
      .run(Date.now(), profile_id, page_id, id);
    return this.getClientSession(id)!;
  }

  disconnectClientSession(id: string): ClientSession {
    const existing = this.getClientSession(id);
    if (!existing) throw new Error(`Sesión no encontrada: ${id}`);
    this.db.prepare("UPDATE client_sessions SET status = 'disconnected', last_seen_at = ? WHERE id = ?")
      .run(Date.now(), id);
    return this.getClientSession(id)!;
  }

  deleteClientSession(id: string): boolean {
    const r = this.db.prepare('DELETE FROM client_sessions WHERE id = ?').run(id);
    return Number((r as any)?.changes ?? 0) > 0;
  }

  /** Expulsa sesiones inactivas (last_seen anterior a `before`). Devuelve nº. */
  purgeStaleClientSessions(before: number): number {
    const r = this.db.prepare('DELETE FROM client_sessions WHERE last_seen_at < ?').run(before);
    return Number((r as any)?.changes ?? 0);
  }

  // Buttons
  getButtonsByPage(pageId: string): Button[] {
    const stmt = this.db.prepare('SELECT * FROM buttons WHERE page_id = ? ORDER BY position');
    const buttons = stmt.all(pageId) as Button[];
    // Parse JSON data field (+ defaults de widget Fase 1)
    return buttons.map(button => this.parseButtonRow(button));
  }

  getButton(id: string): Button | null {
    const stmt = this.db.prepare('SELECT * FROM buttons WHERE id = ?');
    const button = stmt.get(id) as Button;
    if (!button) return null;
    // Parse JSON data field (+ defaults de widget Fase 1)
    return this.parseButtonRow(button);
  }

  createButton(button: Button): void {
    const stmt = this.db.prepare(`
      INSERT INTO buttons (id, page_id, position, data) 
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(button.id, button.page_id, button.position, JSON.stringify(button.data));
  }

  updateButton(id: string, data: any): void {
    const stmt = this.db.prepare('UPDATE buttons SET data = ? WHERE id = ?');
    stmt.run(JSON.stringify(data), id);
  }

  updateButtonComplete(id: string, updates: { data?: any, position?: number }): void {
    const setParts = [];
    const values = [];

    if (updates.data !== undefined) {
      setParts.push('data = ?');
      values.push(JSON.stringify(updates.data));
    }

    if (updates.position !== undefined) {
      setParts.push('position = ?');
      values.push(updates.position);
    }

    if (setParts.length === 0) return;

    const sql = `UPDATE buttons SET ${setParts.join(', ')} WHERE id = ?`;
    values.push(id);

    const stmt = this.db.prepare(sql);
    stmt.run(...values);
  }

  deleteButton(id: string): void {
    const stmt = this.db.prepare('DELETE FROM buttons WHERE id = ?');
    stmt.run(id);
  }

  /**
   * Mueve un botón a otra página (y/o posición) en una sola sentencia.
   * La violación del UNIQUE(page_id, position) la debe gestionar el llamador.
   */
  moveButton(id: string, pageId: string, position?: number): void {
    const existing = this.db.prepare('SELECT id FROM pages WHERE id = ?').get(pageId);
    if (!existing) throw new Error(`Página destino no encontrada: ${pageId}`);
    if (position === undefined) {
      this.db.prepare('UPDATE buttons SET page_id = ? WHERE id = ?').run(pageId, id);
    } else {
      this.db.prepare('UPDATE buttons SET page_id = ?, position = ? WHERE id = ?').run(pageId, position, id);
    }
  }

  /**
   * Reordena botones de una página de forma ATÓMICA (una transacción).
   * Usa posiciones temporales negativas para no colisionar con el índice
   * UNIQUE(page_id, position) durante swaps/ciclos (0→1→2→0).
   * Valida que todos los ids existan y pertenezcan a la página, y que no
   * haya posiciones destino duplicadas. Lanza Error si algo no cuadra
   * (la transacción hace rollback y la BD queda intacta).
   */
  reorderButtons(pageId: string, orders: Array<{ id: string; position: number }>): Button[] {
    if (!Array.isArray(orders) || orders.length === 0) {
      throw new Error('order vacío: nada que reordenar');
    }
    const seenPos = new Set<number>();
    for (const o of orders) {
      if (!o || typeof o.id !== 'string' || !Number.isInteger(o.position) || o.position < 0) {
        throw new Error(`Orden inválido: ${JSON.stringify(o)}`);
      }
      if (seenPos.has(o.position)) {
        throw new Error(`Posición destino duplicada: ${o.position}`);
      }
      seenPos.add(o.position);
    }

    const tx = this.db.transaction(() => {
      // Validar pertenencia antes de tocar nada
      const getPage = this.db.prepare('SELECT page_id FROM buttons WHERE id = ?');
      for (const o of orders) {
        const row = getPage.get(o.id) as { page_id: string } | undefined;
        if (!row) throw new Error(`Botón no encontrado: ${o.id}`);
        if (row.page_id !== pageId) throw new Error(`Botón ${o.id} no pertenece a la página ${pageId}`);
      }
      // Fase 1: posiciones temporales negativas (fuera de colisión)
      const toTemp = this.db.prepare('UPDATE buttons SET position = ? WHERE id = ?');
      orders.forEach((o, i) => toTemp.run(-1 - i, o.id));
      // Fase 2: posiciones finales
      const toFinal = this.db.prepare('UPDATE buttons SET position = ? WHERE id = ?');
      for (const o of orders) toFinal.run(o.position, o.id);
    });
    tx();

    return this.getButtonsByPage(pageId).filter(b => seenPos.has(b.position));
  }

  // Plugins
  getPlugins(): Plugin[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM plugins ORDER BY installed_at DESC');
      return this.normalizePlugins(stmt.all() as any[]);
    } catch {
      const stmt = this.db.prepare('SELECT id, name, version, manifest, enabled, installed_at FROM plugins ORDER BY installed_at DESC');
      return this.normalizePlugins(stmt.all() as any[]);
    }
  }

  private normalizePlugins(rows: any[]): Plugin[] {
    return rows.map((r) => ({
      ...r,
      manifest: typeof r.manifest === 'string' ? safeParseManifest(r.manifest) : r.manifest,
      previous_manifest: typeof r.previous_manifest === 'string' && r.previous_manifest
        ? safeParseManifest(r.previous_manifest) : (r.previous_manifest ?? null),
    })) as Plugin[];
  }

  getPlugin(id: string): Plugin | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM plugins WHERE id = ?');
      const row = stmt.get(id) as any;
      if (!row) return null;
      return this.normalizePlugins([row])[0];
    } catch {
      return null;
    }
  }

  getEnabledPlugins(): Plugin[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM plugins WHERE enabled = 1');
      return this.normalizePlugins(stmt.all() as any[]);
    } catch {
      const stmt = this.db.prepare('SELECT id, name, version, manifest, enabled, installed_at FROM plugins WHERE enabled = 1');
      return this.normalizePlugins(stmt.all() as any[]);
    }
  }

  installPlugin(plugin: Plugin): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO plugins (id, name, version, manifest, enabled, installed_at, updated_at, source_type, origin, ref, commit_sha, checksum, status, last_error, previous_version, previous_manifest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      plugin.id,
      plugin.name,
      plugin.version,
      JSON.stringify(plugin.manifest),
      plugin.enabled,
      plugin.installed_at,
      (plugin as any).updated_at ?? now,
      (plugin as any).source_type ?? null,
      (plugin as any).origin ?? null,
      (plugin as any).ref ?? null,
      (plugin as any).commit ?? (plugin as any).commit_sha ?? null,
      (plugin as any).checksum ?? null,
      (plugin as any).status ?? (plugin.enabled ? 'active' : 'disabled'),
      (plugin as any).last_error ?? null,
      (plugin as any).previous_version ?? null,
      typeof (plugin as any).previous_manifest === 'string'
        ? (plugin as any).previous_manifest
        : (plugin as any).previous_manifest ? JSON.stringify((plugin as any).previous_manifest) : null
    );
  }

  upsertPluginRecord(rec: Partial<Plugin> & { id: string }): void {
    const existing = this.getPlugin(rec.id) as any;
    // `in` distingue "no pasar el campo" (conservar) de null explícito (limpiar).
    // Con `??` un null explícito resucitaba el valor viejo (p.ej. last_error
    // rancio tras una reinstalación que ya compila bien).
    const pick = (key: string, fallback: any): any =>
      (rec as any) && key in (rec as any) ? (rec as any)[key] : (existing?.[key] ?? fallback);
    const pickCommit = (): any => {
      if ((rec as any) && ('commit' in (rec as any) || 'commit_sha' in (rec as any))) {
        return (rec as any).commit ?? (rec as any).commit_sha ?? null;
      }
      return existing?.commit ?? existing?.commit_sha ?? null;
    };
    const merged: any = {
      name: (rec as any) && 'name' in (rec as any) ? (rec as any).name ?? rec.id : (existing?.name ?? rec.id),
      version: (rec as any) && 'version' in (rec as any) ? (rec as any).version ?? '0.0.0' : (existing?.version ?? '0.0.0'),
      manifest: (rec as any) && 'manifest' in (rec as any) ? (rec as any).manifest ?? { id: rec.id, name: rec.id, version: '0.0.0', permissions: [], actions: [] } : (existing?.manifest ?? { id: rec.id, name: rec.id, version: '0.0.0', permissions: [], actions: [] }),
      enabled: (rec as any) && 'enabled' in (rec as any) ? (rec as any).enabled ?? 1 : (existing?.enabled ?? 1),
      installed_at: existing?.installed_at ?? Date.now(),
      updated_at: Date.now(),
      source_type: pick('source_type', null),
      origin: pick('origin', null),
      ref: pick('ref', null),
      commit: pickCommit(),
      checksum: pick('checksum', null),
      status: pick('status', null),
      last_error: pick('last_error', null),
      previous_version: pick('previous_version', null),
      previous_manifest: pick('previous_manifest', null),
    };
    // Mapear commit -> commit_sha
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO plugins (id, name, version, manifest, enabled, installed_at, updated_at, source_type, origin, ref, commit_sha, checksum, status, last_error, previous_version, previous_manifest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      rec.id, merged.name, merged.version,
      typeof merged.manifest === 'string' ? merged.manifest : JSON.stringify(merged.manifest),
      merged.enabled, merged.installed_at, merged.updated_at,
      merged.source_type, merged.origin, merged.ref, merged.commit, merged.checksum,
      merged.status, merged.last_error, merged.previous_version,
      typeof merged.previous_manifest === 'string' ? merged.previous_manifest
        : merged.previous_manifest ? JSON.stringify(merged.previous_manifest) : null
    );
  }

  setPluginEnabled(id: string, enabled: boolean): void {
    const stmt = this.db.prepare('UPDATE plugins SET enabled = ?, status = ?, updated_at = ? WHERE id = ?');
    stmt.run(enabled ? 1 : 0, enabled ? 'active' : 'disabled', Date.now(), id);
  }

  deletePlugin(id: string): void {
    this.db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
  }

  /** Limpieza por sección (restore en modo 'clean'). Nunca lanza si la tabla falta. */
  clearSection(section: string): void {
    const stmts: Record<string, string[]> = {
      profiles: ['DELETE FROM buttons', 'DELETE FROM pages', 'DELETE FROM profiles'],
      pages: ['DELETE FROM buttons', 'DELETE FROM pages'],
      buttons: ['DELETE FROM buttons'],
      widgets: ['DELETE FROM widgets'],
      flows: ['DELETE FROM flows'],
      automations: ['DELETE FROM automations'],
      variables: ['DELETE FROM variables'],
      assets: ['DELETE FROM assets'],
      plugins: ['DELETE FROM plugins'],
      devices: ['DELETE FROM profile_assignments', 'DELETE FROM devices'],
      assignments: ['DELETE FROM profile_assignments'],
    };
    for (const sql of stmts[section] ?? []) {
      try { this.db.prepare(sql).run(); } catch { /* tabla ausente: noop */ }
    }
  }

  private pluginSettingKey(pluginId: string, key: string): string {
    return `plugin.${pluginId}.${key}`;
  }

  /** Ajustes generales del plugin (los del menú ⋯): mapa clave → valor. */
  getPluginSettings(pluginId: string): Record<string, string> {
    const out: Record<string, string> = {};
    try {
      const rows = this.db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(`plugin.${pluginId}.%`) as any[];
      for (const r of rows) {
        const k = String(r.key).slice(`plugin.${pluginId}.`.length);
        if (k && !k.includes('.')) out[k] = r.value;
      }
    } catch { /* sin tabla: {} */ }
    return out;
  }

  /** Guarda ajustes (solo claves simples [a-zA-Z0-9_-]+; valor vacío/null elimina). */
  setPluginSettings(pluginId: string, values: Record<string, any>): void {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new Error(`Clave de ajuste inválida: ${key}`);
      const k = this.pluginSettingKey(pluginId, key);
      if (value === null || value === undefined || value === '') {
        this.db.prepare('DELETE FROM settings WHERE key = ?').run(k);
      } else {
        const s = String(value);
        if (s.length > 8 * 1024) throw new Error(`Ajuste ${key} excede 8KB`);
        this.setSetting(k, s);
      }
    }
  }

  setPluginStatus(id: string, status: string, lastError: string | null = null): void {
    try {
      this.db.prepare('UPDATE plugins SET status = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(status, lastError, Date.now(), id);
    } catch { /* DB antigua sin columnas: ignorar */ }
  }

  // Logs
  addLog(entry: Omit<LogEntry, 'id'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO logs (level, message, meta, ts) 
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(entry.level, entry.message, JSON.stringify(entry.meta), entry.ts);
    // Tiempo real: avisa a los suscritos a 'logs' (CLI --follow, panel).
    // Sin importar ws (evita ciclo db↔ws): el server registra el manager
    // en globalThis al arrancar; si no hay WS, se omite en silencio.
    try {
      (globalThis as any).__libredeckWs?.broadcastLog?.({
        level: entry.level,
        message: entry.message,
        meta: entry.meta,
        ts: entry.ts,
      });
    } catch { /* mejor esfuerzo */ }
  }

  getLogs(limit: number = 100, level?: string): LogEntry[] {
    let query = 'SELECT * FROM logs';
    const params: any[] = [];

    if (level) {
      query += ' WHERE level = ?';
      params.push(level);
    }

    query += ' ORDER BY ts DESC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as LogEntry[];
  }

  // Assets
  listAssets(): Asset[] {
    try {
      return this.db.prepare('SELECT * FROM assets ORDER BY created_at DESC').all() as Asset[];
    } catch {
      return [];
    }
  }

  createAsset(asset: Asset): void {
    const stmt = this.db.prepare(`
      INSERT INTO assets (id, path, hash, size, created_at) 
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(asset.id, asset.path, asset.hash, asset.size, asset.created_at);
  }

  upsertAsset(asset: Asset): void {
    this.db.prepare('INSERT OR REPLACE INTO assets (id, path, hash, size, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(asset.id, asset.path, asset.hash, asset.size, asset.created_at);
  }

  deleteAsset(id: string): void {
    this.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
  }

  getAsset(id: string): Asset | null {
    const stmt = this.db.prepare('SELECT * FROM assets WHERE id = ?');
    return stmt.get(id) as Asset || null;
  }

  // ---- Transacciones (batch atómico MCP, restore) ----
  /** Ejecuta fn dentro de una transacción SQLite (rollback si lanza). */
  transaction<T>(fn: () => T): T {
    const tx = (this.db as any).transaction(fn);
    return tx();
  }

  // ---- Variables globales (scope 'global' sobre la tabla `variables`
  // con scopes del servicio de variables; el backup cubre todos los scopes) ----
  listVariables(scope?: string, scopeId?: string): Variable[] {
    const rows = this.listVariableRows(scope ?? 'global', scopeId ?? '');
    return rows.map((r) => ({
      name: r.name,
      type: r.type ?? null,
      value: parseVariableValue(r.value),
      updated_at: r.updated_at,
    }));
  }

  getVariable(name: string, scope?: string, scopeId?: string): Variable | null {
    const r = this.getVariableRow(name, scope ?? 'global', scopeId ?? '');
    if (!r) return null;
    return { name: r.name, type: r.type ?? null, value: parseVariableValue(r.value), updated_at: r.updated_at };
  }

  setVariable(name: string, value: any, type?: string | null): Variable {
    const { validateVarName, normalizeVarType } = require('./variables/types') as typeof import('./variables/types');
    const clean = validateVarName(name);
    const t = normalizeVarType(type ?? 'text');
    this.setVariableRow({
      name: clean, scope: 'global', scope_id: '', type: t,
      value: JSON.stringify(value ?? null), unavailable: 0, bindings: null,
    });
    return this.getVariable(clean)!;
  }

  deleteVariable(name: string, scope?: string, scopeId?: string): boolean {
    const r = this.db.prepare('DELETE FROM variables WHERE scope = ? AND scope_id = ? AND name = ?')
      .run(scope ?? 'global', scopeId ?? '', name);
    return Number((r as any)?.changes ?? 0) > 0;
  }

  // ---- Flows (secuencias de acciones con nombre) ----
  listFlows(): Flow[] {
    const rows = this.db.prepare('SELECT * FROM flows ORDER BY name').all() as any[];
    return rows.map(normalizeFlowRow);
  }

  getFlow(id: string): Flow | null {
    const r = this.db.prepare('SELECT * FROM flows WHERE id = ?').get(id) as any;
    return r ? normalizeFlowRow(r) : null;
  }

  createFlow(flow: { id: string; name: string; data?: any }): Flow {
    if (!flow.id || typeof flow.id !== 'string') throw new Error('id requerido (string)');
    if (!flow.name || typeof flow.name !== 'string') throw new Error('name requerido (string)');
    const now = Date.now();
    this.db.prepare('INSERT INTO flows (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(flow.id, flow.name, JSON.stringify(flow.data ?? { steps: [] }), now, now);
    return this.getFlow(flow.id)!;
  }

  updateFlow(id: string, updates: { name?: string; data?: any }): Flow {
    const existing = this.getFlow(id);
    if (!existing) throw new Error(`Flow no encontrado: ${id}`);
    const name = updates.name !== undefined ? updates.name : existing.name;
    if (!name || typeof name !== 'string') throw new Error('name inválido');
    const data = updates.data !== undefined ? updates.data : existing.data;
    this.db.prepare('UPDATE flows SET name = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(name, JSON.stringify(data ?? { steps: [] }), Date.now(), id);
    return this.getFlow(id)!;
  }

  deleteFlow(id: string): boolean {
    const r = this.db.prepare('DELETE FROM flows WHERE id = ?').run(id);
    return Number((r as any)?.changes ?? 0) > 0;
  }

  // ---- Automations (trigger + acciones) ----
  listAutomations(): Automation[] {
    const rows = this.db.prepare('SELECT * FROM automations ORDER BY name').all() as any[];
    return rows.map(normalizeAutomationRow);
  }

  getAutomation(id: string): Automation | null {
    const r = this.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as any;
    return r ? normalizeAutomationRow(r) : null;
  }

  createAutomation(a: { id: string; name: string; enabled?: number; trigger?: any; data?: any }): Automation {
    if (!a.id || typeof a.id !== 'string') throw new Error('id requerido (string)');
    if (!a.name || typeof a.name !== 'string') throw new Error('name requerido (string)');
    const now = Date.now();
    this.db.prepare('INSERT INTO automations (id, name, enabled, trigger, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.name, a.enabled ?? 1, JSON.stringify(a.trigger ?? {}), JSON.stringify(a.data ?? { actions: [] }), now, now);
    return this.getAutomation(a.id)!;
  }

  updateAutomation(id: string, updates: { name?: string; enabled?: number; trigger?: any; data?: any }): Automation {
    const existing = this.getAutomation(id);
    if (!existing) throw new Error(`Automatización no encontrada: ${id}`);
    const name = updates.name !== undefined ? updates.name : existing.name;
    if (!name || typeof name !== 'string') throw new Error('name inválido');
    const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled;
    const trigger = updates.trigger !== undefined ? updates.trigger : existing.trigger;
    const data = updates.data !== undefined ? updates.data : existing.data;
    this.db.prepare('UPDATE automations SET name = ?, enabled = ?, trigger = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(name, enabled, JSON.stringify(trigger ?? {}), JSON.stringify(data ?? { actions: [] }), Date.now(), id);
    return this.getAutomation(id)!;
  }

  deleteAutomation(id: string): boolean {
    const r = this.db.prepare('DELETE FROM automations WHERE id = ?').run(id);
    return Number((r as any)?.changes ?? 0) > 0;
  }

  // ---- Widgets ----
  listWidgets(): Widget[] {
    const rows = this.db.prepare('SELECT * FROM widgets ORDER BY name').all() as any[];
    return rows.map(normalizeWidgetRow);
  }

  getWidget(id: string): Widget | null {
    const r = this.db.prepare('SELECT * FROM widgets WHERE id = ?').get(id) as any;
    return r ? normalizeWidgetRow(r) : null;
  }

  createWidget(w: { id: string; name: string; kind?: string | null; data?: any }): Widget {
    if (!w.id || typeof w.id !== 'string') throw new Error('id requerido (string)');
    if (!w.name || typeof w.name !== 'string') throw new Error('name requerido (string)');
    const now = Date.now();
    this.db.prepare('INSERT INTO widgets (id, name, kind, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(w.id, w.name, w.kind ?? null, JSON.stringify(w.data ?? {}), now, now);
    return this.getWidget(w.id)!;
  }

  updateWidget(id: string, updates: { name?: string; kind?: string | null; data?: any }): Widget {
    const existing = this.getWidget(id);
    if (!existing) throw new Error(`Widget no encontrado: ${id}`);
    const name = updates.name !== undefined ? updates.name : existing.name;
    if (!name || typeof name !== 'string') throw new Error('name inválido');
    const kind = updates.kind !== undefined ? updates.kind : existing.kind;
    const data = updates.data !== undefined ? { ...(parseJsonSafe(existing.data as any) ?? {}), ...(updates.data ?? {}) } : existing.data;
    this.db.prepare('UPDATE widgets SET name = ?, kind = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(name, kind ?? null, JSON.stringify(data ?? {}), Date.now(), id);
    return this.getWidget(id)!;
  }

  deleteWidget(id: string): boolean {
    const r = this.db.prepare('DELETE FROM widgets WHERE id = ?').run(id);
    return Number((r as any)?.changes ?? 0) > 0;
  }

  /** Restauración exacta (INSERT OR REPLACE con la fila completa; para undo). */
  replaceWidget(w: { id: string; name: string; kind?: string | null; data?: any; created_at?: number; updated_at?: number | null }): void {
    const existing = this.getWidget(w.id);
    const now = Date.now();
    this.db.prepare('INSERT OR REPLACE INTO widgets (id, name, kind, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(w.id, w.name, w.kind ?? null, JSON.stringify(w.data ?? {}), w.created_at ?? existing?.created_at ?? now, w.updated_at ?? now);
  }

  /** Restauración exacta de un flow (para undo). */
  replaceFlow(f: { id: string; name: string; data?: any; created_at?: number; updated_at?: number | null }): void {
    const existing = this.getFlow(f.id);
    const now = Date.now();
    this.db.prepare('INSERT OR REPLACE INTO flows (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(f.id, f.name, JSON.stringify(f.data ?? { steps: [] }), f.created_at ?? existing?.created_at ?? now, f.updated_at ?? now);
  }

  /** Restauración exacta de una automatización (para undo). */
  replaceAutomation(a: { id: string; name: string; enabled?: number; trigger?: any; data?: any; created_at?: number; updated_at?: number | null }): void {
    const existing = this.getAutomation(a.id);
    const now = Date.now();
    this.db.prepare('INSERT OR REPLACE INTO automations (id, name, enabled, trigger, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.name, a.enabled ?? existing?.enabled ?? 1, JSON.stringify(a.trigger ?? {}), JSON.stringify(a.data ?? { actions: [] }), a.created_at ?? existing?.created_at ?? now, a.updated_at ?? now);
  }

  // Current profile and page management
  getCurrentProfile(): Profile | null {
    const profileId = this.getSetting('current.profile_id');
    if (!profileId) return null;
    return this.getProfile(profileId);
  }

  setCurrentProfile(profileId: string): void {
    this.setSetting('current.profile_id', profileId);
  }

  getCurrentPage(profileId?: string): Page | null {
    const currentProfileId = profileId || this.getSetting('current.profile_id');
    if (!currentProfileId) return null;

    const pageId = this.getSetting('current.page_id');
    if (!pageId) return null;

    const page = this.getPage(pageId);
    // Verify the page belongs to the current profile
    if (page && page.profile_id === currentProfileId) {
      return page;
    }
    return null;
  }

  setCurrentPage(pageId: string): void {
    this.setSetting('current.page_id', pageId);
  }

  // ---- Sesiones por dispositivo/cliente (vistas independientes) ----
  // Cada browser/hardware/relay tiene su propio profileId/pageId. La tabla
  // sobrevive a reconexiones: el deviceId estable restaura la vista.

  getDeviceSession(deviceId: string): DeviceSession | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM device_sessions WHERE device_id = ?');
      return (stmt.get(deviceId) as DeviceSession) || null;
    } catch {
      return null;
    }
  }

  listDeviceSessions(): DeviceSession[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM device_sessions ORDER BY updated_at DESC');
      return stmt.all() as DeviceSession[];
    } catch {
      return [];
    }
  }

  /**
   * Crea o actualiza la sesión de un dispositivo. Solo se sobrescriben los
   * campos presentes en `patch` (los ausentes conservan su valor anterior).
   */
  upsertDeviceSession(patch: Partial<DeviceSession> & { device_id: string }): DeviceSession {
    const existing = this.getDeviceSession(patch.device_id);
    const merged: DeviceSession = {
      device_id: patch.device_id,
      name: patch.name !== undefined ? patch.name : (existing?.name ?? null),
      kind: patch.kind !== undefined ? patch.kind : (existing?.kind ?? null),
      profile_id: patch.profile_id !== undefined ? patch.profile_id : (existing?.profile_id ?? null),
      page_id: patch.page_id !== undefined ? patch.page_id : (existing?.page_id ?? null),
      startup_profile_id: patch.startup_profile_id !== undefined ? patch.startup_profile_id : (existing?.startup_profile_id ?? null),
      updated_at: Date.now(),
    };
    this.db.prepare(`INSERT OR REPLACE INTO device_sessions
      (device_id, name, kind, profile_id, page_id, startup_profile_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      merged.device_id, merged.name, merged.kind, merged.profile_id,
      merged.page_id, merged.startup_profile_id, merged.updated_at,
    );
    return merged;
  }

  /** Vista actual (profile/page) del dispositivo. */
  setDeviceView(deviceId: string, view: { profileId?: string | null; pageId?: string | null }): DeviceSession {
    return this.upsertDeviceSession({
      device_id: deviceId,
      profile_id: view.profileId !== undefined ? view.profileId : undefined,
      page_id: view.pageId !== undefined ? view.pageId : undefined,
    });
  }

  /** Perfil de arranque asignable (se aplica al registrarse/reconectar). */
  setDeviceStartupProfile(deviceId: string, startupProfileId: string | null): DeviceSession {
    return this.upsertDeviceSession({ device_id: deviceId, startup_profile_id: startupProfileId });
  }

  deleteDeviceSession(deviceId: string): void {
    try {
      this.db.prepare('DELETE FROM device_sessions WHERE device_id = ?').run(deviceId);
    } catch { /* sin tabla: noop */ }
  }
}