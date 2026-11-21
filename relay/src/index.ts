import { loadConfig } from './config';
import { DeviceStore } from './store';
import { PairingStore, PAIRING_TTL_MS } from './pairing';
import { RelayServer } from './relay';
import { setUiPageHandler } from './tunnel';
import { renderWaitingPage, waitingLang, wantsJson } from './waiting';

const config = loadConfig();

if (!config.token) {
  console.warn('[relay] RELAY_TOKEN vacío: aceptando conexiones sin auth (solo para dev local).');
}

const store = new DeviceStore(config.dataDir);
const pairing = new PairingStore(PAIRING_TTL_MS);
const relay = new RelayServer({
  token: config.token,
  store,
  pairing,
  version: config.version,
  publicHost: config.domain,
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
