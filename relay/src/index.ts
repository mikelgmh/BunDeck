import { loadConfig } from './config';
import { DeviceStore } from './store';
import { PairingStore, PAIRING_TTL_MS } from './pairing';
import { RelayServer } from './relay';
import { setUiPageHandler } from './tunnel';
import { renderWaitingPage, waitingLang, wantsJson } from './waiting';

const config = loadConfig();

if (!config.token) {
  console.warn('[relay] RELAY_TOKEN vacío: aceptando conexiones sin auth (solo para dev local).');
} else {
  console.log('[relay] RELAY_TOKEN configurado (len=%d).', config.token.length);
}
console.log(
  `[relay] env present: PORT=${process.env.PORT ? 'yes' : 'no'} RELAY_PORT=${process.env.RELAY_PORT ? 'yes' : 'no'} DATA_DIR=${process.env.DATA_DIR ? 'yes' : 'no'} RELAY_DOMAIN=${process.env.RELAY_DOMAIN ? 'yes' : 'no'} TRUST_PROXY=${process.env.TRUST_PROXY ?? '(unset)'}`,
);

const store = new DeviceStore(config.dataDir);
const pairing = new PairingStore(PAIRING_TTL_MS);
const relay = new RelayServer({
  token: config.token,
  rateLimitT: config.rateLimitT,
  rateLimitUi: config.rateLimitUi,
  rateLimitWs: config.rateLimitWs,
  rateLimitPair: config.rateLimitPair,
  trustProxy: config.trustProxy,
  store,
  pairing,
  version: config.version,
  publicHost: config.domain,
  // Sesiones del túnel en SQLite: sobreviven a reinicios del relay para que
  // los `/t/<token>/` existentes sigan valiendo al recargar. Best-effort:
  // si la BD falla, el relay sigue funcionando solo con memoria.
  tunnelPersist: {
    saveSession: (s) => store.saveTunnelSession(s),
    deleteSession: (token) => store.deleteTunnelSession(token),
    deleteDeviceSessions: (deviceId) => store.deleteTunnelSessionsByDevice(deviceId),
    loadSessions: () => store.listTunnelSessions(),
    pruneExpired: (now) => store.pruneTunnelSessions(now),
  },
});

const server = relay.listen(config.port, '0.0.0.0');

// Sala de espera del navegador (/ui/<code>): la sirve waiting.ts a través
// del hook que expone tunnel.ts. Sin esto, /ui/<code> devuelve 404.
setUiPageHandler((urlCode: string, req: Request) => {
  if (wantsJson(req)) return Response.json({ page: 'ui-waiting', urlCode });
  return new Response(renderWaitingPage(urlCode, waitingLang(req)), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
});
console.log(
  `[relay] listening on 0.0.0.0:${server.port}` +
    (config.domain ? ` (domain: ${config.domain})` : '') +
    ` data=${config.dataDir}`,
);

// Limpieza periódica de códigos expirados (best-effort, no bloquea).
const pruneTimer = setInterval(() => {
  pairing.prune();
  relay.pruneTunnel();
  try {
    store.pruneTunnelSessions(Date.now());
  } catch {
    /* noop */
  }
}, 60_000);
pruneTimer.unref?.();

function shutdown(): void {
  console.log('[relay] shutting down…');
  relay.stop();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
