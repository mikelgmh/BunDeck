import { Database } from 'bun:sqlite';

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
  data: any; // JSON layout, grid config
}

export interface Button {
  id: string;
  page_id: string;
  position: number;
  data: any; // JSON: actions, icon, label, state
}

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
    data TEXT, -- JSON
    FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS buttons (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    data TEXT, -- JSON
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

  -- Índices para mejor performance
  CREATE INDEX IF NOT EXISTS idx_pages_profile_id ON pages(profile_id);
  CREATE INDEX IF NOT EXISTS idx_buttons_page_id ON buttons(page_id);
  -- NOTA: el UNIQUE(page_id, position) NO va en el schema base.
  -- Lo crea la migración 3 DESPUÉS de reubicar duplicados existentes.
  -- (Si se crea aquí, db.exec falla con SQLITE_CONSTRAINT_UNIQUE en DBs
  --  antiguas con posiciones duplicadas, antes de que la migración pueda
  --  repararlas, y el daemon no arranca.)
  CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
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

  // Instalar plugins integrados
  await installBuiltInPlugins(db);

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

  console.log('✅ Database migrations completed');
}

async function installBuiltInPlugins(db: Database) {
  console.log('🔌 Installing built-in plugins...');

  // Import built-in plugins statically to avoid dynamic import issues
  const { ShellPlugin, HttpPlugin, HotkeyPlugin, TypeTextPlugin, MultimediaPlugin, OpenAppPlugin, PagePlugin, UtilityPlugin, BrowserPlugin, PCVitalsPlugin, ObsPlugin, HomeAssistantPlugin, SpotifyPlugin } = await import('./plugins/index');

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
    { id: 'spotify', class: SpotifyPlugin }
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

// Funciones de utilidad para acceso a datos
export class DatabaseService {
  private db: Database;

  constructor() {
    this.db = getDatabase();
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
    
    const stmt = this.db.prepare(`
      INSERT INTO pages (id, profile_id, name, order_idx, is_folder, data) 
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(page.id, page.profile_id, page.name, page.order_idx, page.is_folder || 0, JSON.stringify(page.data));
  }

  updatePage(id: string, updates: Partial<Pick<Page, 'name' | 'order_idx' | 'is_folder' | 'data'>>): void {
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
  }

  // Buttons
  getButtonsByPage(pageId: string): Button[] {
    const stmt = this.db.prepare('SELECT * FROM buttons WHERE page_id = ? ORDER BY position');
    const buttons = stmt.all(pageId) as Button[];
    // Parse JSON data field
    return buttons.map(button => ({
      ...button,
      data: typeof button.data === 'string' ? JSON.parse(button.data) : button.data
    }));
  }

  getButton(id: string): Button | null {
    const stmt = this.db.prepare('SELECT * FROM buttons WHERE id = ?');
    const button = stmt.get(id) as Button;
    if (!button) return null;
    // Parse JSON data field
    return {
      ...button,
      data: typeof button.data === 'string' ? JSON.parse(button.data) : button.data
    };
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
  createAsset(asset: Asset): void {
    const stmt = this.db.prepare(`
      INSERT INTO assets (id, path, hash, size, created_at) 
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(asset.id, asset.path, asset.hash, asset.size, asset.created_at);
  }

  getAsset(id: string): Asset | null {
    const stmt = this.db.prepare('SELECT * FROM assets WHERE id = ?');
    return stmt.get(id) as Asset || null;
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
}