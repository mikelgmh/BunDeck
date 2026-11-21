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
import { resolveRelayUrl, resolveRelayToken, withRelayToken } from './public-relay';

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
  private closed = false;
  private registered = false;
  private onEnvelopeCb: EnvelopeHandler | null = null;
  private onStatusCb: StatusHandler | null = null;

  constructor(
    private db: DatabaseService,
    private opts: { deviceId: string; publicKeyB64: string },
  ) {}

  getState(): RelayStatus { return this.status; }

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
    if (!this.relayUrl()) {
      this.setStatus('disabled');
      return;
    }
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
    this.registered = false;
    this.setStatus(this.relayUrl() ? 'disconnected' : 'disabled');
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
    const url = withRelayToken(base, this.relayToken());
    if (!url) { this.setStatus('disabled'); return; }
    this.setStatus('connecting');
    this.registered = false;
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.backoffMs = 1000;
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
      if (!this.closed) {
        this.setStatus('disconnected');
        this.scheduleReconnect();
      }
    };
    this.ws.onerror = () => {
      try { this.ws?.close(); } catch { /* noop */ }
    };
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

  private scheduleReconnect(): void {
    if (this.closed) return;
    const jitter = Math.random() * 500;
    const wait = Math.min(this.backoffMs + jitter, MAX_BACKOFF_MS);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
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
