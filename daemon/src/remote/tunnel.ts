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
 * - Daemon → relay: `{kind:'ui-publish', urlCode, exp, lan?}`,
 *   `{kind:'ui-unpublish', urlCode}`, `{kind:'ui-decision', reqId, allow}`,
 *   `{kind:'ui-bind', urlCode, sessionToken, exp}`,
 *   `{kind:'ui-unbind', sessionToken}`.
 *   `lan?` del `ui-publish` (fast-path LAN, backward-compatible: el relay
 *   viejo lo ignora): SOLO hints de alcanzabilidad
 *   `{ips, port, apiPort, fp, dev}` SIN `code`. El `code` (invite LAN de
 *   128 bits) se genera al APROBAR y viaja en el `ui-bind` (`lan?` con
 *   `{code, ips, port, apiPort, fp}`), que el relay entrega una vez en
 *   `status.approved.lan`. Sin `lan` en origen si el host no tiene IPs LAN.
 *
 * Si el túnel está caído o la UI remota está deshabilitada
 * (`remote.ui.enabled`, default false): las decisiones son deny y los
 * http-req se responden 503.
 *
 * Reconexión exponencial 1s→30s con jitter: re-registra tunnel + republica
 * códigos vigentes.
 */

import { resolveRelayUrl, resolveRelayToken, withRelayToken, DEVICE_TOKEN_KEY, resolveProvisionToken } from './public-relay';
import { getRelaySigningKeys, signTunnelRegister } from './identity';
import {
  RelayAuthTracker,
  ensureDeviceClaim,
  refreshDeviceClaim,
  defaultAuthDeps,
  type RelayAuthDeps,
  type RelayAuthState,
} from './relay-auth';
import { RtcManager, buildTurnCreds } from './rtc';
import { UI_CODE_KEY, UI_SESSION_PREFIX, UI_UNBIND_PENDING_PREFIX } from './ui-policy';
import type { UiFastPathLan } from './ui-policy';
import { buildUiFastPathLan, readUiFastPathLan } from './ui-policy';

/** Objeto `lan` del `ui-publish` extendido (re-export del contrato). */
export type UiPublishLan = UiFastPathLan;

/**
 * Objeto `lan` tal como viaja en el wire del `ui-publish`: SOLO hints de
 * alcanzabilidad (sin `code`). El invite LAN (128 bits) ya NO viaja
 * pre-aprobación (fix de seguridad: era visible en el HTML público de la
 * waiting y permitía entrar por LAN sin aprobación). El `code` se genera
 * al APROBAR y viaja en el `ui-bind` (una sola vez, como el sessionToken).
 */
export type UiPublishLanWire = Omit<UiFastPathLan, 'code'>;

/** Quita el `code` del `lan` interno antes de enviarlo al relay. */
export function toPublishLan(lan: UiFastPathLan): UiPublishLanWire {
  const { code: _code, ...hints } = lan;
  void _code;
  return hints;
}

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
  /** Nuevo flujo split-token: sid público + secreto (cookie HttpOnly). */
  sid?: string;
  secret?: string;
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
  /** Opcional: si existe, el túnel re-anuncia sesiones/códigos persistidos al reconectar. */
  getAllSettings?: () => Record<string, string>;
  setSetting?: (key: string, value: string) => void;
  deleteSetting?: (key: string) => void;
  addLog?: (entry: { level: string; message: string; meta?: any; ts: number }) => void;
}

export const TUNNEL_PENDING_TTL_MS = 120_000;
export const TUNNEL_MAX_PENDING = 20;
export const TUNNEL_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const TUNNEL_MAX_BACKOFF_MS = 30_000;
/**
 * Keepalive del WS daemon↔relay (~25 s): el LB/proxy intermedio corta los
 * sockets ociosos y cada micro-corte disparaba `resyncUiState` pesado +
 * tormenta de hellos. El ping sale del daemon; el relay responde `pong`.
 * El `pong` (o un `ping` entrante) refresca `lastPongAt`: prueba de vida
 * que impide que el barrido periódico considere muerto el registro.
 */
export const TUNNEL_KEEPALIVE_MS = 25_000;

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

function randomSid(): string {
  // 16 bytes hex (128 bits): público en URL, no es el secreto.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('node:crypto');
  return randomBytes(16).toString('hex');
}

export interface TunnelClientOpts {
  deviceId: string;
  /** URL override (tests). Si no, `RELAY_URL` env, `remote.relay.url` o relay público por defecto. */
  relayUrl?: string;
  now?: () => number;
  /**
   * Periodo del keepalive daemon→relay (defecto 25 s). `0` lo desactiva.
   * Inyectable para tests (intervalo corto + `send` stub = sin red real).
   */
  keepaliveMs?: number;
  /** Backoff de reconexión (tests): base y máximo en ms. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

/**
 * Mensaje `tunnel-register`:
 * - Sockets con device-token (relay con `deviceAuth`): `{v, kind, deviceId,
 *   ts, sig}` con `sig` = hex detached-ed25519 sobre
 *   UTF-8(`${deviceId}|${ts}`) y `ts` fresco (ventana ±5 min en el relay).
 * - Sockets legacy (master-token o relay viejo): `{v, kind, deviceId}`.
 */
export function buildTunnelRegister(
  db: { getSetting: (k: string) => string | null; setSetting?: (k: string, v: string) => void },
  deviceId: string,
  opts?: { signed?: boolean; now?: number },
): Record<string, unknown> {
  const base: Record<string, unknown> = { v: 1, kind: 'tunnel-register', deviceId };
  if (!opts?.signed) return base;
  const ts = Math.floor(typeof opts?.now === 'number' ? opts.now : Date.now());
  try {
    const { sig } = signTunnelRegister(db as any, deviceId, ts);
    return { ...base, ts, sig };
  } catch {
    return base;
  }
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
  private published = new Map<string, { exp: number; lan?: UiPublishLan }>(); // urlCode -> {exp, lan?}
  private bindings = new Map<string, UiBinding>(); // sessionToken -> binding
  /** Puentes WS activos: relayId -> { localClientId?, fallbackSubs? } */
  private bridges = new Map<string, { subs?: Set<string> }>();
  private patchedBroadcast: (() => void) | null = null;

  private httpHandler: HttpHandler | null = null;
  private now: () => number;
  private rtc: RtcManager | null = null;
  /** Periodo del keepalive (inyectable para tests). */
  private readonly keepaliveMs: number;
  /** Último ping emitido / último pong (o ping entrante) visto. */
  private lastPingAt = 0;
  private lastPongAt = 0;
  /** Auth device-token (mismas reglas que `relay-client.ts`). */
  private readonly auth = new RelayAuthTracker();
  private readonly authDeps: RelayAuthDeps;
  /** ¿El relay exige device-auth? (`null` = caps ilegibles → legacy.) */
  private deviceAuthRequired: boolean | null = null;
  private openedThisAttempt = false;
  private rateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  constructor(
    private db: DbLike,
    private wsManager: TunnelWsHost | null,
    private opts: TunnelClientOpts,
    authDeps?: Partial<RelayAuthDeps>,
  ) {
    this.now = opts.now ?? Date.now;
    this.keepaliveMs = opts.keepaliveMs ?? TUNNEL_KEEPALIVE_MS;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? TUNNEL_MAX_BACKOFF_MS;
    const d = db;
    this.authDeps = defaultAuthDeps({
      getDeviceToken: () => {
        try { return (d.getSetting(DEVICE_TOKEN_KEY) ?? '') as string; } catch { return ''; }
      },
      setDeviceToken: (t) => {
        try {
          if (t) d.setSetting?.(DEVICE_TOKEN_KEY, t);
          else d.deleteSetting?.(DEVICE_TOKEN_KEY);
        } catch { /* noop */ }
      },
      getProvision: () => resolveProvisionToken(),
      getDeviceId: () => this.opts.deviceId,
      getPubKeyB64: () => {
        try { return getRelaySigningKeys(d as any).publicKeyB64; } catch { return ''; }
      },
      getMasterToken: () => {
        try { return resolveRelayToken(d as any); } catch { return ''; }
      },
      ...authDeps,
    });
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

  /** Estado de enlace device-token (para `GET /status`). */
  getAuthState(): RelayAuthState { return this.auth.state; }

  onAuthState(cb: (s: RelayAuthState) => void): () => void { return this.auth.onChange(cb); }

  /** ¿Hay device-token guardado (vinculado)? Nunca expone el valor. */
  isDeviceLinked(): boolean {
    try { return !!this.authDeps.getDeviceToken(); } catch { return false; }
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
    // Un stop/start manual (p. ej. cambio de URL) reabre el episodio:
    // el claim único vuelve a intentarse.
    this.auth.initialClaimDone = false;
    this.auth.rateRetryUsed = false;
    this.auth.resetFailures();
    void this.bootstrap();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.rateRetryTimer) clearTimeout(this.rateRetryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.reconnectTimer = null;
    this.rateRetryTimer = null;
    this.heartbeatTimer = null;
    this.sweepTimer = null;
    try {
      this.rtc?.closeAll();
    } catch {
      /* noop */
    }
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

  /**
   * Puerta de arranque: caps → claim único si el relay exige device-auth.
   * Sin provisión / claim deshabilitado → aparcado (`auth-required`, sin
   * hot loop). 429 → UN reintento tras `retryAfterMs`.
   */
  private async bootstrap(isRetry = false): Promise<void> {
    if (this.closed) return;
    const url = this.relayUrl();
    if (!url) { this.setStatus('disabled'); return; }
    let r: Awaited<ReturnType<typeof ensureDeviceClaim>>;
    try {
      r = await ensureDeviceClaim(this.authDeps, url, this.auth, { isRetry });
    } catch {
      if (!this.closed) { this.setStatus('disconnected'); this.scheduleReconnect(); }
      return;
    }
    if (this.closed) return;
    this.deviceAuthRequired = r.deviceAuth;
    if (r.rateLimited) {
      this.auth.set('rate-limited');
      this.setStatus('disconnected');
      this.scheduleRateRetry(r.retryAfterMs);
      return;
    }
    if (!r.proceed) {
      this.setStatus('disconnected');
      return;
    }
    this.connect();
  }

  /** UN reintento del claim tras 429; después se aparca (backoff, sin girar). */
  private scheduleRateRetry(retryAfterMs?: number): void {
    if (this.closed || this.auth.rateRetryUsed) return;
    this.auth.rateRetryUsed = true;
    const wait = Math.min(Math.max(retryAfterMs ?? 60_000, 1000), 5 * 60_000);
    if (this.rateRetryTimer) clearTimeout(this.rateRetryTimer);
    this.rateRetryTimer = setTimeout(() => {
      this.rateRetryTimer = null;
      if (!this.closed) void this.bootstrap(true);
    }, wait);
  }

  private connect(): void {
    if (this.closed) return;
    const base = this.relayUrl();
    if (!base) {
      this.setStatus('disabled');
      return;
    }
    // Device-token primero; master legacy (`RELAY_TOKEN`) como respaldo.
    let token = '';
    try { token = this.authDeps.getDeviceToken() || this.relayToken(); } catch { token = this.relayToken(); }
    const url = withRelayToken(base, token);
    this.setStatus('connecting');
    this.openedThisAttempt = false;
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.backoffMs = this.reconnectBaseMs;
      this.openedThisAttempt = true;
      this.auth.noteConnected();
      if (this.auth.state !== 'ok' && this.auth.state !== 'unsupported') this.auth.set('ok');
      this.setStatus('connected');
      // Firmado SOLO con device-token en relay con deviceAuth; en sockets
      // master/open se envía el legacy (el relay lo ignora en master).
      let hasDeviceToken = false;
      try { hasDeviceToken = !!this.authDeps.getDeviceToken(); } catch { hasDeviceToken = false; }
      this.send(buildTunnelRegister(this.db as any, this.opts.deviceId, {
        signed: this.deviceAuthRequired === true && hasDeviceToken,
        now: this.now(),
      }));
      // Keepalive: sin tráfico periódico el LB/proxy corta el socket
      // ocioso (micro-corte → resync pesado + tormenta de hellos).
      this.startHeartbeat();
      // Republicar códigos vigentes tras cada (re)conexión: SOLO hints
      // de alcanzabilidad (SIN `code`: el invite LAN ya no viaja
      // pre-aprobación; se genera al aprobar y va en el `ui-bind`).
      const now = this.now();
      for (const [urlCode, entry] of [...this.published.entries()]) {
        if (entry.exp <= now) {
          this.published.delete(urlCode);
          continue;
        }
        this.send({
          v: 1,
          kind: 'ui-publish',
          urlCode,
          exp: entry.exp,
          ...(entry.lan ? { lan: toPublishLan(entry.lan) } : {}),
        });
      }
      // Re-anunciar el estado UI persistido (códigos + sesiones de settings):
      // sin esto, reiniciar el daemon invalidaba todos los `/t/<token>/`
      // aunque a la sesión le quedaran horas (el relay las borra al caer el
      // socket). Con el re-`bind`, el enlace viejo sigue valiendo.
      try {
        this.resyncUiState();
      } catch { /* best-effort: lo nuevo se aprueba igual */ }
    };
    this.ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        void this.handleRelayMessage(msg);
      } catch { /* mensaje no JSON: ignorar */ }
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      const opened = this.openedThisAttempt;
      this.openedThisAttempt = false;
      if (this.closed) return;
      if (opened) {
        this.auth.noteClosedAfterOpen();
        this.setStatus('disconnected');
        this.scheduleReconnect();
        return;
      }
      // Handshake fallido (401 auth-required/invalid-token, red caída…).
      let stored = '';
      try { stored = this.authDeps.getDeviceToken(); } catch { stored = ''; }
      const decision = this.auth.noteHandshakeFailure(!!stored);
      if (decision === 'reclaim') {
        this.setStatus('disconnected');
        void this.reclaimAndReconnect();
        return;
      }
      if (decision === 'invalid') this.auth.set('invalid-token');
      else if (decision === 'none' && !stored) {
        // Bare (sin device ni master): el fallo resuelve a `unreachable`.
        let master = '';
        try { master = this.authDeps.getMasterToken(); } catch { master = ''; }
        if (!master) this.auth.set('unreachable');
      }
      this.setStatus('disconnected');
      this.scheduleReconnect(decision === 'invalid');
    };
    this.ws.onerror = () => {
      try {
        this.ws?.close();
      } catch { /* noop */ }
    };
  }

  /** Tras 3 handshakes fallidos: UN re-claim fresco y reconectar. */
  private async reclaimAndReconnect(): Promise<void> {
    if (this.closed) return;
    const url = this.relayUrl();
    if (!url) { this.setStatus('disabled'); return; }
    try {
      const r = await refreshDeviceClaim(this.authDeps, url, this.auth);
      if (this.closed) return;
      if (r.rateLimited) {
        this.setStatus('disconnected');
        this.scheduleRateRetry(r.retryAfterMs);
        return;
      }
    } catch {
      if (!this.closed) { this.auth.set('invalid-token'); this.setStatus('disconnected'); this.scheduleReconnect(true); }
      return;
    }
    if (!this.closed) this.connect();
  }

  private scheduleReconnect(slow = false): void {
    if (this.closed) return;
    const jitter = Math.random() * 500;
    let wait = Math.min(this.backoffMs + jitter, this.reconnectMaxMs);
    // Token inválido: backoff lento fijo (nunca girar contra 401s).
    if (slow || this.auth.state === 'invalid-token') wait = this.reconnectMaxMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.reconnectMaxMs);
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

  // ---- keepalive daemon↔relay (~25 s) ----

  /** Último `pong` (o `ping` entrante) visto del relay. */
  lastPongSeenAt(): number {
    return this.lastPongAt;
  }

  /** Último `ping` emitido al relay. */
  lastPingSentAt(): number {
    return this.lastPingAt;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.keepaliveMs <= 0) return;
    this.heartbeatTimer = setInterval(() => this.sendPing(), this.keepaliveMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** Un ping al relay; el `pong` refresca el registro (ver `lastPongAt`). */
  sendPing(): boolean {
    this.lastPingAt = this.now();
    return this.send({ v: 1, kind: 'tunnel-ping', ts: this.lastPingAt });
  }

  // ---- UI codes ----

  /**
   * Publica un código de UI en el relay (lo genera otro módulo).
   * `lan?` = fast-path LAN pareado (backward-compatible: el relay viejo lo
   * ignora). En memoria se conserva el `lan` COMPLETO (con `code`: es DB
   * local); al wire (`ui-publish`) solo salen hints SIN `code` (el invite
   * se genera/entrega al aprobar, en el `ui-bind`). Se republica igual
   * (hints) tras cada reconexión.
   */
  publishUiCode(urlCode: string, exp: number, lan?: UiPublishLan): void {
    this.published.set(urlCode, lan ? { exp, lan } : { exp });
    this.send({ v: 1, kind: 'ui-publish', urlCode, exp, ...(lan ? { lan: toPublishLan(lan) } : {}) });
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

  publishedCodes(): Array<{ urlCode: string; exp: number; lan?: UiPublishLan }> {
    return [...this.published.entries()].map(([urlCode, entry]) => (
      entry.lan ? { urlCode, exp: entry.exp, lan: entry.lan } : { urlCode, exp: entry.exp }
    ));
  }

  /**
   * Re-anuncia al relay el estado UI persistido en settings tras cada
   * (re)conexión:
   * - Código vigente (`remote.ui.code`): se republica si no está ya en
   *   memoria (p. ej. tras reiniciar el daemon). Solo hints SIN `code`.
   * - Sesiones vigentes (`remote.ui.session.*`): se re-emiten como
   *   `ui-rebind` (restaura sin necesitar el código original, ya consumido).
   *   Las revocadas pero aún no caducadas se re-emiten como `ui-unbind`
   *   (cubre revocar con el relay caído y reconectar después).
   * Sin esto, cualquier reinicio del daemon (o micro-corte) dejaba todos los
   * `/t/<token>/` en `401 invalid-token` hasta generar un QR nuevo.
   * NOTA degradación aceptada: el `lan` con `code` del approve es one-shot
   * del `ui-bind` y NO se re-emite aquí ni en `ui-rebind`; si el relay
   * reinicia se pierde y el teléfono cae a `/t/` o `/s/`.
   */
  /**
   * Lee solo las settings bajo un prefijo (`getSettingsByPrefix` acotado
   * por índice; fallback al volcado completo filtrado en DBs viejas/tests).
   * El resync anterior hacía 2× `getAllSettings()` (volcado entero de la
   * tabla en cada micro-corte); ahora son 2 lecturas acotadas por índice.
   */
  private readPrefixedSettings(prefix: string): Record<string, string> {
    try {
      const anyDb = this.db as DbLike & { getSettingsByPrefix?: (p: string) => Record<string, string> };
      if (typeof anyDb.getSettingsByPrefix === 'function') return anyDb.getSettingsByPrefix(prefix);
      const all = typeof this.db.getAllSettings === 'function' ? this.db.getAllSettings() : {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith(prefix)) out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  resyncUiState(): { republishedCode: boolean; rebound: number; unbound: number } {
    const out = { republishedCode: false, rebound: 0, unbound: 0 };
    const now = this.now();
    // 1) Código vigente persistido.
    try {
      const raw = this.db.getSetting(UI_CODE_KEY);
      if (raw) {
        const code = JSON.parse(raw) as { urlCode?: unknown; exp?: unknown; expiresAt?: unknown };
        const urlCode = typeof code?.urlCode === 'string' ? code.urlCode : '';
        // `remote.ui.code` guarda `expiresAt` (las sesiones usan `exp`).
        const exp = typeof code?.expiresAt === 'number' ? code.expiresAt
          : typeof code?.exp === 'number' ? code.exp : 0;
        if (urlCode && Number.isFinite(exp) && exp > now && !this.published.has(urlCode)) {
          // Fast-path LAN pareado (solo snapshot: resync no debe rotar el
          // QR LAN; si no hay invite vigente o no hay IPs, se omite `lan`).
          // Al wire solo salen hints SIN `code` (el invite se entrega al
          // aprobar, en el `ui-bind` one-shot). En memoria se conserva el
          // `lan` completo para republicar los hints tras reconexiones.
          let lan: UiPublishLan | undefined;
          try {
            lan = readUiFastPathLan(this.db as any) as UiPublishLan | undefined;
          } catch { lan = undefined; }
          this.published.set(urlCode, lan ? { exp, lan } : { exp });
          this.send({ v: 1, kind: 'ui-publish', urlCode, exp, ...(lan ? { lan: toPublishLan(lan) } : {}) });
          out.republishedCode = true;
        }
      }
    } catch { /* sin código persistido: nada que republicar */ }
    // 2) Sesiones persistidas (lectura acotada al prefijo, no volcado total).
    const sessions = this.readPrefixedSettings(UI_SESSION_PREFIX);
    for (const [k, v] of Object.entries(sessions)) {
      const token = k.slice(UI_SESSION_PREFIX.length);
      if (!/^[0-9a-fA-F]{16,}$/.test(token)) continue;
      let s: { exp?: unknown; revoked?: unknown; secret?: unknown; sid?: unknown };
      try {
        s = JSON.parse(v) as { exp?: unknown; revoked?: unknown };
      } catch {
        continue;
      }
      const exp = typeof s?.exp === 'number' ? s.exp : 0;
      if (exp !== 0 && (!Number.isFinite(exp) || exp <= now)) continue;
      if (s?.revoked === true) {
        // Revocada en local pero quizá el relay no se enteró (caído al
        // revocar): reintento best-effort, el relay ignora lo desconocido.
        this.bindings.delete(token);
        this.bindings.delete(`sid:${token}`);
        this.send({ v: 1, kind: 'ui-unbind', sessionToken: token });
        this.send({ v: 1, kind: 'ui-unbind', sid: token, sessionToken: token });
        out.unbound += 1;
        continue;
      }
      const secret = typeof s?.secret === 'string' && /^[0-9a-fA-F]{32,}$/.test(s.secret) ? s.secret : null;
      if (secret) {
        // Sesión split-token: re-anuncia SOLO sid+secret (sin sessionToken legacy).
        // Enviar sessionToken=sid crearía un /t/<sid>/ con el sid público (agujero).
        this.bindings.set(token, { sessionToken: token, urlCode: '', exp, sid: token, secret });
        this.send({ v: 1, kind: 'ui-rebind', sid: token, secret, exp });
        out.rebound += 1;
        continue;
      }
      this.bindings.set(token, { sessionToken: token, urlCode: '', exp });
      this.send({ v: 1, kind: 'ui-rebind', sessionToken: token, exp });
      out.rebound += 1;
    }
    // 3) Tombstones de revocación: re-emite ui-unbind aunque la fila de
    // sesión ya no exista (revocar con el relay caído). Idempotente.
    // (lectura acotada al prefijo, no segundo volcado total).
    const tombstones = this.readPrefixedSettings(UI_UNBIND_PENDING_PREFIX);
    for (const [k, v] of Object.entries(tombstones)) {
      const token = k.slice(UI_UNBIND_PENDING_PREFIX.length);
      if (!/^[0-9a-fA-F]{16,}$/.test(token)) continue;
      const exp = Number(v);
      if (exp === 0) {
        // Tombstone perenne: la sesión revocada no caducaba; el unbind
        // se re-emite en cada reconexión (el relay ignora lo desconocido).
        this.bindings.delete(token);
        this.send({ v: 1, kind: 'ui-unbind', sessionToken: token });
        out.unbound += 1;
        continue;
      }
      if (!Number.isFinite(exp) || exp <= now) {
        try { this.db.deleteSetting?.(k); } catch { /* noop */ }
        continue;
      }
      this.bindings.delete(token);
      this.send({ v: 1, kind: 'ui-unbind', sessionToken: token });
      out.unbound += 1;
    }
    return out;
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
   * Al aprobar genera sessionToken legacy (32 bytes hex) + sid (16 bytes) +
   * secreto (32 bytes) y emite ui-bind con ambos (compat: relays viejos usan
   * sessionToken, relays nuevos prefieren sid+secret y nunca exponen el
   * secreto en la URL).
   * Además genera el invite LAN (`buildUiFastPathLan`: reutiliza el vigente
   * con >60 s de vida o crea uno fresco) y lo incluye en el `ui-bind`
   * (`lan: {code, ips, port, apiPort, fp}`), UNA sola vez como el
   * sessionToken: es el único momento en que el `code` viaja al relay
   * (pre-aprobación solo salen hints SIN code). Sin `lan` si el host no
   * tiene IPs LAN o falla la identidad pública.
   * Incluye credenciales TURN efímeras si TURN_SECRET está configurado
   * (para WebRTC P2P; el relay las entrega en el primer poll approved).
   */
  decideUiRequest(reqId: string, allow: boolean, exp?: number): { ok: boolean; allowed: boolean; sessionToken?: string; sid?: string; secret?: string; lan?: UiFastPathLan; error?: string } {
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
    const sid = randomSid();
    const secret = randomSessionToken();
    const bindExp = exp ?? this.now() + 24 * 3600 * 1000;
    this.bindings.set(sessionToken, { sessionToken, urlCode: entry.urlCode, exp: bindExp, sid, secret });
    this.bindings.set(`sid:${sid}`, { sessionToken, urlCode: entry.urlCode, exp: bindExp, sid, secret });
    const turn = buildTurnCreds(sessionToken);
    // Invite LAN post-aprobación (best-effort: sin IPs no hay `lan`).
    let lan: UiFastPathLan | undefined;
    try {
      lan = buildUiFastPathLan(this.db as any);
    } catch { lan = undefined; }
    this.send({
      v: 1,
      kind: 'ui-bind',
      urlCode: entry.urlCode,
      sessionToken,
      sid,
      secret,
      exp: bindExp,
      ...(turn ? { turn } : {}),
      ...(lan ? { lan } : {}),
    });
    return { ok: true, allowed: true, sessionToken, sid, secret, ...(lan ? { lan } : {}) };
  }

   /** Revoca una sesión UI (emite ui-unbind legacy + sid). Acepta token legacy o sid. */
  revokeUiSession(sessionToken: string): boolean {
    const key = String(sessionToken ?? '');
    let existed = false;
    const byToken = this.bindings.get(key);
    if (byToken) {
      existed = true;
      this.bindings.delete(key);
      if (byToken.sid) this.bindings.delete(`sid:${byToken.sid}`);
      this.send({ v: 1, kind: 'ui-unbind', sessionToken: byToken.sessionToken });
      if (byToken.sid) this.send({ v: 1, kind: 'ui-unbind', sid: byToken.sid, sessionToken: byToken.sid });
    }
    // Búsqueda por sid (el panel revoca por prefijo: puede ser sid o legacy).
    for (const [k, b] of [...this.bindings]) {
      if (b.sid === key || b.sessionToken === key) {
        existed = true;
        this.bindings.delete(k);
        if (b.sid) {
          this.bindings.delete(`sid:${b.sid}`);
          this.send({ v: 1, kind: 'ui-unbind', sid: b.sid, sessionToken: b.sid });
        }
        this.send({ v: 1, kind: 'ui-unbind', sessionToken: b.sessionToken });
      }
    }
    // Tombstone durable: si el relay está caído el envío se pierde, pero
      // resyncUiState lo re-emite al reconectar (ver UI_UNBIND_PENDING_PREFIX).
      // Solo si la sesión existe en settings (evita tombstones huérfanos de
      // tokens efímeros de tests que nunca se persistieron).
    try {
      const anyDb = this.db as unknown as { setSetting?: (k: string, v: string) => void; getSetting?: (k: string) => string | null };
      if (typeof anyDb?.setSetting === 'function') {
        let exp: number | null = null;
        try {
          const raw = anyDb.getSetting?.(`remote.ui.session.${sessionToken}`);
          if (!raw) throw new Error('sin sesión persistida');
          exp = Number((JSON.parse(raw) as { exp?: unknown })?.exp ?? NaN);
        } catch { exp = null; }
        if (exp !== null && Number.isFinite(exp) && (exp === 0 || exp > this.now())) {
          try { anyDb.setSetting(`remote.ui.unbind-pending.${sessionToken}`, String(exp)); } catch { /* noop */ }
        }
      }
    } catch { /* noop */ }
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
      case 'tunnel-ping':
        // El relay también puede pingeear: cualquier actividad prueba vida
        // y se responde para que su sweep no purgue el registro.
        this.lastPongAt = this.now();
        this.send({ v: 1, kind: 'tunnel-pong', ts: this.now() });
        break;
      case 'tunnel-pong':
        // Respuesta a nuestro keepalive: refresca el registro de vida.
        this.lastPongAt = this.now();
        break;
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
      case 'error': {
        // El relay descarta por rate-limit con `{kind:'error',
        // error:'rate-limited'}`. Antes se ignoraba en `default:break` y el
        // único síntoma era una petición colgada hasta el 504. Warning
        // visible: consola + log + broadcast para la UI.
        const errCode = String((msg as { error?: unknown }).error ?? '');
        if (errCode === 'rate-limited') {
          const detail = `relay rate-limited: el relay descartó tráfico de este daemon (rate-limit WS)`;
          try {
            console.warn(`[remote-tunnel] ${detail}`);
          } catch { /* noop */ }
          try {
            this.db.addLog?.({ level: 'warn', message: `[remote-tunnel] ${detail}`, meta: { remote: true, tunnel: true }, ts: this.now() });
          } catch { /* noop */ }
          try {
            this.wsManager?.broadcast?.('tunnel-rate-limited', { ts: this.now() }, 'remote');
          } catch { /* noop */ }
        }
        break;
      }
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

  private rtcManager(): RtcManager | null {
    try {
      if ((process.env.RTC_ENABLED ?? '1').trim().toLowerCase() === '0') return null;
    } catch {
      /* noop */
    }
    if (!this.rtc) {
      if (!this.httpHandler) return null;
      this.rtc = new RtcManager({
        handleApi: (req) => this.httpHandler!(req),
        wsManager: this.wsManager,
        db: this.db,
      });
    } else {
      // Refresca deps vivas (httpHandler/wsManager pueden inyectarse tarde).
      try {
        (this.rtc as unknown as { deps: unknown }).deps = {
          handleApi: (req: Request) => this.httpHandler!(req),
          wsManager: this.wsManager,
          db: this.db,
        };
      } catch {
        /* noop */
      }
    }
    return this.rtc;
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
    // Señalización WebRTC por el mismo puente (no pasa al wsManager).
    try {
      const probe = JSON.parse(text) as { type?: unknown; payload?: unknown };
      if (probe?.type === 'rtc-offer' || probe?.type === 'rtc-ice') {
        void this.onRtcSignal(id, probe as { type: string; payload?: Record<string, unknown> });
        return;
      }
      if (probe?.type === 'rtc-ping') {
        this.send({ v: 1, kind: 'ws-msg', id, dataB64: b64encodeText(JSON.stringify({ type: 'rtc-pong' })), isBinary: false });
        return;
      }
    } catch {
      /* no JSON: sigue al wsManager */
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

  private async onRtcSignal(id: string, parsed: { type: string; payload?: Record<string, unknown> }): Promise<void> {
    const mgr = this.rtcManager();
    if (!mgr) return;
    if (parsed.type === 'rtc-offer') {
      const sdp = typeof parsed.payload?.sdp === 'string' ? (parsed.payload.sdp as string) : '';
      const res = await mgr.handleOffer(id, sdp);
      if ('sdp' in res) {
        this.send({ v: 1, kind: 'ws-msg', id, dataB64: b64encodeText(JSON.stringify({ type: 'rtc-answer', payload: { sdp: res.sdp } })), isBinary: false });
      } else {
        this.send({ v: 1, kind: 'ws-msg', id, dataB64: b64encodeText(JSON.stringify({ type: 'rtc-answer', payload: { error: res.error } })), isBinary: false });
      }
      return;
    }
    if (parsed.type === 'rtc-ice') {
      await mgr.handleIce(id, parsed.payload?.candidate);
      return;
    }
  }

  private onWsClose(msg: any): void {
    const id = String(msg.id ?? '');
    if (!id) return;
    this.closeBridge(id);
  }

  private closeBridge(id: string): void {
    this.bridges.delete(id);
    try {
      this.rtc?.close(id);
    } catch {
      /* noop */
    }
    try {
      (this.wsManager as any)?.removeTunnelClient?.(id);
    } catch { /* noop */ }
  }

  bridgeCount(): number {
    return this.bridges.size;
  }

  /**
   * Cierra los peers RTC (P2P directo) de una sesión revocada. Sin esto, un
   * DataChannel ya establecido seguía operando tras revocar: la validación
   * solo ocurría en el `hello` inicial, no en `api-req`/`sub` posteriores.
   */
  closeRtcForToken(sessionToken: string): number {
    try {
      return this.rtc?.closeBySessionToken?.(String(sessionToken ?? '')) ?? 0;
    } catch {
      return 0;
    }
  }
}
