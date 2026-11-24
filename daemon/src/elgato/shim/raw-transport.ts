/**
 * raw-transport.ts — Adaptador para plugins Elgato que hablan el protocolo
 * WebSocket en crudo (sin importar `@elgato/streamdeck`).
 *
 * Caso real: `com.peterneave.streamdeck-plugin-au-uv` (AUS-UV): `new
 * WebSocket` + `send("setTitle"/"setImage"/...)`, argv `-port/-pluginUUID/
 * -registerEvent`. El bridge raw (`loader-shim.ts`) lo importa junto al
 * falso SDK y, ANTES de importar el CodePath, instala:
 * - `globalThis.WebSocket` virtual (compatible con el uso que hace `ws@8`:
 *   `new WebSocket(url)`, `.on('open'|'message')`, `.send()`, `.readyState`,
 *   `WebSocket.OPEN`),
 * - `process.argv` con `-port/-pluginUUID/-registerEvent` virtuales,
 * - un stub `node_modules/ws` que re-exporta el socket virtual.
 *
 * El host emula al Stream Deck: recibe `registerPlugin`, envía
 * `willAppear/keyDown/keyUp/didReceiveSettings/didReceiveGlobalSettings` y
 * traduce `setTitle/setImage/setState/showAlert/showOk/setSettings/
 * getSettings/setGlobalSettings/getGlobalSettings/openUrl/logMessage/
 * sendToPropertyInspector` al núcleo del shim (`sdk.ts`: mismos contextos
 * únicos `ld:<plugin>:<acción>:<buttonId>`, misma persistencia, mismos
 * eventos `elgato.state`/`system.open-url`/`elgato.pi-send`).
 *
 * Cero procesos `node`, cero `Bun.serve`: todo ocurre en el Worker actual.
 * Este fichero es AUTOCONTENIDO salvo el import de `./sdk` (el bridge lo
 * coloca junto a `elgato-shim-sdk.js`).
 */

import {
  createElgatoShim,
  compactElgatoUuid,
  LONG_HOLD_MS_DEFAULT,
  VIRTUAL_DEVICE_ID,
  type ElgatoShim,
  type RawActionClient,
  type ShimApi,
  type ShimOptions,
  type VisualSnapshot,
} from './sdk';

export const RAW_TRANSPORT_VERSION = '1.0.0';
/** Clave global del host raw dentro del Worker (la usa el stub `ws`). */
export const RAW_HOST_KEY = '__LD_RAW_ELGATO_HOST__';

export interface RawHostOptions extends ShimOptions {
  /** UUID Elgato del plugin (para `-pluginUUID` y `registerPlugin`). */
  elgatoUuid: string;
  /** Evento de registro que espera el plugin (por defecto `registerPlugin`). */
  registerEvent?: string;
}

export interface RawFireKeyResult {
  ok: boolean;
  context: string;
  heldMs: number;
  downCalled: boolean;
  upCalled: boolean;
  visuals: VisualSnapshot;
}

/** Mensaje plugin→host del protocolo crudo (JSON por `ws.send`). */
interface RawOutbound {
  event: string;
  uuid?: string;
  context?: string;
  action?: string;
  payload?: any;
}

type Listener = (...args: any[]) => void;

/**
 * Socket virtual compatible con el subconjunto de `ws@8` que usan los
 * plugins (AUS-UV: `new WebSocket(url)`, `ws.on('open'|'message')`,
 * `ws.send()`, `ws.readyState === WebSocket.OPEN`).
 */
export class VirtualElgatoSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  /** `ws@8` expone `Server` para servir; aquí está prohibido (cero `Bun.serve`). */
  static Server: any = class {
    constructor() {
      throw new Error('ws.Server no soportado por el shim LibreDeck (cero Bun.serve por plugin)');
    }
  };

  public readyState: number = VirtualElgatoSocket.CONNECTING;
  public url: string;
  private listeners = new Map<string, Listener[]>();
  private hostRef: RawHost | null = null;

  constructor(url: string) {
    this.url = String(url ?? '');
    const host = (globalThis as any)[RAW_HOST_KEY] as RawHost | null ?? null;
    this.hostRef = host;
    if (host) host.attachSocket(this);
    // `open` asíncrono como en un socket real (el plugin registra `on`
    // justo después del constructor).
    void Promise.resolve().then(() => {
      if (this.readyState !== VirtualElgatoSocket.CONNECTING) return;
      this.readyState = VirtualElgatoSocket.OPEN;
      this.emit('open');
    });
  }

  on(event: string, fn: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }

  once(event: string, fn: Listener): this {
    const wrap = (...a: any[]) => {
      this.removeListener(event, wrap);
      fn(...a);
    };
    return this.on(event, wrap);
  }

  removeListener(event: string, fn: Listener): this {
    const list = this.listeners.get(event);
    if (list) this.listeners.set(event, list.filter((l) => l !== fn));
    return this;
  }

  off(event: string, fn: Listener): this {
    return this.removeListener(event, fn);
  }

  /** plugin→host: el host lo interpreta y actualiza el shim. */
  send(data: any): void {
    if (this.readyState !== VirtualElgatoSocket.OPEN) return;
    try {
      this.hostRef?.handleFromPlugin(this, typeof data === 'string' ? data : String(data));
    } catch {
      this.emit('error', new Error('raw-transport: mensaje no procesable'));
    }
  }

  close(): void {
    if (this.readyState === VirtualElgatoSocket.CLOSED) return;
    this.readyState = VirtualElgatoSocket.CLOSING;
    try { this.hostRef?.detachSocket(this); } catch {}
    this.readyState = VirtualElgatoSocket.CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.close();
  }

  /** host→plugin: entrega un evento como string JSON (`message`). */
  deliver(obj: unknown): boolean {
    if (this.readyState !== VirtualElgatoSocket.OPEN) return false;
    const list = this.listeners.get('message') ?? [];
    if (list.length === 0) return false;
    let text: string;
    try { text = typeof obj === 'string' ? obj : JSON.stringify(obj); }
    catch { return false; }
    for (const fn of [...list]) {
      try { fn(text); } catch {}
    }
    return true;
  }

  private emit(event: string, ...args: any[]): void {
    const list = this.listeners.get(event) ?? [];
    for (const fn of [...list]) {
      try { fn(...args); } catch {}
    }
  }
}

interface RawContext {
  uuid: string;
  seen: boolean;
}

function defaultVisuals(settings: Record<string, any>): VisualSnapshot {
  return { title: null, image: null, state: null, alerts: 0, oks: 0, settings: { ...settings }, appeared: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class RawHost {
  private shim: ElgatoShim;
  private api: ShimApi | null;
  private opts: RawHostOptions;
  private sockets = new Set<VirtualElgatoSocket>();
  private contexts = new Map<string, RawContext>();
  private log: ShimApi['log'];
  readonly registerEvent: string;

  constructor(shim: ElgatoShim, api: ShimApi | null, opts: RawHostOptions) {
    this.shim = shim;
    this.api = api;
    this.opts = { registerEvent: 'registerPlugin', ...opts };
    this.registerEvent = this.opts.registerEvent as string;
    this.log = api
      ? (l, m, meta) => { try { api.log(l, m, meta); } catch {} }
      : (_l, _m) => { try { console.debug('[elgato-raw]', _m); } catch {} };
  }

  shortIdFor(uuid: string): string | null {
    if (typeof (this.shim as any).shortIdFor === 'function') {
      try { return (this.shim as any).shortIdFor(uuid); } catch { /* sigue */ }
    }
    for (const a of this.opts.actions ?? []) {
      if (a?.uuid === uuid && a?.shortId) return a.shortId;
    }
    return null;
  }

  contextFor(uuid: string, buttonId: string): string {
    const short = this.shortIdFor(uuid) ?? compactElgatoUuid(this.opts.pluginId, uuid);
    return `ld:${this.opts.pluginId}:${short}:${buttonId}`;
  }

  uuidForShort(shortId: string): string | null {
    for (const a of this.opts.actions ?? []) {
      if (a?.shortId === shortId) return a.uuid;
    }
    return null;
  }

  attachSocket(sock: VirtualElgatoSocket): void {
    this.sockets.add(sock);
  }

  detachSocket(sock: VirtualElgatoSocket): void {
    this.sockets.delete(sock);
  }

  get socketCount(): number {
    return this.sockets.size;
  }

  /** Emite un evento del host a TODOS los sockets conectados. */
  private broadcast(obj: unknown): boolean {
    let delivered = false;
    for (const s of [...this.sockets]) {
      try { if (s.deliver(obj)) delivered = true; } catch {}
    }
    return delivered;
  }

  private sendToContext(context: string, event: string, extra: Record<string, any> = {}): boolean {
    const rec = this.contexts.get(context);
    const settings = { ...(extra?.payload?.settings ?? {}) };
    return this.broadcast({
      action: rec?.uuid ?? extra?.action ?? null,
      event,
      context,
      device: VIRTUAL_DEVICE_ID,
      payload: { ...(extra?.payload ?? {}), settings },
    });
  }

  /**
   * Interpreta un `ws.send()` del plugin (JSON `{event, context?, payload?}`)
   * y lo aplica al núcleo del shim. Nunca lanza.
   */
  handleFromPlugin(_sock: VirtualElgatoSocket, data: string): void {
    let msg: RawOutbound;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg.event !== 'string') return;
    const ev = msg.event;
    const ctx = typeof msg.context === 'string' ? msg.context : null;
    const payload = (msg.payload !== null && typeof msg.payload === 'object' ? msg.payload : {}) as Record<string, any>;

    // Registro (`registerPlugin`/`registerEvent` + uuid del plugin).
    if (ev === this.registerEvent || ev === 'registerPlugin' || ev === 'registerEvent') {
      this.log('info', `raw: registro ${ev} (${msg.uuid ?? this.opts.elgatoUuid})`, {
        pluginId: this.opts.pluginId, event: ev,
      });
      try {
        this.api?.emitEvent('elgato.raw-register', {
          pluginId: this.opts.pluginId, event: ev, uuid: msg.uuid ?? this.opts.elgatoUuid,
        });
      } catch {}
      return;
    }

    const clientFor = (context: string, actionUuid?: string | null): RawActionClient | null => {
      const uuid = actionUuid ?? this.contexts.get(context)?.uuid ?? this.opts.actions?.[0]?.uuid ?? null;
      if (!uuid) return null;
      return this.shim.rawAction(uuid, context);
    };

    switch (ev) {
      case 'setTitle': {
        if (!ctx) return;
        const title = 'title' in payload ? payload.title : payload;
        clientFor(ctx, msg.action)?.setTitle(title === undefined ? null : String(title ?? ''));
        break;
      }
      case 'setImage': {
        if (!ctx) return;
        const image = 'image' in payload ? payload.image : payload;
        clientFor(ctx, msg.action)?.setImage(image === undefined || image === null || image === '' ? null : String(image));
        break;
      }
      case 'setState': {
        if (!ctx) return;
        const n = Number('state' in payload ? payload.state : payload);
        if (Number.isFinite(n)) clientFor(ctx, msg.action)?.setState(n);
        break;
      }
      case 'showAlert': {
        if (!ctx) return;
        clientFor(ctx, msg.action)?.showAlert();
        break;
      }
      case 'showOk': {
        if (!ctx) return;
        clientFor(ctx, msg.action)?.showOk();
        break;
      }
      case 'setSettings': {
        if (!ctx) return;
        void clientFor(ctx, msg.action)?.setSettings({ ...(payload ?? {}) });
        break;
      }
      case 'getSettings': {
        if (!ctx) return;
        void (async () => {
          try {
            const client = clientFor(ctx, msg.action);
            const settings = client ? await client.getSettings() : {};
            this.sendToContext(ctx, 'didReceiveSettings', { action: msg.action, payload: { settings, coordinates: { column: 0, row: 0 } } });
          } catch {}
        })();
        break;
      }
      case 'setGlobalSettings': {
        void (async () => {
          try { await (this.shim.streamDeck?.settings as any)?.setGlobalSettings?.({ ...(payload ?? {}) }); } catch {}
        })();
        break;
      }
      case 'getGlobalSettings': {
        void (async () => {
          try {
            const settings = await (this.shim.streamDeck?.settings as any)?.getGlobalSettings?.() ?? {};
            this.broadcast({ event: 'didReceiveGlobalSettings', payload: { settings } });
          } catch {}
        })();
        break;
      }
      case 'openUrl': {
        const url = typeof payload.url === 'string' ? payload.url : (typeof payload === 'string' ? payload : '');
        if (url) {
          this.log('info', `raw openUrl (registrado, sin abrir en tests/servidor): ${url}`, { pluginId: this.opts.pluginId, url });
          try { this.api?.emitEvent('system.open-url', { pluginId: this.opts.pluginId, url }); } catch {}
        }
        break;
      }
      case 'logMessage': {
        const message = typeof payload.message === 'string' ? payload.message : String(payload ?? '');
        this.log('debug', `raw logMessage: ${message.slice(0, 300)}`, { pluginId: this.opts.pluginId });
        break;
      }
      case 'sendToPropertyInspector': {
        try {
          this.log('debug', `[raw] sendToPropertyInspector (emulado, sin PI)`, {
            pluginId: this.opts.pluginId, context: ctx, payload,
          });
          this.api?.emitEvent('elgato.pi-send', { pluginId: this.opts.pluginId, context: ctx, payload });
        } catch {}
        break;
      }
      case 'sendToPlugin': {
        // El plugin responde a nuestros envíos; re-emitir como evento para
        // observabilidad (el host real lo encaminaría a la PI).
        try { this.api?.emitEvent('elgato.send-to-plugin', { pluginId: this.opts.pluginId, context: ctx, payload }); } catch {}
        break;
      }
      case 'switchToProfile': {
        const profile = typeof payload.profile === 'string' ? payload.profile : '';
        this.log('warn', `raw switchToProfile('${profile}') emulado: no-op avisado`, { pluginId: this.opts.pluginId, profile });
        try { this.api?.emitEvent('profile.switch', { pluginId: this.opts.pluginId, profile, emulated: true }); } catch {}
        break;
      }
      default: {
        this.log('debug', `raw: evento no mapeado '${ev}' (ignorado)`, { pluginId: this.opts.pluginId, event: ev });
        break;
      }
    }
  }

  /**
   * Pulso completo con contexto ÚNICO por botón (misma convención que
   * `ShimImpl.fireKey`): willAppear en el primer uso (con persistidas +
   * params), keyDown, hold real si la pulsación es larga, keyUp.
   */
  async fireKey(uuid: string, opts: { params?: any; context?: any }): Promise<RawFireKeyResult> {
    const t0 = Date.now();
    const ld = opts?.context ?? {};
    const buttonId = typeof ld === 'string'
      ? ld
      : (ld?.buttonId ?? ld?.button_id ?? 'deck');
    const context = this.contextFor(uuid, String(buttonId));
    const params = (opts?.params && typeof opts.params === 'object' ? opts.params : {}) as Record<string, any>;

    let rec = this.contexts.get(context);
    if (!rec) {
      rec = { uuid, seen: false };
      this.contexts.set(context, rec);
    }
    const client = this.shim.rawAction(uuid, context);

    // 1) willAppear en el primer uso (arranque perezoso) + didReceiveSettings.
    if (!rec.seen) {
      rec.seen = true;
      const persisted = await this.shim.loadPersistedSettings(uuid, context);
      const merged = { ...persisted, ...params };
      await client.setSettings(merged);
      this.sendToContext(context, 'willAppear', {
        action: uuid,
        payload: { settings: merged, coordinates: { column: 0, row: 0 }, state: 0, isInMultiAction: false },
      });
      this.sendToContext(context, 'didReceiveSettings', {
        action: uuid,
        payload: { settings: merged, coordinates: { column: 0, row: 0 } },
      });
    } else if (Object.keys(params).length > 0) {
      // 2) params de LibreDeck se fusionan (mandan) y se notifican.
      const current = await client.getSettings();
      const merged = { ...current, ...params };
      if (JSON.stringify(merged) !== JSON.stringify(current)) {
        await client.setSettings(merged);
        this.sendToContext(context, 'didReceiveSettings', {
          action: uuid,
          payload: { settings: merged, coordinates: { column: 0, row: 0 } },
        });
      }
    }

    // 3) keyDown.
    const currentSettings = await client.getSettings();
    const downCalled = this.sendToContext(context, 'keyDown', {
      action: uuid,
      payload: { settings: currentSettings, coordinates: { column: 0, row: 0 } },
    });

    // 4) Hold real: long de LibreDeck = delay entre keyDown y keyUp.
    const pressType = typeof ld === 'object' ? (ld as any)?.pressType : undefined;
    const holdMs = typeof ld === 'object' ? Number((ld as any)?.holdMs) : NaN;
    let heldMs = 0;
    if (pressType === 'long' || (Number.isFinite(holdMs) && holdMs > 0)) {
      const wait = Number.isFinite(holdMs) && holdMs > 0 ? Math.min(holdMs, 10_000) : LONG_HOLD_MS_DEFAULT;
      await sleep(wait);
      heldMs = Date.now() - t0;
    }

    // 5) keyUp.
    const upCalled = this.sendToContext(context, 'keyUp', {
      action: uuid,
      payload: { settings: await client.getSettings(), coordinates: { column: 0, row: 0 } },
    });

    const visuals = this.shim.getVisuals(uuid, context) ?? defaultVisuals(await client.getSettings());
    return { ok: true, context, heldMs, downCalled, upCalled, visuals };
  }

  getVisuals(uuid: string, context: string): VisualSnapshot | null {
    return this.shim.getVisuals(uuid, context);
  }
}

export type { RawHost };

/** Default export: `import WebSocket from 'ws'` tras la reescritura del entry. */
export default VirtualElgatoSocket;

/** Crea (o reutiliza) el host raw del Worker actual y lo publica globalmente. */
export function createRawHost(api: ShimApi | null, opts: RawHostOptions): RawHost {
  const shim: ElgatoShim = createElgatoShim(api, {
    pluginId: opts.pluginId,
    elgatoDir: opts.elgatoDir,
    actions: opts.actions,
    platform: opts.platform,
  });
  const host = new RawHost(shim, api, opts);
  (globalThis as any)[RAW_HOST_KEY] = host;
  return host;
}

/** Devuelve el host raw del Worker actual (lo que importa el stub `ws`). */
export function getRawHost(): RawHost | null {
  return ((globalThis as any)[RAW_HOST_KEY] as RawHost | null) ?? null;
}

/**
 * Instala los globales que espera un plugin crudo ANTES de importar su
 * CodePath: `WebSocket` virtual, `process.argv` con los datos de conexión
 * (`-port/-pluginUUID/-registerEvent`) y `process.release.name === 'node'`.
 */
export function installRawGlobals(
  host: RawHost,
  opts: { elgatoUuid: string; registerEvent?: string; port?: number } = {} as any,
): void {
  (globalThis as any)[RAW_HOST_KEY] = host;
  try {
    (globalThis as any).WebSocket = VirtualElgatoSocket;
  } catch {}
  const uuid = opts.elgatoUuid;
  const registerEvent = opts.registerEvent ?? host.registerEvent ?? 'registerPlugin';
  const port = String(opts.port ?? 0);
  try {
    const proc = (globalThis as any).process;
    if (proc && Array.isArray(proc.argv)) {
      const argv: string[] = proc.argv.slice(0, 2);
      const has = (flag: string): boolean => argv.includes(flag) || proc.argv.includes(flag);
      if (!has('-port')) argv.push('-port', port);
      if (!has('-pluginUUID')) argv.push('-pluginUUID', uuid);
      if (!has('-registerEvent')) argv.push('-registerEvent', registerEvent);
      proc.argv = argv;
    }
  } catch {}
}
