import { DatabaseService, getDatabase } from './db';
import chokidar from 'chokidar';
import { getPluginsDir } from './paths';
import path from 'path';
import fs from 'fs';
import { createHash } from 'node:crypto';
import { validateManifest, assertValidManifest, satisfiesEngine, compareSemver } from './plugin-system/validator';
import { LIBREDECK_ENGINE_VERSION, secretFieldsOf } from './plugin-system/types';
import { ExternalPluginWorker } from './plugin-system/plugin-worker';
import type { PluginManifestV2, PluginActionV2, LoadedPluginV2 } from './plugin-system/types';
import { getNativeManifests } from './plugins/index';
import { isVersionRangeRef, pickBestTag, invalidateCatalog } from './catalog';
import { getPluginConfiguredStatus } from './plugins/connection-status';

// Re-export para compatibilidad
export interface PluginManifest extends PluginManifestV2 {}
export interface PluginAction extends PluginActionV2 {}
export interface LoadedPlugin extends LoadedPluginV2 {
  module: any;
}

/** Firma mínima del WebSocketManager necesaria para propagar eventos de plugins. */
export interface PluginEventBroadcaster {
  broadcast(eventType: string, payload: any, topic?: string): void;
}

export const BUILT_IN_IDS = new Set([
  'shell', 'http', 'hotkey', 'type-text', 'multimedia',
  'open-app', 'page', 'utility', 'browser', 'pc-vitals',
  'obs', 'homeassistant', 'spotify', 'weather', 'email',
]);

export function isBuiltIn(id: string): boolean {
  return BUILT_IN_IDS.has(id);
}

/** Carpeta en disco para un id (los scoped usan __ en vez de /). */
export function folderForId(id: string): string {
  return id.replace(/^@/, '').replace(/\//g, '__');
}

function isTempEntry(name: string): boolean {
  return name.startsWith('.staging_') || name.startsWith('.backup_')
    || name.startsWith('.tmp_') || name.startsWith('.download_');
}

export interface LoadOptions { force?: boolean }
export interface InstallOptions {
  force?: boolean; // permite engine incompatible o downgrade
  enabled?: boolean; // por defecto true
  sourceType?: string;
  origin?: string;
  ref?: string;
  /** Progreso fino (además del broadcast WS plugin.install-progress). */
  onProgress?: (stage: string, message: string) => void;
}

export type InstallStage = 'download' | 'clone' | 'extract' | 'detect' | 'validate' | 'activate' | 'load' | 'done' | 'error';

export class PluginLoader {
  private loadedPlugins: Map<string, LoadedPlugin> = new Map();
  private pluginActions: Map<string, PluginAction> = new Map();
  // Handlers reales de plugins externos (fullActionId -> handler)
  private externalHandlers: Map<string, Function> = new Map();
  // Un Worker por plugin externo (aislamiento real; ver plugin-system/plugin-worker.ts)
  private externalWorkers: Map<string, ExternalPluginWorker> = new Map();
  // Plugins Elgato con runtime fase 2 en marcha (host Elgato, sin Worker).
  private elgatoRunning: Set<string> = new Set();
  // Plugins externos que fallaron al registrarse/crashearon (fullActionId -> error)
  private pluginErrors: Map<string, string> = new Map();
  private broadcaster: PluginEventBroadcaster | null = null;
  private db: DatabaseService;
  private watcher?: chokidar.FSWatcher;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private installing = new Set<string>();
  // Callbacks para integrar con ActionRunner
  private onExternalActionRegistered?: (fullId: string, handler: Function) => void;
  private onExternalActionUnregistered?: (fullId: string) => void;

  constructor(opts?: {
    onActionRegistered?: (fullId: string, handler: Function) => void;
    onActionUnregistered?: (fullId: string) => void;
  }) {
    this.db = new DatabaseService();
    this.onExternalActionRegistered = opts?.onActionRegistered;
    this.onExternalActionUnregistered = opts?.onActionUnregistered;
    this.setupPluginWatcher();
  }

  // Permite a ActionRunner inyectar callbacks tras construcción (evita ciclo)
  public setActionCallbacks(
    onRegistered: (fullId: string, handler: Function) => void,
    onUnregistered: (fullId: string) => void
  ) {
    this.onExternalActionRegistered = onRegistered;
    this.onExternalActionUnregistered = onUnregistered;
    // Re-registrar handlers ya cargados
    for (const [fullId, handler] of this.externalHandlers.entries()) {
      onRegistered(fullId, handler);
    }
  }

  /**
   * Inyecta el WebSocketManager para que `api.emitEvent` de los plugins
   * externos propague de verdad (antes era no-op). Sin esto, los eventos
   * solo quedan registrados en los logs de DB.
   */
  public setWebSocketManager(ws: PluginEventBroadcaster | null): void {
    this.broadcaster = ws;
  }

  /** Último error conocido de un plugin externo (registro/crash/timeout). */
  public getPluginError(pluginId: string): string | null {
    if (this.pluginErrors.has(pluginId)) return this.pluginErrors.get(pluginId)!;
    try {
      const rec = this.db.getPlugin(pluginId) as any;
      return rec?.last_error ?? null;
    } catch { return null; }
  }

  /**
   * Progreso de instalación/importación: broadcast WS
   * (`plugin.install-progress`, topic plugins) + callback opcional.
   * La UI lo usa para mostrar descarga/instalación/errores en vivo.
   */
  public emitProgress(key: string, stage: string, message: string, cb?: (stage: string, message: string) => void): void {
    try { cb?.(stage, message); } catch {}
    try {
      this.broadcaster?.broadcast('plugin.install-progress', { key, stage, message, ts: Date.now() }, 'plugins');
    } catch {}
  }

  private setupPluginWatcher() {
    const pluginsDir = getPluginsDir();
    // Asegurar que existe (usa bun:sqlite ensure, pero por si acaso)
    try { fs.mkdirSync(pluginsDir, { recursive: true }); } catch {}
    this.watcher = chokidar.watch(pluginsDir, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
      depth: 2,
    });

    this.watcher
      .on('add', (p) => this.handlePluginFileChange(p, 'add'))
      .on('change', (p) => this.handlePluginFileChange(p, 'change'))
      .on('unlink', (p) => this.handlePluginFileChange(p, 'unlink'));
  }

  private async handlePluginFileChange(filePath: string, event: string) {
    // Debounce 300ms por plugin para evitar bucles chokidar
    const isRelevant = filePath.includes('manifest.json') || filePath.includes('main.js') || filePath.includes('main.mjs');
    if (!isRelevant) return;

    // Fix Windows: usar path.sep
    const normalized = filePath.split(path.sep).join('/');
    const parts = normalized.split('/');
    // .../plugins/<id>/manifest.json -> <id> es penúltimo
    const pluginDir = parts[parts.length - 2];
    if (!pluginDir || pluginDir === 'plugins') return;
    if (isTempEntry(pluginDir)) return;
    if (this.installing.has(pluginDir)) return;

    const key = `${pluginDir}:${event}`;
    if (this.debounceTimers.has(key)) clearTimeout(this.debounceTimers.get(key)!);
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(key);
      console.log(`Plugin file ${event}: ${filePath} -> reload ${pluginDir}`);
      try {
        await this.reloadPlugin(pluginDir);
      } catch (e) {
        console.error(`Watcher reload failed for ${pluginDir}:`, e);
      }
    }, 300);
    this.debounceTimers.set(key, timer);
  }

  public async loadAllPlugins(): Promise<void> {
    console.log('🔌 Loading plugins...');
    // 1) Cargar desde DB solo los habilitados. Los deshabilitados NO se cargan:
    // antes el descubrimiento del filesystem podía ejecutar plugins desactivados.
    let records: any[] = [];
    try { records = this.db.getPlugins(); }
    catch (e) { console.error('Failed to read plugins DB:', e); }
    for (const rec of records) {
      if (isBuiltIn(rec.id)) {
        try { await this.loadPlugin(rec.id); }
        catch (e) { console.error(`Failed to load plugin ${rec.id}:`, e); }
        continue;
      }
      if (Number(rec.enabled) !== 1) {
        // Asegurar que no queda cargado de una sesión anterior
        if (this.loadedPlugins.has(rec.id)) this.unloadPlugin(rec.id);
        continue;
      }
      try {
        await this.loadPlugin(rec.id);
      } catch (e) {
        console.error(`Failed to load plugin ${rec.id}:`, e);
      }
    }
    // 2) Descubrir plugins en filesystem que no están en DB (dev, sin instalar):
    // se registran como DESHABILITADOS y no se cargan hasta que el usuario
    // los habilite. Evita ejecución sorpresa de código.
    try {
      const pluginsDir = getPluginsDir();
      const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const folder = ent.name;
        if (isTempEntry(folder)) continue;
        const manifestPath = path.join(pluginsDir, folder, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        let manifest: any = null;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
        } catch { continue; }
        const id = manifest?.id ?? folder;
        if (this.loadedPlugins.has(id)) continue;
        let existing: any = null;
        try { existing = this.db.getPlugin(id); } catch {}
        if (existing) continue;
        const vr = validateManifest(manifest);
        if (!vr.valid) {
          console.warn(`Plugin FS ${folder} con manifest inválido, no se registra: ${vr.errors.join('; ')}`);
          continue;
        }
        // Registrar deshabilitado por defecto
        try {
          this.db.upsertPluginRecord({
            id, name: manifest.name, version: manifest.version, manifest,
            enabled: 0, source_type: 'directory', origin: 'filesystem',
            status: 'disabled',
          } as any);
          console.log(`Descubierto plugin FS no en DB: ${id} (registrado deshabilitado)`);
        } catch {}
        if (process.env.LIBREDECK_AUTOLOAD_FS === '1') {
          try { await this.loadExternalPlugin(id, { force: true }); } catch {}
        }
      }
    } catch {}
    console.log(`✓ Loaded ${this.loadedPlugins.size} plugins (${this.pluginActions.size} actions)`);
  }

  public async loadPlugin(pluginId: string, opts: LoadOptions = {}): Promise<boolean> {
    // Built-ins siempre cargan desde DB/ActionRunner
    let rec: any = null;
    try { rec = this.db.getPlugin(pluginId); } catch {}
    if (rec && isBuiltIn(pluginId)) {
      return this.loadBuiltInPlugin(rec);
    }
    if (rec && Number(rec.enabled) !== 1 && !opts.force) {
      // Deshabilitado: asegurar descarga y no cargar
      if (this.loadedPlugins.has(pluginId)) this.unloadPlugin(pluginId);
      return false;
    }
    if (rec && !isBuiltIn(pluginId)) {
      // Delegación Elgato fase 2: manifest con x-elgato arranca el runtime,
      // no el Worker. Lee DB y, si no cuadra, el manifest en disco.
      try {
        let m: any = null;
        try { m = typeof rec.manifest === 'string' ? JSON.parse(rec.manifest) : rec.manifest; } catch {}
        if (!this.isElgatoPlugin(m)) m = this.readDiskManifest(pluginId);
        if (m && this.isElgatoPlugin(m)) return await this.loadElgatoPlugin((m as any).id ?? pluginId);
      } catch (e) {
        console.error(`Failed to load Elgato plugin ${pluginId}:`, e);
        return false;
      }
      const pluginsDir = getPluginsDir();
      const folder = folderForId(pluginId);
      const fsManifest = path.join(pluginsDir, folder, 'manifest.json');
      if (fs.existsSync(fsManifest)) {
        return this.loadExternalPlugin(pluginId, opts);
      }
      // Registro sin carpeta (zip fallido, etc.): marcar error
      throw new Error(`Plugin ${pluginId} registrado pero sin carpeta en ${folder}`);
    }
    return this.loadExternalPlugin(pluginId, { force: true });
  }

  private async loadBuiltInPlugin(pluginRecord: any): Promise<boolean> {
    const manifest = typeof pluginRecord.manifest === 'string'
      ? JSON.parse(pluginRecord.manifest) : pluginRecord.manifest;
    const vr = validateManifest(manifest);
    if (!vr.valid) throw new Error(`Invalid manifest ${pluginRecord.id}: ${vr.errors.join('; ')}`);

    // Si estaba deshabilitado en DB, no registrar acciones (pero mantener visible)
    if (Number(pluginRecord.enabled) !== 1) {
      if (this.loadedPlugins.has(pluginRecord.id)) this.unloadPlugin(pluginRecord.id);
      return false;
    }

    // Dummy module — handlers reales viven en ActionRunner (nativos)
    const loadedPlugin: LoadedPlugin = {
      manifest,
      module: {
        register: () => console.log(`Built-in ${pluginRecord.id} registered (handlers en ActionRunner)`),
      },
      path: `built-in/${pluginRecord.id}`,
      enabled: true,
      installedAt: pluginRecord.installed_at || Date.now(),
      updatedAt: Date.now(),
    };

    // Evitar duplicados al recargar
    for (const [k] of this.pluginActions) {
      if (k.startsWith(`${pluginRecord.id}.`)) this.pluginActions.delete(k);
    }
    manifest.actions.forEach((action: PluginAction) => {
      const fullActionId = `${pluginRecord.id}.${action.id}`;
      this.pluginActions.set(fullActionId, { ...action, id: fullActionId } as any);
    });

    this.loadedPlugins.set(pluginRecord.id, loadedPlugin as any);
    console.log(`✓ Loaded built-in plugin: ${manifest.name} v${manifest.version}`);
    return true;
  }

  private resolveMain(mainPath: string, manifest: PluginManifestV2): string | null {
    const candidates = manifest.main
      ? [manifest.main, 'main.js', 'main.mjs', 'index.js']
      : ['main.js', 'main.mjs', 'index.js'];
    for (const c of candidates) {
      if (!c || c.includes('..')) continue;
      if (fs.existsSync(path.join(mainPath, c))) return path.join(mainPath, c);
    }
    return null;
  }

  private async loadExternalPlugin(pluginId: string, opts: LoadOptions = {}): Promise<boolean> {
    const pluginsDir = getPluginsDir();
    const folder = folderForId(pluginId);
    const pluginPath = path.join(pluginsDir, folder);

    const manifestFile = Bun.file(path.join(pluginPath, 'manifest.json'));
    if (!(await manifestFile.exists())) {
      throw new Error(`Plugin manifest not found: ${pluginPath}/manifest.json`);
    }
    const manifestText = (await manifestFile.text()).replace(/^\uFEFF/, '');
    const manifest = JSON.parse(manifestText);
    assertValidManifest(manifest);
    if (manifest.id !== pluginId && folderForId(manifest.id) !== folder) {
      throw new Error(`Manifest id ${manifest.id} no coincide con carpeta ${folder}`);
    }
    // Comprobar enabled salvo force (instalación/habilitación explícita)
    if (!opts.force) {
      try {
        const rec = this.db.getPlugin(manifest.id) as any;
        if (rec && Number(rec.enabled) !== 1) {
          if (this.loadedPlugins.has(manifest.id)) this.unloadPlugin(manifest.id);
          return false;
        }
      } catch {}
    }

    // Delegación Elgato fase 2 antes de buscar main.js (los Elgato no usan Worker).
    if (this.isElgatoPlugin(manifest)) {
      return this.loadElgatoPlugin(manifest.id ?? pluginId);
    }

    const mainPath = this.resolveMain(pluginPath, manifest);
    if (!mainPath) throw new Error(`Plugin main not found in ${pluginPath} (manifest.main o main.js/main.mjs/index.js)`);

    // Compatibilidad engine (aviso, no bloqueo duro salvo install que sí valida)
    if (manifest.engine && !satisfiesEngine(manifest.engine, LIBREDECK_ENGINE_VERSION)) {
      console.warn(`Plugin ${pluginId} pide engine ${manifest.engine}, daemon es ${LIBREDECK_ENGINE_VERSION}`);
    }

    // FASE 2: el main del plugin corre en SU PROPIO Bun Worker. El daemon
    // nunca hace import() del plugin: sin módulo acumulado en memoria y con
    // timeout/crash reales (terminate + re-spawn).
    // Si había un worker previo (reload), terminarlo primero: adiós fuga de módulos.
    const prev = this.externalWorkers.get(manifest.id);
    if (prev) {
      try { prev.terminate(); } catch {}
      this.externalWorkers.delete(manifest.id);
    }

    const worker = new ExternalPluginWorker(manifest, mainPath, {
      emitEvent: (eventName, payload, pid) => {
        this.broadcaster?.broadcast('plugin.event', { pluginId: pid, eventName, payload }, 'plugins');
      },
    });

    let registered: string[];
    try {
      registered = await worker.start();
    } catch (e) {
      // El crash en registro NO tumba el loader: se marca en error y se loguea.
      // Se registran las acciones del manifest con handlers que reportan el error,
      // para que el índice de acciones siga completo.
      const errMsg = e instanceof Error ? e.message : String(e);
      this.pluginErrors.set(manifest.id, errMsg);
      try {
        this.db.addLog({ level: 'error', message: `Plugin externo ${manifest.id} en error: ${errMsg}`, meta: { pluginId: manifest.id }, ts: Date.now() });
      } catch {}
      try { this.db.setPluginStatus(manifest.id, 'error', errMsg); } catch {}
      console.error(`Plugin externo ${manifest.id} en error (loader sigue vivo):`, errMsg);
      this.externalWorkers.set(manifest.id, worker);
      this.registerErrorHandlers(manifest.id, manifest, errMsg);
      this.loadedPlugins.set(manifest.id, this.makeLoadedPlugin(manifest.id, manifest, pluginPath));
      try {
        this.broadcaster?.broadcast('plugin.status', { pluginId: manifest.id, status: 'error', error: errMsg }, 'plugins');
      } catch {}
      return false;
    }

    this.pluginErrors.delete(manifest.id);
    try { this.db.setPluginStatus(manifest.id, 'active', null); } catch {}
    this.externalWorkers.set(manifest.id, worker);

    // Índice de acciones del manifest.
    for (const [k] of [...this.pluginActions.keys()]) {
      if (k.startsWith(`${manifest.id}.`)) this.pluginActions.delete(k);
    }
    manifest.actions.forEach((action: PluginAction) => {
      const fullActionId = `${manifest.id}.${action.id}`;
      this.pluginActions.set(fullActionId, { ...action, id: fullActionId } as any);
    });

    // Handlers: cada acción delega al worker (permisos/cooldown/timeout en el padre).
    // Solo se exponen acciones declaradas en el manifest; si el plugin registró
    // alguna no declarada, se ignora con un warning.
    const declared = new Set(manifest.actions.map((a: PluginAction) => a.id));
    for (const actionId of registered) {
      if (!declared.has(actionId)) {
        console.warn(`Plugin ${manifest.id} registró acción no declarada '${actionId}': ignorada`);
        continue;
      }
      const fullId = `${manifest.id}.${actionId}`;
      // Limpiar handler previo si existía (reload)
      if (this.externalHandlers.has(fullId)) {
        this.externalHandlers.delete(fullId);
        this.onExternalActionUnregistered?.(fullId);
      }
      const handler = (params: any, context: any) => worker.invoke(actionId, params, context);
      this.externalHandlers.set(fullId, handler);
      this.onExternalActionRegistered?.(fullId, handler);
      console.log(`Registered external action handler: ${fullId}`);
    }

    this.loadedPlugins.set(manifest.id, this.makeLoadedPlugin(manifest.id, manifest, pluginPath));
    console.log(`✓ Loaded external plugin (worker): ${manifest.name} v${manifest.version} (${registered.length} actions)`);
    return true;
  }

  /** ¿Es un manifest Elgato convertido (trae x-elgato)? */
  public isElgatoPlugin(manifest: any): boolean {
    return !!manifest && typeof manifest === 'object' && !!(manifest as any)['x-elgato'];
  }

  /** Lee el manifest en disco de un plugin (la DB puede estar desincronizada). */
  private readDiskManifest(pluginId: string): any | null {
    try {
      const p = path.join(getPluginsDir(), folderForId(pluginId), 'manifest.json');
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    } catch { return null; }
  }

  // Manager singleton del runtime Elgato (fase 2). `any` + import dinámico:
  // `elgato/runtime.ts` lo crea otro agente y esto no debe romperse si falta.
  private elgatoManager: any = null;

  /**
   * Localiza o crea el manager del runtime Elgato (fase 2).
   * Import dinámico + `any` a propósito: no rompe si el módulo aún no existe.
   */
  private async getElgatoManager(): Promise<any> {
    if (this.elgatoManager) return this.elgatoManager;
    const mod: any = await import('./elgato/runtime');
    const Cls = mod?.ElgatoRuntimeManager ?? mod?.default;
    if (typeof Cls !== 'function') {
      throw new Error('runtime Elgato sin ElgatoRuntimeManager (fase 2 aún no disponible)');
    }
    this.elgatoManager = new Cls({
      pluginsDir: getPluginsDir(),
      db: this.db,
      // setTitle/setImage/setState del plugin → broadcast para la UI.
      onStateChange: (cbPluginId: string, context: string, state: any) => {
        try {
          this.broadcaster?.broadcast('elgato.state', { pluginId: cbPluginId, context, state, running: true }, 'plugins');
        } catch {}
      },
    });
    return this.elgatoManager;
  }

  /**
   * Arranca un plugin Elgato con el runtime fase 2 y registra cada acción
   * como handler que envía keyDown+keyUp al runtime. Sin import estático.
   */
  public async loadElgatoPlugin(pluginId: string): Promise<boolean> {
    const manifest = this.readDiskManifest(pluginId);
    if (!manifest || !this.isElgatoPlugin(manifest)) return false;
    const id = manifest.id ?? pluginId;
    const pluginsDir = getPluginsDir();
    const pluginDir = path.join(pluginsDir, folderForId(id));
    this.emitProgress(id, 'load', 'Arrancando runtime Elgato…');
    try { this.db.setPluginStatus(id, 'elgato-starting', null); } catch {}

    let manager: any = null;
    try {
      manager = await this.getElgatoManager();
    } catch (e) {
      const msg = `Runtime Elgato aún no disponible: ${e instanceof Error ? e.message : String(e)} (listo para activar con runtime Elgato)`;
      try { this.db.setPluginStatus(id, 'elgato-stopped', msg); } catch {}
      try {
        this.broadcaster?.broadcast('plugin.status', { pluginId: id, status: 'elgato-stopped', error: msg }, 'plugins');
        this.broadcaster?.broadcast('elgato.state', { pluginId: id, running: false, reason: 'runtime-missing' }, 'plugins');
      } catch {}
      this.emitProgress(id, 'error', msg);
      return false;
    }

    // Manifest original Elgato (para UUIDs de acciones y CodePath).
    let elgatoRaw: any = null;
    try {
      const p = path.join(pluginDir, 'elgato-manifest.json');
      if (fs.existsSync(p)) elgatoRaw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    } catch {}
    // Mapa actionId LibreDeck -> UUID Elgato (recalculado del manifest original).
    let uuidOf = new Map<string, string>();
    try {
      const { analyzeElgatoManifest } = (await import('./elgato/manifest')) as any;
      if (elgatoRaw && typeof analyzeElgatoManifest === 'function') {
        const rep = analyzeElgatoManifest(elgatoRaw);
        for (const a of rep?.actions ?? []) {
          if (a?.status === 'ok' && a?.id && a?.uuid) uuidOf.set(a.id, a.uuid);
        }
      }
    } catch {}
    if (uuidOf.size === 0 && Array.isArray(manifest['x-elgato']?.originalActions)) {
      // Fallback: alinear por orden con los UUIDs originales.
      const origs = manifest['x-elgato'].originalActions as string[];
      manifest.actions?.forEach((a: any, i: number) => {
        if (a?.id && origs[i]) uuidOf.set(a.id, origs[i]);
      });
    }

    const pushState = (extra: any = {}) => {
      try {
        const live = typeof manager?.isRunning === 'function' ? manager.isRunning(id) : true;
        this.broadcaster?.broadcast('elgato.state', { pluginId: id, running: live, ...extra }, 'plugins');
      } catch {}
    };

    try {
      // El host resuelve el CodePath por plataforma desde el manifest original.
      const rawForStart = elgatoRaw ?? { CodePath: manifest['x-elgato']?.codePath };
      await manager.start(id, rawForStart);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.pluginErrors.set(id, msg);
      try { this.db.setPluginStatus(id, 'error', msg); } catch {}
      try {
        this.broadcaster?.broadcast('plugin.status', { pluginId: id, status: 'error', error: msg }, 'plugins');
        this.broadcaster?.broadcast('elgato.state', { pluginId: id, running: false, error: msg }, 'plugins');
      } catch {}
      this.emitProgress(id, 'error', msg);
      this.registerErrorHandlers(id, manifest, msg);
      this.loadedPlugins.set(id, this.makeLoadedPlugin(id, manifest, pluginDir));
      console.error(`Plugin Elgato ${id} en error (loader sigue vivo):`, msg);
      return false;
    }

    // Índice de acciones + handlers keyDown+keyUp delegados al runtime.
    for (const [k] of [...this.pluginActions.keys()]) {
      if (k.startsWith(`${id}.`)) this.pluginActions.delete(k);
    }
    const fireKey = async (actionId: string, params: any, context: any) => {
      const elgatoUuid = uuidOf.get(actionId) ?? actionId;
      // Contexto Elgato estable por botón+acción: el primer envío dispara
      // willAppear en el host y los siguientes reutilizan el contexto.
      const buttonId = (context as any)?.buttonId ?? 'deck';
      const ctx = `ld:${id}:${actionId}:${buttonId}`;
      const down = manager.sendKey(id, elgatoUuid, ctx, 'keyDown');
      const up = manager.sendKey(id, elgatoUuid, ctx, 'keyUp');
      if (!down || !up) {
        throw new Error(`Plugin Elgato ${id} no aceptó la pulsación (¿runtime detenido?)`);
      }
      return { ok: true };
    };
    manifest.actions.forEach((action: PluginAction) => {
      const fullActionId = `${id}.${action.id}`;
      this.pluginActions.set(fullActionId, { ...action, id: fullActionId } as any);
      if (this.externalHandlers.has(fullActionId)) {
        this.externalHandlers.delete(fullActionId);
        this.onExternalActionUnregistered?.(fullActionId);
      }
      const handler = (params: any, context: any) => fireKey(action.id, params, context);
      this.externalHandlers.set(fullActionId, handler);
      this.onExternalActionRegistered?.(fullActionId, handler);
      console.log(`Registered Elgato action handler: ${fullActionId}`);
    });

    this.pluginErrors.delete(id);
    this.elgatoRunning.add(id);
    this.loadedPlugins.set(id, this.makeLoadedPlugin(id, manifest, pluginDir));
    // Anunciar un contexto virtual por acción (willAppear sin pulsar) para
    // que el plugin arranque su render nada más activarse (DeckCal hace
    // polling y setTitle/setImage en cuanto ve willAppear).
    try {
      if (typeof manager.ensureContext === 'function') {
        for (const [actionId, elgatoUuid] of uuidOf.entries()) {
          try { manager.ensureContext(id, elgatoUuid, `ld:${id}:${actionId}:deck`); } catch {}
        }
      }
    } catch {}
    try { this.db.setPluginStatus(id, 'active', null); } catch {}
    try {
      this.broadcaster?.broadcast('plugin.status', { pluginId: id, status: 'active', runtime: 'elgato' }, 'plugins');
      this.broadcaster?.broadcast('plugin.install-progress', { key: id, stage: 'done', message: 'Runtime Elgato activo', ts: Date.now() }, 'plugins');
    } catch {}
    pushState();
    console.log(`✓ Loaded Elgato plugin (runtime fase 2): ${manifest.name} v${manifest.version}`);
    return true;
  }

  /** Detiene un plugin Elgato (runtime fase 2) y limpia su índice. No tumba si el runtime falta. */
  public unloadElgatoPlugin(pluginId: string): void {
    const id = this.resolveCanonicalId(pluginId);
    // Parada del runtime en segundo plano (best-effort, sin import si no hay manager).
    const m = this.elgatoManager;
    if (m && typeof m.stop === 'function') {
      void (async () => { try { await m.stop(id); } catch {} })();
    }
    try {
      const plugin = this.loadedPlugins.get(id);
      const actions = plugin?.manifest.actions ?? this.readDiskManifest(id)?.actions ?? [];
      for (const action of actions as any[]) {
        const fullActionId = `${id}.${(action as any).id}`;
        this.pluginActions.delete(fullActionId);
        if (this.externalHandlers.has(fullActionId)) {
          this.externalHandlers.delete(fullActionId);
          this.onExternalActionUnregistered?.(fullActionId);
        }
      }
    } catch {}
    this.pluginErrors.delete(id);
    this.elgatoRunning.delete(id);
    this.loadedPlugins.delete(id);
    try {
      this.broadcaster?.broadcast('plugin.status', { pluginId: id, status: 'elgato-stopped' }, 'plugins');
      this.broadcaster?.broadcast('elgato.state', { pluginId: id, running: false }, 'plugins');
    } catch {}
    console.log(`✓ Unloaded Elgato plugin: ${id}`);
  }

  /**
   * Estado Elgato para la UI (running + snapshot del runtime si existe).
   * Solo lee el manager ya creado: sin efectos laterales ni imports nuevos.
   */
  public async getElgatoState(pluginId: string, actionUUID?: string): Promise<any> {
    const id = this.resolveCanonicalId(pluginId);
    const manager = this.elgatoManager;
    let running = this.elgatoRunning.has(id);
    let runtimeState: any = null;
    try {
      if (manager && typeof manager.isRunning === 'function') running = manager.isRunning(id);
      if (manager && actionUUID !== undefined && typeof manager.getStateForAction === 'function') {
        runtimeState = manager.getStateForAction(id, actionUUID);
      } else if (manager && typeof manager.getContexts === 'function') {
        const ctxs = manager.getContexts(id) ?? [];
        runtimeState = {
          contexts: ctxs.map((c: string) => ({
            context: c,
            state: typeof manager.getStateForAction === 'function'
              ? manager.getStateForAction(id, c)
              : null,
          })),
        };
      }
    } catch { runtimeState = null; }
    let manifest: any = null;
    try { manifest = this.readDiskManifest(id); } catch {}
    return {
      pluginId: id,
      elgato: this.isElgatoPlugin(manifest),
      running,
      loaded: this.loadedPlugins.has(id),
      action: actionUUID ?? null,
      state: runtimeState,
    };
  }

  /** Handlers que fallan con el error de registro: el plugin existe pero no corre. */
  private registerErrorHandlers(pluginId: string, manifest: PluginManifestV2, errMsg: string): void {
    manifest.actions.forEach((action: PluginAction) => {
      const fullActionId = `${pluginId}.${action.id}`;
      this.pluginActions.set(fullActionId, { ...action, id: fullActionId } as any);
      const handler = async () => { throw new Error(`Plugin ${pluginId} en error: ${errMsg}`); };
      if (this.externalHandlers.has(fullActionId)) this.onExternalActionUnregistered?.(fullActionId);
      this.externalHandlers.set(fullActionId, handler);
      this.onExternalActionRegistered?.(fullActionId, handler);
    });
  }

  private makeLoadedPlugin(pluginId: string, manifest: PluginManifestV2, pluginPath: string): LoadedPlugin {
    return {
      manifest,
      module: { unload: () => this.unloadPlugin(pluginId) },
      path: pluginPath,
      enabled: true,
      installedAt: Date.now(),
      updatedAt: Date.now(),
    } as unknown as LoadedPlugin;
  }

  public async reloadPlugin(pluginId: string): Promise<boolean> {
    if (this.installing.has(folderForId(pluginId))) return false;
    const id = this.resolveCanonicalId(pluginId);
    if (this.loadedPlugins.has(id)) this.unloadPlugin(id);
    return this.loadPlugin(id, { force: true });
  }

  private resolveCanonicalId(input: string): string {
    // Acepta tanto id como nombre de carpeta
    if (this.loadedPlugins.has(input)) return input;
    try {
      const rec = this.db.getPlugin(input) as any;
      if (rec) return rec.id;
    } catch {}
    // Buscar por carpeta sanitizada
    try {
      const all = this.db.getPlugins();
      const found = all.find((p: any) => folderForId(p.id) === input);
      if (found) return found.id;
    } catch {}
    return input;
  }

  public unloadPlugin(pluginId: string): void {
    const id = this.resolveCanonicalId(pluginId);
    // Delegación Elgato fase 2 (por set en marcha o por manifest en disco).
    if (this.elgatoRunning.has(id)) { this.unloadElgatoPlugin(id); return; }
    try {
      const m = this.readDiskManifest(id);
      if (m && this.isElgatoPlugin(m) && this.loadedPlugins.has(id)) { this.unloadElgatoPlugin(id); return; }
    } catch {}
    const plugin = this.loadedPlugins.get(id);
    if (!plugin) return;

    // Terminar el worker: reload/unload limpio, sin módulos acumulados en memoria.
    const worker = this.externalWorkers.get(id);
    if (worker) {
      try { worker.terminate(); } catch (e) { console.error(`Error terminating worker ${id}:`, e); }
      this.externalWorkers.delete(id);
    }
    this.pluginErrors.delete(id);

    // Quitar actions del índice y handlers externos
    try {
      plugin.manifest.actions.forEach((action) => {
        const fullActionId = `${id}.${action.id}`;
        this.pluginActions.delete(fullActionId);
        if (this.externalHandlers.has(fullActionId)) {
          this.externalHandlers.delete(fullActionId);
          this.onExternalActionUnregistered?.(fullActionId);
        }
      });
    } catch {}

    this.loadedPlugins.delete(id);
    console.log(`✓ Unloaded plugin: ${id}`);
  }

  // Para ActionRunner: obtener handler externo si existe
  public getExternalHandler(fullActionId: string): Function | undefined {
    return this.externalHandlers.get(fullActionId);
  }

  public getExternalHandlers(): Map<string, Function> {
    return new Map(this.externalHandlers);
  }

  // Public getters (compat)
  public getLoadedPlugins(): Map<string, LoadedPlugin> { return this.loadedPlugins; }
  public getPluginActions(): Map<string, PluginAction> { return this.pluginActions; }
  public getPlugin(pluginId: string): LoadedPlugin | undefined { return this.loadedPlugins.get(this.resolveCanonicalId(pluginId)); }
  public getAction(actionId: string): PluginAction | undefined { return this.pluginActions.get(actionId); }

  // ---------- ciclo de vida marketplace ----------

  public async enablePlugin(pluginId: string): Promise<boolean> {
    if (isBuiltIn(pluginId)) {
      this.db.setPluginEnabled(pluginId, true);
      try { this.db.setPluginStatus(pluginId, 'active', null); } catch {}
      await this.loadPlugin(pluginId, { force: true });
      this.broadcaster?.broadcast('plugin.enabled', { pluginId, enabled: true }, 'plugins');
      return true;
    }
    const rec = this.db.getPlugin(pluginId) as any;
    if (!rec) throw new Error(`Plugin desconocido: ${pluginId}`);
    // Delegación Elgato fase 2: arranca el runtime, no el Worker.
    try {
      let m: any = null;
      try { m = typeof rec.manifest === 'string' ? JSON.parse(rec.manifest) : rec.manifest; } catch {}
      if (!this.isElgatoPlugin(m)) m = this.readDiskManifest(pluginId);
      if (m && this.isElgatoPlugin(m)) {
        this.db.setPluginEnabled(pluginId, true);
        const elgOk = await this.loadElgatoPlugin((m as any).id ?? pluginId);
        // loadElgatoPlugin ya emitió plugin.status/elgato.state + install-progress.
        this.broadcaster?.broadcast('plugin.enabled', { pluginId, enabled: true }, 'plugins');
        if (elgOk) {
          this.broadcaster?.broadcast('plugin.installed', { pluginId, plugin: this.db.getPlugin(pluginId) }, 'plugins');
        } else {
          // Seguridad: si el arranque falló sin progreso (retorno temprano),
          // cerrar el cartel "Arrancando…" con un error visible.
          const err = this.getPluginError((m as any).id ?? pluginId) ?? 'fallo al arrancar el runtime Elgato';
          this.emitProgress((m as any).id ?? pluginId, 'error', err);
        }
        return elgOk;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to enable Elgato plugin ${pluginId}:`, e);
      try { this.db.setPluginStatus(pluginId, 'error', msg); } catch {}
      this.emitProgress(pluginId, 'error', msg);
      return false;
    }
    this.db.setPluginEnabled(pluginId, true);
    const ok = await this.loadPlugin(pluginId, { force: true });
    if (ok) {
      try { this.db.setPluginStatus(pluginId, 'active', null); } catch {}
      this.broadcaster?.broadcast('plugin.enabled', { pluginId, enabled: true }, 'plugins');
      this.broadcaster?.broadcast('plugin.installed', { pluginId, plugin: this.db.getPlugin(pluginId) }, 'plugins');
    } else {
      const err = this.getPluginError(pluginId) ?? 'fallo al cargar';
      try { this.db.setPluginStatus(pluginId, 'error', err); } catch {}
      this.broadcaster?.broadcast('plugin.status', { pluginId, status: 'error', error: err }, 'plugins');
      this.emitProgress(pluginId, 'error', err);
    }
    return ok;
  }

  public async disablePlugin(pluginId: string): Promise<boolean> {
    // Delegación Elgato fase 2: parar el runtime en vez del Worker.
    const cid = this.resolveCanonicalId(pluginId);
    let isElg = this.elgatoRunning.has(cid);
    if (!isElg) {
      try {
        const m = this.readDiskManifest(cid);
        isElg = !!(m && this.isElgatoPlugin(m));
      } catch { isElg = false; }
    }
    if (isElg) this.unloadElgatoPlugin(cid);
    else this.unloadPlugin(cid);
    try {
      this.db.setPluginEnabled(pluginId, false);
      try { this.db.setPluginStatus(pluginId, 'disabled', null); } catch {}
    } catch (e) {
      throw e;
    }
    this.broadcaster?.broadcast('plugin.enabled', { pluginId, enabled: false }, 'plugins');
    return true;
  }

  public listDetailed(): any[] {
    let records: any[] = [];
    try { records = this.db.getPlugins(); } catch { records = []; }
    return records.map((r: any) => {
      const manifest = typeof r.manifest === 'string' ? JSON.parse(r.manifest) : r.manifest;
      const loaded = this.loadedPlugins.has(r.id);
      const actions = manifest?.actions ?? [];
      const elgato = this.isElgatoPlugin(manifest);
      // Estado de configuración genérico (a prueba de futuro):
      // cualquier plugin con settingsSchema.required entra en el gating.
      let configured = true;
      let missing: string[] = [];
      let requiresConfiguration = false;
      try {
        const values = this.db.getPluginSettings(manifest?.id ?? r.id);
        const st = getPluginConfiguredStatus(manifest, values);
        configured = st.configured;
        missing = st.missing;
        requiresConfiguration = st.requiresConfiguration;
      } catch { /* sin DB: se asume configurado */ }
      return {
        id: r.id,
        name: r.name ?? manifest?.name ?? r.id,
        version: r.version ?? manifest?.version ?? '?',
        description: manifest?.description ?? '',
        author: manifest?.author ?? '',
        enabled: Number(r.enabled) === 1,
        loaded,
        elgato,
        elgatoRunning: this.elgatoRunning.has(r.id),
        status: r.status ?? (loaded ? 'active' : (Number(r.enabled) === 1 ? 'active' : 'disabled')),
        lastError: r.last_error ?? this.pluginErrors.get(r.id) ?? null,
        sourceType: r.source_type ?? (isBuiltIn(r.id) ? 'builtin' : null),
        origin: r.origin ?? null,
        ref: r.ref ?? null,
        commit: r.commit_sha ?? r.commit ?? null,
        checksum: r.checksum ?? null,
        previousVersion: r.previous_version ?? null,
        actionsCount: actions.length,
        actions: actions.map((a: any) => a.id),
        manifest,
        privileged: (manifest?.permissions ?? []).some((p: string) => p === 'shell' || p === 'system' || p === 'filesystem'),
        hasSettings: !!(manifest?.settingsSchema ?? manifest?.ui?.settingsSchema),
        hasInstructions: typeof manifest?.instructions === 'string' && manifest.instructions.length > 0,
        configured,
        missing,
        requiresConfiguration,
        oauth: manifest?.oauth ?? null,
        installedAt: r.installed_at ?? null,
        updatedAt: r.updated_at ?? null,
      };
    });
  }

  /** Ajustes generales del plugin: schema + instrucciones + valores actuales. */
  public getPluginSettingsBundle(pluginId: string): { schema: any | null; values: Record<string, string>; instructions: string | null; configured: boolean; missing: string[]; requiresConfiguration: boolean; oauth: any | null; secretFields: string[] } {
    const id = this.resolveCanonicalId(pluginId);
    const loaded = this.loadedPlugins.get(id);
    let manifest: any = loaded?.manifest;
    if (!manifest) {
      try {
        const rec = this.db.getPlugin(id) as any;
        manifest = rec ? (typeof rec.manifest === 'string' ? JSON.parse(rec.manifest) : rec.manifest) : null;
      } catch { manifest = null; }
    }
    if (!manifest) {
      // Fallback: manifiesto estático del nativo (DB vacía o sin registro)
      try {
        manifest = getNativeManifests().find((m: any) => m.id === id) ?? null;
      } catch { manifest = null; }
    }
    if (!manifest) throw new Error(`Plugin desconocido: ${pluginId}`);
    const schema = manifest.settingsSchema ?? manifest.ui?.settingsSchema ?? null;
    const values = this.db.getPluginSettings(manifest.id ?? id);
    const st = getPluginConfiguredStatus(manifest, values);
    // Config flows seguros: la UI usa `secretFields` para pintar inputs
    // password y no autocompletar/eco en logs (nunca viajan en claro a WS).
    let secretFields: string[] = [];
    try {
      secretFields = secretFieldsOf(schema);
    } catch { secretFields = []; }
    return {
      schema,
      values,
      instructions: typeof manifest.instructions === 'string' ? manifest.instructions : null,
      configured: st.configured,
      missing: st.missing,
      requiresConfiguration: st.requiresConfiguration,
      oauth: manifest?.oauth ?? null,
      secretFields,
    };
  }

  /** Valida contra el settingsSchema (required + tipos/enum) y guarda. */
  public savePluginSettings(pluginId: string, values: Record<string, any>): Record<string, string> {
    for (const key of Object.keys(values ?? {})) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new Error(`Clave de ajuste inválida: ${key}`);
    }
    const bundle = this.getPluginSettingsBundle(pluginId);
    const schema = bundle.schema;
    const merged = { ...bundle.values, ...Object.fromEntries(Object.entries(values ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '')) };
    if (schema) {
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const key of required) {
        if (merged[key] === undefined || String(merged[key]).trim() === '') {
          throw new Error(`Ajuste requerido: ${key}`);
        }
      }
      const props = schema.properties ?? {};
      for (const [key, value] of Object.entries(values ?? {})) {
        if (value === null || value === undefined || value === '') continue; // borrar: permitido
        const prop = props[key];
        if (!prop) continue; // clave extra: se guarda igualmente (compat)
        const t = prop.type;
        if (t === 'number' || t === 'integer') {
          const n = Number(value);
          if (!Number.isFinite(n)) throw new Error(`Ajuste ${key} debe ser número`);
          if (t === 'integer' && !Number.isInteger(n)) throw new Error(`Ajuste ${key} debe ser entero`);
          if (prop.minimum !== undefined && n < prop.minimum) throw new Error(`Ajuste ${key} mínimo ${prop.minimum}`);
          if (prop.maximum !== undefined && n > prop.maximum) throw new Error(`Ajuste ${key} máximo ${prop.maximum}`);
        } else if (t === 'boolean') {
          if (typeof value !== 'boolean' && value !== 'true' && value !== 'false' && value !== 0 && value !== 1) {
            throw new Error(`Ajuste ${key} debe ser booleano`);
          }
        } else if (t === 'string' && prop.enum && !(prop.enum as any[]).includes(value)) {
          throw new Error(`Ajuste ${key} debe ser uno de: ${(prop.enum as any[]).join(', ')}`);
        }
      }
    }
    const id = this.resolveCanonicalId(pluginId);
    const rec = this.db.getPlugin(id) as any;
    const canonicalId = rec?.id ?? (this.loadedPlugins.get(id)?.manifest.id ?? id);
    this.db.setPluginSettings(canonicalId, values ?? {});
    try {
      this.broadcaster?.broadcast('plugin.settings', { pluginId: canonicalId }, 'plugins');
    } catch {}
    return this.db.getPluginSettings(canonicalId);
  }

  public getStatus(pluginId: string): any {    const rec = this.db.getPlugin(pluginId) as any;
    if (!rec) return null;
    const manifest = typeof rec.manifest === 'string' ? JSON.parse(rec.manifest) : rec.manifest;
    return {
      id: rec.id,
      enabled: Number(rec.enabled) === 1,
      loaded: this.loadedPlugins.has(rec.id),
      elgato: this.isElgatoPlugin(manifest),
      elgatoRunning: this.elgatoRunning.has(rec.id),
      status: rec.status ?? (this.loadedPlugins.has(rec.id) ? 'active' : 'disabled'),
      lastError: rec.last_error ?? this.getPluginError(rec.id),
      version: rec.version,
      previousVersion: rec.previous_version ?? null,
      sourceType: rec.source_type ?? null,
      origin: rec.origin ?? null,
      ref: rec.ref ?? null,
      commit: rec.commit_sha ?? rec.commit ?? null,
      manifest,
      actions: (manifest?.actions ?? []).map((a: any) => a.id),
    };
  }

  // ----- instalación atómica con staging -----

  private stageDirFor(folder: string): string {
    return path.join(getPluginsDir(), `.staging_${folder}_${Date.now()}`);
  }

  private backupDirFor(folder: string): string {
    return path.join(getPluginsDir(), `.backup_${folder}`);
  }

  private checksumOfFile(filePath: string): string {
    const data = fs.readFileSync(filePath);
    return createHash('sha256').update(data).digest('hex');
  }

  private checksumOfDir(dir: string): string {
    const h = createHash('sha256');
    const files = listFilesRecursive(dir).sort();
    for (const f of files) {
      const rel = path.relative(dir, f);
      h.update(rel);
      h.update(fs.readFileSync(f));
    }
    return h.digest('hex');
  }

  private readAndValidateStaged(stageDir: string, expectedId?: string): { manifest: PluginManifestV2; folder: string } {
    const found = findFileRecursive(stageDir, 'manifest.json');
    if (!found) throw new Error('Paquete sin manifest.json');
    const manifest = JSON.parse(fs.readFileSync(found, 'utf8').replace(/^\uFEFF/, ''));
    assertValidManifest(manifest);
    const folder = folderForId(manifest.id);
    if (expectedId && manifest.id !== expectedId && folderForId(expectedId) !== folder && expectedId !== folder) {
      throw new Error(`Manifest id ${manifest.id} no coincide con ${expectedId}`);
    }
    // El código debe vivir junto al manifest (misma carpeta que lo contiene)
    const codeRoot = path.dirname(found);
    const mainCandidates = manifest.main ? [manifest.main, 'main.js', 'main.mjs', 'index.js'] : ['main.js', 'main.mjs', 'index.js'];
    const hasMain = mainCandidates.some((c: string) => !c.includes('..') && fs.existsSync(path.join(codeRoot, c)));
    if (!hasMain) throw new Error(`Paquete sin main (buscado ${mainCandidates.join(',')})`);
    // Si el manifest está en subcarpeta del staging (zip con carpeta raíz),
    // aplanar: mover contenido a la raíz del staging para activación uniforme
    if (path.resolve(codeRoot) !== path.resolve(stageDir)) {
      for (const ent of fs.readdirSync(codeRoot, { withFileTypes: true })) {
        const s = path.join(codeRoot, ent.name);
        const d = path.join(stageDir, ent.name);
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
        fs.renameSync(s, d);
      }
    }
    return { manifest, folder };
  }

  private checkEngine(manifest: PluginManifestV2, force?: boolean): void {
    if (manifest.engine && !satisfiesEngine(manifest.engine, LIBREDECK_ENGINE_VERSION)) {
      const msg = `Plugin ${manifest.id} requiere LibreDeck ${manifest.engine} (daemon ${LIBREDECK_ENGINE_VERSION})`;
      if (!force) throw new Error(msg);
      console.warn(msg + ' — continuando por force');
    }
  }

  /**
   * Activa un staging LibreDeck o delega al importador Elgato si el
   * paquete es un .sdPlugin (detección automática: pegar una URL de
   * GitHub de Elgato funciona sin endpoint separado).
   */
  private async activateStagedOrElgato(
    stageDir: string,
    label: string,
    opts: InstallOptions & { expectedId?: string }
  ): Promise<string> {
    const { detectStagedType } = await import('./elgato/manifest');
    let detected: { kind: string };
    try {
      detected = detectStagedType(stageDir);
    } catch {
      detected = { kind: 'libredeck' };
    }
    if (detected.kind === 'elgato') {
      this.emitProgress(label, 'detect', 'Paquete Elgato detectado (.sdPlugin): importando…', opts.onProgress);
      const { importElgatoPlugin } = await import('./elgato/import');
      try {
        const res = await importElgatoPlugin(this.db, { dir: stageDir }, {
          onProgress: (s, m) => this.emitProgress(label, s, m, opts.onProgress),
        });
        try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
        this.emitProgress(res.pluginId, 'done', `Importado ${res.pluginId} (habilitado por defecto)`, opts.onProgress);
        // Auto-arranque en segundo plano (sin bloquear la respuesta HTTP):
        // el progreso real (load → done/error) llega por WS. Solo si es
        // ejecutable; needs-runtime queda habilitado=0 para diagnóstico.
        try {
          const rec = this.db.getPlugin(res.pluginId) as any;
          if (rec && Number(rec.enabled) === 1 && rec.status === 'elgato-stopped') {
            void this.loadElgatoPlugin(res.pluginId).catch(() => {});
          }
        } catch {}
        return res.pluginId;
      } catch (e) {
        try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
        const msg = e instanceof Error ? e.message : String(e);
        this.emitProgress(label, 'error', msg, opts.onProgress);
        throw e;
      }
    }
    if (detected.kind === 'none') {
      const msg = 'Paquete sin manifest.json reconocible (ni LibreDeck ni Elgato)';
      this.emitProgress(label, 'error', msg, opts.onProgress);
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
      throw new Error(msg);
    }
    try {
      return await this.activateStaged(stageDir, opts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emitProgress(label, 'error', msg, opts.onProgress);
      try { if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
      throw e;
    }
  }

  private async activateStaged(stageDir: string, opts: InstallOptions & { expectedId?: string }): Promise<string> {
    const { manifest, folder } = this.readAndValidateStaged(stageDir, opts.expectedId);
    const pluginId = manifest.id;
    this.emitProgress(pluginId, 'validate', `Manifest válido: ${manifest.name} v${manifest.version}`, opts.onProgress);
    this.checkEngine(manifest, opts.force);
    const pluginsDir = getPluginsDir();
    const dest = path.join(pluginsDir, folder);
    const backup = this.backupDirFor(folder);
    const prevRec = this.db.getPlugin(pluginId) as any;
    const prevVersion = prevRec?.version ?? null;
    const prevManifest = prevRec?.manifest ?? null;
    const checksum = this.checksumOfDir(stageDir);

    if (prevRec && !opts.force && prevVersion && compareSemver(manifest.version, prevVersion) < 0) {
      throw new Error(`Downgrade ${prevVersion} → ${manifest.version} bloqueado (usa force para permitirlo)`);
    }

    this.installing.add(folder);
    this.installing.add(pluginId);
    this.emitProgress(pluginId, 'activate', 'Activando nueva versión…', opts.onProgress);
    // Descargar versión activa antes de tocar disco
    if (this.loadedPlugins.has(pluginId)) this.unloadPlugin(pluginId);
    // Guardar backup de la versión previa (una sola)
    const hadDest = fs.existsSync(dest);
    try {
      if (hadDest) {
        if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
        fs.renameSync(dest, backup);
      }
      fs.renameSync(stageDir, dest);
    } catch (e) {
      // Rollback inmediato si el swap falla
      try {
        if (fs.existsSync(dest) && !hadDest) fs.rmSync(dest, { recursive: true, force: true });
        if (hadDest && fs.existsSync(backup) && !fs.existsSync(dest)) fs.renameSync(backup, dest);
      } catch {}
      this.installing.delete(folder);
      this.installing.delete(pluginId);
      throw e;
    }

    // Persistir registro
    const now = Date.now();
    const wantEnabled = opts.enabled ?? (prevRec ? Number(prevRec.enabled) === 1 : true);
    try {
      this.db.upsertPluginRecord({
        id: pluginId, name: manifest.name, version: manifest.version, manifest,
        enabled: wantEnabled ? 1 : 0,
        source_type: opts.sourceType ?? prevRec?.source_type ?? 'zip',
        origin: opts.origin ?? prevRec?.origin ?? null,
        ref: opts.ref ?? prevRec?.ref ?? null,
        commit: (opts as any).commit ?? prevRec?.commit ?? prevRec?.commit_sha ?? null,
        checksum,
        status: 'active',
        last_error: null,
        previous_version: prevVersion,
        previous_manifest: prevManifest,
      } as any);
      // updated_at explícito
      try { getDatabase().prepare('UPDATE plugins SET updated_at = ? WHERE id = ?').run(now, pluginId); } catch {}
    } catch (e) {
      // Revertir swap si la DB falla
      try {
        fs.rmSync(dest, { recursive: true, force: true });
        if (hadDest && fs.existsSync(backup)) fs.renameSync(backup, dest);
      } catch {}
      this.installing.delete(folder);
      this.installing.delete(pluginId);
      throw e;
    }
    this.installing.delete(folder);
    this.installing.delete(pluginId);

    // Cargar y verificar: si el arranque falla, rollback a backup
    const shouldEnable = opts.enabled ?? (prevRec ? Number(prevRec.enabled) === 1 : true);
    if (shouldEnable) {
      this.emitProgress(pluginId, 'load', 'Arrancando plugin…', opts.onProgress);
      const ok = await this.loadPlugin(pluginId, { force: true });
      if (!ok) {
        const err = this.getPluginError(pluginId) ?? 'fallo al arrancar tras instalar';
        console.error(`Activación falló para ${pluginId}, rollback: ${err}`);
        await this.rollbackPlugin(pluginId).catch(() => {});
        const msg = `Instalación revertida: ${err}`;
        this.emitProgress(pluginId, 'error', msg, opts.onProgress);
        throw new Error(msg);
      }
      this.broadcaster?.broadcast('plugin.installed', { pluginId, plugin: this.db.getPlugin(pluginId) }, 'plugins');
    } else {
      this.db.setPluginEnabled(pluginId, false);
    }
    // Limpiar staging residual
    try { if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
    console.log(`✓ Installed plugin: ${pluginId} v${manifest.version}`);
    try { invalidateCatalog(); } catch {}
    this.emitProgress(pluginId, 'done', `Instalado ${manifest.name} v${manifest.version}`, opts.onProgress);
    return pluginId;
  }

  public async installPluginFromZip(zipPath: string, opts: InstallOptions = {}): Promise<string> {
    const pluginsDir = getPluginsDir();
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    if (!fs.existsSync(zipPath)) throw new Error(`ZIP no encontrado: ${zipPath}`);

    const checksum = this.checksumOfFile(zipPath);
    if (opts.checksum && opts.checksum !== checksum) {
      throw new Error('Checksum del ZIP no coincide');
    }

    // Extraer a staging (adm-zip si está, si no tar del sistema)
    const stage = path.join(pluginsDir, `.staging_zip_${Date.now()}`);
    fs.mkdirSync(stage, { recursive: true });
    const label = `file:${path.basename(zipPath)}`;
    try {
      this.emitProgress(label, 'extract', 'Extrayendo ZIP…', opts.onProgress);
      let AdmZip: any = null;
      try { AdmZip = (await import('adm-zip')).default; } catch {}
      if (AdmZip) {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(stage, true);
      } else {
        const proc = Bun.spawn(['tar', '-xf', zipPath, '-C', stage], { stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
        if (proc.exitCode !== 0) {
          const err = await new Response(proc.stderr).text();
          throw new Error(`Extracción ZIP falló (instala adm-zip): ${err}`);
        }
      }
      const id = await this.activateStagedOrElgato(stage, label, {
        ...opts, sourceType: opts.sourceType ?? 'zip', origin: opts.origin ?? label,
      });
      // Guardar checksum del paquete
      try { getDatabase().prepare('UPDATE plugins SET checksum = ? WHERE id = ?').run(checksum, id); } catch {}
      return id;
    } catch (e) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
      throw e;
    }
  }

  /** Instala desde una carpeta local (útil para dev y tests): copia a staging y activa. */
  public async installPluginFromDirectory(srcDir: string, opts: InstallOptions = {}): Promise<string> {
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      throw new Error(`Directorio no encontrado: ${srcDir}`);
    }
    const pluginsDir = getPluginsDir();
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    const stage = path.join(pluginsDir, `.staging_dir_${Date.now()}`);
    fs.mkdirSync(stage, { recursive: true });
    const label = srcDir;
    try {
      this.emitProgress(label, 'extract', 'Copiando a staging…', opts.onProgress);
      copyRecursiveSync(srcDir, stage);
      return await this.activateStagedOrElgato(stage, label, {
        ...opts, sourceType: opts.sourceType ?? 'directory', origin: opts.origin ?? srcDir,
      });
    } catch (e) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
      throw e;
    }
  }

  /** Instala/actualiza desde un repo git (marketplace con pull). Clona a staging, no hace pull sobre el directorio activo. */
  public async installPluginFromGit(url: string, opts: InstallOptions & { ref?: string } = {}): Promise<string> {
    if (!url || typeof url !== 'string') throw new Error('URL git requerida');
    if (url.includes('..') && !url.includes('://') && !url.startsWith('/') && !/^[A-Za-z]:\\/.test(url)) {
      throw new Error('URL git inválida');
    }
    const pluginsDir = getPluginsDir();
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    const stage = path.join(pluginsDir, `.staging_git_${Date.now()}`);
    this.emitProgress(url, 'clone', `Clonando ${url}…`, opts.onProgress);
    // Instalación versionada: si `ref` es un rango (^1.0.0, >=2.0.0, *) se
    // clona completo, se elige el mejor tag y se hace checkout. Si es
    // rama/tag literal se clona --depth 1 como antes.
    const wantsRange = typeof opts.ref === 'string' && isVersionRangeRef(opts.ref);
    const args = wantsRange ? ['clone', url, stage] : ['clone', '--depth', '1'];
    if (!wantsRange && opts.ref) args.push('--branch', opts.ref);
    if (!wantsRange) args.push(url, stage);
    let proc: any;
    try {
      proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
      await proc.exited;
    } catch (e) {
      const msg = `No se pudo ejecutar git: ${e instanceof Error ? e.message : String(e)}`;
      this.emitProgress(url, 'error', msg, opts.onProgress);
      throw new Error(msg);
    }
    if (proc.exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
      const msg = `git clone falló: ${err.slice(0, 500)}`;
      this.emitProgress(url, 'error', msg, opts.onProgress);
      throw new Error(msg);
    }
    // Checkout del mejor tag cuando se pidió un rango de versión.
    if (wantsRange) {
      try {
        const tagProc = Bun.spawn(['git', '-C', stage, 'tag', '--list'], { stdout: 'pipe', stderr: 'pipe' });
        await tagProc.exited;
        const tags = tagProc.exitCode === 0 ? (await new Response(tagProc.stdout).text()).split('\n').map((t) => t.trim()).filter(Boolean) : [];
        const best = pickBestTag(tags, opts.ref!);
        if (best) {
          this.emitProgress(url, 'clone', `Fijando versión ${best} (rango ${opts.ref})…`, opts.onProgress);
          const coProc = Bun.spawn(['git', '-C', stage, 'checkout', '--quiet', best], { stdout: 'pipe', stderr: 'pipe' });
          await coProc.exited;
          if (coProc.exitCode !== 0) {
            const err = await new Response(coProc.stderr).text();
            throw new Error(`checkout de ${best} falló: ${err.slice(0, 200)}`);
          }
        } else {
          this.emitProgress(url, 'clone', `Sin tags para el rango ${opts.ref}: usando HEAD`, opts.onProgress);
        }
      } catch (e) {
        // Best-effort: si el checkout falla, se sigue con HEAD pero avisando.
        this.emitProgress(url, 'clone', `No se pudo fijar el rango ${opts.ref}, usando HEAD`, opts.onProgress);
      }
    }
    let commit: string | null = null;
    try {
      const p2 = Bun.spawn(['git', '-C', stage, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
      await p2.exited;
      if (p2.exitCode === 0) commit = (await new Response(p2.stdout).text()).trim() || null;
    } catch {}
    // Quitar .git del staging para no arrastrar historial al directorio activo
    try { fs.rmSync(path.join(stage, '.git'), { recursive: true, force: true }); } catch {}
    try {
      return await this.activateStagedOrElgato(stage, url, {
        ...opts, sourceType: 'git', origin: url, ref: opts.ref ?? null,
        ...(commit ? { commit } as any : {}),
      });
    } catch (e) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
      throw e;
    }
  }

  /** Descarga un ZIP desde URL (marketplace) a temporal y lo instala, con progreso real. */
  public async installPluginFromUrl(zipUrl: string, opts: InstallOptions = {}): Promise<string> {
    if (!/^https?:\/\//i.test(zipUrl)) throw new Error('URL debe ser http(s)');
    const prog = (s: string, m: string) => this.emitProgress(zipUrl, s, m, opts.onProgress);
    await fs.promises.mkdir(getPluginsDir(), { recursive: true });
    prog('download', 'Conectando…');
    let res: Response;
    try {
      res = await fetch(zipUrl);
    } catch (e) {
      const msg = `Descarga falló: ${e instanceof Error ? e.message : String(e)}`;
      this.emitProgress(zipUrl, 'error', msg, opts.onProgress);
      throw new Error(msg);
    }
    if (!res.ok) {
      const msg = `Descarga falló: HTTP ${res.status}`;
      this.emitProgress(zipUrl, 'error', msg, opts.onProgress);
      throw new Error(msg);
    }
    const total = Number(res.headers.get('content-length') ?? 0);
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    let lastPct = -1;
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        if (loaded > 50 * 1024 * 1024) throw new Error('Paquete excede 50MB');
        if (total > 0) {
          const pct = Math.floor((loaded / total) * 100);
          if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
            lastPct = pct;
            prog('download', `Descargando… ${pct}%`);
          }
        } else if (loaded % (1024 * 1024) < 64 * 1024) {
          prog('download', `Descargando… ${(loaded / 1048576).toFixed(1)} MB`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emitProgress(zipUrl, 'error', msg, opts.onProgress);
      throw e instanceof Error ? e : new Error(msg);
    }
    prog('download', `Descarga completa (${(loaded / 1048576).toFixed(1)} MB)`);
    const tmp = path.join(getPluginsDir(), `.download_${Date.now()}.zip`);
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    await fs.promises.writeFile(tmp, buf);
    try {
      return await this.installPluginFromZip(tmp, { ...opts, sourceType: opts.sourceType ?? 'marketplace', origin: opts.origin ?? zipUrl });
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  }

  /** Actualiza un plugin ya instalado desde git/URL/directorio. */
  public async updatePlugin(pluginId: string, source: { url?: string; ref?: string; dir?: string; zipPath?: string; version?: string; force?: boolean; onProgress?: (stage: string, message: string) => void } = {}): Promise<string> {
    const rec = this.db.getPlugin(pluginId) as any;
    if (!rec) throw new Error(`Plugin desconocido: ${pluginId}`);
    if (isBuiltIn(pluginId)) throw new Error('Los built-in se actualizan con LibreDeck, no desde marketplace');
    const prog = source.onProgress;
    this.emitProgress(pluginId, 'clone', 'Buscando actualización…', prog);
    const prevVersion = rec.version;
    let id: string;
    if (source.zipPath) id = await this.installPluginFromZip(source.zipPath, { force: source.force, origin: rec.origin, sourceType: rec.source_type ?? 'zip', onProgress: prog });
    else if (source.dir) id = await this.installPluginFromDirectory(source.dir, { force: source.force, origin: rec.origin, sourceType: rec.source_type ?? 'directory', onProgress: prog });
    else if (source.url && /\.zip(\?|#|$)/i.test(source.url)) id = await this.installPluginFromUrl(source.url, { force: source.force, origin: source.url, sourceType: 'marketplace', onProgress: prog });
    else if (source.url) id = await this.installPluginFromGit(source.url, { force: source.force, ref: source.ref ?? rec.ref ?? undefined, onProgress: prog });
    else if (rec.source_type === 'git' && rec.origin) id = await this.installPluginFromGit(rec.origin, { force: source.force, ref: source.ref ?? rec.ref ?? undefined, onProgress: prog });
    else throw new Error('Sin origen para actualizar: indica url, dir o zipPath');
    // Aviso si no hubo cambio de versión
    try {
      const now = this.db.getPlugin(id) as any;
      if (now && prevVersion && now.version === prevVersion) {
        console.log(`Update de ${id}: misma versión ${prevVersion} (reinstalado)`);
      }
    } catch {}
    return id;
  }

  /** Revierte a la versión previa guardada en backup. */
  public async rollbackPlugin(pluginId: string): Promise<boolean> {
    const rec = this.db.getPlugin(pluginId) as any;
    if (!rec) throw new Error(`Plugin desconocido: ${pluginId}`);
    const folder = folderForId(pluginId);
    const dest = path.join(getPluginsDir(), folder);
    const backup = this.backupDirFor(folder);
    if (!rec.previous_version || !fs.existsSync(backup)) {
      throw new Error(`Sin versión previa para ${pluginId}`);
    }
    this.unloadPlugin(pluginId);
    this.installing.add(folder);
    try {
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(backup, dest);
    } finally {
      this.installing.delete(folder);
    }
    const manifestFile = path.join(dest, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''));
    this.db.upsertPluginRecord({
      id: pluginId, name: manifest.name, version: manifest.version, manifest,
      enabled: 1, status: 'active', last_error: null,
      previous_version: null, previous_manifest: null,
    } as any);
    const ok = await this.loadPlugin(pluginId, { force: true });
    this.broadcaster?.broadcast('plugin.installed', { pluginId, plugin: this.db.getPlugin(pluginId), rolledBack: true }, 'plugins');
    return ok;
  }

  public async uninstallPlugin(pluginId: string): Promise<boolean> {
    // Proteger built-ins
    if (isBuiltIn(pluginId)) throw new Error(`No se puede desinstalar plugin built-in ${pluginId} (desactívalo si quieres)`);

    this.unloadPlugin(pluginId);
    getDatabase().prepare('DELETE FROM plugins WHERE id = ?').run(pluginId);

    const pluginsDir = getPluginsDir();
    const folders = [folderForId(pluginId), pluginId];
    for (const f of new Set(folders)) {
      const pluginPath = path.join(pluginsDir, f);
      try {
        if (fs.existsSync(pluginPath)) {
          fs.rmSync(pluginPath, { recursive: true, force: true });
        }
      } catch (e) { console.warn(`No se pudo borrar archivos de ${pluginId}:`, e); }
    }
    // Limpiar staging/backup residuales
    try {
      for (const ent of fs.readdirSync(pluginsDir)) {
        if (ent.includes(folderForId(pluginId)) && isTempEntry(ent)) {
          fs.rmSync(path.join(pluginsDir, ent), { recursive: true, force: true });
        }
      }
    } catch {}
    try {
      // Limpiar settings namespaced
      getDatabase().prepare("DELETE FROM settings WHERE key LIKE ?").run(`plugin.${pluginId}.%`);
    } catch (e) { console.warn(`No se pudo limpiar settings de ${pluginId}:`, e); }
    try { invalidateCatalog(); } catch {}

    try {
      this.broadcaster?.broadcast('plugin.uninstalled', { pluginId }, 'plugins');
    } catch {}
    console.log(`✓ Uninstalled plugin: ${pluginId}`);
    return true;
  }

  public dispose(): void {
    if (this.watcher) this.watcher.close();
    for (const id of [...this.elgatoRunning]) {
      try { this.unloadElgatoPlugin(id); } catch {}
    }
    this.elgatoRunning.clear();
    const m = this.elgatoManager;
    this.elgatoManager = null;
    if (m && typeof m.stopAll === 'function') {
      void (async () => { try { await m.stopAll(); } catch {} })();
    }
    for (const id of [...this.loadedPlugins.keys()]) this.unloadPlugin(id);
    for (const [, w] of this.externalWorkers) {
      try { w.terminate(); } catch {}
    }
    this.externalWorkers.clear();
    this.debounceTimers.forEach(t => clearTimeout(t));
    this.debounceTimers.clear();
  }
}

function findFileRecursive(dir: string, name: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory() && !isTempEntry(e.name) && e.name !== '.git') {
      const found = findFileRecursive(full, name);
      if (found) return found;
    }
  }
  return null;
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '.git' || isTempEntry(ent.name)) continue;
      out.push(...listFilesRecursive(full));
    } else out.push(full);
  }
  return out;
}

function copyRecursiveSync(src: string, dest: string) {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyRecursiveSync(s, d); }
    else fs.copyFileSync(s, d);
  }
}
