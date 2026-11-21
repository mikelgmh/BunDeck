import type { Server, ServerWebSocket } from 'bun';
import { timingSafeEqual } from 'node:crypto';
import type { DeviceStore } from './store';
import type { PairingStore } from './pairing';
import { RateLimiter } from './ratelimit';

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 64 * 1024; // 64 KB
export const EXP_SKEW_MS = 5 * 60 * 1000; // acepta exp hasta 5 min en el pasado
export const RATE_LIMIT_PER_MIN = 60;

type WsData = { ip: string };
type AnyWs = ServerWebSocket<WsData>;

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
  store: DeviceStore;
  pairing: PairingStore;
  version?: string;
  startedAt?: number;
  now?: () => number;
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
  private limiter: RateLimiter;
  private now: () => number;
  readonly startedAt: number;

  constructor(private opts: RelayServerOptions) {
    this.limiter = new RateLimiter(opts.rateLimitPerMin ?? RATE_LIMIT_PER_MIN);
    this.now = opts.now ?? Date.now;
    this.startedAt = opts.startedAt ?? this.now();
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
          self.handleSocketMessage(ws, String(raw));
        },
        close(ws) {
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
    this.byDevice.clear();
    this.deviceByWs.clear();
    this.server?.stop(true);
    this.server = null;
  }

  // ---- HTTP ----

  private handleFetch(req: Request, server: Server<WsData>): Response | undefined {
    const url = new URL(req.url);

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
      const ip = server.requestIP(req)?.address ?? 'unknown';
      if (!this.limiter.allow(`pair:${ip}`)) {
        return Response.json({ error: 'rate-limited' }, { status: 429 });
      }
      const entry = this.opts.pairing.create();
      return Response.json({
        code: entry.code,
        expiresIn: Math.round((entry.expiresAt - entry.createdAt) / 1000),
      });
    }

    // Todo lo demás: WebSocket (wss en prod tras reverse proxy; local ws).
    if (!this.isAuthorized(req)) return new Response('unauthorized', { status: 401 });
    const ip = server.requestIP(req)?.address ?? 'unknown';
    const ok = server.upgrade(req, { data: { ip } });
    if (!ok) return new Response('websocket only', { status: 426 });
    return undefined;
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

    if (!this.limiter.allow(`ws:${ip}`)) {
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
    if (!deviceId) return;
    this.deviceByWs.delete(ws);
    if (this.byDevice.get(deviceId) === ws) {
      this.byDevice.delete(deviceId);
      this.broadcastPresence(deviceId, false);
    }
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
