/**
 * remote-ui-dist.test.ts — La UI servida a través del túnel del relay es el
 * build ACTUAL de `web/dist`, no un resto obsoleto.
 *
 * Regresión de un bug real: el relay sirve `web/dist` compilado y si ese
 * build está obsoleto el móvil ve código viejo (p. ej. anterior a nov-2026)
 * aunque `web/src` ya tenga los cambios.
 *
 * Flujo (reutiliza el harness de `remote-ui-loop.test.ts` + inyección del
 * `httpHandler` real como en `remote-tunnel.test.ts`):
 *
 *   daemon (TunnelClient real + createDaemonFetch real) ↔ relay (RelayServer
 *   real) → publishUiCode → GET /ui/<code> → getPending() →
 *   decideUiRequest(true) → poll /ui/<code>/status → sessionToken →
 *   GET /t/<token>/ (HTML reescrito por el relay) → extrae los
 *   `/_astro/*.js` referenciados → descarga cada uno POR EL TÚNEL siguiendo
 *   los imports entre chunks (como el navegador) → la unión de los bundles
 *   servidos contiene los marcadores del código actual.
 *
 * Marcadores: literales que SOLO existen en el código web actual (un dist
 * anterior a nov-2026 no los tiene) y que sobreviven a la minificación (NO
 * se usan nombres de función: se manglan):
 * - 'bd-preset-dlg-add' (data-cy del diálogo de presets, en el chunk de la app)
 * - 'variable.set' (tipo de mensaje WS web→daemon, en un chunk importado)
 * OJO: por el code-splitting de Vite cada marcador vive en un chunk
 * DISTINTO (el HTML solo referencia los entries), así que se descargan los
 * entries + sus imports (BFS) y se comprueba la UNIÓN.
 *
 * SKIP: si `web/dist/index.html` no existe, p. ej. en CI sin build
 * (`test.skipIf`). Pero si EXISTE y faltan los marcadores → FAIL: ese es
 * el bug.
 *
 * El test NUNCA ejecuta `npm run build`: si el dist está a medio construir
 * (Vite vacía `dist` al empezar: hueco breve de 404) se reintenta con espera
 * unos segundos; para distinguir "build en curso" de "build obsoleto" se
 * comparan mtimes (`web/dist/index.html` vs
 * `web/src/composables/useExposedVariables.ts`).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import { RelayServer } from '../../../relay/src/relay';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { DeviceStore } from '../../../relay/src/store';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { PairingStore } from '../../../relay/src/pairing';
import { TunnelClient } from '../remote/tunnel';
import { createDaemonFetch } from '../http/handler';
import {
  resolveWebDistIndexCandidates,
  resolveWebSrcCandidates,
} from '../http/static';

/** Literales del código web actual (sobreviven a la minificación). */
const MARKERS = ['bd-preset-dlg-add', 'variable.set'] as const;
/** Fichero fuente de referencia para saber si el dist está fresco. */
const SRC_MARKER_REL = path.join('composables', 'useExposedVariables.ts');
/** Cuánto esperar (ms) a que aparezca el dist si Vite lo está reconstruyendo. */
const DIST_APPEAR_TIMEOUT_MS = 120_000;
/** Reintentos de descarga de bundles si el dist parece estar a medio construir. */
const BUNDLE_ATTEMPTS = 12;
const BUNDLE_RETRY_WAIT_MS = 20_000;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-remote-ui-dist-test-'));

let servers: RelayServer[] = [];
let stores: DeviceStore[] = [];
let tunnels: TunnelClient[] = [];
let savedRelayUrl: string | undefined;
let savedDataDir: string | undefined;

function fakeDb(uiEnabled = true) {
  return {
    getSetting: (k: string) => {
      if (k === 'remote.ui.enabled') return uiEnabled ? '1' : '0';
      return null;
    },
  } as any;
}

function fakeDeps() {
  return {
    wsManager: {} as any,
    pluginLoader: {} as any,
    actionRunner: { executeAction: async () => ({ success: true }) } as any,
    windowWatcher: { on: () => {}, isActive: () => false } as any,
  };
}

function startRelay(): RelayServer {
  const dir = fs.mkdtempSync(path.join(ROOT, 'r-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token: '', store, pairing: new PairingStore() });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

function startTunnel(port: number, deviceId: string): TunnelClient {
  const t = new TunnelClient(fakeDb(true), null, {
    deviceId,
    relayUrl: `ws://127.0.0.1:${port}`,
  });
  // Sirve peticiones HTTP reales (web/dist) como en producción.
  t.setHttpHandler(createDaemonFetch(fakeDeps()));
  tunnels.push(t);
  t.start();
  return t;
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timeout esperando condición del túnel');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function statusOf(base: string, code: string): Promise<any> {
  const res = await fetch(`${base}/ui/${code}/status`);
  return res.json();
}

/** Primer `index.html` de web-dist que exista (mismo orden que el servidor). */
function firstExistingDistIndex(): string | null {
  for (const c of resolveWebDistIndexCandidates()) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* siguiente candidato */
    }
  }
  return null;
}

/** mtime del fichero fuente de referencia (null si no se encuentra). */
function srcMarkerMtime(): number | null {
  for (const srcDir of resolveWebSrcCandidates()) {
    const f = path.join(srcDir, SRC_MARKER_REL);
    try {
      const st = fs.statSync(f);
      if (st.isFile()) return st.mtimeMs;
    } catch {
      /* siguiente candidato */
    }
  }
  return null;
}

/** mtime de `web/dist/index.html` (null si no existe). */
function distIndexMtime(distIndex: string): number | null {
  try {
    return fs.statSync(distIndex).mtimeMs;
  } catch {
    return null;
  }
}

/** ¿El dist está obsoleto o ausente? (best-effort: src más nuevo que dist). */
function distIsStale(distIndex: string | null): boolean {
  if (!distIndex) return true;
  const distMtime = distIndexMtime(distIndex);
  if (distMtime === null) return true;
  const srcMtime = srcMarkerMtime();
  return srcMtime !== null && srcMtime > distMtime;
}
/** Nota de frescura del dist para los mensajes de error (best-effort). */
function distFreshnessNote(distIndex: string | null): string {
  if (!distIndex) return 'dist ausente (¿build en curso? Vite vacía dist al empezar)';
  let distMtime = 0;
  try {
    distMtime = fs.statSync(distIndex).mtimeMs;
  } catch {
    return 'dist ilegible a mitad del test (¿build en curso?)';
  }
  const srcMtime = srcMarkerMtime();
  if (srcMtime !== null && srcMtime > distMtime) {
    return (
      `dist OBSOLETO: web/dist/index.html (${new Date(distMtime).toISOString()}) ` +
      `es anterior a web/src/${SRC_MARKER_REL} (${new Date(srcMtime).toISOString()})`
    );
  }
  return `dist fresco: index.html ${new Date(distMtime).toISOString()}`;
}

/** Espera a que exista el index del dist (hueco de 404 mientras Vite reconstruye). */
async function waitForDistIndex(timeoutMs: number): Promise<string | null> {
  const start = Date.now();
  for (;;) {
    const found = firstExistingDistIndex();
    if (found) return found;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Evaluado al registrar el test: en CI sin build no hay web/dist → skip.
// (Si el dist existe al arrancar pero Vite lo vacía a mitad del test, el
// propio test espera y reintenta en vez de pasar en falso.)
// OJO: se mira `web/dist` directamente (no todos los candidatos de prod),
// porque con DEV_MODE el servidor sirve web/dist primero: `daemon/web-dist`
// suele ser una copia vieja que si no taparía al build fresco (ver
// `resolveWebDistCandidates` en static.ts: ese tapado es el bug).
function repoWebDistIndex(): string | null {
  const cands = [
    path.join(process.cwd(), 'web', 'dist', 'index.html'),
    path.join(import.meta.dir, '..', '..', '..', 'web', 'dist', 'index.html'),
  ];
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* siguiente candidato */
    }
  }
  return null;
}
const HAS_DIST_AT_LOAD = repoWebDistIndex() !== null;

let savedDevMode: string | undefined;

beforeEach(() => {
  savedRelayUrl = process.env.RELAY_URL;
  delete process.env.RELAY_URL;
  // El handler crea su propio DatabaseService: aislarlo del data-dir real.
  savedDataDir = process.env.LIBREDECK_DATA_DIR;
  process.env.LIBREDECK_DATA_DIR = fs.mkdtempSync(path.join(ROOT, 'db-'));
  // Como en dev (`dev.sh`): web/dist va primero y `daemon/web-dist` (copia
  // que puede ser vieja) no tapa al build fresco.
  savedDevMode = process.env.DEV_MODE;
  process.env.DEV_MODE = 'true';
});

afterEach(async () => {
  for (const t of tunnels.splice(0)) {
    try {
      t.stop();
    } catch {
      /* noop */
    }
  }
  for (const r of servers.splice(0)) {
    try {
      r.stop();
    } catch {
      /* noop */
    }
  }
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* noop */
    }
  }
  if (savedRelayUrl === undefined) delete process.env.RELAY_URL;
  else process.env.RELAY_URL = savedRelayUrl;
  if (savedDataDir === undefined) delete process.env.LIBREDECK_DATA_DIR;
  else process.env.LIBREDECK_DATA_DIR = savedDataDir;
  if (savedDevMode === undefined) delete process.env.DEV_MODE;
  else process.env.DEV_MODE = savedDevMode;
  await new Promise((r) => setTimeout(r, 100));
});

describe('remote-ui-dist: el túnel sirve el build actual de web/dist', () => {
  test.skipIf(!HAS_DIST_AT_LOAD)(
    'GET /t/<token>/ + bundles _astro contienen los marcadores del código actual',
    async () => {
      // 1) El dist puede estar a medio construir (Vite lo vacía al empezar):
      //    esperar a que el index exista antes de levantar el túnel.
      const distIndex = await waitForDistIndex(DIST_APPEAR_TIMEOUT_MS);
      if (!distIndex) {
        // Desapareció a mitad del test y no volvió: no se puede concluir.
        // (Al registrar el test SÍ había dist, así que esto no es "CI sin build".)
        throw new Error(
          `web/dist/index.html no apareció en ${DIST_APPEAR_TIMEOUT_MS / 1000}s ` +
            `(¿build en curso que vació dist?). Candidatos: ${resolveWebDistIndexCandidates().join(', ')}`,
        );
      }

      // 2) Bucle completo navegador↔daemon↔relay hasta conseguir el token.
      const relay = startRelay();
      const base = `http://127.0.0.1:${relay.port}`;
      const tunnel = startTunnel(relay.port, 'uidist-dev-1');
      await waitFor(() => tunnel.getState() === 'connected');

      const code = `uidist-${Date.now().toString(36)}`;
      tunnel.publishUiCode(code, Date.now() + 600_000);
      await waitFor(
        async () => (await statusOf(base, code)).status === 'pending',
        10_000,
      );

      await fetch(`${base}/ui/${code}`, { headers: { 'user-agent': 'UiDistTest/1.0' } });
      await waitFor(() => tunnel.getPending().length > 0);
      const [req] = tunnel.getPending();
      expect(req.urlCode).toBe(code);

      const decision = tunnel.decideUiRequest(req.reqId, true);
      expect(decision.ok).toBe(true);
      expect(decision.allowed).toBe(true);
      const token = decision.sessionToken;
      expect(typeof token).toBe('string');
      expect(token!.length).toBeGreaterThan(31);

      // El poll del navegador recibe approved + token.
      const first = await statusOf(base, code);
      expect(first.status).toBe('approved');
      expect(first.sessionToken).toBe(token);

      // 3-4) HTML de la UI A TRAVÉS DEL TÚNEL (con reescritura del relay) +
      //    descarga de los bundles `/_astro/*.js`, también por el túnel,
      //    SIGUIENDO LOS IMPORTS entre chunks (como haría el navegador: el
      //    HTML solo referencia los entries y los marcadores viven en chunks
      //    importados). Con reintentos si el dist está a medio construir
      //    (Vite rota los nombres con hash: el HTML se refetchea en cada
      //    intento). NO se ejecuta `npm run build`: solo se espera a que
      //    termine el build en curso del dueño/CI. Si el dist está FRESCO y
      //    completo pero faltan marcadores → es el bug: se falla sin esperar.
      let fetched: { file: string; bytes: number; text: string }[] = [];
      let lastDetail = '';
      for (let attempt = 1; attempt <= BUNDLE_ATTEMPTS; attempt++) {
        fetched = [];
        const seen = new Set<string>();
        const queue: string[] = [];
        const htmlRes = await fetch(`${base}/t/${token}/`, {
          headers: { accept: 'text/html' },
        });
        if (htmlRes.status !== 200) {
          lastDetail = `GET /t/<token>/ → ${htmlRes.status} (intento ${attempt})`;
        } else {
          const html = await htmlRes.text();
          // El relay reescribe `/_astro/x.js` → `/t/<tok>/_astro/x.js` (más
          // `<base href="/t/<tok>/">`); se aceptan ambas formas.
          for (const u of html.match(/\/_astro\/[^"'()\s]+\.js/g) ?? []) {
            queue.push(u.split(/[?#]/)[0]);
          }
          if (queue.length === 0) {
            lastDetail =
              `HTML sin refs a /_astro/*.js (intento ${attempt}, ${html.length} B, ` +
              `head: ${html.slice(0, 200)})`;
          } else {
            let httpOk = true;
            // BFS por los imports relativos (`from"./otro-chunk.hash.js"`):
            // los entries importan al resto de chunks de la app.
            while (queue.length > 0 && fetched.length < 60) {
              const ref = queue.shift() as string;
              // El path bajo /t/<token> es el mismo que en local (el relay ya
              // quitó el prefijo antes de proxear al daemon).
              const rel = ref.startsWith('/t/')
                ? (ref.replace(/^\/t\/[^/]+/, '') as string)
                : ref;
              const tunnelPath = rel.startsWith('/_astro/')
                ? rel
                : `/_astro/${rel.replace(/^\.\//, '')}`;
              if (seen.has(tunnelPath)) continue;
              seen.add(tunnelPath);
              const res = await fetch(`${base}/t/${token}${tunnelPath}`);
              if (res.status !== 200) {
                httpOk = false;
                lastDetail = `${tunnelPath} → ${res.status} (intento ${attempt})`;
                break;
              }
              const text = await res.text();
              fetched.push({ file: tunnelPath, bytes: text.length, text });
              for (const imp of text.match(/\.\/[A-Za-z0-9_.-]+\.js/g) ?? []) {
                const dep = `/_astro/${imp.slice(2).split(/[?#]/)[0]}`;
                if (!seen.has(dep)) queue.push(dep);
              }
            }
            if (httpOk) {
              const unionNow = fetched.map((f) => f.text).join('\n');
              const missingNow = MARKERS.filter((m) => !unionNow.includes(m));
              if (missingNow.length === 0) break; // build actual confirmado
              lastDetail =
                `faltan marcadores: ${missingNow.join(', ')} ` +
                `(${fetched.length} chunks vía túnel, intento ${attempt})`;
            }
          }
        }
        // ¿Transitorio (build en curso) o bug real (dist fresco sin marcadores)?
        const freshIdx = firstExistingDistIndex();
        const complete =
          fetched.length > 0 &&
          MARKERS.every((m) => fetched.map((f) => f.text).join('\n').includes(m));
        if (!complete && freshIdx && !distIsStale(freshIdx)) {
          break; // dist fresco y servido OK pero sin marcadores → el bug, fallar ya
        }
        if (attempt < BUNDLE_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, BUNDLE_RETRY_WAIT_MS));
        }
      }

      // 5) Veredicto: la unión de los bundles servidos POR EL TÚNEL debe
      //    contener AMBOS marcadores. Si el dist fuese anterior a nov-2026
      //    (el bug), no contendría NINGUNO.
      const union = fetched.map((f) => f.text).join('\n');
      const bySize = [...fetched].sort((a, b) => b.bytes - a.bytes);
      const summary =
        `bundles vía túnel: ` +
        (bySize.length > 0
          ? bySize.map((f) => `${f.file} (${f.bytes} B)`).join(', ')
          : '(ninguno)') +
        `. Último detalle: ${lastDetail}. ${distFreshnessNote(firstExistingDistIndex())}`;
      const missing = MARKERS.filter((m) => !union.includes(m));
      // Un único expect con el detalle en el diff: si el dist servido fuese
      // anterior a nov-2026 (el bug), faltarían AMBOS marcadores.
      expect({ missing, summary }).toEqual({ missing: [], summary });
      // Cordura: el bundle mayor debe ser la app real, no una página de error.
      expect(bySize[0]?.bytes ?? 0).toBeGreaterThan(50_000);
    },
    420_000,
  );
});
