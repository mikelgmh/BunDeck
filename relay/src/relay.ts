import type { Server, ServerWebSocket } from 'bun';
import { timingSafeEqual } from 'node:crypto';
import type { DeviceStore } from './store';
import type { PairingStore } from './pairing';
import { DeviceAuthStore, verifyDeviceRegisterSignature } from './device-auth';
import { pickLang, publicHostname, relayWsUrl, renderLanding } from './landing';
import JSQR_VENDOR_JS from './vendor/jsqr-1.4.0.js' with { type: 'text' };
import { RateLimiter } from './ratelimit';
import {
  TunnelState,
  getUiPageHandler,
  injectBase,
  injectBaseForPrefix,
  parseCookies,
  isValidSid,
  isValidSecret,
  TUNNEL_SESSION_COOKIE,
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
/** Tráfico de datos daemon→relay (`http-res`, `ws-msg`…): ráfagas de carga
 * inicial tras aprobar, acotadas por el limiter HTTP /t/* (600/min). */
export const RATE_LIMIT_WS_DATA_PER_MIN = 600;
export const RATE_LIMIT_PAIR_PER_MIN = 30;

/** Kinds WS daemon→relay que son tráfico de DATOS (respuestas al plano
 * HTTP/WS tuneleado). No comparten bucket con el control (`tunnel-register`,
 * `ui-*`, `tunnel-ping`): una carga inicial de dashboard supera 120 msg/min
 * y el limiter tiraba `http-res` a la basura, colgando la petición 30 s. */
const WS_DATA_KINDS = new Set(['http-res', 'ws-msg', 'ws-close', 'tunnel-pong']);

type WsData = {
  ip: string;
  tunnelBridge?: { id: string; token: string; deviceId: string };
  /** Auth del socket: master = secreto compartido (legacy), device = token por dispositivo. */
  authKind?: 'master' | 'device' | 'open';
  /** deviceId ligado al token (solo authKind device). */
  boundDeviceId?: string;
  /** sha256 del device token (para recuperar su pubKey sin guardar el token). */
  tokenHash?: string;
  /** Tras un tunnel-register fallido (firma), se ignoran los kind: hasta un register válido. */
  tunnelBlocked?: boolean;
};
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
  /** Secreto de aprovisionamiento para POST /api/device-claim. Vacío = claim deshabilitado. */
  provisionToken?: string;
  /** Cuota de claims por IP y día (def 200). */
  claimPerDay?: number;
  /** Ráfaga de claims por IP y hora (def 50). */
  claimBurstPerHour?: number;
  /** Gracia tras rotar: el token viejo sigue válido (def 5 min). */
  rotateGraceMs?: number;
  /** Directorio de datos para device-tokens.json. Null = solo memoria (tests/dev). */
  dataDir?: string | null;
  /** Store inyectable (tests). Si se da, manda sobre dataDir. */
  deviceAuth?: DeviceAuthStore | null;
  rateLimitPerMin?: number;
  rateLimitT?: number;
  rateLimitUi?: number;
  rateLimitWs?: number;
  rateLimitWsData?: number;
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
  /**
   * Ventana de gracia para tokens desconocidos tras arrancar (def 0 = off).
   * Producción la activa vía RELAY_UNKNOWN_TOKEN_GRACE_MS (def 90 s, ver
   * config.ts): un token/sid que no existe en memoria recién arrancado
   * responde 502 daemon-offline + Retry-After (el daemon aún no re-anunció
   * con ui-rebind) en vez de 401.
   */
  unknownTokenGraceMs?: number;
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

/** Extrae el sid público de /s/<sid>/... (hex 16+ chars). El secreto va en cookie, nunca aquí. */
export function extractSidToken(pathname: string): string | null {
  const m = /^\/s\/([^/]+)/.exec(pathname);
  if (!m) return null;
  const sid = m[1];
  if (isValidSid(sid)) return sid;
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
  private wsDataLimiter: RateLimiter;
  private discordLimiter: RateLimiter;
  /** Descartes por rate-limit WS (visibles en GET /stats). */
  private rateLimitedWsControl = 0;
  private rateLimitedWsData = 0;
  private now: () => number;
  readonly startedAt: number;
  /** Tokens por dispositivo (auto-provisión; JSON persistente en dataDir). */
  readonly deviceTokens: DeviceAuthStore;
  /** Cuota de POST /api/device-claim por IP. */
  private readonly claimPerDay: number;
  private readonly claimBurstPerHour: number;
  private readonly claimHits = new Map<string, number[]>();
  /** deviceId -> sockets WS autenticados con device token (para cerrar al revocar). */
  private deviceSockets = new Map<string, Set<AnyWs>>();
  readonly tunnel: TunnelState;
  private readonly httpTimeoutMs: number;
  /**
   * Ventana de gracia post-arranque para tokens desconocidos.
   * 0 = desactivada (defecto en librería/tests; producción la activa vía
   * RELAY_UNKNOWN_TOKEN_GRACE_MS con def 90 s desde config.ts).
   */
  private readonly unknownTokenGraceMs: number;

  constructor(private opts: RelayServerOptions) {
    const legacy = opts.rateLimitPerMin;
    const nowFn = opts.now ?? Date.now;
    this.pairLimiter = new RateLimiter(opts.rateLimitPair ?? legacy ?? RATE_LIMIT_PAIR_PER_MIN, 60_000, nowFn);
    this.uiLimiter = new RateLimiter(opts.rateLimitUi ?? legacy ?? RATE_LIMIT_UI_PER_MIN, 60_000, nowFn);
    this.tLimiter = new RateLimiter(opts.rateLimitT ?? legacy ?? RATE_LIMIT_T_PER_MIN, 60_000, nowFn);
    this.wsLimiter = new RateLimiter(opts.rateLimitWs ?? legacy ?? RATE_LIMIT_WS_PER_MIN, 60_000, nowFn);
    this.wsDataLimiter = new RateLimiter(opts.rateLimitWsData ?? RATE_LIMIT_WS_DATA_PER_MIN, 60_000, nowFn);
    this.discordLimiter = new RateLimiter(opts.rateLimitDiscord ?? 30, 60_000, nowFn);
    this.now = opts.now ?? Date.now;
    this.claimPerDay = opts.claimPerDay ?? 200;
    this.claimBurstPerHour = opts.claimBurstPerHour ?? 50;
    this.deviceTokens =
      opts.deviceAuth ?? new DeviceAuthStore(opts.dataDir ?? null, { now: this.now, rotateGraceMs: opts.rotateGraceMs });
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
    this.unknownTokenGraceMs = opts.unknownTokenGraceMs ?? 0;
  }

  /**
   * ¿Estamos en ventana de gracia post-arranque? Un token/sid desconocido
   * justo tras un redespliegue casi seguro es "el daemon aún no re-anunció
   * con ui-rebind" (backoff 1s→30s), no "sesión revocada". En esa ventana
   * se responde 502 daemon-offline + Retry-After (reintentable) en vez del
   * 401 definitivo que mandaría al usuario a pedir un QR nuevo.
   */
  private withinUnknownTokenGrace(): boolean {
    if (!(this.unknownTokenGraceMs > 0)) return false;
    try {
      return this.now() - this.startedAt < this.unknownTokenGraceMs;
    } catch {
      return false;
    }
  }

  /** Segundos restantes de gracia (para `Retry-After`; mín 1). */
  private graceRetryAfterSec(): number {
    try {
      const left = this.unknownTokenGraceMs - (this.now() - this.startedAt);
      return Math.max(1, Math.ceil(left / 1000));
    } catch {
      return 5;
    }
  }

  /**
   * Respuesta para token/sid desconocido: 502 daemon-offline + Retry-After
   * en ventana de gracia, 401 invalid-token pasado ese tiempo.
   * Devuelve `{ status, error }` para JSON, y el caller elige la página
   * HTML amable vía `tunnelGone()` cuando es navegación.
   */
  private unknownTokenResponse(): { status: 502 | 401; error: 'daemon-offline' | 'invalid-token'; retryAfterSec: number | null } {
    if (this.withinUnknownTokenGrace()) {
      return { status: 502, error: 'daemon-offline', retryAfterSec: this.graceRetryAfterSec() };
    }
    return { status: 401, error: 'invalid-token', retryAfterSec: null };
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
          // Registra los sockets con device token para poder cerrarlos al
          // revocar (best-effort), aunque nunca hagan E2E `register`.
          if (ws.data.authKind === 'device' && ws.data.boundDeviceId) {
            let set = self.deviceSockets.get(ws.data.boundDeviceId);
            if (!set) {
              set = new Set();
              self.deviceSockets.set(ws.data.boundDeviceId, set);
            }
            set.add(ws);
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
    this.deviceSockets.clear();
    this.server?.stop(true);
    this.server = null;
  }

  /** Limpieza periódica del túnel (la llama el intervalo de index.ts). */
  pruneTunnel(): void {
    this.tunnel.prune();
    try {
      this.deviceTokens.prune();
    } catch {
      /* noop */
    }
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
      // `storage` + `graceActive`: verificación post-redespliegue sin
      // exponer rutas ni secretos (solo modo y segundos restantes).
      const store = this.opts.store as unknown as { storageMode?: string; storageDir?: string };
      return Response.json({
        ok: true,
        service: 'libredeck-relay',
        version: this.opts.version ?? '0.1.0',
        uptime: Math.floor((this.now() - this.startedAt) / 1000),
        ...(typeof store?.storageMode === 'string' ? { storage: store.storageMode } : {}),
        graceActive: this.withinUnknownTokenGrace(),
      });
    }

    if (url.pathname === '/stats' && req.method === 'GET') {
      // Solo conteos: sin deviceIds, pubKeys ni nada sensible.
      return Response.json({
        online: this.byDevice.size,
        devices: this.opts.store.count(),
        pairingPending: this.opts.pairing.size(),
        uptime: Math.floor((this.now() - this.startedAt) / 1000),
        rateLimitedWsControl: this.rateLimitedWsControl,
        rateLimitedWsData: this.rateLimitedWsData,
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
    // /s/* es el plano nuevo split-token: sid público en URL + secreto en cookie.
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
    if (url.pathname === '/s' || url.pathname.startsWith('/s/')) {
      const ipS = getClientIp(req, server, this.opts.trustProxy ?? false);
      const sid = extractSidToken(url.pathname);
      const key = sid ? `t:sid:${sid}` : `t:${ipS}`;
      if (!this.tLimiter.allow(key)) {
        return rateLimitedResponse();
      }
      return this.handleSidFetch(req, server);
    }

    // Auth por dispositivo (auto-provisión; el master sigue valiendo para compat).
    // GET /api/caps es público (los daemons detectan relay nuevo vs viejo).
    if (url.pathname === '/api/caps' && req.method === 'GET') {
      return Response.json({ deviceAuth: true, version: this.opts.version ?? '0.1.0' });
    }
    if (url.pathname === '/api/device-claim' && req.method === 'POST') {
      return this.handleDeviceClaim(req, server);
    }
    if (url.pathname === '/api/device-revoke' && req.method === 'POST') {
      return this.handleDeviceRevoke(req, server);
    }
    if (url.pathname === '/api/device-rotate' && req.method === 'POST') {
      return this.handleDeviceRotate(req);
    }
    if (
      url.pathname === '/api/device-claim' ||
      url.pathname === '/api/device-revoke' ||
      url.pathname === '/api/device-rotate'
    ) {
      return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    }

    // Todo lo demás: WebSocket (wss en prod tras reverse proxy; local ws).
    // Sin token -> 401 auth-required; token malo/revocado -> 401 invalid-token.
    // Master válido -> socket legacy de confianza; device token válido ->
    // socket ligado a su deviceId.
    const master = this.opts.token?.trim() ?? '';
    if (!master) {
      // Dev sin RELAY_TOKEN: abierto como antes, pero si traen device token
      // se liga igual (compat + tests).
      const ipOpen = getClientIp(req, server, this.opts.trustProxy ?? false);
      const gotOpen = extractToken(req);
      if (gotOpen) {
        const v = this.deviceTokens.verify(gotOpen);
        if (v) {
          const okOpen = server.upgrade(req, {
            data: { ip: ipOpen, authKind: 'device', boundDeviceId: v.deviceId, tokenHash: v.hash } as WsData,
          });
          if (!okOpen) return new Response('websocket only', { status: 426 });
          return undefined;
        }
      }
      const ok = server.upgrade(req, { data: { ip: ipOpen, authKind: 'open' } as WsData });
      if (!ok) return new Response('websocket only', { status: 426 });
      return undefined;
    }
    const got = extractToken(req);
    if (!got) return Response.json({ error: 'auth-required' }, { status: 401 });
    if (sameSecret(got, master)) {
      const ip = getClientIp(req, server, this.opts.trustProxy ?? false);
      const ok = server.upgrade(req, { data: { ip, authKind: 'master' } as WsData });
      if (!ok) return new Response('websocket only', { status: 426 });
      return undefined;
    }
    const v = this.deviceTokens.verify(got);
    if (!v) return Response.json({ error: 'invalid-token' }, { status: 401 });
    const ipDev = getClientIp(req, server, this.opts.trustProxy ?? false);
    const okDev = server.upgrade(req, {
      data: { ip: ipDev, authKind: 'device', boundDeviceId: v.deviceId, tokenHash: v.hash } as WsData,
    });
    if (!okDev) return new Response('websocket only', { status: 426 });
    return undefined;
  }

  /** ¿El credential coincide con el master (timing-safe)? */
  private isMaster(got: string): boolean {
    const master = this.opts.token?.trim() ?? '';
    return master !== '' && got !== '' && sameSecret(got, master);
  }

  /** ¿El credential coincide con el provisionToken (timing-safe)? */
  private isProvision(got: string): boolean {
    const p = this.opts.provisionToken?.trim() ?? '';
    return p !== '' && got !== '' && sameSecret(got, p);
  }

  private checkClaimLimit(ip: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const arr = (this.claimHits.get(ip) ?? []).filter((ts) => now - ts < 24 * 60 * 60_000);
    const hour = arr.filter((ts) => now - ts < 60 * 60_000);
    if (hour.length >= this.claimBurstPerHour) {
      this.claimHits.set(ip, arr);
      return { ok: false, retryAfterMs: Math.max(1, hour[0] + 60 * 60_000 - now) };
    }
    if (arr.length >= this.claimPerDay) {
      this.claimHits.set(ip, arr);
      return { ok: false, retryAfterMs: Math.max(1, arr[0] + 24 * 60 * 60_000 - now) };
    }
    return { ok: true };
  }

  private recordClaimHit(ip: string): void {
    const now = this.now();
    const arr = (this.claimHits.get(ip) ?? []).filter((ts) => now - ts < 24 * 60 * 60_000);
    arr.push(now);
    this.claimHits.set(ip, arr);
  }

  private async readJsonBody(req: Request): Promise<Record<string, unknown>> {
    try {
      const b = (await req.json()) as unknown;
      return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** POST /api/device-claim — emite un device token (auth con provisionToken). */
  private async handleDeviceClaim(req: Request, server: Server<WsData>): Promise<Response> {
    const provision = this.opts.provisionToken?.trim() ?? '';
    if (!provision) return Response.json({ error: 'claim-disabled' }, { status: 503 });
    const ip = getClientIp(req, server, this.opts.trustProxy ?? false);
    const lim = this.checkClaimLimit(ip);
    if (!lim.ok) {
      return Response.json({ error: 'rate-limited', retryAfterMs: lim.retryAfterMs }, { status: 429 });
    }
    this.recordClaimHit(ip);
    const cred = extractToken(req);
    if (!cred) return Response.json({ error: 'provision-required' }, { status: 401 });
    if (!this.isProvision(cred)) return Response.json({ error: 'bad-provision' }, { status: 401 });
    const body = await this.readJsonBody(req);
    const deviceId = body.deviceId;
    if (typeof deviceId !== 'string' || deviceId.length < 1 || deviceId.length > 128) {
      return Response.json({ error: 'bad-device' }, { status: 400 });
    }
    const pubKey = body.pubKeyB64 ?? body.pubKey;
    if (typeof pubKey !== 'string' || pubKey === '') {
      return Response.json({ error: 'bad-pubkey' }, { status: 400 });
    }
    let raw: Buffer;
    try {
      raw = Buffer.from(pubKey, 'base64');
    } catch {
      return Response.json({ error: 'bad-pubkey' }, { status: 400 });
    }
    if (raw.length !== 32) return Response.json({ error: 'bad-pubkey' }, { status: 400 });
    const deviceToken = this.deviceTokens.issue(deviceId, pubKey);
    return Response.json({ deviceToken });
  }

  /** POST /api/device-revoke — el token se revoca a sí mismo, o el master revoca todo un deviceId. */
  private async handleDeviceRevoke(req: Request, server: Server<WsData>): Promise<Response> {
    const cred = extractToken(req);
    if (!cred) return Response.json({ error: 'auth-required' }, { status: 401 });
    if (this.isMaster(cred)) {
      const body = await this.readJsonBody(req);
      const deviceId = body.deviceId;
      if (typeof deviceId !== 'string' || deviceId.length < 1 || deviceId.length > 128) {
        return Response.json({ error: 'bad-device' }, { status: 400 });
      }
      this.deviceTokens.revokeDevice(deviceId);
      this.dropDeviceSockets(deviceId);
      return Response.json({ revoked: true });
    }
    const v = this.deviceTokens.verify(cred);
    if (!v) return Response.json({ error: 'invalid-token' }, { status: 401 });
    this.deviceTokens.revokeToken(cred);
    this.dropDeviceSockets(v.deviceId);
    return Response.json({ revoked: true });
  }

  /** POST /api/device-rotate — cambia un device token por uno nuevo (gracia al viejo). */
  private async handleDeviceRotate(req: Request): Promise<Response> {
    const cred = extractToken(req);
    if (!cred) return Response.json({ error: 'auth-required' }, { status: 401 });
    const v = this.deviceTokens.verify(cred);
    if (!v) return Response.json({ error: 'invalid-token' }, { status: 401 });
    const next = this.deviceTokens.rotate(cred);
    if (!next) return Response.json({ error: 'invalid-token' }, { status: 401 });
    return Response.json({ deviceToken: next });
  }

  /** Cierra (best-effort) los sockets E2E + túnel de un deviceId revocado. */
  private dropDeviceSockets(deviceId: string): void {
    const seen = new Set<object>();
    const targets: AnyWs[] = [];
    const e2e = this.byDevice.get(deviceId);
    if (e2e) targets.push(e2e);
    const tun = this.tunnel.devices.get(deviceId) as AnyWs | undefined;
    if (tun && !targets.includes(tun)) targets.push(tun);
    for (const ws of this.deviceSockets.get(deviceId) ?? []) {
      if (!targets.includes(ws)) targets.push(ws);
    }
    for (const ws of targets) {
      if (seen.has(ws)) continue;
      seen.add(ws);
      try {
        ws.close(4401, 'revoked');
      } catch {
        /* noop */
      }
      try {
        this.handleSocketClose(ws);
      } catch {
        /* noop */
      }
      try {
        this.tunnel.removeSocket(ws);
      } catch {
        /* noop */
      }
    }
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
    if (!m) {
      const g = this.unknownTokenResponse();
      return this.tunnelGone(req, g.error, g.status, g.retryAfterSec) ?? this.tunnelJsonError(g.error, g.status, g.retryAfterSec);
    }
    const token = m[1];
    const rest = m[2]; // '' o '/…'
    const upgrade = (req.headers.get('upgrade') ?? '').toLowerCase();

    if (upgrade.includes('websocket')) {
      if (rest !== '/ws') return Response.json({ error: 'not-found' }, { status: 404 });
      const sess = this.tunnel.sessions.get(token);
      if (!sess) {
        // Gracia post-arranque: el daemon aún no re-anunció (ui-rebind).
        // Se responde 502 + Retry-After (reintentable) en vez de 401
        // definitivo; el front distingue y auto-reintenta.
        if (this.withinUnknownTokenGrace()) {
          const ra = this.graceRetryAfterSec();
          return Response.json({ error: 'daemon-offline', retryAfter: ra }, { status: 502, headers: { 'retry-after': String(ra) } });
        }
        return Response.json({ error: 'invalid-token' }, { status: 401 });
      }
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
   * Todo bajo `/s/<sid>/…` (split-token: sid público en URL + secreto en cookie HttpOnly).
   * `GET /s/<sid>/claim?ticket=…` canjea el ticket de un solo uso por la cookie y
   * redirige (HTML con JS para preservar `location.hash`, que nunca viaja al servidor).
   */
  private handleSidFetch(req: Request, server: Server<WsData>): Response | Promise<Response> | undefined {
    const url = new URL(req.url);
    const m = /^\/s\/([^/]+)([\s\S]*)$/.exec(url.pathname);
    if (!m) {
      const g = this.unknownTokenResponse();
      return this.tunnelGone(req, g.error, g.status, g.retryAfterSec) ?? this.tunnelJsonError(g.error, g.status, g.retryAfterSec);
    }
    const sid = m[1];
    const rest = m[2]; // '' o '/…'
    if (!isValidSid(sid)) {
      const g = this.unknownTokenResponse();
      return this.tunnelGone(req, g.error, g.status, g.retryAfterSec) ?? this.tunnelJsonError(g.error, g.status, g.retryAfterSec);
    }
    const upgrade = (req.headers.get('upgrade') ?? '').toLowerCase();

    // Claim del ticket -> cookie HttpOnly.
    if (rest === '/claim' || rest.startsWith('/claim/') || rest.startsWith('/claim?') || (rest === '' && url.searchParams.has('ticket'))) {
      return this.handleSidClaim(req, sid);
    }

    const cookieSecret = parseCookies(req.headers.get('cookie')).get(TUNNEL_SESSION_COOKIE) ?? null;
    if (upgrade.includes('websocket')) {
      if (rest !== '/ws') return Response.json({ error: 'not-found' }, { status: 404 });
      if (!this.tunnel.validateSid(sid, cookieSecret)) {
        const sess = this.tunnel.sidSessions.get(sid);
        if (!sess) return Response.json({ error: 'invalid-token' }, { status: 401 });
        return Response.json({ error: 'expired' }, { status: 401 });
      }
      const sess = this.tunnel.sidSessions.get(sid);
      if (!sess) return Response.json({ error: 'invalid-token' }, { status: 401 });
      const id = this.tunnel.nextId('ws');
      const ok = server.upgrade(req, {
        data: { ip: getClientIp(req, server, this.opts.trustProxy ?? false), tunnelBridge: { id, token: sid, deviceId: sess.deviceId } },
      });
      if (!ok) return Response.json({ error: 'upgrade-failed' }, { status: 500 });
      return undefined;
    }
    return this.handleSidProxy(req, sid, rest === '' ? '/' : rest, url.search, cookieSecret);
  }

  /** Canje `ticket` (un solo uso) -> `Set-Cookie` HttpOnly + página de salto que preserva hash. */
  private handleSidClaim(req: Request, sid: string): Response {
    const url = new URL(req.url);
    const ticket = url.searchParams.get('ticket') ?? '';
    const secret = ticket ? this.tunnel.claimTicket(sid, ticket) : null;
    if (!secret || !isValidSecret(secret)) {
      return this.tunnelGone(req, 'invalid-token', 401) ?? Response.json({ error: 'invalid-token' }, { status: 401 });
    }
    const sess = this.tunnel.sidSessions.get(sid);
    const cookie = this.buildSidCookie(req, sid, secret, sess?.exp ?? 0);
    // Preserva ?kiosk=&mode= (ticket se elimina); el hash lo repone el JS (nunca llega al servidor).
    const keep = new URLSearchParams();
    for (const [k, v] of url.searchParams) {
      if (k === 'ticket') continue;
      if (k === 'kiosk' || k === 'mode') keep.set(k, v);
    }
    const qs = keep.toString();
    const target = `/s/${encodeURIComponent(sid)}/${qs ? `?${qs}` : ''}`;
    // JSON.stringify solo no basta en contexto <script>: no escapa `<`
    // (`</script>` rompería el bloque). OWASP: escapar `<`, U+2028/2029.
    const jsStr = (s: string): string =>
      JSON.stringify(s).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    if ((req.headers.get('accept') ?? '').includes('application/json') && !wantsHtmlPage(req)) {
      return new Response(JSON.stringify({ ok: true, sid }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': cookie },
      });
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>BunDeck</title></head><body><script>(function(){var t=${jsStr(target)};try{var h=location.hash||'';location.replace(t+h);}catch(e){location.href=t;}})();</script></body></html>`;
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': cookie },
    });
  }

  /** Construye `Set-Cookie` con alcance `Path=/s/<sid>/` (aísla sesiones entre sí). */
  private buildSidCookie(req: Request, sid: string, secret: string, exp: number): string {
    const parts = [`${TUNNEL_SESSION_COOKIE}=${encodeURIComponent(secret)}`, `Path=/s/${sid}/`, 'HttpOnly', 'SameSite=Lax'];
    if (exp !== 0 && Number.isFinite(exp)) {
      const maxAge = Math.max(1, Math.floor((exp - this.now()) / 1000));
      parts.push(`Max-Age=${maxAge}`);
    }
    try {
      const url = new URL(req.url);
      const proto = (req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')).toLowerCase();
      if (proto === 'https') parts.push('Secure');
    } catch {
      /* sin Secure en local */
    }
    return parts.join('; ');
  }

  /** Proxy HTTP split-token: valida cookie y reescribe con prefijo `/s/<sid>`. */
  private async handleSidProxy(req: Request, sid: string, rest: string, search: string, cookieSecret: string | null): Promise<Response> {
    const sess = this.tunnel.sidSessions.get(sid);
    if (!sess) {
      const g = this.unknownTokenResponse();
      return this.tunnelGone(req, g.error, g.status, g.retryAfterSec) ?? this.tunnelJsonError(g.error, g.status, g.retryAfterSec);
    }
    if (!this.tunnel.validateSid(sid, cookieSecret)) {
      if (sess.exp !== 0 && sess.exp <= this.now()) {
        this.tunnel.expireSidSession(sid);
        return this.tunnelGone(req, 'expired', 401) ?? Response.json({ error: 'expired' }, { status: 401 });
      }
      return this.tunnelGone(req, 'invalid-token', 401) ?? Response.json({ error: 'invalid-token' }, { status: 401 });
    }
    if (sess.exp !== 0 && sess.exp <= this.now()) {
      this.tunnel.expireSidSession(sid);
      return this.tunnelGone(req, 'expired', 401) ?? Response.json({ error: 'expired' }, { status: 401 });
    }
    const daemon = this.tunnel.devices.get(sess.deviceId);
    if (!daemon) {
      return this.tunnelGone(req, 'daemon-offline', 502, 5) ?? this.tunnelJsonError('daemon-offline', 502, 5);
    }

    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (k.toLowerCase() === 'cookie') return; // nunca reenviar la cookie de sesión al daemon
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
    const prefix = `/s/${sid}`;
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
        token: sid,
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
    // La cookie es del relay, no del daemon: no dejar que el daemon la pise.
    for (const k of Object.keys(outHeaders)) {
      if (k.toLowerCase() === 'set-cookie') delete outHeaders[k];
    }
    let body: Uint8Array | null = res.bodyB64 ? Buffer.from(res.bodyB64, 'base64') : null;
    const ct = String(outHeaders['content-type'] ?? outHeaders['Content-Type'] ?? '');
    if (body && body.length > 0 && ct.toLowerCase().includes('text/html')) {
      const injected = injectBaseForPrefix(Buffer.from(body).toString('utf8'), prefix);
      body = Buffer.from(injected, 'utf8');
      delete outHeaders['content-length'];
      delete outHeaders['Content-Length'];
    }
    return new Response(body ? new Blob([body as unknown as BlobPart]) : null, { status, headers: outHeaders });
  }

  /**
   * Página amable para navegaciones a `/t/<token>/` con sesión muerta o
   * daemon caído. Sustituye al JSON crudo (`{"error":"invalid-token"}`) que
   * veía el usuario al recargar. Devuelve `null` si no es navegación de
   * página (API/XHR/assets/WS siguen recibiendo JSON).
   * En `daemon-offline` añade `Retry-After` (el front auto-reintenta).
   */
  private tunnelGone(req: Request, reason: TunnelGoneReason, status: number, retryAfterSec?: number | null): Response | null {
    if (req.method !== 'GET' || !wantsHtmlPage(req)) return null;
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (status === 502 && retryAfterSec != null) headers['retry-after'] = String(retryAfterSec);
    return new Response(renderTunnelGonePage(reason, waitingLang(req)), { status, headers });
  }

  /** JSON de error con `Retry-After` opcional (ventana de gracia). */
  private tunnelJsonError(error: string, status: number, retryAfterSec?: number | null): Response {
    const headers: Record<string, string> = {};
    if (retryAfterSec != null) headers['retry-after'] = String(retryAfterSec);
    return Response.json({ error }, { status, headers });
  }

  /** Proxy HTTP tuneleado: inyecta `http-req` al daemon y espera `http-res`. */
  private async handleTunnelProxy(req: Request, token: string, rest: string, search: string): Promise<Response> {
    const sess = this.tunnel.sessions.get(token);
    if (!sess) {
      const g = this.unknownTokenResponse();
      return this.tunnelGone(req, g.error, g.status, g.retryAfterSec) ?? this.tunnelJsonError(g.error, g.status, g.retryAfterSec);
    }
    if (sess.exp !== 0 && sess.exp <= this.now()) {
      this.tunnel.expireSession(token);
      return this.tunnelGone(req, 'expired', 401) ?? Response.json({ error: 'expired' }, { status: 401 });
    }
    const daemon = this.tunnel.devices.get(sess.deviceId);
    if (!daemon) {
      // Sesión conocida pero daemon caído/reconectando: reintentable.
      // Retry-After corto para que el front haga poll en vez de pedir QR nuevo.
      return this.tunnelGone(req, 'daemon-offline', 502, 5) ?? this.tunnelJsonError('daemon-offline', 502, 5);
    }

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
      const kindStr = (parsed as Record<string, unknown>).kind as string;
      // Plano de DATOS (http-res, ws-msg, ws-close, tunnel-pong): bucket
      // propio de 600/min por IP. Una carga inicial supera 120 msg/min y el
      // limiter de control tiraba `http-res` a la basura, colgando la
      // petición 30 s hasta el 504. El control (register, ui-*, pings…)
      // sigue con el bucket estricto de 120/min.
      if (WS_DATA_KINDS.has(kindStr)) {
        if (!this.wsDataLimiter.allow(`ws-data:${ws.data.ip}`)) {
          this.rateLimitedWsData++;
          // Fail-fast: un `http-res` descartado NO puede quedar colgado 30 s
          // hasta el 504; se resuelve el httpPending con 429 inmediato.
          if (kindStr === 'http-res') {
            const id = (parsed as Record<string, unknown>).id;
            if (typeof id === 'string') {
              const e = this.tunnel.takeHttp(id);
              if (e) {
                try {
                  e.resolve({
                    status: 429,
                    headers: { 'content-type': 'application/json', 'retry-after': '5' },
                    bodyB64: Buffer.from(JSON.stringify({ error: 'rate-limited' }), 'utf8').toString('base64'),
                  });
                } catch {
                  /* noop */
                }
              }
            }
          }
          ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'error', error: 'rate-limited' }));
          return;
        }
        this.onTunnelMessage(ws, parsed as Record<string, unknown>);
        return;
      }
      if (!this.wsLimiter.allow(`ws:${ws.data.ip}`)) {
        this.rateLimitedWsControl++;
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
    // Tras un tunnel-register fallido con firma, se ignoran los kind:
    // hasta que llegue un register válido (anti-fuerza bruta).
    if (ws.data.tunnelBlocked === true && msg.kind !== 'tunnel-register') return;
    switch (msg.kind as string) {
      case 'tunnel-register': {
        const deviceId = msg.deviceId;
        if (typeof deviceId !== 'string' || deviceId === '') {
          err('bad-register', 'deviceId required');
          return;
        }
        const authKind = ws.data.authKind ?? 'open';
        if (authKind === 'device') {
          const bound = ws.data.boundDeviceId ?? '';
          const entry = ws.data.tokenHash ? this.deviceTokens.getByHash(ws.data.tokenHash) : null;
          const fail = (detail: string): void => {
            ws.data.tunnelBlocked = true;
            err('bad-register', detail);
          };
          if (!entry) {
            fail('invalid-token');
            return;
          }
          if (deviceId !== bound) {
            fail('device-mismatch');
            return;
          }
          const ok = verifyDeviceRegisterSignature({
            deviceId,
            ts: msg.ts,
            sigHex: msg.sig,
            pubKeyB64: entry.pubKeyB64,
            now: this.now(),
          });
          if (!ok) {
            fail(typeof msg.ts === 'number' ? 'bad-signature' : 'ts required');
            return;
          }
          ws.data.tunnelBlocked = false;
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
        // Nuevo flujo split-token: {urlCode, sid, secret} + legacy {sessionToken} para compat.
        // Se enlazan AMBOS (el status devuelve sid+ticket y, una vez, sessionToken legacy).
        // LAN post-aprobación: `msg.lan` (con `code`) va SOLO al bind legacy
        // (fuente única; el binding sid nunca guarda lan). Sin lan: compat intacta.
        const m = msg as Record<string, unknown>;
        if (typeof m.sid === 'string' && (typeof m.secret === 'string' || typeof m.sessionToken === 'string')) {
          const secret = typeof m.secret === 'string' ? m.secret : m.sessionToken;
          const rSid = this.tunnel.bindSid(msg.urlCode, m.sid, secret, msg.exp, (msg as Record<string, unknown>).turn);
          if (rSid !== 'ok') { err(rSid); return; }
          // Legacy opcional (mismo urlCode, token distinto): no borra el sid (bind no toca sidBindings).
          // Se exige token distinto de sid y secreto para no crear /t/<sid>/ con el sid público.
          if (typeof m.sessionToken === 'string' && m.sessionToken !== secret && m.sessionToken !== m.sid) {
            const rLeg = this.tunnel.bind(msg.urlCode, m.sessionToken, msg.exp, (msg as Record<string, unknown>).turn, (msg as Record<string, unknown>).lan);
            if (rLeg !== 'ok') { err(rLeg); return; }
          }
          ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-bound', urlCode: msg.urlCode, sid: m.sid }));
          return;
        }
        const r = this.tunnel.bind(msg.urlCode, msg.sessionToken, msg.exp, (msg as Record<string, unknown>).turn, (msg as Record<string, unknown>).lan);
        if (r !== 'ok') err(r);
        else ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-bound', urlCode: msg.urlCode }));
        return;
      }
      case 'ui-rebind': {
        // Re-anuncio de una sesión vigente del daemon (tras reconectar).
        // El socket ya está autenticado (RELAY_TOKEN): el daemon afirma sus
        // propias sesiones sin necesitar el código original (consumido).
        // Nuevo: {sid, secret?, exp} + legacy {sessionToken, exp} opcional. Se reanuncian ambos.
        const m = msg as Record<string, unknown>;
        if (typeof m.sid === 'string') {
          const r = this.tunnel.rebindSid(this.tunnel.socketDeviceId(ws), m.sid, m.secret ?? m.sessionToken, m.exp);
          if (r !== 'ok') { err(r); return; }
          // Legacy opcional: solo si es un token distinto del sid y del secreto
          // (evita crear /t/<sid>/ con el sid público).
          if (typeof m.sessionToken === 'string' && m.sessionToken !== m.secret && m.sessionToken !== m.sid && /^[0-9a-fA-F]{32,}$/.test(m.sessionToken)) {
            const rLeg = this.tunnel.rebind(this.tunnel.socketDeviceId(ws), m.sessionToken, m.exp);
            if (rLeg !== 'ok') { err(rLeg); return; }
          }
          ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-rebound', sid: m.sid }));
          return;
        }
        const r = this.tunnel.rebind(this.tunnel.socketDeviceId(ws), msg.sessionToken, msg.exp);
        if (r !== 'ok') err(r);
        else ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-rebound', sessionToken: msg.sessionToken }));
        return;
      }
      case 'ui-unbind': {
        const m = msg as Record<string, unknown>;
        if (typeof m.sid === 'string') {
          const ok = this.tunnel.unbindSid(m.sid);
          if (!ok) err('unknown-token');
          else ws.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ui-unbound', sid: m.sid }));
          return;
        }
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
    // El puente puede colgar de una sesión legacy (`/t/<token>/`, mapa
    // `sessions`) o split-token (`/s/<sid>/`, mapa `sidSessions`): el token
    // del bridge es sessionToken o sid según la ruta del upgrade. Solo mirar
    // `sessions` cerraba los puentes `/s/` con 4401 aunque la cookie fuese válida.
    const legacy = this.tunnel.sessions.get(br.token);
    const sess = legacy ?? this.tunnel.sidSessions.get(br.token);
    if (!sess || (sess.exp !== 0 && sess.exp <= this.now())) {
      if (sess) {
        // Caducada de verdad: 4401 definitivo (pedir QR nuevo).
        if (legacy) this.tunnel.expireSession(br.token);
        else this.tunnel.expireSidSession(br.token);
        try {
          ws.close(4401, 'expired');
        } catch {
          /* noop */
        }
        return;
      }
      // Desconocida en ventana de gracia: el daemon aún no re-anunció
      // (ui-rebind). 1013 = reintentable; pasada la gracia, 4401 definitivo.
      try {
        ws.close(this.withinUnknownTokenGrace() ? 1013 : 4401, this.withinUnknownTokenGrace() ? 'daemon offline, retry' : 'invalid token');
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
      this.rateLimitedWsControl++;
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
    if (ws.data.authKind === 'device' && ws.data.boundDeviceId) {
      const set = this.deviceSockets.get(ws.data.boundDeviceId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.deviceSockets.delete(ws.data.boundDeviceId);
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
