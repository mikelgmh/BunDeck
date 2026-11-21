/**
 * Cableado del módulo remoto: identidad + relay + E2E entrante + túnel UI.
 *
 * - Crea/asegura la identidad (`getIdentity`).
 * - Inyecta persistencia de replay en `remote.seq.<peer>`.
 * - Arranca el `RelayClient`; cada `envelope` para nosotros se descifra
 *   con la privada local + la pública del peer trusted, y se ejecuta vía
 *   `executeRemoteAction` (allowlist + policy + log + broadcast `remote`).
 * - Arranca el `TunnelClient` (`tunnel.ts`): expone la web/API local a
 *   través del relay (http-req + ws bridge + ui-request con aprobación).
 *   El manejador HTTP se inyecta desde `server.ts` vía
 *   `tunnel.setHttpHandler(createDaemonFetch(...))`; sin él, los http-req
 *   responden 503.
 */
import { DatabaseService } from '../db';
import type { WebSocketManager } from '../ws';
import type { ActionRunner } from '../action-runner';
import { getIdentity } from './identity';
import { RelayClient, type RelayEnvelopeMsg } from './relay-client';
import { TunnelClient, type HttpHandler } from './tunnel';
import { decryptFrom, configureReplayStore } from './crypto';
import { getTrusted } from './pairing';
import { executeRemoteAction } from './remote-actions';

export interface RemoteModule {
  relay: RelayClient;
  tunnel: TunnelClient;
  deviceId: string;
  fingerprint: string;
  stop: () => void;
}

export function initRemote(deps: { db?: DatabaseService; wsManager?: WebSocketManager; actionRunner?: ActionRunner } = {}): RemoteModule {
  const db = deps.db ?? new DatabaseService();
  const identity = getIdentity(db);

  // Persistencia de contadores anti-replay en settings.
  configureReplayStore({
    getSeq: (peer) => {
      const v = db.getSetting(`remote.seq.${peer}`);
      const n = v === null ? -1 : Number(v);
      return Number.isFinite(n) ? n : -1;
    },
    setSeq: (peer, seq) => { try { db.setSetting(`remote.seq.${peer}`, String(seq)); } catch { /* noop */ } },
    hasNonce: (nonce) => {
      try {
        return db.getSetting(`remote.nonce.${nonce.slice(0, 16)}`) !== null;
      } catch { return false; }
    },
    addNonce: (nonce) => {
      try { db.setSetting(`remote.nonce.${nonce.slice(0, 16)}`, '1'); } catch { /* noop */ }
    },
  });

  const relay = new RelayClient(db, { deviceId: identity.deviceId, publicKeyB64: identity.publicKeyB64 });

  relay.onEnvelope(async (msg: RelayEnvelopeMsg) => {
    try {
      const peer = getTrusted(db, msg.from);
      if (!peer || peer.revoked || !peer.pubKey) {
        try { db.addLog({ level: 'info', message: `[remote] envelope de peer no emparejado: ${msg.from}`, meta: { remote: true }, ts: Date.now() }); } catch { /* noop */ }
        try { deps.wsManager?.broadcast('remote.received', { from: msg.from, ok: false, error: 'no emparejado', ts: Date.now() }, 'remote'); } catch { /* noop */ }
        return;
      }
      const cmd = decryptFrom(peer.pubKey, identity.secretKeyB64, {
        from: msg.from, to: msg.to, nonce: msg.nonce, ciphertext: msg.ciphertext, ts: msg.ts, seq: msg.seq, v: 1,
      });
      await executeRemoteAction(
        { db, actionRunner: deps.actionRunner, wsManager: deps.wsManager },
        msg.from,
        { type: String((cmd as any).type ?? ''), params: (cmd as any).params ?? (cmd as any) },
      );
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      try { db.addLog({ level: 'info', message: `[remote] envelope rechazado de ${msg.from}: ${error}`, meta: { remote: true }, ts: Date.now() }); } catch { /* noop */ }
      try { deps.wsManager?.broadcast('remote.received', { from: msg.from, ok: false, error, ts: Date.now() }, 'remote'); } catch { /* noop */ }
    }
  });

  relay.start();

  // Túnel UI: misma URL de relay, protocolo `kind:` multiplexado en su
  // propia conexión WS (ver `tunnel.ts`). Por defecto usa el relay público;
  // setting `remote.relay.url` a '' lo deja en 'disabled'.
  const tunnel = new TunnelClient(db, (deps.wsManager as any) ?? null, { deviceId: identity.deviceId });
  tunnel.start();
  return {
    relay,
    tunnel,
    deviceId: identity.deviceId,
    fingerprint: identity.fingerprint,
    stop: () => { try { relay.stop(); } catch { /* noop */ } try { tunnel.stop(); } catch { /* noop */ } },
  };
}

export { getIdentity };
export { TunnelClient, type HttpHandler } from './tunnel';
