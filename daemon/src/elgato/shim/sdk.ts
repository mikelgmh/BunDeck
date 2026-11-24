/**
 * sdk.ts — Falso `@elgato/streamdeck` (shim P0, sin dependencias).
 *
 * Este fichero es AUTOCONTENIDO a propósito (cero imports): `loader-shim.ts`
 * lo copia/transpila a `<plugin>/elgato-shim-sdk.js` y un stub en
 * `node_modules/@elgato/streamdeck` lo re-exporta, de modo que el CodePath
 * original del plugin corre SIN MODIFICAR dentro del Worker LibreDeck
 * actual (cero procesos `node`, cero `Bun.serve` por plugin).
 *
 * Superficie cubierta (P0):
 * - `action(UUID)` + `SingletonAction` (onKeyDown/Up, onWillAppear/Disappear,
 *   onDidReceiveSettings, onSendToPlugin, onTitleParametersDidChange)
 * - `streamDeck.actions.registerAction(inst)` (estilo decorador)
 * - `ev.action.setTitle/setImage/setState/showAlert/showOk/getSettings/setSettings`
 * - `streamDeck.settings` get/set + globales
 * - `streamDeck.system.openUrl`, `streamDeck.devices`, `streamDeck.profiles`,
 *   `streamDeck.logger`
 * - `streamDeck.connect()` emite `deviceDidConnect`/`applicationDidLaunch`/
 *   `titleParametersDidChange` básicos (log + evento estructurado)
 * - `DialAction` existe pero su registro se RECHAZA de forma explícita
 *   (sin equivalente hardware en LibreDeck).
 *
 * Emulaciones documentadas (v1): coordenadas fijas {column:0,row:0},
 * `userDesiredState: {}`, `switchToProfile` = no-op avisado (emite
 * `profile.switch`), `sendToPropertyInspector` = log estructurado +
 * evento `elgato.pi-send`, `setImage` resuelve rutas relativas contra el
 * paquete pero la UI puede ignorar el binario (el estado crudo viaja en
 * `elgato.state`).
 */

export const ELGATO_SHIM_VERSION = '1.0.0';
export const VIRTUAL_DEVICE_ID = 'LD-VIRTUAL-KEYPAD';
export const VIRTUAL_DEVICE_NAME = 'LibreDeck Virtual Keypad';
/** Hold por defecto cuando LibreDeck reporta pulsación larga (ms). */
export const LONG_HOLD_MS_DEFAULT = 600;

/** API mínima que el bridge inyecta (subset de PluginAPI del Worker). */
export interface ShimApi {
  onAction(actionId: string, handler: (params: any, context: any) => Promise<any>): void;
  getSetting(key: string): Promise<string | null> | string | null;
  setSetting(key: string, value: string): Promise<unknown> | unknown;
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: any): void;
  emitEvent(eventName: string, payload: any): void;
  setButtonState?(buttonId: string, state: any): void;
}

export interface ShimOptions {
  pluginId: string;
  /** Subcarpeta del paquete con el código Elgato (para setImage relativo). */
  elgatoDir?: string;
  /** Acciones Keypad esperadas: [{ shortId (LibreDeck), uuid (Elgato) }]. */
  actions?: Array<{ shortId: string; uuid: string }>;
  platform?: string;
  longHoldMs?: number;
}

export interface ElgatoCoordinates {
  column: number;
  row: number;
}

export interface TitleParameters {
  fontFamily: string;
  fontSize: number;
  fontStyle: string;
  fontUnderline: boolean;
  showTitle: boolean;
  titleAlignment: string;
  titleColor: string;
}

export interface ActionPayload {
  settings: Record<string, any>;
  coordinates: ElgatoCoordinates;
  state: number;
  userDesiredState: Record<string, any>;
  title: string;
  titleParameters: TitleParameters;
  isInMultiAction: boolean;
}

export interface ElgatoKeyEvent {
  /** Cliente de acción ligado al contexto (setTitle/setImage/...). */
  action: ActionClient;
  /** UUID de la acción Elgato. */
  actionId: string;
  context: string;
  device: string;
  payload: ActionPayload;
  /** Alias de `action` (compat). */
  actionClient: ActionClient;
  /** Alias de `action` (compat). */
  actionObj?: ActionClient;
}

export interface VisualSnapshot {
  title: string | null;
  image: string | null;
  state: number | null;
  alerts: number;
  oks: number;
  settings: Record<string, any>;
  appeared: boolean;
}

export interface FireKeyResult {
  ok: boolean;
  context: string;
  heldMs: number;
  downCalled: boolean;
  upCalled: boolean;
  visuals: VisualSnapshot;
}

type Handler = (ev: any) => unknown;

interface ActionHandlers {
  keyDown: Handler[];
  keyUp: Handler[];
  willAppear: Handler[];
  willDisappear: Handler[];
  didReceiveSettings: Handler[];
  sendToPlugin: Handler[];
  titleParametersDidChange: Handler[];
}

interface ContextState {
  seen: boolean;
  settings: Record<string, any>;
  title: string | null;
  image: string | null;
  state: number | null;
  alerts: number;
  oks: number;
}

interface ActionRecord {
  uuid: string;
  handlers: ActionHandlers;
  contexts: Map<string, ContextState>;
  dialRejected: boolean;
}

function emptyHandlers(): ActionHandlers {
  return {
    keyDown: [], keyUp: [], willAppear: [], willDisappear: [],
    didReceiveSettings: [], sendToPlugin: [], titleParametersDidChange: [],
  };
}

/** Mapeo nombre de método SDK → slot interno de handlers. */
const METHOD_TO_SLOT = {
  onKeyDown: 'keyDown',
  onKeyUp: 'keyUp',
  onWillAppear: 'willAppear',
  onWillDisappear: 'willDisappear',
  onDidReceiveSettings: 'didReceiveSettings',
  onSendToPlugin: 'sendToPlugin',
  onTitleParametersDidChange: 'titleParametersDidChange',
} as const;

function defaultTitleParameters(): TitleParameters {
  return {
    fontFamily: 'Arial', fontSize: 12, fontStyle: '', fontUnderline: false,
    showTitle: true, titleAlignment: 'middle', titleColor: '#ffffff',
  };
}

/** Base para acciones Keypad (estilo SDK real). */
export class SingletonAction {
  public manifestId?: string;
  public UUID?: string;
  public actionUUID?: string;
  async onKeyDown(_ev: any): Promise<void> {}
  async onKeyUp(_ev: any): Promise<void> {}
  async onWillAppear(_ev: any): Promise<void> {}
  async onWillDisappear(_ev: any): Promise<void> {}
  async onDidReceiveSettings(_ev: any): Promise<void> {}
  async onSendToPlugin(_ev: any): Promise<void> {}
  async onTitleParametersDidChange(_ev: any): Promise<void> {}
}

/** Acción de dial/encoder: SIN equivalente en LibreDeck. Su registro se rechaza. */
export class DialAction extends SingletonAction {
  async onDialRotate(_ev: any): Promise<void> {
    throw new Error('DialAction no soportado por el shim LibreDeck (sin dial hardware)');
  }
  async onDialDown(_ev: any): Promise<void> {
    throw new Error('DialAction no soportado por el shim LibreDeck (sin dial hardware)');
  }
  async onDialUp(_ev: any): Promise<void> {
    throw new Error('DialAction no soportado por el shim LibreDeck (sin dial hardware)');
  }
}

/** Cliente de acción ligado a un contexto (forma mínima que usa el transporte raw). */
export interface RawActionClient {
  setTitle(title: string | null): void;
  setImage(image: string | null): void;
  setState(state: number): void;
  showAlert(): void;
  showOk(): void;
  getSettings(): Promise<Record<string, any>>;
  setSettings(settings: Record<string, any>): Promise<void>;
  sendToPropertyInspector(payload: any): void;
}

/** Compacta un UUID Elgato a shortId LibreDeck (`<plugin>.<short>` → `<short>`). */
export function compactElgatoUuid(pluginId: string, uuid: string): string {
  return compactUuid(pluginId, uuid);
}

/** Genera un settingsSchema LibreDeck a partir de valores por defecto. */
export function buildSettingsSchema(defaults: Record<string, any> | null | undefined): any | null {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return null;
  const properties: Record<string, any> = {};
  for (const [k, v] of Object.entries(defaults)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(k)) continue;
    const t = typeof v;
    if (t === 'string') properties[k] = { type: 'string', default: v };
    else if (t === 'number') properties[k] = { type: 'number', default: v };
    else if (t === 'boolean') properties[k] = { type: 'boolean', default: v };
    else if (v !== null && v !== undefined) properties[k] = { type: 'string', default: String(v) };
  }
  if (Object.keys(properties).length === 0) return null;
  return { type: 'object', properties, additionalProperties: true };
}

/** Resuelve un icono/asset Elgato (relativo al paquete) a ruta usable. */
export function resolveAssetPath(asset: string | null | undefined, elgatoDir?: string): string | null {
  if (asset === null || asset === undefined) return null;
  const s = String(asset);
  if (!s) return null;
  if (/^(https?:|data:|file:)/i.test(s) || s.startsWith('/')) return s;
  const base = (elgatoDir ?? 'elgato').replace(/\\/g, '/').replace(/\/+$/, '');
  return `${base}/${s.replace(/^\.\//, '').replace(/^\/+/, '')}`;
}

function settingsKey(pluginId: string, uuid: string, context: string): string {
  const safe = (v: string) => String(v).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  return `elgato.shim.${safe(uuid)}.${safe(context)}`;
}

const globalSettingsKey = (pluginId: string): string => `elgato.shim.${pluginId}.global`;

async function readSetting(api: ShimApi | null, key: string): Promise<string | null> {
  if (!api) return null;
  try {
    const v = await api.getSetting(key);
    return v === undefined ? null : (v as string | null);
  } catch { return null; }
}

async function writeSetting(api: ShimApi | null, key: string, value: string): Promise<void> {
  if (!api) return;
  try { await api.setSetting(key, value); } catch { /* persistencia best-effort */ }
}

function logOf(api: ShimApi | null): ShimApi['log'] {
  if (api) return (l, m, meta) => { try { api.log(l, m, meta); } catch {} };
  return (l, m) => { try { console.debug(`[elgato-shim:${l}]`, m); } catch {} };
}

export interface ElgatoShim {
  streamDeck: any;
  action(uuid: string): any;
  fireKey(uuid: string, opts: { params?: any; context?: any }): Promise<FireKeyResult>;
  getVisuals(uuid: string, context: string): VisualSnapshot | null;
  getRegisteredUUIDs(): string[];
  wasDialRejected(uuid: string): boolean;
  bound: boolean;
  /** Camino raw: cliente ligado a un contexto (misma persistencia/publicación). */
  rawAction(uuid: string, context: string): RawActionClient;
  /** Camino raw: settings persistidas de un contexto (hidrata willAppear). */
  loadPersistedSettings(uuid: string, context: string): Promise<Record<string, any>>;
  /** shortId LibreDeck para un UUID Elgato (o null si no está mapeado). */
  shortIdFor(uuid: string): string | null;
}

const REGISTRY = '__LD_ELGATO_SHIM_REGISTRY__';

interface RegistryState {
  actions: Map<string, ActionRecord>;
  connectRequested: boolean;
  boundApi: ShimApi | null;
  boundOpts: ShimOptions | null;
}

function registry(): RegistryState {
  const g = globalThis as any;
  if (!g[REGISTRY]) {
    g[REGISTRY] = { actions: new Map(), connectRequested: false, boundApi: null, boundOpts: null } as RegistryState;
  }
  return g[REGISTRY] as RegistryState;
}

function recordFor(uuid: string): ActionRecord {
  const reg = registry();
  let rec = reg.actions.get(uuid);
  if (!rec) {
    rec = { uuid, handlers: emptyHandlers(), contexts: new Map(), dialRejected: false };
    reg.actions.set(uuid, rec);
  }
  return rec;
}

function ctxStateOf(rec: ActionRecord, context: string): ContextState {
  let st = rec.contexts.get(context);
  if (!st) {
    st = { seen: false, settings: {}, title: null, image: null, state: null, alerts: 0, oks: 0 };
    rec.contexts.set(context, st);
  }
  return st;
}

function eventFor(shim: ShimImpl, rec: ActionRecord, context: string, extra?: Partial<ActionPayload>): any {
  const st = ctxStateOf(rec, context);
  const payload: ActionPayload = {
    settings: { ...st.settings },
    coordinates: { column: 0, row: 0 }, // EMULADO (v1): sin rejilla real
    state: st.state ?? 0,
    userDesiredState: {}, // EMULADO (v1)
    title: st.title ?? '',
    titleParameters: defaultTitleParameters(),
    isInMultiAction: false,
    ...(extra ?? {}),
  };
  const actionClient = new ActionClient(shim, rec, context);
  const ev: any = {
    // Forma SDK real: `ev.action` es el cliente ligado al contexto
    // (setTitle/setImage/setState/...), `ev.actionId` el UUID.
    action: actionClient,
    actionId: rec.uuid,
    context,
    device: VIRTUAL_DEVICE_ID,
    payload,
    actionClient,
    actionObj: actionClient,
  };
  return ev;
}

async function runHandlers(list: Handler[], ev: any, log: ShimApi['log']): Promise<boolean> {
  let called = false;
  for (const h of list) {
    called = true;
    try { await h(ev); } catch (e) {
      log('error', `Handler Elgato falló: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return called;
}

class ActionClient {
  constructor(private shim: ShimImpl, private rec: ActionRecord, private context: string) {}

  get manifestId(): string {
    return this.rec.uuid;
  }

  private st(): ContextState {
    return ctxStateOf(this.rec, this.context);
  }

  setTitle(title: string | null): void {
    const st = this.st();
    st.title = title === null || title === undefined ? null : String(title);
    this.shim.publishVisual(this.rec.uuid, this.context);
  }

  setImage(image: string | null): void {
    const st = this.st();
    st.image = resolveAssetPath(image, this.shim.opts.elgatoDir);
    this.shim.publishVisual(this.rec.uuid, this.context);
  }

  setState(state: number): void {
    const st = this.st();
    const n = Number(state);
    st.state = Number.isFinite(n) ? n : null;
    this.shim.publishVisual(this.rec.uuid, this.context);
  }

  showAlert(): void {
    this.st().alerts += 1;
    this.shim.publishVisual(this.rec.uuid, this.context);
  }

  showOk(): void {
    this.st().oks += 1;
    this.shim.publishVisual(this.rec.uuid, this.context);
  }

  async getSettings(): Promise<Record<string, any>> {
    return { ...this.st().settings };
  }

  async setSettings(settings: Record<string, any>): Promise<void> {
    const st = this.st();
    st.settings = { ...(settings ?? {}) };
    await this.shim.persistSettings(this.rec.uuid, this.context);
  }

  sendToPropertyInspector(payload: any): void {
    // v1: la PI web no existe en LibreDeck → log estructurado + evento.
    this.shim.log('debug', `[${this.rec.uuid}] sendToPropertyInspector (emulado, sin PI)`, {
      pluginId: this.shim.opts.pluginId, action: this.rec.uuid, context: this.context, payload,
    });
    try { this.shim.api?.emitEvent('elgato.pi-send', { pluginId: this.shim.opts.pluginId, action: this.rec.uuid, context: this.context, payload }); } catch {}
  }
}

class ShimImpl implements ElgatoShim {
  public bound = false;
  public api: ShimApi | null = null;
  public opts: ShimOptions;
  public log: ShimApi['log'];
  private uuidOfShort = new Map<string, string>();

  constructor(api: ShimApi | null, opts: ShimOptions) {
    this.api = api;
    this.opts = { elgatoDir: 'elgato', actions: [], ...opts };
    this.log = logOf(api);
    for (const a of this.opts.actions ?? []) {
      if (a?.shortId && a?.uuid) this.uuidOfShort.set(a.shortId, a.uuid);
    }
    void this.flushPendingLifecycle();
  }

  get streamDeck(): any {
    return this.buildStreamDeck();
  }

  action(uuid: string): any {
    return this.actionProxy(uuid);
  }

  getRegisteredUUIDs(): string[] {
    return [...registry().actions.keys()];
  }

  wasDialRejected(uuid: string): boolean {
    return registry().actions.get(uuid)?.dialRejected ?? false;
  }

  getVisuals(uuid: string, context: string): VisualSnapshot | null {
    const rec = registry().actions.get(uuid);
    const st = rec?.contexts.get(context);
    if (!rec || !st) return null;
    return { title: st.title, image: st.image, state: st.state, alerts: st.alerts, oks: st.oks, settings: { ...st.settings }, appeared: st.seen };
  }

  /**
   * Acceso raw al cliente de un contexto (transporte crudo `raw-transport.ts`):
   * crea el registro si no existe y devuelve el cliente ligado al contexto,
   * con la misma persistencia/publicación que el camino SDK.
   */
  rawAction(uuid: string, context: string): RawActionClient {
    const rec = recordFor(uuid);
    // Toca el estado para que getVisuals() no devuelva null tras willAppear.
    ctxStateOf(rec, context);
    return new ActionClient(this, rec, context) as unknown as RawActionClient;
  }

  /** Settings persistidas de un contexto (transporte raw: hidrata willAppear). */
  async loadPersistedSettings(uuid: string, context: string): Promise<Record<string, any>> {
    const raw = await readSetting(this.api, settingsKey(this.opts.pluginId, uuid, context));
    try { return raw ? { ...(JSON.parse(raw) as Record<string, any>) } : {}; }
    catch { return {}; }
  }

  shortIdFor(uuid: string): string | null {
    for (const [short, u] of this.uuidOfShort.entries()) if (u === uuid) return short;
    return null;
  }

  publishVisual(uuid: string, context: string): void {
    const v = this.getVisuals(uuid, context);
    if (!v) return;
    const buttonId = buttonIdOf(context);
    try {
      // Contrato v2.2: label/state via setButtonState cuando hay botón real.
      this.api?.setButtonState?.(buttonId, {
        state: v.state === null || v.state === undefined ? 'default' : String(v.state),
        ...(v.title !== null ? { label: v.title } : {}),
        ...(v.image !== null ? { icon: v.image } : {}),
      });
    } catch {}
    try {
      this.api?.emitEvent('elgato.state', {
        pluginId: this.opts.pluginId, action: uuid, context,
        buttonId, state: v, running: true, shim: ELGATO_SHIM_VERSION,
      });
    } catch {}
  }

  async persistSettings(uuid: string, context: string): Promise<void> {
    const rec = registry().actions.get(uuid);
    if (!rec) return;
    const st = rec.contexts.get(context);
    if (!st) return;
    await writeSetting(this.api, settingsKey(this.opts.pluginId, uuid, context), JSON.stringify(st.settings ?? {}));
  }

  private buttonFallback(context: string): string {
    return buttonIdOf(context);
  }

  private actionProxy(uuid: string): any {
    const shim = this;
    const rec = recordFor(uuid);
    const push = (slot: keyof ActionHandlers, fn: Handler) => {
      if (typeof fn !== 'function') throw new Error(`Handler de ${uuid}.${slot} no es función`);
      rec.handlers[slot].push(fn);
      return proxy;
    };
    const applyTo = (contexts: string[] | null, fn: (c: ActionClient) => void) => {
      const targets = contexts ?? [...rec.contexts.keys()];
      for (const c of targets) fn(new ActionClient(shim, rec, c));
    };
    const proxy: any = {
      manifestId: uuid,
      UUID: uuid,
      onKeyDown: (fn: Handler) => push('keyDown', fn),
      onKeyUp: (fn: Handler) => push('keyUp', fn),
      onWillAppear: (fn: Handler) => push('willAppear', fn),
      onWillDisappear: (fn: Handler) => push('willDisappear', fn),
      onDidReceiveSettings: (fn: Handler) => push('didReceiveSettings', fn),
      onSendToPlugin: (fn: Handler) => push('sendToPlugin', fn),
      onTitleParametersDidChange: (fn: Handler) => push('titleParametersDidChange', fn),
      register: (instance: any) => shim.registerInstance(uuid, instance),
      setTitle: (title: string | null, opts?: { context?: string }) =>
        applyTo(opts?.context ? [opts.context] : null, (c) => c.setTitle(title)),
      setImage: (image: string | null, opts?: { context?: string }) =>
        applyTo(opts?.context ? [opts.context] : null, (c) => c.setImage(image)),
      setState: (state: number, opts?: { context?: string }) =>
        applyTo(opts?.context ? [opts.context] : null, (c) => c.setState(state)),
      showAlert: (opts?: { context?: string }) =>
        applyTo(opts?.context ? [opts.context] : null, (c) => c.showAlert()),
      showOk: (opts?: { context?: string }) =>
        applyTo(opts?.context ? [opts.context] : null, (c) => c.showOk()),
    };
    return proxy;
  }

  registerInstance(uuid: string, instance: any): void {
    const rec = recordFor(uuid);
    if (!instance || typeof instance !== 'object') {
      throw new Error(`register(${uuid}): instancia inválida`);
    }
    if (instance instanceof DialAction) {
      // RECHAZO EXPLÍCITO: dial/encoder sin equivalente en LibreDeck.
      rec.dialRejected = true;
      this.log('error', `[${uuid}] DialAction rechazado: sin dial hardware en LibreDeck (shim v1)`, {
        pluginId: this.opts.pluginId, action: uuid,
      });
      try {
        this.api?.emitEvent('elgato.dial-rejected', {
          pluginId: this.opts.pluginId, action: uuid, reason: 'dial sin equivalente hardware',
        });
      } catch {}
      return;
    }
    const maybe = (name: keyof typeof METHOD_TO_SLOT) => {
      const fn = (instance as any)[name];
      if (typeof fn === 'function') rec.handlers[METHOD_TO_SLOT[name]].push(fn.bind(instance));
    };
    maybe('onKeyDown'); maybe('onKeyUp'); maybe('onWillAppear');
    maybe('onWillDisappear'); maybe('onDidReceiveSettings');
    maybe('onSendToPlugin'); maybe('onTitleParametersDidChange');
  }

  registerSingleton(instance: any): string {
    const uuid = instance?.manifestId ?? instance?.UUID ?? instance?.actionUUID
      ?? (instance?.constructor as any)?.manifestId ?? (instance?.constructor as any)?.UUID;
    if (!uuid || typeof uuid !== 'string') {
      throw new Error('registerAction: la instancia no declara UUID (manifestId/UUID)');
    }
    const rec = recordFor(uuid);
    if (instance instanceof DialAction) {
      rec.dialRejected = true;
      this.log('error', `[${uuid}] DialAction rechazado: sin dial hardware en LibreDeck (shim v1)`, {
        pluginId: this.opts.pluginId, action: uuid,
      });
      try {
        this.api?.emitEvent('elgato.dial-rejected', {
          pluginId: this.opts.pluginId, action: uuid, reason: 'dial sin equivalente hardware',
        });
      } catch {}
      return uuid;
    }
    const names = ['onKeyDown', 'onKeyUp', 'onWillAppear', 'onWillDisappear', 'onDidReceiveSettings', 'onSendToPlugin', 'onTitleParametersDidChange'] as const;
    for (const n of names) {
      const fn = (instance as any)[n];
      // Se omiten los no-op heredados de la base para no duplicar llamadas.
      if (typeof fn === 'function' && fn !== (SingletonAction.prototype as any)[n]) {
        rec.handlers[METHOD_TO_SLOT[n]].push(fn.bind(instance));
      }
    }
    return uuid;
  }

  buildStreamDeck(): any {
    const shim = this;
    const logger = {
      info: (...a: any[]) => shim.log('info', fmt(a)),
      debug: (...a: any[]) => shim.log('debug', fmt(a)),
      warn: (...a: any[]) => shim.log('warn', fmt(a)),
      error: (...a: any[]) => shim.log('error', fmt(a)),
      trace: (...a: any[]) => shim.log('debug', fmt(a)),
    };
    const settings = {
      async getSettings(context: string): Promise<Record<string, any>> {
        return { ...(recCtx(context)?.settings ?? {}) };
      },
      async setSettings(context: string, s: Record<string, any>): Promise<void> {
        const uuid = uuidForContext(context) ?? firstUuid();
        if (!uuid) return;
        const rec = recordFor(uuid);
        ctxStateOf(rec, context).settings = { ...(s ?? {}) };
        await shim.persistSettings(uuid, context);
      },
      async getGlobalSettings(): Promise<Record<string, any>> {
        const raw = await readSetting(shim.api, globalSettingsKey(shim.opts.pluginId));
        try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
      },
      async setGlobalSettings(s: Record<string, any>): Promise<void> {
        await writeSetting(shim.api, globalSettingsKey(shim.opts.pluginId), JSON.stringify(s ?? {}));
      },
      onDidReceiveSettings(_uuidOrHandler: any, _maybeHandler?: Handler): void {
        // Compat: settings.onDidReceiveSettings(uuid, fn) o (fn global).
        if (typeof _uuidOrHandler === 'function') {
          for (const rec of registry().actions.values()) rec.handlers.didReceiveSettings.push(_uuidOrHandler);
        } else if (typeof _uuidOrHandler === 'string' && typeof _maybeHandler === 'function') {
          recordFor(_uuidOrHandler).handlers.didReceiveSettings.push(_maybeHandler);
        }
      },
    };
    const devices = {
      getDevices: () => [{ id: VIRTUAL_DEVICE_ID, name: VIRTUAL_DEVICE_NAME, type: 0, size: { columns: 8, rows: 4 } }],
      getDeviceInfo: (_id?: string) => ({ id: VIRTUAL_DEVICE_ID, name: VIRTUAL_DEVICE_NAME, type: 0, size: { columns: 8, rows: 4 } }),
    };
    const profiles = {
      async switchToProfile(profile: string, _device?: string): Promise<boolean> {
        // EMULADO (v1): sin perfiles Elgato; se avisa y se emite para page/select.
        shim.log('warn', `switchToProfile('${profile}') emulado: no-op avisado (sin perfiles Elgato en LibreDeck)`, {
          pluginId: shim.opts.pluginId, profile,
        });
        try { shim.api?.emitEvent('profile.switch', { pluginId: shim.opts.pluginId, profile, emulated: true }); } catch {}
        return true;
      },
      getProfiles: async () => [],
    };
    const system = {
      async openUrl(url: string): Promise<void> {
        shim.log('info', `openUrl (registrado, sin abrir en tests/servidor): ${url}`, { pluginId: shim.opts.pluginId, url });
        try { shim.api?.emitEvent('system.open-url', { pluginId: shim.opts.pluginId, url }); } catch {}
      },
    };
    const sd: any = {
      shimVersion: ELGATO_SHIM_VERSION,
      action: (uuid: string) => shim.actionProxy(uuid),
      actions: {
        registerAction: (instance: any) => shim.registerSingleton(instance),
      },
      settings,
      devices,
      profiles,
      system,
      logger,
      connect: () => shim.connect(),
      // Compat con importaciones parciales del SDK real.
      version: ELGATO_SHIM_VERSION,
    };
    return sd;
  }

  private async flushPendingLifecycle(): Promise<void> {
    const reg = registry();
    if (!this.api) return;
    if (!reg.connectRequested) return;
    reg.connectRequested = false;
    await this.connect();
  }

  markConnectRequested(): void {
    registry().connectRequested = true;
    if (this.api) void this.flushPendingLifecycle();
  }

  async connect(): Promise<void> {
    if (!this.api) {
      registry().connectRequested = true;
      return;
    }
    const pid = this.opts.pluginId;
    this.log('info', `shim connect: deviceDidConnect ${VIRTUAL_DEVICE_ID} + applicationDidLaunch (emulados)`, { pluginId: pid });
    try {
      this.api.emitEvent('elgato.device-connected', {
        pluginId: pid, device: VIRTUAL_DEVICE_ID, name: VIRTUAL_DEVICE_NAME, emulated: true,
      });
      this.api.emitEvent('elgato.app-launch', { pluginId: pid, emulated: true });
      this.api.emitEvent('elgato.title-parameters', {
        pluginId: pid, titleParameters: defaultTitleParameters(), emulated: true,
      });
    } catch {}
  }

  /**
   * Pulso completo de tecla con contexto ÚNICO por botón
   * (`ld:<plugin>:<short>:<buttonId>`): willAppear en el primer uso,
   * settings = persistidas + params LibreDeck, keyDown, hold real si la
   * pulsación es larga, keyUp.
   */
  async fireKey(uuid: string, opts: { params?: any; context?: any }): Promise<FireKeyResult> {
    const t0 = Date.now();
    const rec = recordFor(uuid);
    const ld = opts?.context ?? {};
    const buttonId = typeof ld === 'string'
      ? ld
      : (ld?.buttonId ?? ld?.button_id ?? 'deck');
    const short = this.shortIdFor(uuid) ?? compactUuid(this.opts.pluginId, uuid);
    const context = `ld:${this.opts.pluginId}:${short}:${buttonId}`;
    const params = (opts?.params && typeof opts.params === 'object' ? opts.params : {}) as Record<string, any>;
    const st = ctxStateOf(rec, context);

    // 1) willAppear en el primer uso del contexto (arranque perezoso).
    if (!st.seen) {
      st.seen = true;
      const raw = await readSetting(this.api, settingsKey(this.opts.pluginId, uuid, context));
      try { st.settings = raw ? { ...(JSON.parse(raw) as Record<string, any>) } : {}; }
      catch { st.settings = {}; }
      const ev = eventFor(this, rec, context);
      await runHandlers(rec.handlers.willAppear, ev, this.log);
      await runHandlers(rec.handlers.didReceiveSettings, ev, this.log);
    }

    // 2) settings efectivas = persistidas + params LibreDeck (params mandan).
    const before = JSON.stringify(st.settings ?? {});
    st.settings = { ...(st.settings ?? {}), ...params };
    if (JSON.stringify(st.settings) !== before) {
      await this.persistSettings(uuid, context);
      const ev = eventFor(this, rec, context);
      await runHandlers(rec.handlers.didReceiveSettings, ev, this.log);
    }

    // 3) keyDown.
    const downEv = eventFor(this, rec, context);
    const downCalled = await runHandlers(rec.handlers.keyDown, downEv, this.log);

    // 4) Hold real: long de LibreDeck = delay entre keyDown y keyUp.
    const pressType = typeof ld === 'object' ? (ld as any)?.pressType : undefined;
    const holdMs = typeof ld === 'object' ? Number((ld as any)?.holdMs) : NaN;
    let heldMs = 0;
    if (pressType === 'long' || (Number.isFinite(holdMs) && holdMs > 0)) {
      const wait = Number.isFinite(holdMs) && holdMs > 0 ? Math.min(holdMs, 10_000) : (this.opts.longHoldMs ?? LONG_HOLD_MS_DEFAULT);
      await sleep(wait);
      heldMs = Date.now() - t0;
    }

    // 5) keyUp.
    const upEv = eventFor(this, rec, context);
    const upCalled = await runHandlers(rec.handlers.keyUp, upEv, this.log);
    this.publishVisual(uuid, context);

    return {
      ok: true,
      context,
      heldMs,
      downCalled,
      upCalled,
      visuals: this.getVisuals(uuid, context)!,
    };
  }
}

function buttonIdOf(context: string): string {
  const parts = String(context ?? '').split(':');
  return parts.length >= 4 ? parts.slice(3).join(':') || 'deck' : (String(context ?? '') || 'deck');
}

function compactUuid(pluginId: string, uuid: string): string {
  let id = uuid.startsWith(pluginId + '.') ? uuid.slice(pluginId.length + 1) : uuid;
  id = id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
  return (id || 'action').slice(0, 64);
}

function firstUuid(): string | null {
  const keys = [...registry().actions.keys()];
  return keys.length > 0 ? keys[0] : null;
}

function recCtx(context: string): ContextState | null {
  for (const rec of registry().actions.values()) {
    const st = rec.contexts.get(context);
    if (st) return st;
  }
  return null;
}

function uuidForContext(context: string): string | null {
  for (const [uuid, rec] of registry().actions.entries()) {
    if (rec.contexts.has(context)) return uuid;
  }
  return null;
}

function fmt(a: any[]): string {
  try {
    return a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  } catch { return a.map(String).join(' '); }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Crea (o vincula) el shim para el Worker actual. El registro de acciones
 * es global al Worker: el CodePath se importa una vez (side-effect) y aquí
 * se vincula el `api` real + la lista de acciones del manifest.
 */
export function createElgatoShim(api: ShimApi | null, opts: ShimOptions): ElgatoShim {
  const reg = registry();
  const impl = new ShimImpl(api, opts);
  reg.boundApi = api;
  reg.boundOpts = opts;
  impl.bound = true;
  return impl;
}

/** Acceso al singleton del SDK (lo que importan los plugins Elgato). */
function singleton(): any {
  const reg = registry();
  if (!(reg as any).sd) {
    const impl = new ShimImpl(reg.boundApi, reg.boundOpts ?? { pluginId: 'unknown' });
    (reg as any).impl = impl;
    (reg as any).sd = impl.buildStreamDeck();
    // `action()` expuesto también como función con métodos (estilo SDK).
    const actionFn: any = (uuid: string) => impl.actionProxy(uuid);
    actionFn.registerAction = (instance: any) => impl.registerSingleton(instance);
    (reg as any).actionFn = actionFn;
  }
  const api = reg.boundApi;
  // Si el bridge ya vinculó el api, propagarlo al impl del singleton.
  const impl = (reg as any).impl as ShimImpl;
  if (api && impl.api !== api) {
    impl.api = api;
    impl.log = logOf(api);
    void impl.flushPendingLifecycle();
  }
  return { sd: (reg as any).sd, actionFn: (reg as any).actionFn, impl: (reg as any).impl as ShimImpl };
}

function patchConnect(sd: any): void {
  void sd;
}

/** Default export: `import streamDeck from '@elgato/streamdeck'`. */
const _default = new Proxy({}, {
  get(_t, prop: string) {
    const { sd } = singleton();
    if (prop === 'connect') {
      return () => {
        const { impl } = singleton();
        if (!impl.api) { registry().connectRequested = true; return Promise.resolve(); }
        return impl.connect();
      };
    }
    const v = (sd as any)[prop];
    if (typeof v === 'function') return v.bind(sd);
    return v;
  },
});

export default _default;
void patchConnect;

/** Named: `import { streamDeck } from '@elgato/streamdeck'`. */
export const streamDeck: any = _default;

/** Named: `import { action } from '@elgato/streamdeck'`. */
export const action: any = (uuid: string) => singleton().actionFn(uuid);
(action as any).registerAction = (instance: any) => singleton().impl.registerSingleton(instance);

/** Named: `import { logger } from '@elgato/streamdeck'`. */
export const logger: any = new Proxy({}, {
  get(_t, prop: string) {
    const fn = (singleton().sd.logger as any)?.[prop];
    if (typeof fn === 'function') return fn;
    return () => {};
  },
});

/** Named: `import { devices } from '@elgato/streamdeck'`. */
export const devices: any = new Proxy({}, {
  get(_t, prop: string) {
    const v = (singleton().sd.devices as any)?.[prop];
    if (typeof v === 'function') return v;
    return v;
  },
});

/** Named: `import { system } from '@elgato/streamdeck'`. */
export const system: any = new Proxy({}, {
  get(_t, prop: string) {
    const v = (singleton().sd.system as any)?.[prop];
    if (typeof v === 'function') return v;
    return v;
  },
});

/** Named: `import { profiles } from '@elgato/streamdeck'`. */
export const profiles: any = new Proxy({}, {
  get(_t, prop: string) {
    const v = (singleton().sd.profiles as any)?.[prop];
    if (typeof v === 'function') return v;
    return v;
  },
});

/** Named: `import { settings } from '@elgato/streamdeck'`. */
export const settings: any = new Proxy({}, {
  get(_t, prop: string) {
    const v = (singleton().sd.settings as any)?.[prop];
    if (typeof v === 'function') return v;
    return v;
  },
});
