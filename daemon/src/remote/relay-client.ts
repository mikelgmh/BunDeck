/**
 * Cliente WS del relay de presencia/señalización.
 *
 * El relay SOLO reenvía sobres opacos (`envelope` E2E) y presencia; nunca
 * ve plaintext (ver `crypto.ts`: TLS != E2E). Protocolo mínimo:
 *
 *   → `{type:'register', deviceId, pubKey, token}` (token = RELAY_TOKEN)
 *   ← `{type:'registered', ok:true}`
 *   → `{type:'ping'}` cada 25 s · ← `{type:'pong'}`
 *   ← `{type:'presence', devices:[{deviceId, online}]}` (difundir por WS)
 *   ↔ `{type:'envelope', to, from, nonce, ciphertext, ts, seq, v}` opaco.
 *
 * Config: `RELAY_URL`/`RELAY_TOKEN` de env, o `remote.relay.url` /
 * `remote.relay.token` en settings. Sin URL → `disabled` (el resto del
 * módulo remoto —pairing local por QR, policy— sigue funcionando).
 * Reconexión exponencial 1s→30s con jitter. Solo `WebSocket` global de Bun.
 */
import { DatabaseService } from '../db';

export type RelayStatus = 'disabled' | 'disconnected' | 'connecting' | 'connected';

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

export class RelayClient {
  private ws: WebSocket | null = null;
  private status: RelayStatus = 'disconnected';
  private backoffMs = 1000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
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
    return process.env.RELAY_URL ?? this.db.getSetting('remote.relay.url') ?? '';
  }
  relayToken(): string {
    return process.env.RELAY_TOKEN ?? this.db.getSetting('remote.relay.token') ?? '';
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
    this.setStatus(this.relayUrl() ? 'disconnected' : 'disabled');
  }

  private connect(): void {
    if (this.closed) return;
    const url = this.relayUrl();
    if (!url) { this.setStatus('disabled'); return; }
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
      this.send({ type: 'register', deviceId: this.opts.deviceId, pubKey: this.opts.publicKeyB64, token: this.relayToken() });
      this.startHeartbeat();
    };
    this.ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg?.type === 'envelope' && msg?.to === this.opts.deviceId) {
          this.onEnvelopeCb?.(msg as RelayEnvelopeMsg);
        } else if (msg?.type === 'presence') {
          // Presencia: se re-emite por el WS local (topic `remote` lo hace
          // el suscriptor en index.ts vía wsManager).
          (globalThis as any).__libredeckRelayPresence = msg;
        }
      } catch { /* mensaje no JSON: ignorar */ }
    };
    this.ws.onclose = () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.ws = null;
      if (!this.closed) {
        this.setStatus('disconnected');
        this.scheduleReconnect();
      }
    };
    this.ws.onerror = () => {
      try { this.ws?.close(); } catch { /* noop */ }
    };
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping', deviceId: this.opts.deviceId, ts: Date.now() });
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
    return this.send({ type: 'envelope', to, ...envelope });
  }

  /** Actualiza identidad tras `rotateKeys()` sin recrear el cliente. */
  updateIdentity(deviceId: string, publicKeyB64: string): void {
    this.opts = { deviceId, publicKeyB64 };
    if (this.status === 'connected') {
      this.send({ type: 'register', deviceId, pubKey: publicKeyB64, token: this.relayToken() });
    }
  }
}
