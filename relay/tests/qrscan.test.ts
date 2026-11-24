import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyQrText, isPairCode } from '../src/qrscan';
import { pickLang, publicHostname, renderLanding } from '../src/landing';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';

const landingData = (lang: 'es' | 'en' = 'es') => ({
  version: '0.1.0',
  online: 1,
  devices: 2,
  wsUrl: 'wss://example.test',
  lang,
});

describe('qrscan parser (classifyQrText)', () => {
  test('código suelto de 6 dígitos → pair-code', () => {
    const r = classifyQrText('  482913  ');
    expect(r.kind).toBe('pair-code');
    expect(r.code).toBe('482913');
  });

  test('no códigos: 5/7 dígitos, letras → other', () => {
    for (const t of ['12345', '1234567', 'abcdef', '', '   ']) {
      expect(classifyQrText(t).kind).toBe('other');
    }
    expect(isPairCode('123456')).toBe(true);
    expect(isPairCode(' 123456 ')).toBe(true);
    expect(isPairCode('12345a')).toBe(false);
  });

  test('QR de emparejamiento BunDeck (formato GET /api/v1/remote/qr) → pair-qr', () => {
    const payload = {
      v: 1,
      relay: 'wss://bundeck.mikelgranero.com',
      code: '482913',
      dev: 'device-id-abc',
      pub: 'cHViLWtleQ==',
      fp: 'abcd:1234:abcd:1234:abcd:1234:abcd:1234',
      exp: Date.now() + 300_000,
    };
    const r = classifyQrText(JSON.stringify(payload));
    expect(r.kind).toBe('pair-qr');
    expect(r.code).toBe('482913');
    expect(r.relay).toBe('wss://bundeck.mikelgranero.com');
    expect(r.expired).toBe(false);
  });

  test('pair-qr caducado marca expired pero sigue siendo pair-qr', () => {
    const r = classifyQrText(
      JSON.stringify({ v: 1, relay: '', code: '000001', dev: 'd', pub: 'p', fp: 'f', exp: 1 }),
      999_999_999,
    );
    expect(r.kind).toBe('pair-qr');
    expect(r.expired).toBe(true);
  });

  test('JSON no válido como pairing → other (versión, campos, `{` roto)', () => {
    const badVersion = classifyQrText(JSON.stringify({ v: 2, code: '123456', dev: 'd', pub: 'p' }));
    expect(badVersion.kind).toBe('other');
    const badFields = classifyQrText(JSON.stringify({ v: 1, code: '123', dev: '', pub: '' }));
    expect(badFields.kind).toBe('other');
    expect(classifyQrText('{"v":1,').kind).toBe('other');
    expect(classifyQrText('{"otro":1}').kind).toBe('other');
    expect(classifyQrText('[1,2,3]').kind).toBe('other');
  });

  test('wss:// → relay-url', () => {
    const r = classifyQrText('wss://bundeck.mikelgranero.com');
    expect(r.kind).toBe('relay-url');
    expect(r.url).toBe('wss://bundeck.mikelgranero.com');
  });

  test('…/ui/<code> → ui-url con urlCode', () => {
    const r = classifyQrText('https://bundeck.mikelgranero.com/ui/AbC123xYz');
    expect(r.kind).toBe('ui-url');
    expect(r.urlCode).toBe('AbC123xYz');
  });

  test('…/t/<token>/… → tunnel-url', () => {
    const r = classifyQrText('https://relay.example.test/t/sess-token-1/api/v1/config');
    expect(r.kind).toBe('tunnel-url');
  });

  test('otra http(s) (p. ej. QR Local http://lan:3002) → http-url', () => {
    const r = classifyQrText('http://192.168.1.50:3002');
    expect(r.kind).toBe('http-url');
    expect(r.url).toBe('http://192.168.1.50:3002');
  });

  test('texto plano y esquemas raros → other', () => {
    expect(classifyQrText('hola mundo').kind).toBe('other');
    expect(classifyQrText('ftp://x.test/f').kind).toBe('other');
    expect(classifyQrText('nota: sin cámara').kind).toBe('other');
    // classifyQrText no lanza con entradas no-string.
    expect(classifyQrText(null).kind).toBe('other');
    expect(classifyQrText(undefined).kind).toBe('other');
  });
});

describe('landing: sección escáner QR', () => {
  test('ES contiene sección, vídeo+canvas, pegado manual y fallback jsqr auto-hospedado', () => {
    const html = renderLanding(landingData('es'));
    expect(html).toContain('Escanear un QR de BunDeck');
    expect(html).toContain('id="qrscan-open"');
    expect(html).toContain('id="qrscan-video"');
    expect(html).toContain('playsinline');
    expect(html).toContain('id="qrscan-canvas"');
    expect(html).toContain('id="qrscan-paste"');
    expect(html).toContain('id="qrscan-validate"');
    expect(html).toContain('id="qrscan-result"');
    expect(html).toContain('id="qrscan-openurl"');
    expect(html).toContain('BarcodeDetector');
    expect(html).toContain('facingMode');
    // Fallback auto-hospedado bajo demanda (no incrusta el decoder en la landing).
    expect(html).toContain('vendor/jsqr-1.4.0.js');
    expect(html).toContain('window.jsQR');
    expect(html).toContain('Cargando detector QR compatible');
  });

  test('EN contiene la misma estructura con sus cadenas', () => {
    const html = renderLanding(landingData('en'));
    expect(html).toContain('Scan a BunDeck QR');
    expect(html).toContain('Scan QR');
    expect(html).toContain('id="qrscan-video"');
    expect(html).toContain('id="qrscan-paste"');
    expect(html).toContain('BarcodeDetector');
    expect(html).toContain('vendor/jsqr-1.4.0.js');
    expect(html).toContain('window.jsQR');
  });

  test('JS inline sin eval/new Function/handlers inline (CSP-compatible)', () => {
    for (const lang of ['es', 'en'] as const) {
      const html = renderLanding(landingData(lang));
      expect(html).not.toContain('eval(');
      expect(html).not.toContain('new Function');
      expect(html).not.toContain('onclick=');
      expect(html).not.toContain('onload=');
      // Sin URLs absolutas en el escáner: funciona tras reverse proxy.
      expect(html).not.toContain('http://localhost');
      expect(html).not.toContain('127.0.0.1:3');
      // Etiquetas tipo para el resultado (las usa el clasificador cliente).
      for (const id of ['qrscan-kind', 'qrscan-text', 'qrscan-code', 'qrscan-hint', 'qrscan-copy']) {
        expect(html).toContain(`id="${id}"`);
      }
    }
  });
});

describe('landing: contratos intactos (pickLang/publicHostname)', () => {
  test('pickLang: default ES, EN por Accept-Language, q=0 respeta orden', () => {
    const req = (al: string | null) =>
      new Request('http://x.test/', al === null ? {} : { headers: { 'Accept-Language': al } });
    expect(pickLang(req(null))).toBe('es');
    expect(pickLang(req('en-US,en;q=0.9'))).toBe('en');
    expect(pickLang(req('es-ES,es;q=0.9'))).toBe('es');
    expect(pickLang(req('fr-FR,fr;q=0.9,en;q=0.8'))).toBe('es');
  });

  test('publicHostname: RELAY_DOMAIN gana; si no, x-forwarded-host; si no, Host', () => {
    const base = 'http://internal:8080/';
    expect(publicHostname(new Request(base), 'bundeck.mikelgranero.com')).toBe('bundeck.mikelgranero.com');
    expect(publicHostname(new Request(base), 'wss://bundeck.mikelgranero.com/')).toBe(
      'bundeck.mikelgranero.com',
    );
    expect(
      publicHostname(
        new Request(base, { headers: { 'x-forwarded-host': 'proxy.example.test', host: 'h.test' } }),
      ),
    ).toBe('proxy.example.test');
    expect(publicHostname(new Request('http://direct.example.test:3001/'))).toBe(
      'direct.example.test:3001',
    );
  });
});

describe('landing servida: no-store intacto con la nueva sección', () => {
  const servers: RelayServer[] = [];
  const stores: DeviceStore[] = [];

  afterEach(() => {
    for (const r of servers.splice(0)) r.stop();
    for (const s of stores.splice(0)) s.close();
  });

  test('GET / mantiene cache-control: no-store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-qrscan-test-'));
    const store = new DeviceStore(dir);
    stores.push(store);
    const relay = new RelayServer({ store, pairing: new PairingStore(), version: '0.1.0' });
    relay.listen(0, '127.0.0.1');
    servers.push(relay);
    const res = await fetch(`http://127.0.0.1:${relay.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('qrscan-video');
  });

  test('GET /vendor/jsqr-1.4.0.js sirve el decoder con cache immutable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-vendor-test-'));
    const store = new DeviceStore(dir);
    stores.push(store);
    const relay = new RelayServer({ store, pairing: new PairingStore(), version: '0.1.0' });
    relay.listen(0, '127.0.0.1');
    servers.push(relay);
    const res = await fetch(`http://127.0.0.1:${relay.port}/vendor/jsqr-1.4.0.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const js = await res.text();
    expect(js.length).toBeGreaterThan(100_000);
    expect(js).toContain('jsQR');
  });
});
