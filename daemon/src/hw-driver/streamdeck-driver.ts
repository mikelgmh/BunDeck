import type { StreamDeck } from '@elgato-stream-deck/node';
import { DatabaseService } from '../db';
import { resolveAssignedPageForDevice } from '../devices';
import type { PressType } from '../flow/types';
import { buttonHasTrigger } from '../flow/migrate';
import type { Env } from '../variables/expressions';
import {
  DEFAULT_KEY_BG,
  DEFAULT_KEY_FG,
  displayNeedsLiveUpdate,
  getDaemonDisplayEnv,
  resolvedSignature,
  resolveKeyDisplay,
} from './key-display';
import {
  DeviceIdleTracker,
  dimLevelFor,
  displaySettingKey,
  normalizeBrightness,
  resolveEffectiveDisplaySettings,
  validateDisplayPatch,
  type DeviceDisplaySettings,
} from './device-display';

// Carga perezosa de las libs nativas (node-hid): si faltan o fallan,
// el driver queda "sin hardware" en vez de tumbar el daemon/API.
let elgatoMod: any = null;
let elgatoFailed = false;
async function getElgato(): Promise<any | null> {
  if (elgatoMod) return elgatoMod;
  if (elgatoFailed) return null;
  try {
    elgatoMod = await import('@elgato-stream-deck/node');
    return elgatoMod;
  } catch (e) {
    elgatoFailed = true;
    console.warn('⚠️ HID Elgato no disponible (modo sin hardware):', e instanceof Error ? e.message : e);
    return null;
  }
}

async function getJpeg(): Promise<((w: number, h: number, bg: any, fg: any) => Promise<Buffer>) | null> {
  try {
    const m = await import('@elgato-stream-deck/node-lib');
    return m.encodeJPEG;
  } catch (e) {
    console.warn('⚠️ encodeJPEG no disponible:', e instanceof Error ? e.message : e);
    return null;
  }
}

// canvas también es nativo: perezoso para no tumbar el daemon sin él.
let canvasMod: any = null;
let canvasFailed = false;
async function getCanvas(): Promise<any | null> {
  if (canvasMod) return canvasMod;
  if (canvasFailed) return null;
  try {
    canvasMod = await import('@napi-rs/canvas');
    return canvasMod;
  } catch (e) {
    canvasFailed = true;
    console.warn('⚠️ canvas no disponible (render HW desactivado):', e instanceof Error ? e.message : e);
    return null;
  }
}

// Cache del módulo 'lucide' (paquete grande): un solo import en vez de
// uno por botón. Sin esto, cada render de icono re-parsea el paquete
// en el hilo principal y retrasa segundos el arranque con HW conectado.
let lucideModulePromise: Promise<any> | null = null;
function getLucideModule(): Promise<any> {
  if (!lucideModulePromise) {
    lucideModulePromise = import('lucide').catch((e) => {
      lucideModulePromise = null;
      throw e;
    });
  }
  return lucideModulePromise;
}

// Cache del módulo 'simple-icons' (marcas como YouTube/Twitch/GitHub que
// Lucide eliminó y por eso en el HW caían al fallback de texto). Solo se
// carga bajo demanda, la primera vez que se pide un icono de marca.
let simpleIconsModulePromise: Promise<any> | null = null;
function getSimpleIconsModule(): Promise<any> {
  if (!simpleIconsModulePromise) {
    simpleIconsModulePromise = import('simple-icons').catch((e) => {
      simpleIconsModulePromise = null;
      throw e;
    });
  }
  return simpleIconsModulePromise;
}

/** slug (minúsculas) → icono simple-icons, construido una sola vez. */
let simpleIconsBySlugCache: Map<string, any> | null = null;
async function getSimpleIconsBySlug(): Promise<Map<string, any>> {
  if (simpleIconsBySlugCache) return simpleIconsBySlugCache;
  const mod: any = await getSimpleIconsModule();
  const map = new Map<string, any>();
  for (const v of Object.values(mod)) {
    const icon: any = v;
    if (icon && typeof icon.slug === 'string' && typeof icon.path === 'string') {
      map.set(icon.slug, icon);
    }
  }
  simpleIconsBySlugCache = map;
  return map;
}

/**
 * Resuelve un icono de marca simple-icons a partir del nombre guardado:
 * - `si:<slug>` (pestaña «Simple Icons» del selector): p. ej. `si:youtube`.
 * - Nombre Lucide de marca eliminada (perfiles antiguos): `Youtube`,
 *   `Twitch`, `Github` → slugs `youtube`, `twitch`, `github`.
 * Devuelve el `path` SVG (glifo sólido 24×24) o null si no es una marca.
 */
async function getSimpleIconPath(iconName: string): Promise<string | null> {
  const siPrefixed = /^si:([a-z0-9]+)$/.exec(iconName.trim());
  const slug = siPrefixed
    ? siPrefixed[1]
    : /^[A-Za-z][A-Za-z0-9]*$/.test(iconName) && /^(youtube|twitch|github)$/i.test(iconName)
      ? iconName.toLowerCase()
      : null;
  if (!slug) return null;
  try {
    const map = await getSimpleIconsBySlug();
    const icon = map.get(slug);
    return icon && typeof icon.path === 'string' ? icon.path : null;
  } catch {
    return null;
  }
}

export class StreamDeckDriver {
  private streamDeck: StreamDeck | null = null;
  private connectedDevice: string | null = null;

  /**
   * Brillo por dispositivo + dim + idle (devices.<id>.* en settings).
   * Sin timers propios: `idleTimer` sondea `tracker.poll()` cada 5 s;
   * los tests avanzan el reloj llamando a `checkIdleState(nowMs)`.
   */
  private readonly idleTracker = new DeviceIdleTracker();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Sesión propia del hardware (independiente de los browsers/relay).
   * Sobrevive a reinicios vía `device_sessions` (deviceId estable).
   */
  private readonly deviceId = 'streamdeck-local';
  private sessionProfileId: string | null = null;
  private sessionPageId: string | null = null;

  /** Identificador estable de la sesión hardware (para navegación dirigida). */
  getDeviceId(): string {
    return this.deviceId;
  }

  /** Vista actual propia (no lee `current.*` globales salvo migración inicial). */
  getSessionView(): { profileId: string | null; pageId: string | null } {
    // Refrescar desde la tabla si la memoria aún no se inicializó
    if (!this.sessionProfileId && !this.sessionPageId) {
      this.loadSessionView();
    }
    return { profileId: this.sessionProfileId, pageId: this.sessionPageId };
  }

  /**
   * Fija la vista propia (p. ej. desde POST /sessions/streamdeck-local o
   * navegación dirigida) y repinta si hay hardware conectado.
   */
  async setSessionView(view: { profileId?: string | null; pageId?: string | null }): Promise<void> {
    const db = new DatabaseService();
    if (view.profileId !== undefined) {
      if (view.profileId !== null && !db.getProfile(view.profileId)) {
        throw new Error(`Profile not found: ${view.profileId}`);
      }
      this.sessionProfileId = view.profileId;
    }
    if (view.pageId !== undefined) {
      if (view.pageId !== null && !db.getPage(view.pageId)) {
        throw new Error(`Page not found: ${view.pageId}`);
      }
      if (view.pageId !== null && this.streamDeck) {
        // El HW solo muestra cuadrícula con su tamaño exacto.
        const { parseLayoutMode, resolvePageSize } = await import('../devices');
        const grid = this.getGridGeometry();
        const pg = db.getPage(view.pageId)!;
        if (grid && parseLayoutMode(pg.data) !== 'classic') {
          throw new Error(`La página «${pg.name}» está en modo libre y un Stream Deck solo admite cuadrícula`);
        }
        if (grid) {
          const profileData = db.getProfile(pg.profile_id)?.data;
          const size = resolvePageSize(
            { grid_cols: pg.grid_cols ?? null, grid_rows: pg.grid_rows ?? null },
            profileData,
          );
          if (size.cols !== grid.cols || size.rows !== grid.rows) {
            throw new Error(
              `La página «${pg.name}» es de ${size.cols}×${size.rows} y el Stream Deck es de ${grid.cols}×${grid.rows}`,
            );
          }
        }
      }
      this.sessionPageId = view.pageId;
      const page = view.pageId ? db.getPage(view.pageId) : null;
      if (page) this.sessionProfileId = page.profile_id;
    }
    db.upsertDeviceSession({
      device_id: this.deviceId,
      name: 'StreamDeck',
      kind: 'hardware',
      profile_id: this.sessionProfileId,
      page_id: this.sessionPageId,
    });
    if (this.sessionPageId && this.streamDeck) {
      await this.updateFromPage(this.sessionPageId);
    }
  }

  /**
   * Página que debe mostrar el HW en un perfil: la asignada a este
   * dispositivo si es válida (pertenece al perfil), o la primera página
   * del perfil. Misma regla que `pageFor` de `navigateProfileTo` (ws.ts).
   */
  resolveHwAssignedPageId(
    db: DatabaseService,
    profileId: string,
    deviceId: string = this.deviceId,
  ): string | null {
    let assignments: Record<string, string> = {};
    try {
      assignments = db.getAssignments(profileId) ?? {};
    } catch { assignments = {}; }
    let firstPage: string | null = null;
    try {
      const pages = db.getPagesByProfile(profileId);
      firstPage = (pages.find((p) => p.is_folder === 0) || pages[0])?.id ?? null;
    } catch { firstPage = null; }
    return resolveAssignedPageForDevice({
      assignments,
      pageProfileIdOf: (pageId: string) => {
        try {
          return db.getPage(pageId)?.profile_id ?? null;
        } catch {
          return null;
        }
      },
      profileId,
      deviceId,
      firstPageId: firstPage,
    });
  }

  /**
   * Aplica al HW la página asignada del perfil dado (o del perfil global
   * actual): resuelve asignación validada + fallback a primera página,
   * fija la sesión (memoria + tabla) y repinta si hay hardware conectado.
   * Nunca tumba al llamador (boot/conexión son non-fatal): devuelve la
   * pageId aplicada o null si no había nada que mostrar o era incompatible.
   *
   * Anti-bloqueo: si la página asignada YA es la pintada en esta conexión,
   * no se repinta (cada `hello` del WS llamaba aquí → N repaints completos
   * de 15 botones que bloqueaban /health). Salvo `force: true`.
   */
  async applyProfileAssignment(
    profileId?: string | null,
    dbArg?: DatabaseService,
    opts?: { force?: boolean },
  ): Promise<string | null> {
    try {
      const db = dbArg ?? new DatabaseService();
      const current = profileId ?? db.getCurrentProfile()?.id ?? this.sessionProfileId;
      if (!current || !db.getProfile(current)) return null;
      const pageId = this.resolveHwAssignedPageId(db, current);
      if (!pageId) return null;
      if (!opts?.force && this.streamDeck && pageId === this.lastPaintedPageId) {
        this.skippedSamePage += 1;
        return pageId;
      }
      await this.setSessionView({ profileId: current, pageId });
      return pageId;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(`⚠️ HW assignment no aplicada: ${reason}`);
      try {
        (globalThis as any).__libredeckWs?.broadcast?.('page.blocked', { reason }, 'pages');
      } catch { /* noop */ }
      return null;
    }
  }

  /** Carga la vista propia desde `device_sessions` (o migra la global). */
  private loadSessionView(): void {
    try {
      const db = new DatabaseService();
      const persisted = db.getDeviceSession(this.deviceId);
      if (persisted && (persisted.profile_id || persisted.page_id)) {
        this.sessionProfileId = persisted.profile_id;
        this.sessionPageId = persisted.page_id;
        // Validar que sigan existiendo
        if (this.sessionProfileId && !db.getProfile(this.sessionProfileId)) {
          this.sessionProfileId = null;
        }
        if (this.sessionPageId) {
          const page = db.getPage(this.sessionPageId);
          if (!page) {
            this.sessionPageId = null;
          } else if (this.sessionProfileId && page.profile_id !== this.sessionProfileId) {
            this.sessionPageId = null;
          } else if (!this.sessionProfileId) {
            this.sessionProfileId = page.profile_id;
          }
        }
        if (this.sessionProfileId && !this.sessionPageId) {
          const pages = db.getPagesByProfile(this.sessionProfileId);
          const first = pages.find((p) => p.is_folder === 0) || pages[0];
          this.sessionPageId = first ? first.id : null;
        }
        if (this.sessionProfileId) return;
      }
      // Migración inicial: heredar la vista global una sola vez
      const globalProfileId = db.getSetting('current.profile_id');
      const globalPageId = db.getSetting('current.page_id');
      const valid = (v: string | null) => (v && v !== 'null' && v !== '' ? v : null);
      let profileId = valid(globalProfileId);
      let pageId = valid(globalPageId);
      if (profileId && !db.getProfile(profileId)) profileId = null;
      if (pageId) {
        const page = db.getPage(pageId);
        if (!page || (profileId && page.profile_id !== profileId)) {
          pageId = null;
        } else if (!profileId) {
          profileId = page.profile_id;
        }
      }
      if (!profileId) {
        const profiles = db.getProfiles();
        profileId = profiles.length > 0 ? profiles[0].id : null;
      }
      if (profileId && !pageId) {
        const pages = db.getPagesByProfile(profileId);
        const first = pages.find((p) => p.is_folder === 0) || pages[0];
        pageId = first ? first.id : null;
      }
      this.sessionProfileId = profileId;
      this.sessionPageId = pageId;
      db.upsertDeviceSession({
        device_id: this.deviceId,
        name: 'StreamDeck',
        kind: 'hardware',
        profile_id: profileId,
        page_id: pageId,
      });
    } catch {
      // sin BD: la sesión queda vacía hasta conectar
    }
  }

  /** Lista dispositivos sin tumbar nada si no hay HID. */
  async listDevices(): Promise<any[]> {
    const mod = await getElgato();
    if (!mod) return [];
    try {
      return await mod.listStreamDecks();
    } catch (e) {
      console.warn('⚠️ listStreamDecks falló:', e instanceof Error ? e.message : e);
      return [];
    }
  }

  async connect(devicePath?: string): Promise<boolean> {
    try {
      console.log('🔌 Attempting to connect to StreamDeck...');

      const mod = await getElgato();
      if (!mod) {
        console.log('ℹ️ Sin soporte HID: no se puede conectar al StreamDeck físico');
        return false;
      }
      const devices = await this.listDevices();
      console.log(`📋 Found ${devices.length} StreamDeck devices:`, devices);

      if (devices.length === 0) {
        console.log('❌ No StreamDeck devices found');
        return false;
      }

      // Use provided device path or first available device
      const targetDevice = devicePath || devices[0].path;
      console.log(`🎯 Connecting to device: ${targetDevice}`);

      if (this.streamDeck) {
        console.log('🔌 Disconnecting existing connection...');
        await this.disconnect();
      }

      console.log('🔌 Opening StreamDeck connection...');
      this.streamDeck = await mod.openStreamDeck(targetDevice);
      this.connectedDevice = targetDevice;
      // Conexión nueva: la pantalla física está sin pintar aunque la
      // sesión recuerde una página (el skip-if-same no aplica aquí).
      this.lastPaintedPageId = null;
      this.paintedKeySigs.clear();
      this.hidFailCount = 0;
      this.hidCooldownUntil = 0;
      this.queuedPageId = null;

      console.log('✅ StreamDeck connected successfully');
      
      this.setupEventHandlers();
      console.log('🎧 Event handlers set up');

      // Initialize all buttons to black (for testing)
      console.log('🎨 Initializing buttons...');
      await this.initializeButtons();

      console.log(`🎛️ Connected to StreamDeck: ${targetDevice}`);

      // Try to update with current page if available
      // This will be called from the API route after connection
      // La asignación del perfil actual manda sobre la sesión recordada:
      // al abrir la app / (re)conectar el HW, el deck muestra SU página
      // asignada (validada, con fallback a la primera del perfil).
      this.loadSessionView();
      let painted: string | null = null;
      try {
        painted = await this.applyProfileAssignment();
      } catch {
        painted = null;
      }
      if (!painted && this.sessionPageId) {
        console.log(`🎛️ Restoring hardware session page: ${this.sessionPageId}`);
        await this.updateFromPage(this.sessionPageId);
      }
      // Brillo por dispositivo + bucle dim/idle de este deck.
      this.refreshDisplaySettings();
      this.startIdleLoop();
      return true;
    } catch (error) {
      console.error('❌ Failed to connect to StreamDeck:', error);
      console.error('❌ Stack trace:', error.stack);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.stopIdleLoop();
    this.lastPaintedPageId = null;
    this.paintedKeySigs.clear();
    for (const [, iv] of this.dynamicIntervals.entries()) {
      clearInterval(iv);
    }
    this.dynamicIntervals.clear();
    if (this.liveInterval) {
      clearInterval(this.liveInterval);
      this.liveInterval = null;
    }
    this.liveSigs.clear();
    this.liveRaws.clear();
    if (this.streamDeck) {
      this.streamDeck.removeAllListeners();
      await this.streamDeck.close();
      this.streamDeck = null;
      this.connectedDevice = null;
      console.log('Disconnected from StreamDeck');
    }
  }

  private setupEventHandlers(): void {
    if (!this.streamDeck) return;

    this.streamDeck.on('down', (keyInfo) => {
      // keyInfo might be an object with index property, or just the index number
      const keyIndex = typeof keyInfo === 'object' && keyInfo !== null ? keyInfo.index || keyInfo.keyIndex || 0 : keyInfo;
      console.log(`StreamDeck button ${keyIndex} pressed`);
      void this.handleKeyDown(keyIndex);
    });

    this.streamDeck.on('up', (keyInfo) => {
      const keyIndex = typeof keyInfo === 'object' && keyInfo !== null ? keyInfo.index || keyInfo.keyIndex || 0 : keyInfo;
      console.log(`StreamDeck button ${keyIndex} released`);
      void this.handleKeyUp(keyIndex);
    });

    this.streamDeck.on('error', (error) => {
      console.error('StreamDeck error:', error);
    });
  }

  // ---- Detección de pressType (short/long/double/touch-start/touch-end) ----
  //
  // El daemon ejecuta cada pressType como flujo (acciones + reglas `when`).
  // Sin UI abierta esto sustituye al motor cliente (useKeyEngine): la
  // semántica vive en `flow/migrate.ts` y la ejecuta POST /buttons/press.

  private keyDownAt = new Map<number, number>();
  private longTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private longFired = new Set<number>();
  private pendingShort = new Map<number, ReturnType<typeof setTimeout>>();
  private lastUpAt = new Map<number, number>();

  private static readonly LONG_MS = 500;
  private static readonly DOUBLE_GAP_MS = 350;

  private getLongPressMs(): number {
    try {
      const db = new DatabaseService();
      const raw = db.getSetting('input.longpress_ms') ?? db.getSetting('hardware.longpress_ms');
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n) && n >= 150 && n <= 3000) return n;
    } catch { /* umbral por defecto */ }
    return StreamDeckDriver.LONG_MS;
  }

  private async handleKeyDown(keyIndex: number): Promise<void> {
    this.keyDownAt.set(keyIndex, Date.now());
    this.longFired.delete(keyIndex);
    void this.noteHwActivity();
    // Si había un short pendiente (posible doble), se cancela: la segunda
    // pulsación decide (double), no se ejecuta el short anterior.
    const pending = this.pendingShort.get(keyIndex);
    if (pending) {
      clearTimeout(pending);
      this.pendingShort.delete(keyIndex);
    }
    // touch-start: solo si la tecla tiene reglas para ello (evita POSTs inútiles).
    try {
      const target = this.resolvePressTarget(keyIndex);
      if (target && buttonHasTrigger(target.button.data, 'touch-start')) {
        void this.postPress(target, 'touch-start');
      }
    } catch { /* mejor esfuerzo */ }
    // Armar long-press.
    const longMs = this.getLongPressMs();
    const timer = setTimeout(() => {
      this.longTimers.delete(keyIndex);
      const downAt = this.keyDownAt.get(keyIndex);
      if (downAt === undefined) return; // ya se soltó
      this.longFired.add(keyIndex);
      void this.handleButtonPress(keyIndex, 'long');
    }, longMs);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    this.longTimers.set(keyIndex, timer);
  }

  private async handleKeyUp(keyIndex: number): Promise<void> {
    const timer = this.longTimers.get(keyIndex);
    if (timer) {
      clearTimeout(timer);
      this.longTimers.delete(keyIndex);
    }
    this.keyDownAt.delete(keyIndex);
    void this.noteHwActivity();
    // touch-end (best-effort, solo con reglas).
    try {
      const target = this.resolvePressTarget(keyIndex);
      if (target && buttonHasTrigger(target.button.data, 'touch-end')) {
        void this.postPress(target, 'touch-end');
      }
      if (this.longFired.has(keyIndex)) {
        this.longFired.delete(keyIndex);
        return; // el long ya se ejecutó al cumplirse el umbral
      }
      // ¿Doble pulsación? (misma tecla, gap corto desde el último `up`)
      const now = Date.now();
      const lastUp = this.lastUpAt.get(keyIndex) ?? 0;
      this.lastUpAt.set(keyIndex, now);
      if (now - lastUp <= StreamDeckDriver.DOUBLE_GAP_MS && target && buttonHasTrigger(target.button.data, 'double')) {
        // Cancelar el short pendiente de la primera pulsación, si lo hay.
        const pending = this.pendingShort.get(keyIndex);
        if (pending) {
          clearTimeout(pending);
          this.pendingShort.delete(keyIndex);
        }
        await this.handleButtonPress(keyIndex, 'double');
        return;
      }
      // Si la tecla distingue double, retrasar el short para no ejecutarlo
      // antes de saber si viene la segunda pulsación; si no, inmediato.
      if (target && buttonHasTrigger(target.button.data, 'double')) {
        const t = setTimeout(() => {
          this.pendingShort.delete(keyIndex);
          void this.handleButtonPress(keyIndex, 'short');
        }, StreamDeckDriver.DOUBLE_GAP_MS);
        if (typeof (t as any).unref === 'function') (t as any).unref();
        this.pendingShort.set(keyIndex, t);
        return;
      }
      await this.handleButtonPress(keyIndex, 'short');
    } catch (error) {
      console.error(`❌ Error handling StreamDeck button release ${keyIndex}:`, error);
    }
  }

  getConnectedDevice(): string | null {
    return this.connectedDevice;
  }

  isConnected(): boolean {
    return this.streamDeck !== null;
  }

  /**
   * Número de teclas del dispositivo conectado (6/15/32 según modelo).
   * Sin hardware conectado devuelve el fallback clásico de 15.
   */
  getKeyCount(): number {
    try {
      const controls = (this.streamDeck as any)?.CONTROLS;
      if (Array.isArray(controls)) {
        const n = controls.filter((c: any) => c?.type === 'button').length;
        if (Number.isInteger(n) && n > 0) return n;
      }
    } catch { /* fallback */ }
    return 15;
  }

  /**
   * Geometría (filas/columnas) derivada de los controles del dispositivo.
   * Null si no hay hardware conectado.
   */
  getGridGeometry(): { cols: number; rows: number } | null {
    try {
      const controls = (this.streamDeck as any)?.CONTROLS;
      if (Array.isArray(controls)) {
        const btns = controls.filter((c: any) => c?.type === 'button');
        if (btns.length > 0) {
          const cols = Math.max(...btns.map((c: any) => Number(c.column) || 0)) + 1;
          const rows = Math.max(...btns.map((c: any) => Number(c.row) || 0)) + 1;
          return { cols, rows };
        }
      }
    } catch { /* sin geometría */ }
    return null;
  }

  // ---- Brillo por dispositivo + dim + idle ----

  /** Id usado en las claves `devices.<id>.*`. Sin HW conectado, sesión local. */
  getDisplayDeviceId(): string {
    return this.connectedDevice ?? 'streamdeck-local';
  }

  /** Ajustes de pantalla del dispositivo (ruta efectiva: virgen → dim/idle off). */
  getDisplaySettings(
    deviceId: string = this.getDisplayDeviceId(),
    store?: { getSetting(k: string): string | null },
  ): DeviceDisplaySettings {
    const db = store ?? new DatabaseService();
    return resolveEffectiveDisplaySettings((k) => db.getSetting(k), deviceId);
  }

  /** Recarga los ajustes efectivos del deck conectado en el tracker (tras conectar o POST). */
  refreshDisplaySettings(
    deviceId: string = this.getDisplayDeviceId(),
    store?: { getSetting(k: string): string | null },
  ): DeviceDisplaySettings {
    const s = this.getDisplaySettings(deviceId, store);
    this.idleTracker.updateSettings(s);
    return s;
  }

  /**
   * Guarda un patch parcial (`brightness`, `dimAfterSec`, `idleMinutes`,
   * `idleAction`) para un dispositivo y lo aplica en vivo si es el conectado.
   */
  async setDisplaySettings(
    patch: Record<string, unknown>,
    deviceId: string = this.getDisplayDeviceId(),
    store?: { getSetting(k: string): string | null; setSetting(k: string, v: string): void },
  ): Promise<DeviceDisplaySettings> {
    const valid = validateDisplayPatch(patch);
    const db = store ?? new DatabaseService();
    for (const [field, value] of Object.entries(valid)) {
      db.setSetting(displaySettingKey(deviceId, field as 'brightness'), String(value));
    }
    this.idleTracker.updateSettings(valid);
    // Cualquier cambio manual despierta: restaura brillo y repinta.
    if (deviceId === this.getDisplayDeviceId()) {
      this.idleTracker.noteActivity(Date.now());
      if (this.streamDeck) {
        await this.applyHwBrightness(this.idleTracker.getSettings().brightness);
        const view = this.getSessionView();
        if (view.pageId) await this.updateFromPage(view.pageId);
      }
    }
    return this.idleTracker.getSettings();
  }

  /** Atajo: fija el brillo (0-100) de un dispositivo. */
  async setBrightness(
    deviceId: string,
    brightness: number,
    store?: { getSetting(k: string): string | null; setSetting(k: string, v: string): void },
  ): Promise<DeviceDisplaySettings> {
    return this.setDisplaySettings({ brightness: normalizeBrightness(brightness) }, deviceId, store);
  }

  /** ¿Pantalla apagada por reposo? (los repintados periódicos la respetan). */
  isScreenOff(): boolean {
    const s = this.idleTracker.getSettings();
    return this.idleTracker.currentPhase() === 'idle' && s.idleAction === 'off';
  }

  /** Actividad HW: despierta de dim/idle restaurando brillo y página. */
  async noteHwActivity(): Promise<void> {
    const was = this.idleTracker.currentPhase();
    this.idleTracker.noteActivity(Date.now());
    if (was === 'active' || !this.streamDeck) return;
    await this.applyHwBrightness(this.idleTracker.getSettings().brightness);
    const view = this.getSessionView();
    if (view.pageId) await this.updateFromPage(view.pageId);
  }

  private startIdleLoop(): void {
    this.stopIdleLoop();
    this.idleTracker.noteActivity(Date.now());
    // Aplica el brillo guardado al conectar (la lib lo resetea al abrir).
    void this.applyHwBrightness(this.idleTracker.getSettings().brightness);
    this.idleTimer = setInterval(() => {
      void this.checkIdleState().catch((e) => console.error('❌ Idle check failed:', e));
    }, 5000);
    if (typeof (this.idleTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.idleTimer as unknown as { unref: () => void }).unref();
    }
  }

  private stopIdleLoop(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Avanza dim/idle al instante `nowMs` (el bucle usa Date.now()).
   * Devuelve la fase nueva si cambió, null si sigue igual.
   */
  async checkIdleState(nowMs: number = Date.now()): Promise<'active' | 'dimmed' | 'idle' | null> {
    const changed = this.idleTracker.poll(nowMs);
    if (!changed || !this.streamDeck) return changed;
    const s = this.idleTracker.getSettings();
    if (changed === 'dimmed') {
      await this.applyHwBrightness(s.idleAction === 'clock' ? s.brightness : dimLevelFor(s.brightness));
    } else if (changed === 'idle') {
      if (s.idleAction === 'off') {
        try {
          await this.streamDeck.clearPanel();
        } catch (e) {
          console.warn('⚠️ clearPanel falló:', e instanceof Error ? e.message : e);
        }
      } else if (s.idleAction === 'dim') {
        await this.applyHwBrightness(dimLevelFor(s.brightness));
      } else {
        await this.paintClockIdle();
      }
    }
    return changed;
  }

  /** Brillo nativo (`setBrightness` existe en todos los modelos, ver core/types). */
  private async applyHwBrightness(n: number): Promise<void> {
    if (!this.streamDeck) return;
    try {
      await (this.streamDeck as StreamDeck).setBrightness(normalizeBrightness(n));
    } catch (e) {
      // Modelos/lib antiguas sin soporte: el dim se emula apagando en idle.
      console.warn('⚠️ setBrightness no soportado:', e instanceof Error ? e.message : e);
    }
  }

  /** Reposo `clock`: pinta HH:MM en todas las teclas con el render normal. */
  private async paintClockIdle(): Promise<void> {
    if (!this.streamDeck) return;
    try {
      const d = new Date();
      const label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const size = this.getIconSize();
      const keyCount = this.getKeyCount();
      const raw = { label, backgroundColor: '#000000', textColor: '#f1f5f9' };
      const env = getDaemonDisplayEnv();
      const sig = this.keyContentSig(raw, env, size);
      const tG0 = Bun.nanoseconds();
      const buf = await this.getCachedOrRender(sig, size, raw, env);
      this.noteKeyGen((Bun.nanoseconds() - tG0) / 1e6);
      for (let i = 0; i < keyCount; i++) {
        const tW0 = Bun.nanoseconds();
        await this.setButtonImage(i, buf);
        this.noteKeyWrite((Bun.nanoseconds() - tW0) / 1e6);
        this.paintedKeySigs.set(i, sig);
      }
    } catch (e) {
      console.warn('⚠️ Reloj idle falló:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * Firma del contenido a pintar por tecla: apariencia efectiva resuelta
   * (looks + {{vars}} + dynamicValue) + tamaño. Barata (sin canvas): el
   * diff se decide ANTES de renderizar o escribir al HID.
   */
  private keyContentSig(dataToRender: any, env: Env, size: number): string {
    try {
      return `${size}|${resolvedSignature(resolveKeyDisplay(dataToRender ?? {}, env ?? getDaemonDisplayEnv()))}`;
    } catch {
      try {
        return `${size}|${JSON.stringify(dataToRender ?? null)}`;
      } catch {
        return `${size}|unhashable`;
      }
    }
  }

  /** Render con caché por firma (evita re-renderizar iconos/fondos iguales). */
  private async getCachedOrRender(sig: string, size: number, dataToRender: any, env: Env): Promise<Buffer> {
    const key = `${size}|${sig}`;
    const hit = this.keyImageCache.get(key);
    if (hit) {
      this.keyImageCacheHits += 1;
      return hit;
    }
    const buf = await this.generateButtonImage(dataToRender, size, env);
    if (this.keyImageCache.size >= StreamDeckDriver.KEY_IMAGE_CACHE_MAX) {
      const oldest = this.keyImageCache.keys().next();
      if (!oldest.done) this.keyImageCache.delete(oldest.value);
    }
    this.keyImageCache.set(key, buf);
    return buf;
  }

  private noteKeyGen(ms: number): void {
    this.keyGenCount += 1;
    this.keyGenMsTotal += ms;
    if (ms > StreamDeckDriver.GEN_SLOW_WARN_MS) {
      this.slowGenRenders += 1;
      console.warn(`⚠️ HW gen lenta: render tecla ${ms.toFixed(0)}ms (>${StreamDeckDriver.GEN_SLOW_WARN_MS}ms)`);
    }
  }

  private noteKeyWrite(ms: number): void {
    this.keyWriteCount += 1;
    this.keyWriteMsTotal += ms;
  }

  async testStreamDeck(): Promise<void> {    if (!this.streamDeck) {
      console.log('❌ StreamDeck not connected, cannot run test');
      return;
    }

    console.log('🧪 Running StreamDeck color test...');
    const keyCount = this.getKeyCount();
    const colors: Array<[number, number, number]> = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ];
    try {
      for (const [r, g, b] of colors) {
        for (let i = 0; i < keyCount; i++) {
          await this.setButtonColor(i, r, g, b);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
      }
      console.log('✅ StreamDeck color test completed, restoring page...');
    } catch (error) {
      console.error('❌ Error during StreamDeck test:', error);
    }
    // Restaurar la página actual tras el test
    try {
      const view = this.getSessionView();
      if (view.pageId) {
        await this.updateFromPage(view.pageId);
      }
    } catch (error) {
      console.error('❌ Failed to restore StreamDeck after test:', error);
    }
  }

  async setButtonColor(keyIndex: number, r: number, g: number, b: number): Promise<void> {
    if (!this.streamDeck) {
      console.log(`❌ StreamDeck not connected, cannot set color for button ${keyIndex}`);
      return;
    }

    console.log(`🎨 Setting button ${keyIndex} to color RGB(${r}, ${g}, ${b})`);
    
    try {
      // Try using fillKeyColor first (simpler method)
      console.log(`🔄 Trying fillKeyColor for button ${keyIndex}...`);
      const t0 = Bun.nanoseconds();
      try {
        await this.streamDeck.fillKeyColor(keyIndex, r, g, b);
      } catch (e) {
        this.noteHidFailure(e);
        throw e;
      }
      const ms = (Bun.nanoseconds() - t0) / 1e6;
      if (ms > StreamDeckDriver.HID_SLOW_WARN_MS) {
        this.slowHidWrites += 1;
        console.warn(`⚠️ HID fillKeyColor lento: tecla ${keyIndex} ${ms.toFixed(0)}ms (>${StreamDeckDriver.HID_SLOW_WARN_MS}ms, bloquea /health)`);
      }
      this.noteHidSuccess();
      console.log(`✅ fillKeyColor successful for button ${keyIndex}`);
    } catch (error) {
      console.error(`❌ fillKeyColor failed for button ${keyIndex}:`, error);
      
      // Fallback to fillKeyBuffer with a simple BMP image
      try {
        console.log(`🔄 Generating BMP image for button ${keyIndex}...`);
        const bmpBuffer = this.generateBMPImage(r, g, b);
        console.log(`📸 Generated BMP buffer, size: ${bmpBuffer.length} bytes`);
        
        console.log(`🔄 Calling fillKeyBuffer for button ${keyIndex}...`);
        const t1 = Bun.nanoseconds();
        try {
          await this.streamDeck.fillKeyBuffer(keyIndex, bmpBuffer);
        } catch (e) {
          this.noteHidFailure(e);
          throw e;
        }
        const ms1 = (Bun.nanoseconds() - t1) / 1e6;
        if (ms1 > StreamDeckDriver.HID_SLOW_WARN_MS) {
          this.slowHidWrites += 1;
          console.warn(`⚠️ HID fillKeyBuffer lento: tecla ${keyIndex} ${ms1.toFixed(0)}ms (>${StreamDeckDriver.HID_SLOW_WARN_MS}ms, bloquea /health)`);
        }
        this.noteHidSuccess();
        console.log(`✅ fillKeyBuffer with BMP successful for button ${keyIndex}`);
      } catch (fallbackError) {
        console.error(`❌ fillKeyBuffer with BMP also failed for button ${keyIndex}:`, fallbackError);
      }
    }
  }

  async setButtonImage(keyIndex: number, imageBuffer: Buffer): Promise<void> {
    if (this.streamDeck) {
      // RGB top-down nativo del tamaño de la tecla (generateButtonImage).
      // OJO: node-hid escribe de forma SÍNCRONA (bloquea el event loop de
      // Bun): se mide y se avisa si es lento; el fallo alimenta el backoff.
      const t0 = Bun.nanoseconds();
      try {
        await this.streamDeck.fillKeyBuffer(keyIndex, imageBuffer, { format: 'rgb' });
      } catch (e) {
        this.noteHidFailure(e);
        throw e;
      }
      const ms = (Bun.nanoseconds() - t0) / 1e6;
      if (ms > StreamDeckDriver.HID_SLOW_WARN_MS) {
        this.slowHidWrites += 1;
        console.warn(`⚠️ HID fillKeyBuffer lento: tecla ${keyIndex} ${ms.toFixed(0)}ms (>${StreamDeckDriver.HID_SLOW_WARN_MS}ms, bloquea /health)`);
      }
      this.noteHidSuccess();
    }
  }

  async initializeButtons(): Promise<void> {
    if (!this.streamDeck) {
      console.log('❌ StreamDeck not connected, cannot initialize buttons');
      return;
    }

    console.log('🎛️ Initializing all StreamDeck buttons...');
    const keyCount = this.getKeyCount();

    try {
      // Poner todas las teclas en rojo inicialmente (color de test)
      for (let i = 0; i < keyCount; i++) {
        console.log(`🔄 Initializing button ${i} to RED...`);
        await this.setButtonColor(i, 255, 0, 0);
        console.log(`✅ Button ${i} initialized`);
      }
      console.log('🎛️ StreamDeck buttons initialized successfully');
    } catch (error) {
      console.error('❌ Error initializing StreamDeck buttons:', error);
    }
  }

  generateBMPImage(r: number, g: number, b: number): Buffer {
    const width = 72;
    const height = 72;
    
    // BMP header (simplified 24-bit BMP)
    const headerSize = 54;
    const imageSize = width * height * 3;
    const fileSize = headerSize + imageSize;
    
    const buffer = Buffer.alloc(fileSize);
    
    // BMP file header
    buffer.write('BM', 0); // Signature
    buffer.writeUInt32LE(fileSize, 2); // File size
    buffer.writeUInt32LE(0, 6); // Reserved
    buffer.writeUInt32LE(headerSize, 10); // Data offset
    
    // BMP info header
    buffer.writeUInt32LE(40, 14); // Header size
    buffer.writeInt32LE(width, 18); // Width
    buffer.writeInt32LE(height, 22); // Height
    buffer.writeUInt16LE(1, 26); // Planes
    buffer.writeUInt16LE(24, 28); // Bits per pixel
    buffer.writeUInt32LE(0, 30); // Compression
    buffer.writeUInt32LE(imageSize, 34); // Image size
    buffer.writeInt32LE(0, 38); // X pixels per meter
    buffer.writeInt32LE(0, 42); // Y pixels per meter
    buffer.writeUInt32LE(0, 46); // Colors used
    buffer.writeUInt32LE(0, 50); // Important colors
    
    // BMP pixel data (BGR format, bottom-up)
    let offset = headerSize;
    for (let y = height - 1; y >= 0; y--) {
      for (let x = 0; x < width; x++) {
        buffer[offset++] = b; // Blue
        buffer[offset++] = g; // Green
        buffer[offset++] = r; // Red
      }
      // BMP rows must be padded to 4-byte boundaries
      // For 72 pixels * 3 bytes = 216 bytes per row
      // 216 % 4 = 0, so no padding needed
    }
    
    return buffer;
  }

  /**
   * Tamaño nativo de tecla (px) del dispositivo conectado, leído de
   * `CONTROLS` (pixelSize del primer botón LCD). Cubre todos los modelos
   * (Mini 80, Classic/MK2 72, XL 96, Plus 120…); sin HW, fallback 72.
   */
  getIconSize(): number {
    try {
      const controls = (this.streamDeck as any)?.CONTROLS;
      if (Array.isArray(controls)) {
        for (const c of controls) {
          const w = Number(c?.pixelSize?.width);
          const h = Number(c?.pixelSize?.height);
          if (c?.type === 'button' && Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0) {
            return Math.min(w, h);
          }
        }
      }
    } catch { /* fallback 72 */ }
    return 72;
  }

  /**
   * Genera la imagen de una tecla replicando StageBoard (web): fondo
   * `backgroundColor` (+ `backgroundImage` en cover), centro
   * (`dynamicValue` > `iconImage` > icono Lucide tintado > `emoji`),
   * `textTop` arriba y `textBottom`/`label` abajo (si `showTitle`).
   * Icono y texto coexisten (antes el icono solo se pintaba sin texto).
   *
   * `buttonData` puede venir en crudo (con `looks`/`{{vars}}`): se resuelve
   * con `resolveKeyDisplay`. El buffer es RGB top-down del tamaño nativo.
   */
  async generateButtonImage(buttonData: any, size?: number, env?: Env): Promise<Buffer> {
    const s = size && Number.isInteger(size) && size > 0 ? size : this.getIconSize();
    const width = s;
    const height = s;

    const canvasLib = await getCanvas();
    if (!canvasLib) throw new Error('canvas no disponible: no se puede renderizar la tecla');

    const eff = resolveKeyDisplay(buttonData ?? {}, env ?? getDaemonDisplayEnv());

    const canvas = canvasLib.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const U = s / 72;

    // Fondo sólido (la web usa gradiente; el HW pide color plano).
    ctx.fillStyle = eff.backgroundColor || DEFAULT_KEY_BG;
    ctx.fillRect(0, 0, width, height);

    // Imagen de fondo en cover (best-effort).
    await this.tryDrawKeyImage(ctx, canvasLib, eff.backgroundImage, width, height, true);

    // Color de texto/icono.
    const fg = eff.textColor || DEFAULT_KEY_FG;
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Layout tipo web: textTop arriba, centro (dinámico/imagen/icono/emoji)
    // y textBottom/label abajo. Icono y texto coexisten.
    const cx = width / 2;
    const hasTop = eff.textTop.trim() !== '';
    const bottomText = eff.textBottom.trim() || eff.label.trim();
    const hasBottom = eff.showTitle && bottomText !== '';

    const topH = hasTop ? 16 * U : 5 * U;
    const botH = hasBottom ? 16 * U : 5 * U;
    const centerY = topH + (height - topH - botH) / 2;
    const maxW = width - 10 * U;

    const FONT_FAMILY = `Arial, "DejaVu Sans", "Liberation Sans", sans-serif`;
    const fitFont = (text: string, base: number, weight = ''): number => {
      let fs = base;
      try {
        ctx.font = `${weight ? weight + ' ' : ''}${fs}px ${FONT_FAMILY}`;
        while (fs > 7 * U && ctx.measureText(text).width > maxW) {
          fs -= 1;
          ctx.font = `${weight ? weight + ' ' : ''}${fs}px ${FONT_FAMILY}`;
        }
      } catch { /* medida no disponible: tamaño base */ }
      return fs;
    };
    const ellipsis = (text: string): string => {
      try {
        if (ctx.measureText(text).width <= maxW) return text;
        let t = text;
        while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
        return `${t}…`;
      } catch {
        return text;
      }
    };

    const dyn = eff.dynamicValue.trim();
    if (dyn !== '') {
      // Valor dinámico: grande y centrado (web: .bd-dyn mono).
      fitFont(dyn, dyn.length > 6 ? 16 * U : 22 * U, 'bold');
      ctx.fillText(ellipsis(dyn), cx, centerY);
    } else {
      // Centro: iconImage (contain) > icono Lucide tintado > emoji.
      const box = Math.min((hasBottom ? 34 : 42) * U, (height - topH - botH) * 0.92);
      let centerDone = false;
      if (eff.iconImage) {
        centerDone = await this.tryDrawKeyImageBox(ctx, canvasLib, eff.iconImage, cx, centerY, box);
      }
      if (!centerDone && eff.icon.trim() !== '') {
        centerDone = await this.tryDrawLucideIcon(
          ctx, canvasLib, eff.icon.replace(/Icon$/, ''), cx, centerY, box, fg,
        );
      }
      if (!centerDone && eff.emoji.trim() !== '') {
        fitFont(eff.emoji.trim(), 26 * U);
        ctx.fillText(eff.emoji.trim(), cx, centerY);
        centerDone = true;
      }
      if (!centerDone) {
        // Sin visual central: texto grande (clásico por texto).
        const t = bottomText || eff.textTop.trim();
        if (t !== '') {
          if (t.length > 8 && t.includes(' ')) {
            const parts = t.split(' ');
            const mid = Math.ceil(parts.length / 2);
            ctx.font = `${12 * U}px Arial, "DejaVu Sans", "Liberation Sans", sans-serif`;
            ctx.fillText(ellipsis(parts.slice(0, mid).join(' ')), cx, centerY - 8 * U);
            ctx.fillText(ellipsis(parts.slice(mid).join(' ')), cx, centerY + 8 * U);
          } else {
            fitFont(t, t.length > 10 ? 13 * U : t.length > 5 ? 17 * U : 22 * U);
            ctx.fillText(ellipsis(t), cx, centerY);
          }
        }
      }
    }

    // textTop arriba (web: .bd-tt).
    if (hasTop) {
      fitFont(eff.textTop.trim(), Math.max(10 * U, eff.fontSize * U * 0.85));
      ctx.fillText(ellipsis(eff.textTop.trim()), cx, topH / 2 + 1 * U);
    }
    // textBottom/label abajo (web: .bd-tb/small, tono atenuado).
    if (hasBottom) {
      fitFont(bottomText, Math.max(10 * U, eff.fontSize * U * 0.8));
      const prevAlpha = ctx.globalAlpha;
      try { ctx.globalAlpha = 0.92; } catch { /* noop */ }
      ctx.fillText(ellipsis(bottomText), cx, height - botH / 2);
      try { ctx.globalAlpha = prevAlpha; } catch { /* noop */ }
    }

    // Buffer RGB top-down nativo (lo que fillKeyBuffer espera por defecto).
    return this.canvasToRGBBuffer(canvas);
  }

  /**
   * Dibuja un icono Lucide centrado en (cx, cy) dentro de un cuadrado `box`,
   * tintado con `color` (= textColor, como la web vía currentColor).
   * Usa el `Path2D` de @napi-rs/canvas: el global no existe en Bun y era
   * la causa de que ningún icono llegase al StreamDeck.
   */
  private async tryDrawLucideIcon(
    ctx: any, canvasLib: any, iconName: string, cx: number, cy: number, box: number, color: string,
  ): Promise<boolean> {
    try {
      // Normalizar nombre: ArrowBigDown -> ArrowBigDown, arrow-big-down -> ArrowBigDown
      // Lucide usa PascalCase en el paquete 'lucide'
      const normalized = iconName.replace(/-/g, '').replace(/^./, (c: string) => c.toUpperCase());
      // También probar con el nombre tal cual
      const candidates = [iconName, normalized, iconName.replace(/Icon$/, ''), normalized.replace(/Icon$/, '')];
      
      let iconData: any = null;
      let foundName = '';
      for (const cand of candidates) {
        try {
          const mod: any = await getLucideModule();
          if (mod[cand]) {
            iconData = mod[cand];
            foundName = cand;
            break;
          }
          // Probar kebab-case a PascalCase
          const pascal = cand.split('-').map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
          if (mod[pascal]) {
            iconData = mod[pascal];
            foundName = pascal;
            break;
          }
        } catch {}
      }
      
      if (!iconData || !Array.isArray(iconData) || iconData.length === 0) {
        // Lucide eliminó las marcas (YouTube/Twitch/GitHub…): probar con
        // simple-icons (`si:<slug>` o el nombre heredado). Sin esto el HW
        // caía al fallback de texto mientras la web sí mostraba el logo.
        return await this.tryDrawSimpleIcon(ctx, canvasLib, iconName, cx, cy, box, color);
      }

      // iconData es array de [tag, attrs] como [["path", {d: "..."}]]
      // Dibujar centrado en (cx, cy) dentro del cuadrado `box` (viewBox 24).
      const scale = box / 24;
      const offsetX = cx - (24 * scale) / 2;
      const offsetY = cy - (24 * scale) / 2;

      const P2D = (canvasLib as any)?.Path2D ?? (globalThis as any)?.Path2D;
      
      ctx.save();
      let ok = true;
      ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (const [tag, attrs] of iconData) {
          if (tag === 'path' && attrs.d) {
            if (!P2D) { ok = false; break; }
            try {
              const path = new P2D(attrs.d);
              if (attrs.fill && attrs.fill !== 'none') {
                ctx.fill(path);
              } else {
                ctx.stroke(path);
              }
            } catch {
              ok = false;
              break;
            }
          } else if (tag === 'circle' && attrs.cx) {
          ctx.beginPath();
          ctx.arc(Number(attrs.cx), Number(attrs.cy), Number(attrs.r), 0, Math.PI * 2);
          if (attrs.fill && attrs.fill !== 'none') ctx.fill();
          else ctx.stroke();
        } else if (tag === 'rect' && attrs.x !== undefined) {
          if (attrs.fill && attrs.fill !== 'none') {
            ctx.fillRect(Number(attrs.x), Number(attrs.y), Number(attrs.width), Number(attrs.height));
          } else {
            ctx.strokeRect(Number(attrs.x), Number(attrs.y), Number(attrs.width), Number(attrs.height));
          }
        } else if (tag === 'line') {
          ctx.beginPath();
          ctx.moveTo(Number(attrs.x1), Number(attrs.y1));
          ctx.lineTo(Number(attrs.x2), Number(attrs.y2));
          ctx.stroke();
        } else if (tag === 'polyline' && attrs.points) {
          const points = attrs.points.split(' ').map((p: string) => p.split(',').map(Number));
          ctx.beginPath();
          points.forEach(([x, y]: number[], i: number) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
          ctx.stroke();
        } else if (tag === 'polygon' && attrs.points) {
          const points = attrs.points.split(' ').map((p: string) => p.split(',').map(Number));
          ctx.beginPath();
          points.forEach(([x, y]: number[], i: number) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
          ctx.closePath();
          if (attrs.fill && attrs.fill !== 'none') ctx.fill();
          else ctx.stroke();
        }
      }
      ctx.restore();
      return ok;
    } catch (e) {
      // console.error('Failed to draw lucide icon', iconName, e);
      try { ctx.restore(); } catch { /* noop */ }
      return false;
    }
  }

  /**
   * Dibuja un icono de marca simple-icons centrado en (cx, cy) dentro de un
   * cuadrado `box`, tintado con `color`. Los glifos de simple-icons son
   * sólidos (una sola ruta con relleno), al contrario que los trazos Lucide.
   */
  private async tryDrawSimpleIcon(
    ctx: any, canvasLib: any, iconName: string, cx: number, cy: number, box: number, color: string,
  ): Promise<boolean> {
    try {
      const path = await getSimpleIconPath(iconName);
      if (!path) return false;
      const P2D = (canvasLib as any)?.Path2D ?? (globalThis as any)?.Path2D;
      if (!P2D) return false;
      const scale = box / 24;
      ctx.save();
      try {
        ctx.translate(cx - (24 * scale) / 2, cy - (24 * scale) / 2);
        ctx.scale(scale, scale);
        ctx.fillStyle = color;
        ctx.fill(new P2D(path));
      } finally {
        ctx.restore();
      }
      return true;
    } catch {
      try { ctx.restore(); } catch { /* noop */ }
      return false;
    }
  }

  /**
   * Dibuja `iconImage` contenida (fit) y centrada en (cx, cy) dentro de un
   * cuadrado `box` (web: `.bd-kimg` 40px con cover y radio). Devuelve false
   * si no se pudo cargar: el llamador prueba con icono/emoji/texto.
   */
  private async tryDrawKeyImageBox(
    ctx: any,
    canvasLib: any,
    rel: unknown,
    cx: number,
    cy: number,
    box: number,
  ): Promise<boolean> {
    try {
      if (typeof rel !== 'string' || !rel) return false;
      const name = rel.split('?')[0].replace(/^\/assets\//, '');
      if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return false;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return false;
      const { getDataDir } = await import('../paths');
      const { default: path } = await import('path');
      const file = Bun.file(path.join(getDataDir(), 'assets', name));
      if (!(await file.exists())) return false;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!bytes.byteLength) return false;
      const loader = (canvasLib as any)?.loadImage;
      if (typeof loader !== 'function') return false;
      const img: any = await loader(bytes);
      const iw = Number(img?.width) || 0;
      const ih = Number(img?.height) || 0;
      if (!iw || !ih) return false;
      const s = Math.min(box / iw, box / ih);
      const dw = Math.max(1, iw * s);
      const dh = Math.max(1, ih * s);
      const x = cx - dw / 2;
      const y = cy - dh / 2;
      ctx.save();
      try {
        if (typeof (ctx as any).roundRect === 'function') {
          const r = Math.min(8 * (box / 40), dw / 2, dh / 2);
          ctx.beginPath();
          (ctx as any).roundRect(x, y, dw, dh, r);
          ctx.clip();
        }
        ctx.drawImage(img, x, y, dw, dh);
      } finally {
        ctx.restore();
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Dibuja la imagen personalizada de la tecla (`iconImage`/`backgroundImage`,
   * URLs `/assets/<fichero>`) con recorte «cover» a 72x72.
   * Best-effort: GIF → primer frame; si no se puede cargar, no dibuja nada
   * y el llamador sigue con color + texto/icono.
   */
  private async tryDrawKeyImage(
    ctx: any,
    canvasLib: any,
    rel: unknown,
    width: number,
    height: number,
    cover: boolean
  ): Promise<boolean> {
    try {
      if (typeof rel !== 'string' || !rel) return false;
      const name = rel.split('?')[0].replace(/^\/assets\//, '');
      if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return false;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return false;
      const { getDataDir } = await import('../paths');
      const { default: path } = await import('path');
      const file = Bun.file(path.join(getDataDir(), 'assets', name));
      if (!(await file.exists())) return false;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!bytes.byteLength) return false;
      const loader = (canvasLib as any)?.loadImage;
      if (typeof loader !== 'function') return false;
      const img: any = await loader(bytes);
      const iw = Number(img?.width) || 0;
      const ih = Number(img?.height) || 0;
      if (!iw || !ih) return false;
      if (cover) {
        const s = Math.max(width / iw, height / ih);
        const dw = iw * s;
        const dh = ih * s;
        ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
      } else {
        ctx.drawImage(img, 0, 0, width, height);
      }
      return true;
    } catch {
      return false;
    }
  }

  // Resolver valor dinámico con métricas ya obtenidas (un solo fetch por
  // repintado). Mantiene la firma antigua delegando en la versión con caché.
  private dynamicValueFromMetrics(button: any, metrics: any): string | null {
    try {
      const action = button.data?.actions?.find((a: any) => a.type?.includes('pc-vitals'));
      if (!action) return null;
      const { component = 'cpu', metric = 'usage' } = action.parameters || {};
      const type: string = action.type ?? '';
      if (!metrics) return null;
      // Acciones dedicadas nuevas (sin component/metric): mapear al endpoint.
      if (type.endsWith('cpu-temp')) {
        const v = metrics.cpu?.temperature;
        return v == null || isNaN(v) ? null : `${Math.round(v * 10) / 10}°C`;
      }
      if (type.endsWith('gpu-usage')) {
        const v = metrics.gpu?.usage;
        return v == null || isNaN(v) ? null : `${Math.round(v * 10) / 10}%`;
      }
      if (type.endsWith('gpu-temp')) {
        const v = metrics.gpu?.temperature;
        return v == null || isNaN(v) ? null : `${Math.round(v * 10) / 10}°C`;
      }
      if (type.endsWith('fan-speed')) {
        const v = metrics.fans?.[0]?.value;
        return v == null || isNaN(v) ? null : `${Math.round(v)} RPM`;
      }
      let value: number | null = null;
      let unit = '';
      if (component === 'cpu' && metric === 'usage') { value = metrics.cpu?.usage; unit = '%'; }
      else if (component === 'cpu' && metric === 'temperature') { value = metrics.cpu?.temperature; unit = '°C'; }
      else if (component === 'ram' && metric === 'usage') { value = metrics.ram?.usage; unit = '%'; }
      else if (component === 'gpu' && metric === 'usage') { value = metrics.gpu?.usage; unit = '%'; }
      else if (component === 'gpu' && metric === 'temperature') { value = metrics.gpu?.temperature; unit = '°C'; }
      if (value == null || isNaN(value)) return null;
      const rounded = Math.round(value * 10) / 10;
      return `${rounded}${unit}`;
    } catch {
      return null;
    }
  }

  private async fetchSystemMetricsOnce(hasDynamic: boolean): Promise<any | null> {
    if (!hasDynamic) return null;
    try {
      const { API_PORT } = await import('../config');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const res = await fetch(`http://localhost:${API_PORT}/api/v1/system/metrics`, { signal: ctrl.signal });
        if (!res.ok) return null;
        return await res.json();
      } finally {
        clearTimeout(t);
      }
    } catch {
      return null;
    }
  }

  // Resolver valor dinámico para botones con pc-vitals u otros plugins dinámicos
  private async resolveDynamicValue(button: any): Promise<string | null> {
    try {
      const action = button.data?.actions?.find((a: any) => a.type?.includes('pc-vitals'));
      if (!action) return null;
      const metrics = await this.fetchSystemMetricsOnce(true);
      return this.dynamicValueFromMetrics(button, metrics);
    } catch {
      return null;
    }
  }

  private dynamicIntervals = new Map<number, ReturnType<typeof setInterval>>();
  private liveInterval: ReturnType<typeof setInterval> | null = null;
  private liveSigs = new Map<number, string>();
  private liveRaws = new Map<number, any>();

  // Repintado diferido y coalescado: los endpoints de botones llaman a esto
  // en vez de `await updateFromPage()` para no bloquear la respuesta HTTP.
  // Múltiples cambios seguidos (vaciar + mover + editar) colapsan en un solo
  // repintado, y si ya hay uno en vuelo se encola otro al terminar.
  private pendingSchedule: { pageId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private updateInFlight = false;
  private queuedPageId: string | null = null;

  // ---- Anti-bloqueo del event loop (repaints HID) ----
  //
  // Diagnóstico medido: `GET /health` (handler trivial) tardaba 0.5–2.7 s a
  // rachas porque el loop estaba ocupado en escrituras HID síncronas
  // (node-hid bloquea el hilo de Bun) multiplicadas por ráfagas de repintados
  // (cada `hello` del WS repintaba la página completa). Las escrituras en sí
  // no se pueden hacer async (la lib es síncrona), así que el fix es:
  //  1. medir cada write y avisar si es lento (>50 ms),
  //  2. no reintentar en caliente si el device falla (backoff + cooldown),
  //  3. no repintar lo ya pintado (skip-if-same en la vía hello/asignación),
  //  4. abortar el repintado tras 2 fallos HID seguidos (no 15 timeouts).
  private static readonly HID_SLOW_WARN_MS = 50;
  private static readonly REPAINT_SLOW_WARN_MS = 500;
  /** Render de UNA tecla >50 ms también se avisa (separado del write HID). */
  private static readonly GEN_SLOW_WARN_MS = 50;
  /** Caché de imágenes renderizadas por firma de contenido (evita re-render). */
  private static readonly KEY_IMAGE_CACHE_MAX = 64;
  private static readonly HID_COOLDOWN_BASE_MS = 2000;
  private static readonly HID_COOLDOWN_MAX_MS = 30000;
  private hidFailCount = 0;
  private hidCooldownUntil = 0;
  private cooldownRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Última página pintada OK en ESTA conexión (null = aún sin pintar). */
  private lastPaintedPageId: string | null = null;
  /**
   * Diff por tecla: firma del contenido pintado por posición en ESTA
   * conexión. Si la firma coincide se omite render + write HID. Cambio de
   * página distinto → se vacía (repintado completo). Conexión nueva →
   * se vacía (la pantalla física está sin pintar).
   */
  private paintedKeySigs = new Map<number, string>();
  /** Imágenes renderizadas por firma (size|sig → RGB top-down). */
  private keyImageCache = new Map<string, Buffer>();
  private repaintStarts: number[] = [];
  private totalRepaints = 0;
  private skippedSamePage = 0;
  private skippedCooldown = 0;
  private slowHidWrites = 0;
  /** Diff por tecla + medición gen vs write (ver resumen). */
  private skippedSameKey = 0;
  private keyGenMsTotal = 0;
  private keyWriteMsTotal = 0;
  private keyGenCount = 0;
  private keyWriteCount = 0;
  private slowGenRenders = 0;
  private keyImageCacheHits = 0;

  /** Contadores para diagnóstico (log de comprobación, ver resumen). */
  getRepaintStats(): {
    totalRepaints: number;
    repaintsLastMinute: number;
    lastPaintedPageId: string | null;
    hidFailCount: number;
    coolingDown: boolean;
    skippedSamePage: number;
    skippedCooldown: number;
    slowHidWrites: number;
    skippedSameKey: number;
    keyGenMsTotal: number;
    keyWriteMsTotal: number;
    keyGenCount: number;
    keyWriteCount: number;
    slowGenRenders: number;
    keyImageCacheHits: number;
    keyImageCacheSize: number;
  } {
    const now = Date.now();
    this.repaintStarts = this.repaintStarts.filter((t) => now - t < 60_000);
    return {
      totalRepaints: this.totalRepaints,
      repaintsLastMinute: this.repaintStarts.length,
      lastPaintedPageId: this.lastPaintedPageId,
      hidFailCount: this.hidFailCount,
      coolingDown: now < this.hidCooldownUntil,
      skippedSamePage: this.skippedSamePage,
      skippedCooldown: this.skippedCooldown,
      slowHidWrites: this.slowHidWrites,
      skippedSameKey: this.skippedSameKey,
      keyGenMsTotal: this.keyGenMsTotal,
      keyWriteMsTotal: this.keyWriteMsTotal,
      keyGenCount: this.keyGenCount,
      keyWriteCount: this.keyWriteCount,
      slowGenRenders: this.slowGenRenders,
      keyImageCacheHits: this.keyImageCacheHits,
      keyImageCacheSize: this.keyImageCache.size,
    };
  }

  /** Solo tests: resetea pintado/cooldown/contadores sin tocar la sesión. */
  __resetHwPaintStateForTests(): void {
    if (this.cooldownRetryTimer) {
      clearTimeout(this.cooldownRetryTimer);
      this.cooldownRetryTimer = null;
    }
    this.hidFailCount = 0;
    this.hidCooldownUntil = 0;
    this.lastPaintedPageId = null;
    this.paintedKeySigs.clear();
    this.keyImageCache.clear();
    this.repaintStarts = [];
    this.totalRepaints = 0;
    this.skippedSamePage = 0;
    this.skippedCooldown = 0;
    this.slowHidWrites = 0;
    this.skippedSameKey = 0;
    this.keyGenMsTotal = 0;
    this.keyWriteMsTotal = 0;
    this.keyGenCount = 0;
    this.keyWriteCount = 0;
    this.slowGenRenders = 0;
    this.keyImageCacheHits = 0;
    this.updateInFlight = false;
    this.queuedPageId = null;
    if (this.pendingSchedule) {
      clearTimeout(this.pendingSchedule.timer);
      this.pendingSchedule = null;
    }
  }

  /** ¿El error es un device HID muerto (`Cannot write to hid device`, …)? */
  private isHidDeadError(e: unknown): boolean {
    const m = e instanceof Error ? e.message : String(e);
    return /cannot write to hid device|hid device|hid\b.*(write|fail|error|disconnect)|device.*(disconnected|not connected|no such device|not open)/i.test(m);
  }

  private noteHidFailure(e: unknown): void {
    this.hidFailCount += 1;
    const backoff = Math.min(
      StreamDeckDriver.HID_COOLDOWN_MAX_MS,
      StreamDeckDriver.HID_COOLDOWN_BASE_MS * 2 ** Math.min(4, this.hidFailCount - 1),
    );
    this.hidCooldownUntil = Date.now() + backoff;
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`⚠️ HID write falló (${this.hidFailCount}x, cooldown ${backoff}ms): ${reason}`);
    this.scheduleCooldownRetry();
  }

  private noteHidSuccess(): void {
    if (this.hidFailCount !== 0) this.hidFailCount = 0;
  }

  /** Reintento único al salir del cooldown, con la última página encolada. */
  private scheduleCooldownRetry(): void {
    if (this.cooldownRetryTimer) return;
    const wait = Math.max(0, this.hidCooldownUntil - Date.now());
    this.cooldownRetryTimer = setTimeout(() => {
      this.cooldownRetryTimer = null;
      const q = this.queuedPageId;
      this.queuedPageId = null;
      if (q && Date.now() >= this.hidCooldownUntil && this.streamDeck) {
        this.updateFromPage(q, { force: true }).catch((e) =>
          console.error('❌ Queued StreamDeck update failed:', e),
        );
      }
    }, wait);
    if (typeof (this.cooldownRetryTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.cooldownRetryTimer as unknown as { unref: () => void }).unref();
    }
  }

  scheduleUpdateFromPage(pageId: string, delayMs = 150): void {
    if (!pageId) return;
    if (this.pendingSchedule) clearTimeout(this.pendingSchedule.timer);
    this.pendingSchedule = {
      pageId,
      timer: setTimeout(() => {
        this.pendingSchedule = null;
        this.updateFromPage(pageId).catch((e) =>
          console.error('❌ Scheduled StreamDeck update failed:', e)
        );
      }, delayMs),
    };
  }

  /**
   * Repintado por EDICIÓN (no por navegación): solo refresca si el HW ya
   * muestra esa página (o aún no tiene sesión). Nunca cambia la vista del
   * HW: editar otra página en el editor no debe mover el deck físico.
   * Como solo se llama cuando coincide, el `updateFromPage` interno no
   * secuestra la sesión (reescribe la misma página).
   */
  scheduleRefreshIfVisible(pageId: string, delayMs = 150): void {
    if (!pageId) return;
    let cur: string | null = null;
    try {
      cur = this.getSessionView().pageId;
    } catch { cur = null; }
    if (cur && cur !== pageId) return;
    this.scheduleUpdateFromPage(pageId, delayMs);
  }

  private startDynamicPolling(buttons: any[], profileName = '', pageName = '') {
    // Limpiar intervalos previos (métricas + looks/tiempo).
    for (const [, iv] of this.dynamicIntervals.entries()) {
      clearInterval(iv);
    }
    this.dynamicIntervals.clear();
    if (this.liveInterval) {
      clearInterval(this.liveInterval);
      this.liveInterval = null;
    }
    this.liveSigs.clear();
    this.liveRaws.clear();

    const size = this.getIconSize();

    buttons.forEach((btn, idx) => {
      if (!btn || !btn.data?.actions?.some((a: any) => a.type?.includes('pc-vitals'))) return;
      const action = btn.data.actions.find((a: any) => a.type?.includes('pc-vitals'));
      const intervalMs = action?.parameters?.updateInterval || 1000;
      const pos = btn.position ?? idx;
      const raw = btn.data;
      const iv = setInterval(async () => {
        try {
          const env = getDaemonDisplayEnv(profileName, pageName);
          const dyn = await this.resolveDynamicValue(btn);
          const dataWithDyn = dyn ? { ...raw, dynamicValue: dyn } : { ...raw };
          const sig = resolvedSignature(resolveKeyDisplay(dataWithDyn, env));
          if (this.liveSigs.get(pos) === sig) return;
          this.liveSigs.set(pos, sig);
          const fullSig = this.keyContentSig(dataWithDyn, env, size);
          const tG0 = Bun.nanoseconds();
          const buf = await this.getCachedOrRender(fullSig, size, dataWithDyn, env);
          this.noteKeyGen((Bun.nanoseconds() - tG0) / 1e6);
          const tW0 = Bun.nanoseconds();
          await this.setButtonImage(pos, buf);
          this.noteKeyWrite((Bun.nanoseconds() - tW0) / 1e6);
          this.paintedKeySigs.set(pos, fullSig);
        } catch {}
      }, Math.max(500, intervalMs));
      this.dynamicIntervals.set(pos, iv);
    });

    // Looks/tiempo ({{hora}}, conds con vars…): re-resolver 1/s y repintar
    // solo las teclas cuya apariencia efectiva cambió. Sin métricas aquí.
    const live = buttons.filter(
      (btn, idx) =>
        btn?.data && !btn.data.actions?.some((a: any) => a.type?.includes('pc-vitals')) &&
        displayNeedsLiveUpdate(btn.data),
    ).map((btn, _i) => ({ pos: btn.position ?? buttons.indexOf(btn), raw: btn.data }));
    if (!live.length) return;
    try {
      const env0 = getDaemonDisplayEnv(profileName, pageName);
      for (const e of live) {
        this.liveRaws.set(e.pos, e.raw);
        this.liveSigs.set(e.pos, resolvedSignature(resolveKeyDisplay(e.raw, env0)));
      }
    } catch { /* primer tick lo fijará */ }
    this.liveInterval = setInterval(() => {
      void (async () => {
        try {
          const env = getDaemonDisplayEnv(profileName, pageName);
          for (const [pos, raw] of this.liveRaws.entries()) {
            try {
              const sig = resolvedSignature(resolveKeyDisplay(raw, env));
              if (this.liveSigs.get(pos) === sig) continue;
              this.liveSigs.set(pos, sig);
              const fullSig = this.keyContentSig(raw, env, size);
              const tG0 = Bun.nanoseconds();
              const buf = await this.getCachedOrRender(fullSig, size, raw, env);
              this.noteKeyGen((Bun.nanoseconds() - tG0) / 1e6);
              const tW0 = Bun.nanoseconds();
              await this.setButtonImage(pos, buf);
              this.noteKeyWrite((Bun.nanoseconds() - tW0) / 1e6);
              this.paintedKeySigs.set(pos, fullSig);
            } catch { /* best-effort por tecla */ }
          }
        } catch { /* best-effort */ }
      })();
    }, 1000);
  }

  canvasToRGBBuffer(canvas: any): Buffer {
    const width = canvas.width;
    const height = canvas.height;

    // Get image data
    const imageData = canvas.getContext('2d').getImageData(0, 0, width, height);
    const data = imageData.data;

    // RGB top-down: es lo que fillKeyBuffer espera por defecto
    // (format 'rgb': fila 0 = arriba, stride width*3). Antes se emitía
    // BGR bottom-up de la era BMP y los rojos/azules salían cruzados.
    const buffer = Buffer.alloc(width * height * 3);
    let offset = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * width + x) * 4;
        buffer[offset++] = data[pixelIndex]; // Red
        buffer[offset++] = data[pixelIndex + 1]; // Green
        buffer[offset++] = data[pixelIndex + 2]; // Blue
      }
    }

    return buffer;
  }

  async updateButtonStates(buttonStates: boolean[], pageId?: string): Promise<void> {
    if (!this.streamDeck) {
      console.log('❌ StreamDeck not connected, skipping button update');
      return;
    }

    // Legacy boolean path — redirigir a updateFromPage para usar datos reales y valores dinámicos
    console.log('🎛️ updateButtonStates (legacy boolean) recibido, delegando a updateFromPage con datos reales');
    try {
      const db = new DatabaseService();
      // La página explícita (si viene) manda; si no, la guardada en settings
      const rawPageId = pageId ?? db.getSetting('current.page_id');
      const currentPageId = rawPageId && rawPageId !== 'null' && rawPageId !== '' ? rawPageId : null;
      if (currentPageId && currentPageId !== 'null' && currentPageId !== '') {
        const page = db.getPage(currentPageId);
        if (page) {
          await this.updateFromPage(currentPageId);
          return;
        }
      }
      // Fallback: si no hay página, usar lógica anterior pero sin hardcode "Botón"
      console.log('⚠️ No hay página actual, usando fallback por posición');
      const fallbackCount = this.getKeyCount();
      const size = this.getIconSize();
      const env = getDaemonDisplayEnv();
      for (let i = 0; i < Math.min(buttonStates.length, fallbackCount); i++) {
        const hasContent = buttonStates[i];
        if (hasContent) {
          const db2 = new DatabaseService();
          const pageId = db2.getSetting('current.page_id');
          const btn = pageId ? db2.getButtonsByPage(pageId).find(b => b.position === i) : null;
          const data = btn?.data || { label: `Btn ${i + 1}`, backgroundColor: '#374151', textColor: '#f1f5f9' };
          const imageBuffer = await this.generateButtonImage(data, size, env);
          await this.setButtonImage(i, imageBuffer);
          console.log(`📝 Set button ${i} to TEXT (fallback)`);
        } else {
          // Tecla vacía: fondo por defecto como la web (ya no rojo de test).
          const imageBuffer = await this.generateButtonImage({ icon: '' }, size, env);
          await this.setButtonImage(i, imageBuffer);
          console.log(`⬛ Set button ${i} to default (empty)`);
        }
      }
    } catch (error) {
      console.error('❌ Error en updateButtonStates fallback:', error);
    }
  }

  async updateButtonsWithData(buttons: any[]): Promise<void> {
    if (!this.streamDeck) {
      console.log('❌ StreamDeck not connected, skipping button update');
      return;
    }
    // Reposo con pantalla apagada: no repintar (encendería el panel).
    // El despertar repinta la página al pulsar (noteHwActivity).
    if (this.isScreenOff()) {
      console.log('💤 StreamDeck en reposo (pantalla apagada): repintado omitido');
      return;
    }

    console.log(`🎛️ Updating StreamDeck buttons with data for ${buttons.length} buttons`);
    const keyCount = this.getKeyCount();
    const size = this.getIconSize();
    // Contador de repaints (diagnóstico anti-bloqueo: ver getRepaintStats).
    const repaintT0 = Bun.nanoseconds();
    this.totalRepaints += 1;
    this.repaintStarts.push(Date.now());
    if (this.repaintStarts.length > 120) this.repaintStarts.splice(0, this.repaintStarts.length - 120);
    // Marcas para el desglose gen vs write de ESTE repaint (visibles en finally).
    const genT0 = this.keyGenMsTotal;
    const writeT0 = this.keyWriteMsTotal;

    try {
      // Un solo fetch de métricas por repintado completo: antes se hacía un
      // fetch (PowerShell ~s) POR CADA tecla dinámica, secuencial, lo que
      // dejaba la API colgada y el HW "eterno" al vaciar/mover teclas.
      const hasDynamic = buttons.some((b) => b?.data?.actions?.some((a: any) => a.type?.includes('pc-vitals')));
      const metrics = await this.fetchSystemMetricsOnce(hasDynamic);
      // Nombres para las incorporadas perfil/pagina del env (best-effort).
      let profileName = '';
      let pageName = '';
      try {
        const dbn = new DatabaseService();
        const first = buttons.find((b) => b?.page_id);
        if (first?.page_id) {
          const pg = dbn.getPage(first.page_id);
          if (pg) {
            pageName = pg.name ?? '';
            const pf = pg.profile_id ? dbn.getProfile(pg.profile_id) : null;
            profileName = (pf as any)?.name ?? '';
          }
        }
      } catch { /* sin nombres: env igualmente válido */ }
      const env = getDaemonDisplayEnv(profileName, pageName);
      // Si el device está muerto, cada write HID falla lento: abortar tras
      // 2 fallos seguidos en vez de quemar los 15-32 timeouts en serie
      // (cada uno bloquea el loop y retrasa /health).
      let consecHidFail = 0;
      let painted = 0;
      let skipped = 0;
      for (let i = 0; i < Math.min(buttons.length, keyCount); i++) {
        // Ceder el event loop por botón: el render (canvas) + escritura USB
        // son pesados y si no la API/WS se quedan colgados durante el repintado.
        await new Promise<void>((r) => setImmediate(r));
        try {
          const wrote = await this.paintButtonAt(buttons[i], i, size, env, metrics);
          painted += wrote;
          skipped += wrote ? 0 : 1;
          consecHidFail = 0;
        } catch (e) {
          if (this.isHidDeadError(e)) {
            consecHidFail += 1;
            if (consecHidFail >= 2) {
              console.warn(`⚠️ HW repaint abortado en tecla ${i}: device HID no responde (backoff activo, /health se libera)`);
              break;
            }
            continue;
          }
          throw e;
        }
      }

      console.log(`✅ StreamDeck buttons updated with data successfully (${painted} writes, ${skipped} omitidas por diff)`);
    } catch (error) {
      console.error('❌ Error updating StreamDeck buttons with data:', error);
    } finally {
      const ms = (Bun.nanoseconds() - repaintT0) / 1e6;
      const genMs = this.keyGenMsTotal - genT0;
      const writeMs = this.keyWriteMsTotal - writeT0;
      if (ms > StreamDeckDriver.REPAINT_SLOW_WARN_MS) {
        const perMin = this.getRepaintStats().repaintsLastMinute;
        // Desglose gen vs write: si domina el write, es límite USB del
        // equipo (node-hid síncrono, no arreglable por software más allá
        // del diff); si dominase la gen, la caché de imágenes la absorbe.
        const dom = writeMs >= genMs
          ? 'domina WRITE (límite USB del equipo: node-hid síncrono; el diff ya minimiza writes)'
          : 'domina GEN (render canvas; la caché por firma la absorbe)';
        console.warn(`⚠️ HW repaint lento: ${ms.toFixed(0)}ms (>${StreamDeckDriver.REPAINT_SLOW_WARN_MS}ms, ${perMin}/min, bloquea /health) [gen ${genMs.toFixed(0)}ms / write ${writeMs.toFixed(0)}ms → ${dom}]`);
      }
    }
  }

  /**
   * Pinta UNA tecla (diff + render con caché + write HID). Calcula la firma
   * del contenido ANTES de renderizar: si coincide con lo último pintado en
   * esta conexión se omite render y write. Devuelve 1 si escribió al HID,
   * 0 si se omitió por diff. Ante fallo HID lanza (sin registrar firma).
   */
  private async paintButtonAt(button: any, i: number, size: number, env: any, metrics: any): Promise<number> {
    // Resolver qué se va a pintar (incluido valor dinámico) para la firma.
    let dataToRender: any = null;
    let hasContent = false;
    if (button && button.data) {
      // Check if button has content
      hasContent = !!(
        button.data.label?.trim() ||
        button.data.textTop?.trim() ||
        button.data.textBottom?.trim() ||
        button.data.emoji?.trim() ||
        button.data.icon ||
        button.data.iconImage ||
        button.data.backgroundImage ||
        (button.data.actions && button.data.actions.length > 0)
      );

      if (hasContent) {
        // Si es dinámico (pc-vitals), usar las métricas ya obtenidas
        dataToRender = button.data;
        if (button.data.actions?.some((a: any) => a.type?.includes('pc-vitals'))) {
          try {
            const dyn = this.dynamicValueFromMetrics(button, metrics);
            if (dyn) dataToRender = { ...button.data, dynamicValue: dyn };
          } catch {}
        }
      } else {
        // Tecla vacía: fondo por defecto como la web (ya no rojo de test).
        dataToRender = { icon: '' };
      }
    } else {
      // Tecla vacía: fondo por defecto como la web (ya no rojo de test).
      dataToRender = { icon: '' };
    }

    // Diff por tecla: sin cambios → sin render ni write HID.
    const sig = this.keyContentSig(dataToRender, env, size);
    if (this.paintedKeySigs.get(i) === sig) {
      this.skippedSameKey += 1;
      return 0;
    }

    // Generación (con caché por firma) medida por separado del write HID.
    const tG0 = Bun.nanoseconds();
    const imageBuffer = await this.getCachedOrRender(sig, size, dataToRender, env);
    this.noteKeyGen((Bun.nanoseconds() - tG0) / 1e6);

    const tW0 = Bun.nanoseconds();
    try {
      await this.setButtonImage(i, imageBuffer);
    } finally {
      // El write se mide aunque falle (el aborto por HID muerto lo decide
      // el llamador con isHidDeadError; aquí no se registra la firma).
      this.noteKeyWrite((Bun.nanoseconds() - tW0) / 1e6);
    }
    this.paintedKeySigs.set(i, sig);

    if (hasContent) {
      const effLog = (() => { try { return resolveKeyDisplay(dataToRender, env); } catch { return null; } })();
      console.log(`📝 Set button ${i} to "${effLog?.dynamicValue || effLog?.label || effLog?.emoji || effLog?.icon || 'BTN'}"`);
    } else {
      console.log(`⬛ Set button ${i} to default (empty)`);
    }
    return 1;
  }

  async updateFromPage(pageId: string, opts?: { force?: boolean }): Promise<void> {
    if (!this.streamDeck) {
      console.log('❌ StreamDeck not connected, skipping page update');
      return;
    }

    // La página repintada pasa a ser la vista propia de la sesión hardware.
    try {
      const dbSession = new DatabaseService();
      const page = dbSession.getPage(pageId);
      if (page) {
        this.sessionPageId = pageId;
        this.sessionProfileId = page.profile_id;
        dbSession.upsertDeviceSession({
          device_id: this.deviceId,
          name: 'StreamDeck',
          kind: 'hardware',
          profile_id: page.profile_id,
          page_id: pageId,
        });
      }
    } catch { /* best-effort */ }

    // Reposo con pantalla apagada: se conserva la sesión pero no se pinta
    // (al despertar se repinta la página vigente).
    if (this.isScreenOff()) {
      console.log('💤 StreamDeck en reposo (pantalla apagada): repintado omitido');
      return;
    }

    // Cooldown HID: si el device no responde, no quemar otro repintado
    // completo en caliente (cada write bloquea el loop y retrasa /health).
    // La página queda encolada y el retry único la repinta al salir.
    if (!opts?.force && Date.now() < this.hidCooldownUntil) {
      this.skippedCooldown += 1;
      this.queuedPageId = pageId;
      this.scheduleCooldownRetry();
      return;
    }

    // Coalescar repintados concurrentes: si ya hay uno en vuelo (p.ej. un
    // vaciado seguido de un reorder), encolar el último pageId y volver.
    // Evita N repintados completos solapados que eternizaban el HW.
    // (Si ya hay uno encolado para la MISMA página no se duplica: colapsa.)
    if (this.updateInFlight) {
      this.queuedPageId = pageId;
      console.log(`⏳ StreamDeck update in flight, queued page: ${pageId}`);
      return;
    }
    this.updateInFlight = true;

    try {
      // Diff por tecla: página distinta → repintado completo (se vacían las
      // firmas; pintar solo el delta contra la página anterior no compensa).
      // Misma página → solo se escriben las teclas cuya firma cambió.
      if (pageId !== this.lastPaintedPageId) {
        this.paintedKeySigs.clear();
      }
      console.log(`📄 Updating StreamDeck from page: ${pageId}`);

      const db = new DatabaseService();
      const buttons = db.getButtonsByPage(pageId);

      console.log(`📊 Found ${buttons.length} buttons in page ${pageId}`);

      // Create array of buttons in position order
      const buttonsByPosition: any[] = [];
      const maxButtons = this.getKeyCount(); // teclas reales del modelo (6/15/32…)

      for (let i = 0; i < maxButtons; i++) {
        const button = buttons.find(b => b.position === i);
        buttonsByPosition.push(button || null);
        
        if (button && button.data) {
          const hasContent = !!(
            button.data.label?.trim() ||
            button.data.textTop?.trim() ||
            button.data.textBottom?.trim() ||
            button.data.emoji?.trim() ||
            button.data.icon ||
            button.data.iconImage ||
            button.data.backgroundImage ||
            (button.data.actions && button.data.actions.length > 0)
          );

          console.log(`Button ${i}: exists=${!!button}, hasContent=${hasContent}`, {
            label: button.data.label,
            textTop: button.data.textTop,
            textBottom: button.data.textBottom,
            emoji: button.data.emoji,
            icon: button.data.icon,
            actionsCount: button.data.actions?.length || 0
          });
        } else {
          console.log(`Button ${i}: no button data`);
        }
      }

      console.log('🎛️ Updating buttons with full data');
      await this.updateButtonsWithData(buttonsByPosition);
      // Solo cuenta como "pintada" si ningún write rearmó el cooldown
      // durante el repintado: si el device falló a medias, el próximo
      // trigger (hello/edición) debe reintentar, no darse por pintado.
      if (Date.now() >= this.hidCooldownUntil) {
        this.lastPaintedPageId = pageId;
      }
      // Polling en vivo: pc-vitals + looks/tiempo (1 s, solo cambios).
      try {
        const pg = db.getPage(pageId);
        const pf = pg?.profile_id ? db.getProfile(pg.profile_id) : null;
        this.startDynamicPolling(buttonsByPosition, (pf as any)?.name ?? '', pg?.name ?? '');
      } catch {
        this.startDynamicPolling(buttonsByPosition);
      }

    } catch (error) {
      console.error('❌ Error updating StreamDeck from page:', error);
    } finally {
      this.updateInFlight = false;
      // Si durante el repintado llegó otro cambio, repintar una vez más con
      // la página más reciente en vez de haberlo solapado. Si el repintado
      // murió por HID muerto y no hay nada encolado, re-encolar la propia
      // página para el retry único del cooldown (no en caliente).
      let queued = this.queuedPageId;
      this.queuedPageId = null;
      if (!queued && Date.now() < this.hidCooldownUntil) {
        queued = pageId;
      }
      if (queued) {
        if (Date.now() < this.hidCooldownUntil) {
          this.queuedPageId = queued;
          this.scheduleCooldownRetry();
        } else {
          this.updateFromPage(queued).catch((e) =>
            console.error('❌ Queued StreamDeck update failed:', e)
          );
        }
      }
    }
  }

  async updateButtons(buttonStates: boolean[], pageId?: string): Promise<void> {
    console.log('🎛️ Updating StreamDeck buttons with states:', buttonStates);
    await this.updateButtonStates(buttonStates, pageId);
  }

  async handleButtonPress(keyIndex: number, pressType: PressType = 'short'): Promise<void> {
    try {
      console.log(`🎛️ StreamDeck button ${keyIndex} pressed (${pressType}) - executing flow`);

      const target = this.resolvePressTarget(keyIndex);
      if (!target) return;
      const { button } = target;

      // Sin contenido ejecutable para este pressType no se hace nada
      // (p. ej. tecla sin reglas `long` ante una pulsación larga).
      if (!buttonHasTrigger(button.data, pressType)) {
        console.log(`⚠️ Button at position ${keyIndex} has no flow content for pressType ${pressType}`);
        return;
      }

      console.log(`🔘 Executing flow for button at position ${keyIndex} (pressType=${pressType})`);
      await this.postPress(target, pressType);

      console.log(`✅ Finished executing flow for StreamDeck button ${keyIndex}`);
    } catch (error) {
      console.error(`❌ Error handling StreamDeck button press ${keyIndex}:`, error);
    }
  }

  /**
   * Resuelve perfil/página/botón de la SESIÓN PROPIA del hardware
   * (device_sessions), con los mismos fallbacks que antes (global → primer
   * perfil/página). Devuelve null si no hay nada ejecutable.
   */
  private resolvePressTarget(keyIndex: number): { button: any; page: any; profile: any } | null {
    const db = new DatabaseService();
    const view = this.getSessionView();

    let currentProfile = view.profileId ? db.getProfile(view.profileId) : null;
    if (!currentProfile) {
      const globalProfileId = db.getSetting('current.profile_id');
      const valid = (v: string | null) => (v && v !== 'null' && v !== '' ? v : null);
      let fallbackId = valid(globalProfileId);
      if (fallbackId && !db.getProfile(fallbackId)) fallbackId = null;
      if (!fallbackId) {
        const allProfiles = db.getProfiles();
        fallbackId = allProfiles.length > 0 ? allProfiles[0].id : null;
      }
      if (fallbackId) {
        this.sessionProfileId = fallbackId;
        db.upsertDeviceSession({
          device_id: this.deviceId,
          name: 'StreamDeck',
          kind: 'hardware',
          profile_id: fallbackId,
          page_id: this.sessionPageId,
        });
        currentProfile = db.getProfile(fallbackId);
      }
    }

    if (!currentProfile) {
      console.log('❌ No current profile found for StreamDeck button press');
      return null;
    }

    const allPages = db.getPagesByProfile(currentProfile.id);
    let validCurrentPage = view.pageId ? db.getPage(view.pageId) : null;
    if (!validCurrentPage || validCurrentPage.profile_id !== currentProfile.id) {
      const nonFolderPages = allPages.filter(p => p.is_folder === 0);
      const fallbackPage = nonFolderPages.length > 0 ? nonFolderPages[0] : (allPages.length > 0 ? allPages[0] : null);
      if (fallbackPage) {
        this.sessionPageId = fallbackPage.id;
        db.upsertDeviceSession({
          device_id: this.deviceId,
          name: 'StreamDeck',
          kind: 'hardware',
          profile_id: currentProfile.id,
          page_id: fallbackPage.id,
        });
        validCurrentPage = fallbackPage;
      }
    }

    if (!validCurrentPage) {
      console.log('❌ No current page found for StreamDeck button press');
      return null;
    }

    const button = db.getButtonsByPage(validCurrentPage.id).find(b => b.position === keyIndex);
    if (!button) {
      console.log(`❌ No button found at position ${keyIndex}`);
      return null;
    }
    return { button, page: validCurrentPage, profile: currentProfile };
  }

  /**
   * Ejecución canónica: un solo POST a /api/v1/buttons/press que corre el
   * flujo (acciones + reglas del pressType) en el daemon. Si el endpoint aún
   * no existe (daemon antiguo), cae al bucle legacy por acción.
   */
  private async postPress(target: { button: any; page: any; profile: any }, pressType: PressType): Promise<void> {
    const { button, page, profile } = target;
    const keyIndex = button.position;
    try {
      const { API_PORT } = await import('../config');
      const response = await fetch(`http://localhost:${API_PORT}/api/v1/buttons/press`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          buttonId: button.id,
          pressType,
          context: {
            buttonId: button.id,
            pageId: page.id,
            profileId: profile.id,
            position: keyIndex,
            source: 'streamdeck',
            deviceId: this.deviceId
          }
        })
      });

      if (response.ok) {
        const result = await response.json().catch(() => ({}));
        console.log(`✅ Flow executed for StreamDeck button ${keyIndex} (${pressType})`, result?.empty ? '(empty)' : '');
        return;
      }
      const text = await response.text().catch(() => '');
      if (response.status !== 404 || !/API endpoint not found/.test(text)) {
        console.error(`❌ Flow press failed: ${response.status} ${text}`);
        return;
      }
      console.log('⚠️ /buttons/press no disponible, usando ejecución legacy por acción');
    } catch (error) {
      console.error(`❌ Error posting flow press:`, error);
      return;
    }
    await this.legacyExecuteActions(target);
  }

  /** Compat: ejecuta `data.actions` en orden (sin reglas) vía /actions/execute. */
  private async legacyExecuteActions(target: { button: any; page: any; profile: any }): Promise<void> {
    const { button, page, profile } = target;
    const keyIndex = button.position;
    for (const action of button.data.actions ?? []) {
      try {
        console.log(`▶️ Executing action: ${action.type}`);

        const { API_PORT } = await import('../config');
        const response = await fetch(`http://localhost:${API_PORT}/api/v1/actions/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action,
            context: {
              buttonId: button.id,
              pageId: page.id,
              profileId: profile.id,
              position: keyIndex,
              source: 'streamdeck',
              deviceId: this.deviceId
            }
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`❌ Failed to execute action ${action.type}: ${response.status} ${errorText}`);
        } else {
          const result = await response.json();
          console.log(`✅ Action executed successfully: ${action.type}`, result);
        }
      } catch (error) {
        console.error(`❌ Error executing action ${action.type}:`, error);
      }
    }
  }
}

// Singleton instance
export const streamDeckDriver = new StreamDeckDriver();