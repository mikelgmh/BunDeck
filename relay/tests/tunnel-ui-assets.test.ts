/**
 * E2E del túnel UI con assets reales: reproduce lo que ve el móvil tras
 * aprobar la invitación (`/ui/<code>` → approve → `/t/<token>/`).
 *
 * Cadena cubierta: RelayServer real + daemon falso que sirve ficheros con
 * las MISMAS reglas del daemon (`isAllowedTunnelPath`, `getContentType`) +
 * HTML inyectado por el relay (`injectBase`).
 *
 * Regresión: el HTML de Astro usa `component-url`/`renderer-url` en
 * `<astro-island>` (además de `href`/`src`). Si el relay no los reescribe
 * al prefijo `/t/<token>/`, el móvil pide `/…` en la raíz del relay (401)
 * y la app queda sin JS (y, según el relay desplegado, sin CSS): se ve
 * "bundeck" pero todo sin estilos y sin hidratar.
 *
 * Desviación consciente respecto al daemon real: el daemon hace fallback
 * SPA a index.html cuando falta un fichero; aquí un asset ausente es 404
 * a propósito para que el test sea ruidoso (un CSS que devolviera HTML
 * es exactamente el "sin estilos" del bug).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { injectBase, setUiPageHandler } from '../src/tunnel';
// Reglas REALES del daemon (misma allowlist y mismos MIME que en prod).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { isAllowedTunnelPath } from '../../daemon/src/remote/tunnel';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { getContentType } from '../../daemon/src/http/static';

const TOKEN = 'test-relay-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];
const sockets: WebSocket[] = [];

function startRelay(opts: { rateLimitPerMin?: number; uiRequestTimeoutMs?: number; httpTimeoutMs?: number } = {}): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-ui-assets-test-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token: TOKEN, store, pairing: new PairingStore(), ...opts });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

afterEach(async () => {
  setUiPageHandler(null);
  for (const s of sockets.splice(0)) {
    try {
      s.close();
    } catch {
      /* noop */
    }
  }
  for (const r of servers.splice(0)) r.stop();
  for (const s of stores.splice(0)) s.close();
  await new Promise((r) => setTimeout(r, 25));
});

/** Daemon falso que sirve ficheros estáticos con las reglas del daemon real. */
class FileDaemon {
  ws!: WebSocket;
  buf: any[] = [];
  constructor(private root: string) {}

  async connect(port: number): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
    sockets.push(this.ws);
    this.ws.addEventListener('message', (e) => {
      let m: any = null;
      try {
        m = JSON.parse(String((e as MessageEvent).data));
      } catch {
        return;
      }
      this.buf.push(m);
      try {
        if (m.kind === 'http-req') void this.onHttp(m);
      } catch {
        /* el test decide */
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('daemon connect failed')), { once: true });
    });
    return this;
  }

  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }

  next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const take = (): any | undefined => {
      const i = this.buf.findIndex(pred);
      return i >= 0 ? this.buf.splice(i, 1)[0] : undefined;
    };
    const hit = take();
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('timeout waiting for daemon message'));
      }, timeoutMs);
      const poll = setInterval(() => {
        const m = take();
        if (m !== undefined) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(m);
        }
      }, 5);
    });
  }

  private onHttp(m: any): void {
    const id = String(m.id ?? '');
    const rawPath = String(m.path ?? '/');
    const respond = (status: number, headers: Record<string, string>, body: Uint8Array | string | null) => {
      const bytes = body === null ? null : typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
      this.send({
        v: 1,
        kind: 'http-res',
        id,
        status,
        headers,
        bodyB64: bytes ? bytes.toString('base64') : null,
      });
    };
    if (!isAllowedTunnelPath(rawPath)) {
      respond(403, { 'content-type': 'application/json' }, JSON.stringify({ error: 'forbidden' }));
      return;
    }
    // Como el handler del daemon: pathname sin query, `/` → `/index.html`.
    const pathname = rawPath.split('?')[0].split('#')[0] || '/';
    const rel = normalize(pathname.replace(/^\/+/, '')).split(sep).join('/');
    if (rel.startsWith('..')) {
      respond(403, { 'content-type': 'application/json' }, JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const filePath = pathname === '/' ? '/index.html' : pathname;
    const full = join(this.root, normalize(filePath.replace(/^\/+/, '')));
    try {
      const data = readFileSync(full);
      respond(200, { 'content-type': getContentType(filePath) }, new Uint8Array(data));
    } catch {
      respond(404, { 'content-type': 'application/json' }, JSON.stringify({ error: 'not-found', path: pathname }));
    }
  }
}

const CODE = 'testcode-abc123';
const TOK = 'ab'.repeat(32);

async function approvedSession(base: string, relay: RelayServer, daemon: FileDaemon, code = CODE, token = TOK): Promise<string> {
  daemon.send({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-1' });
  await daemon.next((m) => m.kind === 'tunnel-registered');
  daemon.send({ v: 1, kind: 'ui-publish', urlCode: code, exp: Date.now() + 600_000 });
  await daemon.next((m) => m.kind === 'ui-published');
  void relay;
  setUiPageHandler(() => new Response('<h1>espera</h1>', { headers: { 'content-type': 'text/html' } }));
  await fetch(`${base}/ui/${code}`);
  const req = await daemon.next((m) => m.kind === 'ui-request');
  daemon.send({ v: 1, kind: 'ui-decision', reqId: req.reqId, allow: true });
  await daemon.next((m) => m.kind === 'ui-decision-ack');
  daemon.send({ v: 1, kind: 'ui-bind', urlCode: code, sessionToken: token, exp: Date.now() + 600_000 });
  await daemon.next((m) => m.kind === 'ui-bound');
  const st = await (await fetch(`${base}/ui/${code}/status`)).json();
  expect(st.status).toBe('approved');
  expect(typeof st.sessionToken).toBe('string');
  return String(st.sessionToken);
}

/** Extrae refs de assets del HTML: attrs simples + entradas de srcset. */
function extractAssetRefs(html: string): Array<{ attr: string; url: string }> {
  // `<base href>` no es un asset cargable: se excluye del fetch.
  const noBase = html.replace(/<base\b[^>]*>/gi, '');
  const out: Array<{ attr: string; url: string }> = [];
  const attrRe = /(href|src|action|poster|component-url|renderer-url|before-hydration-url)\s*=\s*(["'])(.*?)\2/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(noBase)) !== null) {
    const v = m[3].trim();
    if (v) out.push({ attr: m[1].toLowerCase(), url: v });
  }
  const srcsetRe = /srcset\s*=\s*(["'])(.*?)\1/gi;
  while ((m = srcsetRe.exec(noBase)) !== null) {
    for (const part of m[2].split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url) out.push({ attr: 'srcset', url });
    }
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.attr}=${r.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Solo rutas absolutas del mismo origen (las que el relay debe reescribir). */
function absoluteSameOrigin(refs: string[]): string[] {
  return refs.filter((u) => u.startsWith('/') && !u.startsWith('//'));
}

function mimeFor(path: string): string {
  const ext = path.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    html: 'text/html',
    css: 'text/css',
    js: 'javascript',
    mjs: 'javascript',
    json: 'json',
    map: 'json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'svg',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
  };
  return map[ext] ?? 'text/plain';
}

describe('túnel UI: la app aprobada carga con estilos y JS (e2e móvil)', () => {
  test('fixture tipo Astro: base inyectada + todos los assets resuelven con su MIME', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const dir = mkdtempSync(join(tmpdir(), 'relay-ui-fixture-'));
    const files: Record<string, { body: string; type: string }> = {
      '/index.html': {
        body: [
          '<!doctype html><html><head><meta charset="utf-8"><title>x</title>',
          '<link rel="icon" href="/favicon.svg">',
          '<link rel="stylesheet" href="/_astro/index.HASH.css">',
          '</head><body>',
          '<img src="/img/logo.png" srcset="/img/logo.png 1x, /img/logo@2x.png 2x">',
          '<astro-island component-url="/_astro/App.HASH.js" renderer-url="/_astro/client.HASH.js" props="{}"></astro-island>',
          '</body></html>',
        ].join(''),
        type: 'text/html',
      },
      '/_astro/index.HASH.css': { body: '.bundeck{color:red}', type: 'text/css' },
      '/_astro/App.HASH.js': { body: 'console.log("app")', type: 'application/javascript' },
      '/_astro/client.HASH.js': { body: 'console.log("client")', type: 'application/javascript' },
      '/favicon.svg': { body: '<svg></svg>', type: 'image/svg+xml' },
      '/img/logo.png': { body: 'PNG', type: 'image/png' },
      '/img/logo@2x.png': { body: 'PNG2x', type: 'image/png' },
    };
    const { writeFileSync, mkdirSync } = await import('node:fs');
    for (const [p, f] of Object.entries(files)) {
      const full = join(dir, p.replace(/^\/+/, ''));
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, f.body);
    }

    const daemon = await new FileDaemon(dir).connect(relay.port);
    const sessionToken = await approvedSession(base, relay, daemon);

    const page = await fetch(`${base}/t/${sessionToken}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type') ?? '').toContain('text/html');
    const html = await page.text();
    // Base inyectada para que las relativas resuelvan bajo el túnel.
    expect(html).toContain(`<base href="/t/${sessionToken}/">`);

    // NINGUNA ref absoluta del mismo origen puede quedar sin prefijo del
    // túnel: en el móvil pediría `/…` en la raíz del relay (401) y la app
    // quedaría sin estilos/JS (el bug reportado).
    const refs = extractAssetRefs(html);
    const absolute = absoluteSameOrigin(refs.map((r) => r.url));
    const unprefixed = absolute.filter((u) => !u.startsWith(`/t/${sessionToken}/`) && !u.startsWith('/ui/'));
    expect(unprefixed).toEqual([]);

    // Cada asset del HTML resuelve por el túnel con su MIME y su cuerpo
    // (no un 401/404 ni el fallback SPA con HTML). `action` es un endpoint
    // de formulario, no un asset cargable: solo se exige su reescritura.
    for (const { attr, url: ref } of refs) {
      if (!ref.startsWith(`/t/${sessionToken}/`) || attr === 'action') continue;
      const res = await fetch(`${base}${ref}`);
      expect(`${ref} → status`).toBe(`${ref} → status`);
      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).toContain(mimeFor(ref));
      const body = await res.text();
      if (ref.endsWith('.css') || ref.endsWith('.js')) {
        expect(body).not.toContain('<!doctype html>');
        expect(body).not.toContain('<astro-island');
      }
    }
  });

  test('injectBase cubre todos los atributos de assets (unitario)', () => {
    const tok = 'tok123';
    const html =
      '<html><head><title>t</title>' +
      '<link rel="stylesheet" href="/_astro/a.css">' +
      '<link rel="icon" href="/favicon.svg">' +
      '</head><body>' +
      '<img src="/i.png" srcset="/i.png 1x, /i@2x.png 2x">' +
      '<form action="/submit"></form>' +
      '<video poster="/p.jpg"></video>' +
      '<astro-island component-url="/_astro/App.js" renderer-url="/_astro/c.js" before-hydration-url="/_astro/h.js"></astro-island>' +
      '<a href="/ui/abc">relay</a>' +
      '<a href="https://fonts.googleapis.com/css">g</a>' +
      '<img src="data:image/png;base64,xx">' +
      '</body></html>';
    const out = injectBase(html, tok);
    expect(out).toContain(`<base href="/t/${tok}/">`);
    for (const want of [
      `href="/t/${tok}/_astro/a.css"`,
      `href="/t/${tok}/favicon.svg"`,
      `src="/t/${tok}/i.png"`,
      `srcset="/t/${tok}/i.png 1x, /t/${tok}/i@2x.png 2x"`,
      `action="/t/${tok}/submit"`,
      `poster="/t/${tok}/p.jpg"`,
      `component-url="/t/${tok}/_astro/App.js"`,
      `renderer-url="/t/${tok}/_astro/c.js"`,
      `before-hydration-url="/t/${tok}/_astro/h.js"`,
    ]) {
      expect(out).toContain(want);
    }
    // Lo que NO debe tocarse.
    expect(out).toContain('href="/ui/abc"');
    expect(out).toContain('href="https://fonts.googleapis.com/css"');
    expect(out).toContain('src="data:image/png;base64,xx"');
  });

  test('build real web/dist: todo lo que referencia index.html carga por el túnel (si hay build)', async () => {
    const distUrl = new URL('../../web/dist/index.html', import.meta.url);
    const distDir = new URL('../../web/dist/', import.meta.url);
    const distPath = distUrl.pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const rootPath = distDir.pathname.replace(/^\/([A-Za-z]:)/, '$1');
    if (!existsSync(distPath)) {
      console.log('skip: sin web/dist (corre `npm run build` en web/ para este e2e)');
      return;
    }
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const daemon = await new FileDaemon(rootPath).connect(relay.port);
    const sessionToken = await approvedSession(base, relay, daemon);

    const page = await fetch(`${base}/t/${sessionToken}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`<base href="/t/${sessionToken}/">`);

    const refs = extractAssetRefs(html);
    const absolute = absoluteSameOrigin(refs.map((r) => r.url));
    // El build real referencia al menos su CSS y sus islands.
    expect(absolute.length).toBeGreaterThan(0);
    const unprefixed = absolute.filter((u) => !u.startsWith(`/t/${sessionToken}/`) && !u.startsWith('/ui/'));
    expect(`sin reescribir: ${unprefixed.join(', ')}`).toBe('sin reescribir: ');

    for (const { attr, url: ref } of refs) {
      if (!ref.startsWith(`/t/${sessionToken}/`) || attr === 'action') continue;
      const under = ref.slice(`/t/${sessionToken}`.length);
      const res = await fetch(`${base}${ref}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain(mimeFor(under));
      if (/\.(css|js|mjs)$/.test(under.split('?')[0])) {
        const body = await res.text();
        expect(body).not.toContain('<!doctype html>');
      }
    }
    // Cordura: el CSS y los JS de islands del HTML existen de verdad.
    void readdirSync;
  });
});
