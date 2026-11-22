/**
 * CLIENTE DEL TÚNEL: expone la web/API local a través del relay.
 *
 * Protocolo (lo implementa el relay en paralelo; programa contra ÉL):
 * - Al conectar: `{v:1, kind:'tunnel-register', deviceId}` (y en cada reconexión).
 * - Relay → daemon: `{kind:'ui-request', reqId, urlCode, ua, ip}` →
 *   cola de pendientes (máx 20, TTL 120s) + broadcast local
 *   `ui-approval-requested` (topic `remote`) + log. Nunca se decide solo.
 * - Relay → daemon: `{kind:'http-req', id, method, path, headers, bodyB64}` →
 *   se sirve contra el manejador HTTP LOCAL (la misma función que usa
 *   `Bun.serve` del daemon: `http/handler.ts`) y se responde
 *   `{kind:'http-res', id, status, headers, bodyB64}`.
 * - Relay → daemon: `{kind:'ws-open', id}` / `{kind:'ws-msg', id, dataB64,
 *   isBinary}` / `{kind:'ws-close', id}` → puente contra el WS MANAGER local
 *   como un cliente local más (ver `ws.ts`: `createTunnelClient`,
 *   `handleTunnelMessage`, `removeTunnelClient`).
 * - Daemon → relay: `{kind:'ui-publish', urlCode, exp}`,
 *   `{kind:'ui-unpublish', urlCode}`, `{kind:'ui-decision', reqId, allow}`,
 *   `{kind:'ui-bind', urlCode, sessionToken, exp}`,
 *   `{kind:'ui-unbind', sessionToken}`.
 *
 * Si el túnel está caído o la UI remota está deshabilitada
 * (`remote.ui.enabled`, default false): las decisiones son deny y los
 * http-req se responden 503.
 *
 * Reconexión exponencial 1s→30s con jitter: re-registra tunnel + republica
 * códigos vigentes.
 */

import { resolveRelayUrl, resolveRelayToken, withRelayToken } from './public-relay';

export type TunnelStatus = 'disabled' | 'disconnected' | 'connecting' | 'connected';

export interface UiPendingRequest {
  reqId: string;
  urlCode: string;
  ua: string;
  ip: string;
  receivedAt: number;
  expiresAt: number;
}

export interface UiBinding {
  sessionToken: string;
  urlCode: string;
  exp: number;
}

export type HttpHandler = (req: Request) => Promise<Response>;

/** Interfaz mínima del WS manager que necesita el túnel. */
export interface TunnelWsHost {
  broadcast: (event: string, payload: any, topic?: string) => void;
  createTunnelClient?: (tunnelId: string, send: (text: string) => void) => string;
  removeTunnelClient?: (tunnelId: string) => void;
  handleTunnelMessage?: (tunnelId: string, text: string) => void;
}

interface DbLike {
  getSetting: (key: string) => string | null;
  addLog?: (entry: { level: string; message: string; meta?: any; ts: number }) => void;
}

export const TUNNEL_PENDING_TTL_MS = 120_000;
export const TUNNEL_MAX_PENDING = 20;
export const TUNNEL_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const TUNNEL_MAX_BACKOFF_MS = 30_000;

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Cabeceras hop-by-hop: nunca se reenvían al servidor local ni al relay. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function b64encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function b64encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decodeBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function sanitizeRequestHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'content-length' || lk === 'host') continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function sanitizeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    if (lk === 'transfer-encoding') return;
    out[k] = v;
  });
  return out;
}

/** ¿Ruta servible por el túnel? Solo lo que el servidor local ya sirve. */
export function isAllowedTunnelPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  if (path.includes('..') || path.includes('\0')) return false;
  // Decodifica %2e para pillar `/%2e%2e/` y variantes.
  try {
    const decoded = decodeURIComponent(path);
    if (decoded.includes('..') || decoded.includes('\0')) return false;
  } catch {
    return false; // path con % inválido: denegar
  }
  // Fragmento / control: denegar.
  if (/[\r\n]/.test(path)) return false;
  return (
    path.startsWith('/api/') ||
    path === '/api' ||
    path.startsWith('/assets/') ||
    path === '/config' ||
    path === '/health' ||
    path === '/' ||
    path.startsWith('/_app/') || // frontend (vite/sveltekit) si existe
    path.match(/^\/[^/]*\.(html|js|css|json|png|jpg|jpeg|svg|ico|woff2?|ttf|map|webp|mp3|wav|ogg)$/) !== null ||
    // Cualquier otra ruta del frontend (SPA): se deja pasar al handler local,
    // que hace fallback a index.html igual que en local.
    !path.startsWith('/api/') && !path.startsWith('/assets/')
  );
}

function randomSessionToken(): string {
  // 32 bytes hex con crypto (node:crypto, disponible en Bun).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('node:crypto');
  return randomBytes(32).toString('hex');
}

export interface TunnelClientOpts {
  deviceId: string;
  /** URL override (tests). Si no, `RELAY_URL` env, `remote.relay.url` o relay público por defecto. */
  relayUrl?: string;
  now?: () => number;
}

export class TunnelClient {
  private ws: WebSocket | null = null;
  private status: TunnelStatus = 'disconnected';
  private backoffMs = 1000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private statusCb: ((s: TunnelStatus) => void) | null = null;

  private pending = new Map<string, UiPendingRequest>();
  private published = new Map<string, number>(); // urlCode -> exp
  private bindings = new Map<string, UiBinding>(); // sessionToken -> binding
  /** Puentes WS activos: relayId -> { localClientId?, fallbackSubs? } */
  private bridges = new Map<string, { subs?: Set<string> }>();
  private patchedBroadcast: (() => void) | null = null;

  private httpHandler: HttpHandler | null = null;
  private now: () => number;

  constructor(
    private db: DbLike,
    private wsManager: TunnelWsHost | null,
    private opts: TunnelClientOpts,
  ) {
    this.now = opts.now ?? Date.now;
  }

  // ---- estado / config ----

  getState(): TunnelStatus {
    return this.status;
  }

  onStatus(cb: (s: TunnelStatus) => void): void {
    this.statusCb = cb;
  }

  setWsManager(m: TunnelWsHost | null): void {
    this.wsManager = m;
  }

  setHttpHandler(h: HttpHandler | null): void {
    this.httpHandler = h;
  }

  relayUrl(): string {
    if (this.opts.relayUrl) return this.opts.relayUrl;
    return resolveRelayUrl(this.db);
  }

  relayToken(): string {
    return resolveRelayToken(this.db);
  }

  /** UI remota habilitada (`remote.ui.enabled`, default false). */
  isUiEnabled(): boolean {
    const v = (this.db.getSetting('remote.ui.enabled') ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes';
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  /** ¿Puede atender peticiones? Túnel conectado + UI habilitada. */
  isAvailable(): boolean {
    return this.isConnected() && this.isUiEnabled();
  }

  private setStatus(s: TunnelStatus): void {
    this.status = s;
    try {
      this.statusCb?.(s);
    } catch { /* noop */ }
  }

  // ---- ciclo de vida ----

  start(): void {
    this.closed = false;
    if (!this.relayUrl()) {
      this.setStatus('disabled');
      return;
    }
    this.startSweep();
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.sweepTimer = null;
    // Limpia puentes WS virtuales.
    for (const id of [...this.bridges.keys()]) this.closeBridge(id);
    try {
      this.ws?.close();
    } catch { /* noop */ }
    this.ws = null;
    this.setStatus(this.relayUrl() ? 'disconnected' : 'disabled');
  }

  private startSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = setInterval(() => this.purgeExpired(), 15_000);
  }

  private connect(): void {
    if (this.closed) return;
    const base = this.relayUrl();
    if (!base) {
      this.setStatus('disabled');
      return;
    }
    const url = withRelayToken(base, this.relayToken());
    this.setStatus('connecting');
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.backoffMs = 1000;
      this.setStatus('connected');
      this.send({ v: 1, kind: 'tunnel-register', deviceId: this.opts.deviceId });
      // Republicar códigos vigentes tras cada (re)conexión.
      const now = this.now();
      for (const [urlCode, exp] of [...this.published.entries()]) {
        if (exp <= now) {
          this.published.delete(urlCode);
          continue;
        }
        this.send({ v: 1, kind: 'ui-publish', urlCode, exp });
      }
    };
    this.ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        void this.handleRelayMessage(msg);
      } catch { /* mensaje no JSON: ignorar */ }
    };
    this.ws.onclose = () => {
      this.ws = null;
      if (!this.closed) {
        this.setStatus('disconnected');
        this.scheduleReconnect();
      }
    };
    this.ws.onerror = () => {
      try {
        this.ws?.close();
      } catch { /* noop */ }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const jitter = Math.random() * 500;
    const wait = Math.min(this.backoffMs + jitter, TUNNEL_MAX_BACKOFF_MS);
    this.backoffMs = Math.min(this.backoffMs * 2, TUNNEL_MAX_BACKOFF_MS);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  send(obj: unknown): boolean {
    try {
      if (this.ws && (this.ws as WebSocket).readyState === WebSocket.OPEN) {
        (this.ws as WebSocket).send(JSON.stringify(obj));
        return true;
      }
    } catch { /* noop */ }
    return false;
  }

  // ---- UI codes ----

  /** Publica un código de UI en el relay (lo genera otro módulo). */
  publishUiCode(urlCode: string, exp: number): void {
    this.published.set(urlCode, exp);
    this.send({ v: 1, kind: 'ui-publish', urlCode, exp });
  }

  /** Retira un código de UI del relay. */
  unpublishUiCode(urlCode: string): void {
    this.published.delete(urlCode);
    this.send({ v: 1, kind: 'ui-unpublish', urlCode });
  }

  /**
   * Marca el código como consumido para no republicarlo al reconectar, sin
   * enviar ui-unpublish: el relay debe conservarlo hasta entregar el token
   * de sesión al navegador que ya está esperando.
   */
  consumeUiCode(urlCode: string): void {
    this.published.delete(urlCode);
  }

  publishedCodes(): Array<{ urlCode: string; exp: number }> {
    return [...this.published.entries()].map(([urlCode, exp]) => ({ urlCode, exp }));
  }

  // ---- pendientes ui-request ----

  pendingCount(): number {
    this.purgeExpired();
    return this.pending.size;
  }

  getPending(): UiPendingRequest[] {
    this.purgeExpired();
    return [...this.pending.values()];
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [k, v] of [...this.pending.entries()]) {
      if (v.expiresAt <= now) this.pending.delete(k);
    }
  }

  private enqueuePending(entry: UiPendingRequest): void {
    this.purgeExpired();
    // Evicción FIFO si se supera el máximo.
    while (this.pending.size >= TUNNEL_MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
    this.pending.set(entry.reqId, entry);
  }

  /**
   * Aprueba/deniega una petición pendiente. Si el túnel está caído o la UI
   * remota está deshabilitada, la decisión es deny aunque se pida allow.
   * Al aprobar genera sessionToken (32 bytes hex) y emite ui-bind.
   */
  decideUiRequest(reqId: string, allow: boolean, exp?: number): { ok: boolean; allowed: boolean; sessionToken?: string; error?: string } {
    const entry = this.pending.get(reqId);
    if (!entry) return { ok: false, allowed: false, error: 'reqId desconocido o expirado' };
    if (entry.expiresAt <= this.now()) {
      this.pending.delete(reqId);
      return { ok: false, allowed: false, error: 'reqId expirado' };
    }
    this.pending.delete(reqId);
    const effectiveAllow = allow && this.isAvailable();
    this.send({ v: 1, kind: 'ui-decision', reqId, allow: effectiveAllow });
    if (!effectiveAllow) return { ok: true, allowed: false };
    const sessionToken = randomSessionToken();
    const bindExp = exp ?? this.now() + 24 * 3600 * 1000;
    this.bindings.set(sessionToken, { sessionToken, urlCode: entry.urlCode, exp: bindExp });
    this.send({ v: 1, kind: 'ui-bind', urlCode: entry.urlCode, sessionToken, exp: bindExp });
    return { ok: true, allowed: true, sessionToken };
  }

  /** Revoca una sesión UI (emite ui-unbind). */
  revokeUiSession(sessionToken: string): boolean {
    const existed = this.bindings.delete(sessionToken);
    this.send({ v: 1, kind: 'ui-unbind', sessionToken });
    return existed;
  }

  bindingsCount(): number {
    return this.bindings.size;
  }

  // ---- mensajes del relay ----

  private async handleRelayMessage(msg: any): Promise<void> {
    if (!msg || typeof msg.kind !== 'string') return;
    switch (msg.kind) {
      case 'ui-request':
        this.onUiRequest(msg);
        break;
      case 'http-req':
        await this.onHttpReq(msg);
        break;
      case 'ws-open':
        this.onWsOpen(msg);
        break;
      case 'ws-msg':
        this.onWsMsg(msg);
        break;
      case 'ws-close':
        this.onWsClose(msg);
        break;
      default:
        break; // otros kinds (envelope E2E, presence…): los lleva RelayClient
    }
  }

  private onUiRequest(msg: any): void {
    const reqId = String(msg.reqId ?? '');
    const urlCode = String(msg.urlCode ?? '');
    if (!reqId || !urlCode) return;
    const now = this.now();
    this.enqueuePending({
      reqId,
      urlCode,
      ua: String(msg.ua ?? ''),
      ip: String(msg.ip ?? ''),
      receivedAt: now,
      expiresAt: now + TUNNEL_PENDING_TTL_MS,
    });
    try {
      this.db.addLog?.({
        level: 'info',
        message: `[remote-tunnel] ui-request ${reqId} (${urlCode})`,
        meta: { remote: true, tunnel: true, reqId, urlCode, ua: String(msg.ua ?? ''), ip: String(msg.ip ?? '') },
        ts: now,
      });
    } catch { /* noop */ }
    try {
      this.wsManager?.broadcast?.(
        'ui-approval-requested',
        { reqId, urlCode, ua: String(msg.ua ?? ''), ip: String(msg.ip ?? ''), ts: now },
        'remote',
      );
    } catch { /* noop */ }
  }

  private httpUnavailable(id: string, status = 503): void {
    this.send({
      v: 1,
      kind: 'http-res',
      id,
      status,
      headers: { 'content-type': 'application/json' },
      bodyB64: b64encodeText(JSON.stringify({ error: 'tunnel unavailable' })),
    });
  }

  private async onHttpReq(msg: any): Promise<void> {
    const id = String(msg.id ?? '');
    if (!id) return;
    // Túnel caído o UI deshabilitada → 503 (contrato).
    if (!this.isAvailable() || !this.httpHandler) {
      this.httpUnavailable(id, 503);
      return;
    }
    const method = String(msg.method ?? 'GET').toUpperCase();
    const path = String(msg.path ?? '/');
    if (!ALLOWED_METHODS.has(method)) {
      this.send({ v: 1, kind: 'http-res', id, status: 405, headers: {}, bodyB64: b64encodeText('method not allowed') });
      return;
    }
    if (!isAllowedTunnelPath(path)) {
      this.send({ v: 1, kind: 'http-res', id, status: 403, headers: {}, bodyB64: b64encodeText('forbidden') });
      return;
    }
    // Body: 413 si supera 5MB.
    let bodyBytes: Uint8Array | null = null;
    if (typeof msg.bodyB64 === 'string' && msg.bodyB64.length > 0) {
      try {
        bodyBytes = b64decodeBytes(msg.bodyB64);
      } catch {
        this.send({ v: 1, kind: 'http-res', id, status: 400, headers: {}, bodyB64: b64encodeText('bad body') });
        return;
      }
      if (bodyBytes.byteLength > TUNNEL_MAX_BODY_BYTES) {
        this.send({ v: 1, kind: 'http-res', id, status: 413, headers: {}, bodyB64: b64encodeText('body too large') });
        return;
      }
    }
    const headers = sanitizeRequestHeaders(msg.headers as Record<string, string> | undefined);
    try {
      const init: RequestInit = { method, headers };
      if (bodyBytes && method !== 'GET' && method !== 'HEAD') {
        init.body = bodyBytes as unknown as BodyInit;
      }
      // Host local ficticio: el handler solo mira path/método/cabeceras/body.
      const localReq = new Request(`http://127.0.0.1${path}`, init);
      const res = await this.httpHandler(localReq);
      const resBuf = new Uint8Array(await res.arrayBuffer());
      this.send({
        v: 1,
        kind: 'http-res',
        id,
        status: res.status,
        headers: sanitizeResponseHeaders(res.headers),
        bodyB64: b64encodeBytes(resBuf),
      });
    } catch (e) {
      this.send({
        v: 1,
        kind: 'http-res',
        id,
        status: 500,
        headers: {},
        bodyB64: b64encodeText(e instanceof Error ? e.message : 'internal error'),
      });
    }
  }

  // ---- puente WS ----

  private ensureBroadcastPatch(): void {
    const mgr: any = this.wsManager;
    if (!mgr || typeof mgr.broadcast !== 'function') return;
    if (mgr.__tunnelPatched) return;
    const orig = mgr.broadcast.bind(mgr);
    const self = this;
    mgr.broadcast = function (event: string, payload: any, topic?: string) {
      try {
        orig(event, payload, topic);
      } catch { /* noop */ }
      // Reenvía a los puentes del túnel suscritos al topic (o sin topic: todos).
      for (const [id, b] of self.bridges) {
        try {
          if (topic && b.subs && !b.subs.has(topic)) continue;
          const text = JSON.stringify({ type: event, payload });
          if (mgr.createTunnelClient && self.bridges.has(id)) {
            // Con API nativa el broadcast ya llegó por `clients`; evita duplicar.
            continue;
          }
          self.send({ v: 1, kind: 'ws-msg', id, dataB64: b64encodeText(text), isBinary: false });
        } catch { /* noop */ }
      }
    };
    mgr.__tunnelPatched = true;
    this.patchedBroadcast = () => {
      try {
        if (mgr.__tunnelPatched) {
          mgr.broadcast = orig;
          delete mgr.__tunnelPatched;
        }
      } catch { /* noop */ }
    };
  }

  private onWsOpen(msg: any): void {
    const id = String(msg.id ?? '');
    if (!id) return;
    // Sin UI habilitada no se abren puentes (pero se responde al ciclo open/close).
    if (!this.isUiEnabled()) return;
    if (this.bridges.has(id)) this.closeBridge(id);
    const mgr: any = this.wsManager;
    if (mgr && typeof mgr.createTunnelClient === 'function') {
      try {
        mgr.createTunnelClient(id, (text: string) => {
          this.send({ v: 1, kind: 'ws-msg', id, dataB64: b64encodeText(text), isBinary: false });
        });
        this.bridges.set(id, {});
        return;
      } catch { /* cae al fallback */ }
    }
    // Fallback (managers fake sin API nativa): subs internas + patch broadcast.
    this.ensureBroadcastPatch();
    this.bridges.set(id, { subs: new Set() });
  }

  private onWsMsg(msg: any): void {
    const id = String(msg.id ?? '');
    if (!id || !this.bridges.has(id)) return;
    let text: string;
    try {
      if (typeof msg.dataB64 !== 'string') return;
      const bytes = b64decodeBytes(msg.dataB64);
      text = Buffer.from(bytes).toString('utf8');
    } catch {
      return;
    }
    const mgr: any = this.wsManager;
    if (mgr && typeof mgr.handleTunnelMessage === 'function') {
      try {
        mgr.handleTunnelMessage(id, text);
      } catch { /* noop */ }
      return;
    }
    // Fallback: gestiona subscribe/unsubscribe localmente; el resto se
    // re-emite como broadcast local best-effort.
    try {
      const parsed = JSON.parse(text) as { type?: string; payload?: any };
      const bridge = this.bridges.get(id);
      if (parsed?.type === 'subscribe' && bridge?.subs) {
        const topics = parsed?.payload?.topics;
        if (Array.isArray(topics)) for (const t of topics) if (typeof t === 'string') bridge.subs.add(t);
        this.send({ v: 1, kind: 'ws-msg', id, dataB64: b64encodeText(JSON.stringify({ type: 'subscribed', payload: { topics } })), isBinary: false });
        return;
      }
      if (parsed?.type === 'unsubscribe' && bridge?.subs) {
        const topics = parsed?.payload?.topics;
        if (Array.isArray(topics)) for (const t of topics) bridge.subs.delete(t);
        return;
      }
    } catch { /* noop */ }
  }

  private onWsClose(msg: any): void {
    const id = String(msg.id ?? '');
    if (!id) return;
    this.closeBridge(id);
  }

  private closeBridge(id: string): void {
    this.bridges.delete(id);
    try {
      (this.wsManager as any)?.removeTunnelClient?.(id);
    } catch { /* noop */ }
  }

  bridgeCount(): number {
    return this.bridges.size;
  }
}
