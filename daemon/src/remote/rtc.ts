/**
 * WebRTC DataChannel para control remoto (P2P).
 *
 * El navegador crea la oferta (nativo) y el daemon responde (werift).
 * La señalización viaja por el puente WS existente (`ws-msg` con
 * `type: rtc-offer/rtc-answer/rtc-ice`), el plano de datos por un
 * único DataChannel `libredeck-rpc` que multiplexa:
 * - hello/welcome (auth con sessionToken ya aprobado)
 * - api-req/api-res (mismo handler HTTP local que http-req)
 * - sub/subbed + event (mismo wsManager que los puentes WS)
 * - ping/pong
 *
 * Si P2P falla, el frontend usa el transporte relay existente (fallback).
 */

import { createHmac } from 'node:crypto';

export interface RtcTurnCreds {
  urls: string[];
  username: string;
  credential: string;
  ttl?: number;
}

export interface RtcDataHandler {
  handleApi: (req: Request) => Promise<Response>;
  // wsManager mínimo (create/remove/handle + broadcast ya parcheado en tunnel.ts)
  wsManager: {
    createTunnelClient?: (id: string, send: (text: string) => void) => string;
    removeTunnelClient?: (id: string) => void;
    handleTunnelMessage?: (id: string, text: string) => void;
  } | null;
  db: { getSetting: (k: string) => string | null };
}

function b64encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decodeText(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** Genera credenciales TURN efímeras (RFC 5389). Null si no hay TURN_SECRET. */
export function buildTurnCreds(
  sessionToken: string,
  nowMs = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): RtcTurnCreds | null {
  const secret = (env.TURN_SECRET ?? '').trim();
  if (!secret) return null;
  const urlsRaw = (env.TURN_URLS ?? 'turn:bundeck.mikelgranero.com:3478').trim();
  const urls = urlsRaw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (urls.length === 0) return null;
  const ttl = 24 * 3600;
  const exp = Math.floor(nowMs / 1000) + ttl;
  const username = `${exp}:${sessionToken.slice(0, 16)}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { urls, username, credential, ttl };
}

type SendViaDc = (obj: unknown) => void;

interface PeerEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dc: any | null;
  bridgeId: string;
  sessionToken: string | null;
  rtcClientId: string | null;
  closed: boolean;
}

function unwrap<T>(v: T | T[]): T {
  return (Array.isArray(v) ? v[0] : v) as T;
}

export class RtcManager {
  private peers = new Map<string, PeerEntry>();
  private iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;

  constructor(private deps: RtcDataHandler) {
    const stun = (process.env.RTC_STUN_URLS ?? 'stun:stun.l.google.com:19302')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    this.iceServers = stun.length > 0 ? [{ urls: stun }] : [];
  }

  isEnabled(): boolean {
    const v = (process.env.RTC_ENABLED ?? '1').trim().toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no' && v !== 'disabled';
  }

  peerCount(): number {
    return this.peers.size;
  }

  /** El navegador envía offer por el puente WS; devolvemos answer SDP (non-trickle). */
  async handleOffer(bridgeId: string, sdpOffer: string): Promise<{ sdp: string } | { error: string }> {
    if (!this.isEnabled()) return { error: 'rtc-disabled' };
    if (typeof sdpOffer !== 'string' || sdpOffer.length < 10 || sdpOffer.length > 16384) {
      return { error: 'bad-sdp' };
    }
    try {
      const { RTCPeerConnection } = await import('werift');
      this.close(bridgeId);
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const entry: PeerEntry = { pc, dc: null, bridgeId, sessionToken: null, rtcClientId: null, closed: false };
      this.peers.set(bridgeId, entry);

      pc.onDataChannel.subscribe((dc: unknown) => {
        const ch = unwrap(dc) as PeerEntry['dc'];
        if (!ch || typeof ch !== 'object') return;
        entry.dc = ch;
        try {
          (ch.onMessage as { subscribe: (fn: (v: unknown) => void) => void }).subscribe((raw: unknown) => {
            const data = unwrap(raw) as string | Buffer;
            void this.onDcMessage(entry, typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8'));
          });
        } catch {
          /* noop */
        }
      });

      await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer } as never);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      // Non-trickle: espera a gathering completo (host + STUN).
      await this.waitGatheringComplete(pc, 8000);
      const local = pc.localDescription;
      const sdp = typeof local === 'string' ? local : (local as { sdp?: string })?.sdp ?? '';
      if (!sdp) return { error: 'no-sdp' };
      return { sdp };
    } catch (e) {
      this.close(bridgeId);
      return { error: e instanceof Error ? e.message.slice(0, 120) : 'rtc-failed' };
    }
  }

  async handleIce(bridgeId: string, candidate: unknown): Promise<void> {
    const entry = this.peers.get(bridgeId);
    if (!entry || entry.closed) return;
    try {
      if (!candidate) {
        await entry.pc.addIceCandidate(undefined as never);
        return;
      }
      await entry.pc.addIceCandidate(candidate as never);
    } catch {
      /* candidatos tardíos: ignorar */
    }
  }

  close(bridgeId: string): void {
    const entry = this.peers.get(bridgeId);
    if (!entry) return;
    this.peers.delete(bridgeId);
    entry.closed = true;
    if (entry.sessionToken) {
      try {
        (this.deps.wsManager as unknown as { broadcast?: (e: string, p: unknown, t?: string) => void })?.broadcast?.(
          // Prefijo `remote.`: el panel web solo reenvía a la UI los tipos
          // `remote.*` (ver useRemote.onRemoteEvent); sin prefijo el aviso
          // P2P nunca llegaba y todo quedaba como Relay.
          'remote.rtc-closed',
          { tokenPrefix: entry.sessionToken.slice(0, 8), bridgeId, ts: Date.now() },
          'remote',
        );
      } catch {
        /* broadcast opcional */
      }
    }
    if (entry.rtcClientId) {
      try {
        this.deps.wsManager?.removeTunnelClient?.(entry.rtcClientId);
      } catch {
        /* noop */
      }
    }
    try {
      entry.dc?.close?.();
    } catch {
      /* noop */
    }
    try {
      entry.pc?.close?.();
    } catch {
      /* noop */
    }
  }

  closeAll(): void {
    for (const id of [...this.peers.keys()]) this.close(id);
  }

  private waitGatheringComplete(pc: { iceGatheringState?: string; iceGatheringStateChange?: { subscribe: (fn: (s: unknown) => void) => void } }, timeoutMs: number): Promise<void> {
    if ((pc.iceGatheringState as string) === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      try {
        pc.iceGatheringStateChange?.subscribe((s: unknown) => {
          const st = unwrap(s) as string;
          if (st === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private sendDc(entry: PeerEntry, obj: unknown): void {
    try {
      entry.dc?.send?.(JSON.stringify(obj));
    } catch {
      /* noop */
    }
  }

  private async onDcMessage(entry: PeerEntry, text: string): Promise<void> {
    let msg: { t?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    const t = msg.t;
    if (t === 'ping') {
      this.sendDc(entry, { t: 'pong' });
      return;
    }
    if (t === 'hello') {
      const token = String(msg.sessionToken ?? '');
      if (!/^[0-9a-fA-F]{32,}$/.test(token)) {
        this.sendDc(entry, { t: 'bye', reason: 'bad-token' });
        return;
      }
      // Valida contra settings (misma que http-req usa vía validateUiSession).
      // Leemos la sesión directamente para no importar DatabaseService aquí.
      try {
        const raw = this.deps.db.getSetting(`remote.ui.session.${token}`);
        if (!raw) {
          this.sendDc(entry, { t: 'bye', reason: 'unknown' });
          return;
        }
        const s = JSON.parse(raw) as { exp?: number; revoked?: boolean };
        if (s.revoked || (typeof s.exp === 'number' && s.exp < Date.now())) {
          this.sendDc(entry, { t: 'bye', reason: 'expired' });
          return;
        }
      } catch {
        this.sendDc(entry, { t: 'bye', reason: 'unknown' });
        return;
      }
      entry.sessionToken = token;
      this.sendDc(entry, { t: 'welcome', bridgeId: entry.bridgeId });
      // Avisa al host (panel remoto): esta sesión ya habla P2P.
      // Prefijo `remote.*` (ver arriba): si no, el aviso no llega al panel.
      try {
        (this.deps.wsManager as unknown as { broadcast?: (e: string, p: unknown, t?: string) => void })?.broadcast?.(
          'remote.rtc-connected',
          { tokenPrefix: token.slice(0, 8), bridgeId: entry.bridgeId, ts: Date.now() },
          'remote',
        );
      } catch {
        /* broadcast opcional */
      }
      return;
    }
    if (!entry.sessionToken) {
      this.sendDc(entry, { t: 'bye', reason: 'hello-required' });
      return;
    }
    if (t === 'api-req') {
      await this.onDcApiReq(entry, msg);
      return;
    }
    if (t === 'sub' || t === 'unsub') {
      this.onDcSub(entry, msg);
      return;
    }
  }

  private async onDcApiReq(entry: PeerEntry, msg: { id?: unknown; method?: unknown; path?: unknown; headers?: unknown; bodyB64?: unknown }): Promise<void> {
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (!id) return;
    const method = String(msg.method ?? 'GET').toUpperCase();
    const path = String(msg.path ?? '/');
    const allowed = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
    if (!allowed.has(method)) {
      this.sendDc(entry, { t: 'api-res', id, status: 405, headers: {}, bodyB64: b64encodeText('method not allowed') });
      return;
    }
    // Reutiliza el allowlist del túnel HTTP (sin importar tunnel.ts para evitar ciclo).
    if (path.includes('..') || !path.startsWith('/')) {
      this.sendDc(entry, { t: 'api-res', id, status: 403, headers: {}, bodyB64: b64encodeText('forbidden') });
      return;
    }
    let body: Uint8Array | null = null;
    if (typeof msg.bodyB64 === 'string' && msg.bodyB64.length > 0) {
      try {
        body = new Uint8Array(Buffer.from(msg.bodyB64, 'base64'));
      } catch {
        this.sendDc(entry, { t: 'api-res', id, status: 400, headers: {}, bodyB64: b64encodeText('bad body') });
        return;
      }
      if (body.byteLength > 5 * 1024 * 1024) {
        this.sendDc(entry, { t: 'api-res', id, status: 413, headers: {}, bodyB64: b64encodeText('body too large') });
        return;
      }
    }
    const headers: Record<string, string> = {};
    if (msg.headers && typeof msg.headers === 'object') {
      for (const [k, v] of Object.entries(msg.headers as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
    try {
      const init: RequestInit = { method, headers };
      if (body && method !== 'GET' && method !== 'HEAD') init.body = body as unknown as BodyInit;
      const res = await this.deps.handleApi(new Request(`http://127.0.0.1${path}`, init));
      const buf = new Uint8Array(await res.arrayBuffer());
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      this.sendDc(entry, { t: 'api-res', id, status: res.status, headers: outHeaders, bodyB64: Buffer.from(buf).toString('base64') });
    } catch (e) {
      this.sendDc(entry, { t: 'api-res', id, status: 500, headers: {}, bodyB64: b64encodeText(e instanceof Error ? e.message : 'internal error') });
    }
  }

  private onDcSub(entry: PeerEntry, msg: { t?: string; topics?: unknown }): void {
    const mgr = this.deps.wsManager;
    if (!mgr || typeof mgr.createTunnelClient !== 'function') {
      this.sendDc(entry, { t: 'subbed', topics: [] });
      return;
    }
    if (!entry.rtcClientId) {
      const rtcId = `rtc:${entry.bridgeId}`;
      try {
        mgr.createTunnelClient(rtcId, (text: string) => {
          this.sendDc(entry, { t: 'event', data: text });
        });
        entry.rtcClientId = rtcId;
      } catch {
        /* noop */
      }
    }
    if (entry.rtcClientId && typeof mgr.handleTunnelMessage === 'function') {
      try {
        const topics = Array.isArray(msg.topics) ? (msg.topics as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        const type = msg.t === 'unsub' ? 'unsubscribe' : 'subscribe';
        mgr.handleTunnelMessage(entry.rtcClientId, JSON.stringify({ type, payload: { topics } }));
      } catch {
        /* noop */
      }
    }
    this.sendDc(entry, { t: 'subbed' });
  }
}
