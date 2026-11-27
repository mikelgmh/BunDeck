/**
 * Cliente WS del relay E2E (presencia + señalización).
 *
 * Habla el protocolo del relay (`relay/src/relay.ts`):
 *
 *   → `{v:1, type:'register', from, nonce, exp, payload:{deviceId, pubKey}}`
 *   ← `{v:1, type:'registered', to, ...}`
 *   → `{v:1, type:'ping', ...}` cada 25 s · ← `{v:1, type:'pong', ...}`
 *   ↔ `{v:1, type:'signal', from, to, nonce, exp, payloadEncrypted}` opaco.
 *   ← `{v:1, type:'presence', payload:{deviceId, online}}`
 *
 * El relay SOLO reenvía sobres opacos (`payloadEncrypted` E2E de
 * `crypto.ts`) y presencia; nunca ve plaintext (TLS != E2E).
 *
 * Config: `RELAY_URL`/`RELAY_TOKEN` de env, o `remote.relay.url` /
 * `remote.relay.token` en settings. Por defecto usa el relay público
 * (`public-relay.ts`); setting `remote.relay.url` a 'off'/'none'/'disabled'
 * → `disabled` (el resto del módulo remoto —pairing local por QR, policy— sigue
 * funcionando). Reconexión exponencial 1s→30s con jitter.
 * Solo `WebSocket` global de Bun.
 */
import { DatabaseService } from '../db';
import { resolveRelayUrl, resolveRelayToken, withRelayToken, resolveDeviceToken, DEVICE_TOKEN_KEY, resolveProvisionToken } from './public-relay';
import { getRelaySigningKeys } from './identity';
import {
  RelayAuthTracker,
  ensureDeviceClaim,
  refreshDeviceClaim,
  defaultAuthDeps,
  type RelayAuthDeps,
  type RelayAuthState,
} from './relay-auth';

export type { RelayAuthState };

export type RelayStatus = 'disabled' | 'disconnected' | 'connecting' | 'connected';

/** Sobre E2E descifrable por el receptor (contenido de `payloadEncrypted`). */
export interface RelayEnvelopeMsg {
  type: 'envelope';
  to: string;
  from: string;
  nonce: string;
  ciphertext: string;
  ts: number;
  seq: number;
  v: 1;
}

type EnvelopeHandler = (env: RelayEnvelopeMsg) => void;
type StatusHandler = (status: RelayStatus) => void;

const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;
const PROTOCOL_V = 1;
const ENVELOPE_TTL_MS = 60_000;

function randomNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

type WireExtra = Record<string, unknown>;

export class RelayClient {
  private ws: WebSocket | null = null;
  private status: RelayStatus = 'disconnected';
  private backoffMs = 1000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private registered = false;
  private openedThisAttempt = false;
  private onEnvelopeCb: EnvelopeHandler | null = null;
  private onStatusCb: StatusHandler | null = null;
  private readonly auth = new RelayAuthTracker();
  private readonly authDeps: RelayAuthDeps;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(
    private db: DatabaseService,
    private opts: { deviceId: string; publicKeyB64: string },
    authDeps?: Partial<RelayAuthDeps> & { backoffBaseMs?: number; backoffMaxMs?: number },
  ) {
    const { backoffBaseMs, backoffMaxMs, ...deps } = authDeps ?? {};
    this.backoffBaseMs = backoffBaseMs ?? 1000;
    this.backoffMaxMs = backoffMaxMs ?? MAX_BACKOFF_MS;
    const d = db;
    this.authDeps = defaultAuthDeps({
      getDeviceToken: () => resolveDeviceToken(d),
      setDeviceToken: (t) => {
        try {
          if (t) d.setSetting(DEVICE_TOKEN_KEY, t);
          else d.deleteSetting(DEVICE_TOKEN_KEY);
        } catch { /* noop */ }
      },
      getProvision: () => resolveProvisionToken(),
      getDeviceId: () => this.opts.deviceId,
      getPubKeyB64: () => {
        try { return getRelaySigningKeys(d).publicKeyB64; } catch { return ''; }
      },
      getMasterToken: () => {
        try { return this.relayToken(); } catch { return ''; }
      },
      ...deps,
    });
  }

  getState(): RelayStatus { return this.status; }

  /** Estado de enlace device-token (para `GET /status`). */
  getAuthState(): RelayAuthState { return this.auth.state; }

  onAuthState(cb: (s: RelayAuthState) => void): () => void { return this.auth.onChange(cb); }

  /** ¿Hay device-token guardado (vinculado)? Nunca expone el valor. */
  isDeviceLinked(): boolean {
    try { return !!this.authDeps.getDeviceToken(); } catch { return false; }
  }

  onEnvelope(cb: EnvelopeHandler): void { this.onEnvelopeCb = cb; }
  onStatus(cb: StatusHandler): void { this.onStatusCb = cb; }

  relayUrl(): string {
    return resolveRelayUrl(this.db);
  }
  relayToken(): string {
    return resolveRelayToken(this.db);
  }

  private setStatus(s: RelayStatus): void {
    this.status = s;
    try { this.onStatusCb?.(s); } catch { /* noop */ }
  }

  start(): void {
    this.closed = false;
    this.backoffMs = this.backoffBaseMs;
    if (!this.relayUrl()) {
      this.setStatus('disabled');
      return;
    }
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
    this.reconnectTimer = null;
    this.rateRetryTimer = null;
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
    this.registered = false;
    this.setStatus(this.relayUrl() ? 'disconnected' : 'disabled');
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
    if (r.rateLimited) {
      this.auth.set('rate-limited');
      this.setStatus('disconnected');
      this.scheduleRateRetry(r.retryAfterMs);
      return;
    }
    if (!r.proceed) {
      // auth-required / unreachable: aparcado, sin hot loop.
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

  private wire(type: string, payload?: unknown, extra?: WireExtra): Record<string, unknown> {
    return {
      v: PROTOCOL_V,
      type,
      from: this.opts.deviceId,
      nonce: randomNonce(),
      exp: Date.now() + ENVELOPE_TTL_MS,
      ...(payload !== undefined ? { payload } : {}),
      ...(extra ?? {}),
    };
  }

  private connect(): void {
    if (this.closed) return;
    const base = this.relayUrl();
    if (!base) { this.setStatus('disabled'); return; }
    // Device-token primero; master legacy (`RELAY_TOKEN`) como respaldo.
    let token = '';
    try { token = this.authDeps.getDeviceToken() || this.relayToken(); } catch { token = this.relayToken(); }
    const url = withRelayToken(base, token);
    if (!url) { this.setStatus('disabled'); return; }
    this.setStatus('connecting');
    this.registered = false;
    this.openedThisAttempt = false;
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.backoffMs = this.backoffBaseMs;
      this.openedThisAttempt = true;
      this.auth.noteConnected();
      // Un open con token es prueba de vida: el enlace vale.
      if (this.auth.state !== 'ok' && this.auth.state !== 'unsupported') this.auth.set('ok');
      this.send(this.wire('register', { deviceId: this.opts.deviceId, pubKey: this.opts.publicKeyB64 }));
      this.startHeartbeat();
    };
    this.ws.onmessage = (ev: MessageEvent) => {
      try {
        this.handleServerMessage(JSON.parse(String(ev.data)));
      } catch { /* mensaje no JSON: ignorar */ }
    };
    this.ws.onclose = () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.ws = null;
      this.registered = false;
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
      try { this.ws?.close(); } catch { /* noop */ }
    };
  }

  /** Tras 3 handshakes fallidos: UN re-claim fresco y reconectar. */
  private async reclaimAndReconnect(): Promise<void> {
    if (this.closed) return;
    const url = this.relayUrl();
    if (!url) { this.setStatus('disabled'); return; }
    let r: Awaited<ReturnType<typeof refreshDeviceClaim>>;
    try {
      r = await refreshDeviceClaim(this.authDeps, url, this.auth);
    } catch {
      if (!this.closed) { this.auth.set('invalid-token'); this.setStatus('disconnected'); this.scheduleReconnect(true); }
      return;
    }
    if (this.closed) return;
    if (r.rateLimited) {
      this.setStatus('disconnected');
      this.scheduleRateRetry(r.retryAfterMs);
      return;
    }
    // Con token fresco o con `invalid-token`: reconectar (lento si inválido).
    this.connect();
  }

  private handleServerMessage(msg: any): void {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'registered':
        this.registered = true;
        this.setStatus('connected');
        break;
      case 'signal': {
        // Reenvío opaco del relay: payloadEncrypted es el sobre E2E.
        if (typeof msg.payloadEncrypted !== 'string') return;
        let env: any = null;
        try { env = JSON.parse(msg.payloadEncrypted); } catch { return; }
        if (!env || typeof env.nonce !== 'string' || typeof env.ciphertext !== 'string') return;
        try {
          this.onEnvelopeCb?.({
            type: 'envelope',
            to: typeof env.to === 'string' ? env.to : this.opts.deviceId,
            from: typeof env.from === 'string' ? env.from : String(msg.from ?? ''),
            nonce: env.nonce,
            ciphertext: env.ciphertext,
            ts: typeof env.ts === 'number' ? env.ts : 0,
            seq: typeof env.seq === 'number' ? env.seq : 0,
            v: 1,
          });
        } catch { /* el receptor valida y descarta */ }
        break;
      }
      case 'presence':
        // Presencia: se expone para paneles que la lean.
        (globalThis as any).__libredeckRelayPresence = msg;
        break;
      case 'pong':
      case 'paired':
        break; // latido / confirmaciones sin efecto local
      default:
        break; // errores del servidor y tipos futuros: ignorar sin romper
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send(this.wire('ping'));
    }, HEARTBEAT_MS);
  }

  private scheduleReconnect(slow = false): void {
    if (this.closed) return;
    const jitter = Math.random() * 500;
    let wait = Math.min(this.backoffMs + jitter, this.backoffMaxMs);
    // Token inválido: backoff lento fijo (nunca girar contra 401s).
    if (slow || this.auth.state === 'invalid-token') wait = this.backoffMaxMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
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

  sendEnvelope(to: string, envelope: Omit<RelayEnvelopeMsg, 'type' | 'to'> & { to?: string }): boolean {
    return this.send(this.wire('signal', undefined, {
      to,
      payloadEncrypted: JSON.stringify({
        to: envelope.to ?? to,
        from: this.opts.deviceId,
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
        ts: envelope.ts,
        seq: envelope.seq,
        v: 1,
      }),
    }));
  }

  /** Actualiza identidad tras `rotateKeys()` sin recrear el cliente. */
  updateIdentity(deviceId: string, publicKeyB64: string): void {
    this.opts = { deviceId, publicKeyB64 };
    if (this.status === 'connected' || this.registered) {
      this.send(this.wire('register', { deviceId, pubKey: publicKeyB64 }));
    }
  }
}
