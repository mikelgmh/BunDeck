import type { Server, ServerWebSocket } from 'bun';
import { timingSafeEqual } from 'node:crypto';
import type { DeviceStore } from './store';
import type { PairingStore } from './pairing';
import { pickLang, publicHostname, relayWsUrl, renderLanding } from './landing';
import JSQR_VENDOR_JS from './vendor/jsqr-1.4.0.js' with { type: 'text' };
import { RateLimiter } from './ratelimit';
import {
  TunnelState,
  getUiPageHandler,
  injectBase,
  HTTP_TIMEOUT_MS,
  MAX_TUNNEL_BODY_BYTES,
  type HttpResult,
  type TunnelSessionPersist,
} from './tunnel';
import { renderTunnelGonePage, renderUiGonePage, wantsHtmlPage, waitingLang, type TunnelGoneReason } from './waiting';
import {
  DISCORD_CALLBACK_PATH,
  DISCORD_RPC_TOKEN_PATH,
  discordProxyPreflight,
  handleDiscordRpcToken,
  renderDiscordCallbackPage,
} from './discord';

export { getUiPageHandler, setUiPageHandler } from './tunnel';

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 64 * 1024; // 64 KB
export const EXP_SKEW_MS = 5 * 60 * 1000; // acepta exp hasta 5 min en el pasado
export const RATE_LIMIT_PER_MIN = 60;
// Nuevos defaults diferenciados: el plano de datos /t/* necesita ráfagas de
// carga inicial (HTML + assets + API), el resto sigue estricto.
export const RATE_LIMIT_T_PER_MIN = 600;
export const RATE_LIMIT_UI_PER_MIN = 120;
export const RATE_LIMIT_WS_PER_MIN = 120;
export const RATE_LIMIT_PAIR_PER_MIN = 30;

type WsData = { ip: string; tunnelBridge?: { id: string; token: string; deviceId: string } };
type AnyWs = ServerWebSocket<WsData>;
type TunnelBridgeData = NonNullable<WsData['tunnelBridge']>;

export interface WireMessage {
  v?: unknown;
  type?: unknown;
  from?: unknown;
  to?: unknown;
  nonce?: unknown;
  exp?: unknown;
  payload?: unknown;
  payloadEncrypted?: unknown;
}

export interface RelayServerOptions {
  /** Secreto compartido. Vacío = sin auth (solo dev local). */
  token?: string;
  rateLimitPerMin?: number;
  rateLimitT?: number;
  rateLimitUi?: number;
  rateLimitWs?: number;
  rateLimitPair?: number;
  /** Cuota POST /api/discord/rpc-token por IP (def 30/min). */
  rateLimitDiscord?: number;
  /** Si true, respeta X-Forwarded-For / X-Real-IP para rate-limit (proxy confiable). */
  trustProxy?: boolean;
  store: DeviceStore;
  pairing: PairingStore;
  version?: string;
  /** Dominio público para la landing (RELAY_DOMAIN). Si vacío, se autodetecta del Host. */
  publicHost?: string;
  startedAt?: number;
  now?: () => number;
  /** Sin decisión del daemon en este tiempo, el poll pasa a `denied` (defecto 120 s). */
  uiRequestTimeoutMs?: number;
  /** Respuesta del daemon a `http-req` en este tiempo o 504 (defecto 30 s). */
  httpTimeoutMs?: number;
  /** Persistencia opcional de sesiones del túnel (SQLite: sobreviven al reinicio). */
  tunnelPersist?: TunnelSessionPersist | null;
  /** App de Discord del maintainer para el proxy OAuth (secret NUNCA expuesto). */
  discordClientId?: string;
  discordClientSecret?: string;
  /** fetch inyectable para el proxy Discord (tests). */
  discordFetchFn?: typeof fetch;
  /** Puerto API del daemon que la página del callback prueba por defecto (def 3001). */
  discordApiPort?: number;
}

function rateLimitedResponse(): Response {
  return Response.json({ error: 'rate-limited' }, { status: 429, headers: { 'retry-after': '5' } });
}

/** IP real del cliente: directa salvo trustProxy, donde se respeta el proxy. */
export function getClientIp(req: Request, server: Server<WsData>, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const real = req.headers.get('x-real-ip')?.trim();
    if (real) return real;
    const cf = req.headers.get('cf-connecting-ip')?.trim();
    if (cf) return cf;
  }
  try {
    return server.requestIP(req)?.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Extrae sessionToken de /t/<token>/... si parece token hex (32+ chars). */
export function extractTunnelToken(pathname: string): string | null {
  const m = /^\/t\/([^/]+)/.exec(pathname);
  if (!m) return null;
  const tok = m[1];
  if (/^[0-9a-fA-F]{32,}$/.test(tok)) return tok;
  return null;
}

function serverEnvelope(to: unknown, reason: string, detail?: string, now = Date.now()): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'error',
    to: to ?? null,
    nonce: `srv-${now}-${Math.floor(Math.random() * 1e6)}`,
    exp: now + 60_000,
    reason,
    ...(detail ? { detail } : {}),
  });
}

function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Extrae el token de ?token=, Authorization: Bearer o x-relay-token. */
export function extractToken(req: Request): string {
  const url = new URL(req.url);
  const q = url.searchParams.get('token');
  if (q) return q;
  const auth = req.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers.get('x-relay-token') ?? '';
}

/**
 * Relay E2E: enruta mensajes opacos por deviceId. NUNCA descifra
 * `payloadEncrypted`: lo reenvía tal cual. Sin cola: si el destino está
 * offline responde { type: 'error', reason: 'offline' }.
 */
export class RelayServer {
  private server: Server<WsData> | null = null;
  /** deviceId -> socket (solo dispositivos registrados). */
  private byDevice = new Map<string, AnyWs>();
  /** socket -> deviceId. */
  private deviceByWs = new Map<AnyWs, string>();
  private pairLimiter: RateLimiter;
  private uiLimiter: RateLimiter;
  private tLimiter: RateLimiter;
  private wsLimiter: RateLimiter;
  private discordLimiter: RateLimiter;
  private now: () => number;
  readonly startedAt: number;
  /** Núcleo del túnel inverso (estado + decisiones; el E2E sigue aparte). */
  readonly tunnel: TunnelState;
  private readonly httpTimeoutMs: number;

  constructor(private opts: RelayServerOptions) {
    const legacy = opts.rateLimitPerMin;
    const nowFn = opts.now ?? Date.now;
    this.pairLimiter = new RateLimiter(opts.rateLimitPair ?? legacy ?? RATE_LIMIT_PAIR_PER_MIN, 60_000, nowFn);
    this.uiLimiter = new RateLimiter(opts.rateLimitUi ?? legacy ?? RATE_LIMIT_UI_PER_MIN, 60_000, nowFn);
    this.tLimiter = new RateLimiter(opts.rateLimitT ?? legacy ?? RATE_LIMIT_T_PER_MIN, 60_000, nowFn);
    this.wsLimiter = new RateLimiter(opts.rateLimitWs ?? legacy ?? RATE_LIMIT_WS_PER_MIN, 60_000, nowFn);
    this.discordLimiter = new RateLimiter(opts.rateLimitDiscord ?? 30, 60_000, nowFn);
    this.now = opts.now ?? Date.now;
    this.startedAt = opts.startedAt ?? this.now();
    this.tunnel = new TunnelState({ now: this.now, uiRequestTimeoutMs: opts.uiRequestTimeoutMs, persist: opts.tunnelPersist ?? null });
    // Rehidrata sesiones vigentes persistidas (reinicio del relay sin perder
    // los `/t/<token>/` existentes). Best-effort: sin persistencia o con la
    // BD inaccesible se arranca vacío como antes.
    try {
      opts.tunnelPersist?.pruneExpired(this.now());
    } catch {
      /* noop */
    }
    try {
      const restored = this.tunnel.restorePersistedSessions();
      if (restored > 0) console.log(`[relay] restored ${restored} tunnel session(s) from storage`);
    } catch {
      /* noop */
    }
    this.httpTimeoutMs = opts.httpTimeoutMs ?? HTTP_TIMEOUT_MS;
  }

  /** Compat: expone el limiter de datos para tests antiguos. */
  get limiter(): RateLimiter {
    return this.tLimiter;
  }

  get authorized(): boolean {
    return true;
  }

  isAuthorized(req: Request): boolean {
    const token = this.opts.token?.trim() ?? '';
    if (!token) return true; // dev sin token
    const got = extractToken(req);
    return got !== '' && sameSecret(got, token);
  }

  listen(port: number, hostname = '0.0.0.0'): Server<WsData> {
    const self = this;
    this.server = Bun.serve<WsData>({
      port,
      hostname,
      fetch(req, server) {
        return self.handleFetch(req, server);
      },
      websocket: {
        open(ws) {
          // Los navegadores tuneleados NO reciben el sobre `connected`:
          // su WS es un puente crudo hacia el daemon.
          if (ws.data.tunnelBridge) {
            self.onTunnelBridgeOpen(ws, ws.data.tunnelBridge);
            return;
          }
          ws.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'connected',
              nonce: `srv-${self.now()}`,
              exp: self.now() + 60_000,
            }),
          );
        },
        message(ws, raw) {
          self.handleTunnelOrRelayMessage(ws, raw);
        },
        close(ws) {
          if (ws.data.tunnelBridge) {
            self.onTunnelBridgeClose(ws.data.tunnelBridge);
            return;
          }
          self.handleSocketClose(ws);
        },
      },
    });
    return this.server;
  }

  get port(): number {
    return this.server?.port ?? 0;
  }

  onlineCount(): number {
    return this.byDevice.size;
  }

  onlineIds(): string[] {
    return [...this.byDevice.keys()];
  }

  stop(): void {
    for (const ws of this.byDevice.values()) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
    this.tunnel.shutdown();
    this.byDevice.clear();
    this.deviceByWs.clear();
    this.server?.stop(true);
    this.server = null;
  }

  /** Limpieza periódica del túnel (la llama el intervalo de index.ts). */
  pruneTunnel(): void {
    this.tunnel.prune();
  }

  // ---- HTTP ----

  private handleFetch(req: Request, server: Server<WsData>): Response | Promise<Response> | undefined {
    const url = new URL(req.url);

    // Landing pública: GET / sin auth. OJO: si es un upgrade a WebSocket
    // (los clientes conectan a ws(s)://host/?token=…) se deja pasar al
    // flujo WS de abajo, que sí exige token.
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      const upgrade = req.headers.get('upgrade') ?? '';
      if (!upgrade.toLowerCase().includes('websocket')) {
        const version = this.opts.version ?? '0.1.0';
        const accept = req.headers.get('accept') ?? '';
        if (accept.includes('application/json')) {
          return Response.json({ service: 'libredeck-relay', version, online: this.byDevice.size });
        }
        // Evita que el Host quede vacío detrás de proxies raros.
        const html = renderLanding({
          version,
          online: this.byDevice.size,
          devices: this.opts.store.count(),
          wsUrl: relayWsUrl(req, this.opts.publicHost ?? ''),
          lang: pickLang(req),
        });
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
    }

    if (url.pathname === '/vendor/jsqr-1.4.0.js' && req.method === 'GET') {
      // Detector QR compatible (jsQR 1.4.0 UMD, MIT) para navegadores sin
      // BarcodeDetector nativo (p. ej. Safari en iPad). La landing lo carga
      // bajo demanda con <script>; cache immutable: se versiona en la URL.
      return new Response(JSQR_VENDOR_JS, {
        status: 200,
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return Response.json({
        ok: true,
        service: 'libredeck-relay',
        version: this.opts.version ?? '0.1.0',
        uptime: Math.floor((this.now() - this.startedAt) / 1000),
      });
    }

    if (url.pathname === '/stats' && req.method === 'GET') {
      // Solo conteos: sin deviceIds, pubKeys ni nada sensible.
      return Response.json({
        online: this.byDevice.size,
        devices: this.opts.store.count(),
        pairingPending: this.opts.pairing.size(),
        uptime: Math.floor((this.now() - this.startedAt) / 1000),
      });
    }

    if (url.pathname === '/pair' && req.method === 'POST') {
      if (!this.isAuthorized(req)) return new Response('unauthorized', { status: 401 });
      const ip = getClientIp(req, server, this.opts.trustProxy ?? false);
      if (!this.pairLimiter.allow(`pair:${ip}`)) {
        return rateLimitedResponse();
      }
      const entry = this.opts.pairing.create();
      return Response.json({
        code: entry.code,
        expiresIn: Math.round((entry.expiresAt - entry.createdAt) / 1000),
      });
    }

    // Discord OAuth (cero-config, público: el daemon del usuario final no
    // tiene RELAY_TOKEN). Sin auth: solo rate-limit por IP.
    // GET /api/discord/callback → página que reenvía el code al daemon local
    // (o lo muestra para copiado manual). POST /api/discord/rpc-token →
    // proxy code→token custodiando el secret en servidor.
    if (url.pathname === DISCORD_CALLBACK_PATH && req.method === 'GET') {
      return new Response(renderDiscordCallbackPage({ lang: pickLang(req), defaultApiPort: this.opts.discordApiPort ?? 3001 }), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === DISCORD_RPC_TOKEN_PATH) {
      if (req.method === 'OPTIONS') return discordProxyPreflight();
      if (req.method === 'POST') {
        const ipDiscord = getClientIp(req, server, this.opts.trustProxy ?? false);
        if (!this.discordLimiter.allow(`discord:${ipDiscord}`)) {
          return rateLimitedResponse();
        }
        return handleDiscordRpcToken(req, {
          clientId: this.opts.discordClientId,
          clientSecret: this.opts.discordClientSecret,
          fetchFn: this.opts.discordFetchFn,
        });
      }
      return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    }

    // Túnel inverso (público, sin RELAY_TOKEN: el navegador no lo tiene).
    // /ui/* por IP, /t/* por sessionToken (cuota por sesión aprobada) con
    // fallback a IP cuando aún no hay token válido.
    if (url.pathname === '/ui' || url.pathname.startsWith('/ui/')) {
      const ipUi = getClientIp(req, server, this.opts.trustProxy ?? false);
      if (!this.uiLimiter.allow(`ui:${ipUi}`)) {
        return rateLimitedResponse();
      }
      return this.handleUiFetch(req, server);
    }
    if (url.pathname === '/t' || url.pathname.startsWith('/t/')) {
      const ipT = getClientIp(req, server, this.opts.trustProxy ?? false);
      const tok = extractTunnelToken(url.pathname);
      const key = tok ? `t:tok:${tok}` : `t:${ipT}`;
      if (!this.tLimiter.allow(key)) {
        return rateLimitedResponse();
      }
      return this.handleTunnelFetch(req, server);
    }

    // Todo lo demás: WebSocket (wss en prod tras reverse proxy; local ws).
    if (!this.isAuthorized(req)) return new Response('unauthorized', { status: 401 });
    const ip = getClientIp(req, server, this.opts.trustProxy ?? false);
    const ok = server.upgrade(req, { data: { ip } });
    if (!ok) return new Response('websocket only', { status: 426 });
    return undefined;
  }

  // ---- Túnel inverso ----

  /**
   * `GET /ui/<urlCode>` → página de espera (dispara `ui-request` en la
   * primera visita). `GET /ui/<urlCode>/status` → estado del flujo.
   */
  private handleUiFetch(req: Request, server: Server<WsData>): Response | Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'GET') {
      return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    }
    const parts = url.pathname.slice('/ui'.length).split('/').filter((p) => p !== '');
    if (parts.length === 2 && parts[1] === 'status') {
      return Response.json(this.tunnel.status(parts[0]));
    }
    if (parts.length !== 1) {
      return Response.json({ error: 'not-found' }, { status: 404 });
    }
    const urlCode = parts[0];
    const ensured = this.tunnel.ensureRequest(urlCode, {
      ua: req.headers.get('user-agent') ?? '',
      ip: getClientIp(req, server, this.opts.trustProxy ?? false),
    });
    if ('error' in ensured) {
      // Navegadores: página amable ("enlace caducado o inválido") en vez
      // del JSON crudo `{"error":"unknown-code"}` que no explica nada.
      if (wantsHtmlPage(req)) {
        return new Response(renderUiGonePage(waitingLang(req)), {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      return Response.json({ error: ensured.error }, { status: 404 });
    }
    if (ensured.created) {
      const sock = this.tunnel.devices.get(ensured.deviceId);
      if (sock) {
        try {
          sock.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              kind: 'ui-request',
              reqId: ensured.reqId,
              urlCode,
              ua: ensured.ua,
              ip: ensured.ip,
            }),
          );
          this.tunnel.markSent(ensured.reqId);
        } catch {
          /* daemon caído: se reenvía al registrarse (takeUnsent) */
        }
      }
      // Sin socket del daemon: la petición queda pendiente sin enviar y se
      // entrega en cuanto el daemon se registre (takeUnsent).
    }
    const page = getUiPageHandler();
    if (!page) {
      return Response.json({ error: 'ui-page-missing' }, { status: 404 });
    }
    return page(urlCode, req);
  }

  /**
   * Todo bajo `/t/<sessionToken>/…`. El upgrade a WS del puente debe ser
   * síncrono (Bun no permite `server.upgrade()` tras un `await`), así que
   * esta parte es síncrona y solo el proxy HTTP es asíncrono.
   */
  private handleTunnelFetch(req: Request, server: Server<WsData>): Response | Promise<Response> | undefined {
    const url = new URL(req.url);
    const m = /^\/t\/([^/]+)([\s\S]*)$/.exec(url.pathname);
    if (!m) return this.tunnelGone(req, 'invalid-token', 401) ?? Response.json({ error: 'invalid-token' }, { status: 401 });
    const token = m[1];
    const rest = m[2]; // '' o '/…'
    const upgrade = (req.headers.get('upgrade') ?? '').toLowerCase();

    if (upgrade.includes('websocket')) {
      if (rest !== '/ws') return Response.json({ error: 'not-found' }, { status: 404 });
      const sess = this.tunnel.sessions.get(token);
      if (!sess) return Response.json({ error: 'invalid-token' }, { status: 401 });
      if (sess.exp !== 0 && sess.exp <= this.now()) {
        this.tunnel.expireSession(token);
        return Response.json({ error: 'expired' }, { status: 401 });
      }
      const id = this.tunnel.nextId('ws');
      const ok = server.upgrade(req, {
        data: { ip: getClientIp(req, server, this.opts.trustProxy ?? false), tunnelBridge: { id, token, deviceId: sess.deviceId } },
      });
      if (!ok) return Response.json({ error: 'upgrade-failed' }, { status: 500 });
      return undefined;
    }
    return this.handleTunnelProxy(req, token, rest === '' ? '/' : rest, url.search);
  }

  /**
   * Página amable para navegaciones a `/t/<token>/` con sesión muerta o
   * daemon caído. Sustituye al JSON crudo (`{"error":"invalid-token"}`) que
   * veía el usuario al recargar. Devuelve `null` si no es navegación de
   * página (API/XHR/assets/WS siguen recibiendo JSON).
   */
  private tunnelGone(req: Request, reason: TunnelGoneReason, status: number): Response | null {
    if (req.method !== 'GET' || !wantsHtmlPage(req)) return null;
    return new Response(renderTunnelGonePage(reason, waitingLang(req)), {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  /** Proxy HTTP tuneleado: inyecta `http-req` al daemon y espera `http-res`. */
  private async handleTunnelProxy(req: Request, token: string, rest: string, search: string): Promise<Response> {
    const sess = this.tunnel.sessions.get(token);
    if (!sess) return this.tunnelGone(req, 'invalid-token', 401) ?? Response.json({ error: 'invalid-token' }, { status: 401 });
    if (sess.exp !== 0 && sess.exp <= this.now()) {
      this.tunnel.expireSession(token);
      return this.tunnelGone(req, 'expired', 401) ?? Response.json({ error: 'expired' }, { status: 401 });
    }
    const daemon = this.tunnel.devices.get(sess.deviceId);
    if (!daemon) return this.tunnelGone(req, 'daemon-offline', 502) ?? Response.json({ error: 'daemon-offline' }, { status: 502 });

    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    let bodyB64: string | null = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_TUNNEL_BODY_BYTES) {
        return Response.json({ error: 'body-too-large' }, { status: 413 });
      }
      if (buf.byteLength > 0) bodyB64 = Buffer.from(buf).toString('base64');
    }

    const id = this.tunnel.nextId('http');
    const path = (rest === '/' ? '/' : rest) + search;
    const res: HttpResult = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.tunnel.httpPending.delete(id);
        resolve({
          status: 504,
          headers: { 'content-type': 'application/json' },
          bodyB64: Buffer.from(JSON.stringify({ error: 'daemon-timeout' }), 'utf8').toString('base64'),
        });
      }, this.httpTimeoutMs);
      timer.unref?.();
      this.tunnel.httpPending.set(id, {
        deviceId: sess.deviceId,
        token,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        timer,
      });
      try {
        daemon.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'http-req', id, method: req.method, path, headers, bodyB64 }));
      } catch {
        const e = this.tunnel.takeHttp(id);
        if (e) {
          resolve({
            status: 502,
            headers: { 'content-type': 'application/json' },
            bodyB64: Buffer.from(JSON.stringify({ error: 'daemon-offline' }), 'utf8').toString('base64'),
          });
        }
      }
    });

    const status = Number.isInteger(res.status) && res.status >= 100 && res.status <= 599 ? res.status : 502;
    const outHeaders: Record<string, string> = { ...(res.headers ?? {}) };
    let body: Uint8Array | null = res.bodyB64 ? Buffer.from(res.bodyB64, 'base64') : null;
    const ct = String(outHeaders['content-type'] ?? outHeaders['Content-Type'] ?? '');
    if (body && body.length > 0 && ct.toLowerCase().includes('text/html')) {
      const injected = injectBase(Buffer.from(body).toString('utf8'), token);
      body = Buffer.from(injected, 'utf8');
      delete outHeaders['content-length'];
      delete outHeaders['Content-Length'];
    }
    return new Response(body ? new Blob([body as unknown as BlobPart]) : null, { status, headers: outHeaders });
  }

  // ---- WS del túnel ----

  /** Entrada única WS: puentes tuneleados, `kind:*` del daemon o E2E. */
  private handleTunnelOrRelayMessage(ws: AnyWs, raw: string | Buffer): void {
    const br = ws.data.tunnelBridge;
    if (br) {
      this.onTunnelBridgeMessage(ws, br, raw);
      return;
    }
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).kind === 'string' &&
      (parsed as Record<string, unknown>).type === undefined
    ) {
      if (!this.wsLimiter.allow(`ws:${ws.data.ip}`)) {
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'error', error: 'rate-limited' }));
        return;
      }
      this.onTunnelMessage(ws, parsed as Record<string, unknown>);
      return;
    }
    this.handleSocketMessage(ws, text);
  }

  private onTunnelMessage(ws: AnyWs, msg: Record<string, unknown>): void {
    const err = (error: string, detail?: string): void => {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'error', error, ...(detail ? { detail } : {}) }));
    };
    switch (msg.kind as string) {
      case 'tunnel-register': {
        const deviceId = msg.deviceId;
        if (typeof deviceId !== 'string' || deviceId === '') {
          err('bad-register', 'deviceId required');
          return;
        }
        this.tunnel.registerDevice(ws, deviceId);
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'tunnel-registered', deviceId }));
        // Entrega peticiones creadas mientras el daemon estaba offline.
        for (const p of this.tunnel.takeUnsent(deviceId)) {
          try {
            ws.send(
              JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-request', reqId: p.reqId, urlCode: p.urlCode, ua: p.ua, ip: p.ip }),
            );
          } catch {
            /* noop */
          }
        }
        return;
      }
      case 'ui-publish': {
        const r = this.tunnel.publish(ws, msg.urlCode, msg.exp, (msg as Record<string, unknown>).lan);
        if ('error' in r) err(r.error);
        else ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-published', urlCode: msg.urlCode }));
        return;
      }
      case 'ui-decision': {
        const r = this.tunnel.decide(msg.reqId, msg.allow);
        if (r !== 'ok') err(r, typeof msg.reqId === 'string' ? msg.reqId : undefined);
        else {
          ws.send(
            JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-decision-ack', reqId: msg.reqId, allow: msg.allow }),
          );
        }
        return;
      }
      case 'ui-bind': {
        const r = this.tunnel.bind(msg.urlCode, msg.sessionToken, msg.exp, (msg as Record<string, unknown>).turn);
        if (r !== 'ok') err(r);
        else ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-bound', urlCode: msg.urlCode }));
        return;
      }
      case 'ui-rebind': {
        // Re-anuncio de una sesión vigente del daemon (tras reconectar).
        // El socket ya está autenticado (RELAY_TOKEN): el daemon afirma sus
        // propias sesiones sin necesitar el código original (consumido).
        const r = this.tunnel.rebind(this.tunnel.socketDeviceId(ws), msg.sessionToken, msg.exp);
        if (r !== 'ok') err(r);
        else ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-rebound', sessionToken: msg.sessionToken }));
        return;
      }
      case 'ui-unbind': {
        const ok = this.tunnel.unbind(msg.sessionToken);
        if (!ok) err('unknown-token');
        else ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-unbound', sessionToken: msg.sessionToken }));
        return;
      }
      case 'ui-unpublish': {
        const ok = this.tunnel.unpublish(msg.urlCode);
        if (!ok) err('unknown-code');
        else ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-unpublished', urlCode: msg.urlCode }));
        return;
      }
      case 'http-res': {
        const id = msg.id;
        if (typeof id !== 'string') return;
        const e = this.tunnel.takeHttp(id);
        if (!e) return;
        const headers: Record<string, string> = {};
        if (msg.headers && typeof msg.headers === 'object') {
          for (const [k, v] of Object.entries(msg.headers as Record<string, unknown>)) {
            if (typeof v === 'string') headers[k] = v;
          }
        }
        e.resolve({
          status: typeof msg.status === 'number' ? msg.status : 502,
          headers,
          bodyB64: typeof msg.bodyB64 === 'string' ? msg.bodyB64 : null,
        });
        return;
      }
      case 'ws-msg': {
        // Daemon → navegador (puente).
        if (typeof msg.id !== 'string' || typeof msg.dataB64 !== 'string') return;
        const bridge = this.tunnel.getBridge(msg.id);
        if (!bridge) return;
        const bytes = Buffer.from(msg.dataB64, 'base64');
        try {
          bridge.browser.send(msg.isBinary === true ? bytes : bytes.toString('utf8'));
        } catch {
          /* el puente se limpia al cerrar el socket */
        }
        return;
      }
      case 'ws-close': {
        // Extensión simétrica: el daemon también puede cerrar un puente.
        if (typeof msg.id !== 'string') return;
        const bridge = this.tunnel.removeBridge(msg.id);
        if (bridge) {
          try {
            bridge.browser.close(1000, 'closed by daemon');
          } catch {
            /* noop */
          }
        }
        return;
      }
      case 'tunnel-ping': {
        // Keepalive del daemon (~25 s): refresca el registro de vida y
        // se responde `pong` para que el daemon no considere muerto el
        // enlace. Sin esto, el LB corta el socket ocioso (micro-corte →
        // resync pesado + tormenta de hellos).
        const id = this.tunnel.socketDeviceId(ws);
        if (id) this.tunnel.noteDeviceActivity(id);
        try {
          ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'tunnel-pong', ts: this.now() }));
        } catch {
          /* daemon caído: se limpia al cerrar el socket */
        }
        return;
      }
      case 'tunnel-pong': {
        // Respuesta a un ping del relay (o eco): refresca el registro.
        const id = this.tunnel.socketDeviceId(ws);
        if (id) this.tunnel.noteDeviceActivity(id);
        return;
      }
      default:
        err('unknown-kind', String(msg.kind));
    }
  }

  private onTunnelBridgeOpen(ws: AnyWs, br: TunnelBridgeData): void {
    const sess = this.tunnel.sessions.get(br.token);
    if (!sess || (sess.exp !== 0 && sess.exp <= this.now())) {
      if (sess) this.tunnel.expireSession(br.token);
      try {
        ws.close(4401, 'expired');
      } catch {
        /* noop */
      }
      return;
    }
    const daemon = this.tunnel.devices.get(sess.deviceId);
    if (!daemon) {
      try {
        ws.close(1013, 'daemon offline');
      } catch {
        /* noop */
      }
      return;
    }
    this.tunnel.addBridge(br.id, ws, sess.deviceId, br.token);
    try {
      daemon.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ws-open', id: br.id }));
    } catch {
      this.tunnel.removeBridge(br.id);
      try {
        ws.close(1011, 'daemon unreachable');
      } catch {
        /* noop */
      }
    }
  }

  private onTunnelBridgeMessage(ws: AnyWs, br: TunnelBridgeData, raw: string | Buffer): void {
    const bridge = this.tunnel.getBridge(br.id);
    if (!bridge) return; // puente desconocido: ignora el frame
    const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
    const daemon = this.tunnel.devices.get(bridge.deviceId);
    if (!daemon) {
      this.tunnel.removeBridge(br.id);
      try {
        ws.close(1013, 'daemon offline');
      } catch {
        /* noop */
      }
      return;
    }
    try {
      daemon.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          kind: 'ws-msg',
          id: br.id,
          dataB64: bytes.toString('base64'),
          isBinary: typeof raw !== 'string',
        }),
      );
    } catch {
      /* daemon caído: se limpia al cerrar el socket */
    }
  }

  private onTunnelBridgeClose(br: TunnelBridgeData): void {
    const entry = this.tunnel.removeBridge(br.id);
    if (!entry) return;
    const daemon = this.tunnel.devices.get(entry.deviceId);
    if (daemon) {
      try {
        daemon.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ws-close', id: br.id }));
      } catch {
        /* noop */
      }
    }
  }

  // ---- WS ----

  /** Valida estructura mínima + tamaño + expiración. El nonce/counter lo valida el CLIENTE. */
  validate(raw: string): { ok: true; msg: WireMessage } | { ok: false; error: string } {
    if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
      return { ok: false, error: 'too-large' };
    }
    let msg: WireMessage;
    try {
      msg = JSON.parse(raw) as WireMessage;
    } catch {
      return { ok: false, error: 'bad-json' };
    }
    if (typeof msg !== 'object' || msg === null) return { ok: false, error: 'bad-shape' };
    if (msg.v !== PROTOCOL_VERSION) return { ok: false, error: 'bad-version' };
    if (typeof msg.type !== 'string' || msg.type === '') return { ok: false, error: 'bad-type' };
    if (typeof msg.nonce !== 'string' || msg.nonce === '') return { ok: false, error: 'missing-nonce' };
    if (typeof msg.exp !== 'number' || !Number.isFinite(msg.exp)) {
      return { ok: false, error: 'missing-exp' };
    }
    if (msg.exp < this.now() - EXP_SKEW_MS) return { ok: false, error: 'expired' };
    return { ok: true, msg };
  }

  private handleSocketMessage(ws: AnyWs, raw: string): void {
    const ip = ws.data.ip;

    if (!this.wsLimiter.allow(`ws:${ip}`)) {
      ws.send(serverEnvelope(undefined, 'rate-limited', undefined, this.now()));
      return;
    }

    const res = this.validate(raw);
    if (!res.ok) {
      ws.send(serverEnvelope(undefined, res.error, undefined, this.now()));
      return;
    }
    const msg = res.msg;
    const type = msg.type as string;

    switch (type) {
      case 'register':
        this.onRegister(ws, msg);
        break;
      case 'request-pair':
        this.onRequestPair(ws, msg);
        break;
      case 'signal':
      case 'invite':
      case 'pair-accept':
        this.onRouted(ws, msg, type);
        break;
      case 'presence': {
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'presence',
            to: (msg.from as string) ?? null,
            nonce: `srv-${this.now()}`,
            exp: this.now() + 60_000,
            payload: { online: this.onlineIds() },
          }),
        );
        break;
      }
      case 'ping':
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'pong',
            to: (msg.from as string) ?? null,
            nonce: msg.nonce,
            exp: this.now() + 60_000,
          }),
        );
        break;
      default:
        ws.send(serverEnvelope(msg.from, 'unknown-type', type, this.now()));
    }
  }

  private onRegister(ws: AnyWs, msg: WireMessage): void {
    const payload = (msg.payload ?? {}) as { deviceId?: unknown; pubKey?: unknown; name?: unknown };
    const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : '';
    const pubKey = typeof payload.pubKey === 'string' ? payload.pubKey : '';
    if (!deviceId || !pubKey) {
      ws.send(serverEnvelope(msg.from, 'bad-register', 'payload.deviceId+pubKey required', this.now()));
      return;
    }
    if (typeof msg.from === 'string' && msg.from !== '' && msg.from !== deviceId) {
      ws.send(serverEnvelope(msg.from, 'bad-register', 'from != payload.deviceId', this.now()));
      return;
    }
    // Reemplaza conexiones viejas del mismo deviceId.
    const prev = this.byDevice.get(deviceId);
    if (prev && prev !== ws) {
      try {
        prev.close();
      } catch {
        /* noop */
      }
      this.deviceByWs.delete(prev);
    }
    this.byDevice.set(deviceId, ws);
    this.deviceByWs.set(ws, deviceId);
    this.opts.store.upsert(deviceId, pubKey, typeof payload.name === 'string' ? payload.name : undefined);

    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'registered',
        to: deviceId,
        nonce: `srv-${this.now()}`,
        exp: this.now() + 60_000,
        payload: { deviceId, online: true },
      }),
    );
    this.broadcastPresence(deviceId, true);
  }

  private onRequestPair(ws: AnyWs, msg: WireMessage): void {
    const payload = (msg.payload ?? {}) as { code?: unknown };
    const code = typeof payload.code === 'string' ? payload.code : '';
    const entry = code ? this.opts.pairing.consume(code) : null;
    if (!entry) {
      ws.send(serverEnvelope(msg.from, 'invalid-code', undefined, this.now()));
      return;
    }
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'paired',
        to: (msg.from as string) ?? null,
        nonce: `srv-${this.now()}`,
        exp: this.now() + 60_000,
        payload: { paired: true },
      }),
    );
  }

  /** invite / pair-accept / signal: reenvío opaco al `to`. Sin cola: offline => error. */
  private onRouted(ws: AnyWs, msg: WireMessage, type: string): void {
    const to = typeof msg.to === 'string' ? msg.to : '';
    if (!to) {
      ws.send(serverEnvelope(msg.from, 'missing-to', undefined, this.now()));
      return;
    }
    if (type === 'signal' && typeof msg.payloadEncrypted !== 'string') {
      ws.send(serverEnvelope(msg.from, 'missing-payload', 'signal needs payloadEncrypted', this.now()));
      return;
    }
    const target = this.byDevice.get(to);
    if (!target) {
      ws.send(serverEnvelope(msg.from, 'offline', to, this.now()));
      return;
    }
    // Reenvío byte-opaco: se re-serializa el mismo objeto validado, sin inspeccionar el cifrado.
    target.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type,
        from: msg.from ?? null,
        to,
        nonce: msg.nonce,
        exp: msg.exp,
        ...(msg.payload !== undefined ? { payload: msg.payload } : {}),
        ...(msg.payloadEncrypted !== undefined ? { payloadEncrypted: msg.payloadEncrypted } : {}),
      }),
    );
  }

  private handleSocketClose(ws: AnyWs): void {
    const deviceId = this.deviceByWs.get(ws);
    if (deviceId) {
      this.deviceByWs.delete(ws);
      if (this.byDevice.get(deviceId) === ws) {
        this.byDevice.delete(deviceId);
        this.broadcastPresence(deviceId, false);
      }
    }
    // Túnel: al caer el socket se borran sus publicaciones y sesiones.
    this.tunnel.removeSocket(ws);
  }

  private broadcastPresence(deviceId: string, online: boolean): void {
    const body = JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'presence',
      nonce: `srv-${this.now()}`,
      exp: this.now() + 60_000,
      payload: { deviceId, online },
    });
    for (const ws of this.byDevice.values()) {
      try {
        ws.send(body);
      } catch {
        /* noop */
      }
    }
  }
}
