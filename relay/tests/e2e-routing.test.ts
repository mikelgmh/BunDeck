import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import {
  decodeOpaque,
  generateIdentity,
  openEnvelope,
  openFromOpaque,
  seal,
  sealToOpaque,
} from '../src/crypto';

// NOTA API: el protocolo real usa seal/sealToOpaque (cifra, "encryptTo") y
// openEnvelope/openFromOpaque (descifra, "decryptFrom"). No existen funciones
// llamadas encryptTo/decryptFrom en crypto.ts; este fichero fija el uso real.

const TOKEN = 'test-e2e-routing-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];

function startRelay(pairing?: PairingStore): RelayServer {
  const dir = mkdtempSync(join(tmpdir(), 'relay-e2e-routing-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({ token: TOKEN, store, pairing: pairing ?? new PairingStore() });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return relay;
}

afterEach(() => {
  for (const r of servers.splice(0)) r.stop();
  for (const s of stores.splice(0)) s.close();
});

const baseMsg = (type: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  type,
  from: 'dev-a',
  nonce: `n-${Math.random().toString(36).slice(2)}-${Date.now()}`,
  exp: Date.now() + 60_000,
  ...extra,
});

function connect(port: number, token = TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    (ws as any)._buf = [] as any[];
    ws.addEventListener('message', (e) => {
      try {
        (ws as any)._buf.push(JSON.parse(String((e as MessageEvent).data)));
      } catch {
        /* ignora no-JSON */
      }
    });
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true });
  });
}

function nextOf(ws: WebSocket, pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
  const buf = (ws as any)._buf as any[];
  const take = (): any | undefined => {
    const i = buf.findIndex(pred);
    return i >= 0 ? buf.splice(i, 1)[0] : undefined;
  };
  const hit = take();
  if (hit !== undefined) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error('timeout waiting for message'));
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

async function register(ws: WebSocket, deviceId: string, pubKey: string): Promise<void> {
  ws.send(JSON.stringify(baseMsg('register', { from: deviceId, payload: { deviceId, pubKey } })));
  await nextOf(ws, (m) => m.type === 'registered');
}

async function pair(relay: RelayServer, idA = 'dev-a', idB = 'dev-b') {
  const a = generateIdentity();
  const b = generateIdentity();
  const wsA = await connect(relay.port);
  const wsB = await connect(relay.port);
  await Promise.all([
    nextOf(wsA, (m) => m.type === 'connected'),
    nextOf(wsB, (m) => m.type === 'connected'),
  ]);
  await register(wsA, idA, a.publicKey);
  await register(wsB, idB, b.publicKey);
  return { a, b, wsA, wsB };
}

describe('e2e-routing: cifrado y enrutado del relay', () => {
  test('1. A cifra para B (sealToOpaque) -> relay entrega intacto -> B descifra exacto (openFromOpaque)', async () => {
    const relay = startRelay();
    const { a, b, wsA, wsB } = await pair(relay);
    try {
      const plaintext = 'hola B, pulsa botón 7 🔒';
      // encryptTo == sealToOpaque(plaintext, pubB, secA)
      const opaque = sealToOpaque(plaintext, b.publicKey, a.secretKey);
      const delivered = nextOf(wsB, (m) => m.type === 'signal');
      wsA.send(JSON.stringify(baseMsg('signal', { to: 'dev-b', payloadEncrypted: opaque })));
      const got = await delivered;
      expect(got.from).toBe('dev-a');
      expect(got.to).toBe('dev-b');
      expect(got.payloadEncrypted).toBe(opaque); // intacto, byte-opaco
      // decryptFrom == openFromOpaque(opaque, secB)
      const pt = openFromOpaque(got.payloadEncrypted, b.secretKey);
      expect(pt).not.toBeNull();
      expect(Buffer.from(pt!).toString('utf8')).toBe(plaintext);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  test('2. el relay nunca ve plaintext: el frame reenviado no contiene el texto claro', async () => {
    const relay = startRelay();
    const { a, b, wsA, wsB } = await pair(relay);
    try {
      const plaintext = 'SECRETO_RELATIVO_XYZ_987_plano';
      const opaque = sealToOpaque(plaintext, b.publicKey, a.secretKey);
      const delivered = nextOf(wsB, (m) => m.type === 'signal');
      const rawWire = JSON.stringify(baseMsg('signal', { to: 'dev-b', payloadEncrypted: opaque }));
      // El cable hacia el relay tampoco lleva el claro (solo opaco).
      expect(rawWire).not.toContain(plaintext);
      wsA.send(rawWire);
      const got = await delivered;
      // Intercepta lo reenviado por el servidor: ni el JSON ni el envelope
      // decodificado contienen el plaintext.
      expect(JSON.stringify(got)).not.toContain(plaintext);
      const inner = Buffer.from(got.payloadEncrypted, 'base64').toString('utf8');
      expect(inner).not.toContain(plaintext);
      const env = decodeOpaque(got.payloadEncrypted);
      expect(Buffer.from(env.box, 'base64').toString('utf8')).not.toContain(plaintext);
      // Y B sí lo recupera: el cifrado es E2E real, el relay es opaco.
      expect(Buffer.from(openFromOpaque(got.payloadEncrypted, b.secretKey)!).toString('utf8')).toBe(
        plaintext,
      );
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  test('3. tercero C con clave distinta NO puede descifrar (null)', async () => {
    const relay = startRelay();
    const { a, b, wsA, wsB } = await pair(relay);
    const c = generateIdentity();
    try {
      const opaque = sealToOpaque('solo para B', b.publicKey, a.secretKey);
      const delivered = nextOf(wsB, (m) => m.type === 'signal');
      wsA.send(JSON.stringify(baseMsg('signal', { to: 'dev-b', payloadEncrypted: opaque })));
      const got = await delivered;
      // C intenta con su propia secreta (con y sin pubkey explícita del emisor).
      expect(openFromOpaque(got.payloadEncrypted, c.secretKey, a.publicKey)).toBeNull();
      expect(openFromOpaque(got.payloadEncrypted, c.secretKey)).toBeNull();
      // B sí puede.
      expect(
        Buffer.from(openFromOpaque(got.payloadEncrypted, b.secretKey)!).toString('utf8'),
      ).toBe('solo para B');
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  test('4. MAC manipulado (flip 1 byte en ciphertext) -> descifrado falla (null)', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const env = seal('datos íntegros', b.publicKey, a.secretKey);
    const bytes = Buffer.from(env.box, 'base64');
    bytes[0] ^= 0x01; // flip de 1 bit es suficiente para romper el MAC Poly1305
    const tampered = { ...env, box: bytes.toString('base64') };
    expect(openEnvelope(tampered, b.secretKey, a.publicKey)).toBeNull();
  });

  test('5. destino offline -> el remitente recibe {type:error, reason:offline}', async () => {
    const relay = startRelay();
    const a = generateIdentity();
    const b = generateIdentity();
    const wsA = await connect(relay.port);
    try {
      await nextOf(wsA, (m) => m.type === 'connected');
      await register(wsA, 'dev-a', a.publicKey);
      const opaque = sealToOpaque('para nadie', b.publicKey, a.secretKey);
      const errP = nextOf(wsA, (m) => m.type === 'error');
      wsA.send(JSON.stringify(baseMsg('signal', { to: 'dev-ghost', payloadEncrypted: opaque })));
      const err = await errP;
      expect(err.type).toBe('error');
      expect(err.reason).toBe('offline');
    } finally {
      wsA.close();
    }
  });

  test('6a. envelope con exp caducado (>5min) -> rechazado (expired)', async () => {
    const relay = startRelay();
    const a = generateIdentity();
    const wsA = await connect(relay.port);
    try {
      await nextOf(wsA, (m) => m.type === 'connected');
      await register(wsA, 'dev-a', a.publicKey);
      wsA.send(JSON.stringify({ ...baseMsg('ping'), exp: Date.now() - 10 * 60_000 }));
      expect((await nextOf(wsA, (m) => m.type === 'error')).reason).toBe('expired');
    } finally {
      wsA.close();
    }
  });

  test('6b. mensaje >64KB -> rechazado (too-large)', async () => {
    const relay = startRelay();
    const a = generateIdentity();
    const wsA = await connect(relay.port);
    try {
      await nextOf(wsA, (m) => m.type === 'connected');
      await register(wsA, 'dev-a', a.publicKey);
      wsA.send(JSON.stringify({ ...baseMsg('ping'), payloadEncrypted: 'x'.repeat(70 * 1024) }));
      expect((await nextOf(wsA, (m) => m.type === 'error')).reason).toBe('too-large');
    } finally {
      wsA.close();
    }
  });

  test('6c. v!==1 -> rechazado (bad-version)', async () => {
    const relay = startRelay();
    const a = generateIdentity();
    const wsA = await connect(relay.port);
    try {
      await nextOf(wsA, (m) => m.type === 'connected');
      await register(wsA, 'dev-a', a.publicKey);
      wsA.send(JSON.stringify({ ...baseMsg('ping'), v: 999 }));
      expect((await nextOf(wsA, (m) => m.type === 'error')).reason).toBe('bad-version');
    } finally {
      wsA.close();
    }
  });

  test('6d. falta nonce / falta exp -> rechazado (missing-nonce / missing-exp)', async () => {
    const relay = startRelay();
    const a = generateIdentity();
    const wsA = await connect(relay.port);
    try {
      await nextOf(wsA, (m) => m.type === 'connected');
      await register(wsA, 'dev-a', a.publicKey);
      const { nonce: _n, ...noNonce } = baseMsg('ping');
      wsA.send(JSON.stringify(noNonce));
      expect((await nextOf(wsA, (m) => m.type === 'error')).reason).toBe('missing-nonce');
      const { exp: _e, ...noExp } = baseMsg('ping');
      wsA.send(JSON.stringify(noExp));
      expect((await nextOf(wsA, (m) => m.type === 'error')).reason).toBe('missing-exp');
    } finally {
      wsA.close();
    }
  });

  test('7a. pairing E2E: POST /pair genera code, se consume una vez, el segundo uso falla', async () => {
    const relay = startRelay();
    const base = `http://127.0.0.1:${relay.port}`;
    const res = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const { code, expiresIn } = (await res.json()) as { code: string; expiresIn: number };
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresIn).toBeLessThanOrEqual(300);

    const a = generateIdentity();
    const wsA = await connect(relay.port);
    try {
      await nextOf(wsA, (m) => m.type === 'connected');
      await register(wsA, 'dev-a', a.publicKey);
      wsA.send(JSON.stringify(baseMsg('request-pair', { payload: { code } })));
      const paired = await nextOf(wsA, (m) => m.type === 'paired');
      expect(paired.payload).toMatchObject({ paired: true });
      // Segundo uso del mismo código -> falla (un solo uso).
      wsA.send(JSON.stringify(baseMsg('request-pair', { payload: { code } })));
      expect((await nextOf(wsA, (m) => m.type === 'error')).reason).toBe('invalid-code');
    } finally {
      wsA.close();
    }
  });

  test('7b. pairing E2E: code expirado falla por el protocolo real (TTL corto)', async () => {
    const relay = startRelay(new PairingStore(80)); // TTL 80 ms solo para este test
    const base = `http://127.0.0.1:${relay.port}`;
    const res = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const { code } = (await res.json()) as { code: string };
    await new Promise((r) => setTimeout(r, 150)); // deja que expire el TTL

    const a = generateIdentity();
    const wsA = await connect(relay.port);
    try {
      await nextOf(wsA, (m) => m.type === 'connected');
      await register(wsA, 'dev-a', a.publicKey);
      wsA.send(JSON.stringify(baseMsg('request-pair', { payload: { code } })));
      expect((await nextOf(wsA, (m) => m.type === 'error')).reason).toBe('invalid-code');
    } finally {
      wsA.close();
    }
  });

  test('7c. expiración a nivel de PairingStore (reloj inyectado)', () => {
    let t = 1_000_000;
    const store = new PairingStore(5 * 60 * 1000, () => t);
    const { code } = store.create();
    t += 5 * 60 * 1000 + 1; // pasado el TTL de 5 min
    expect(store.consume(code)).toBeNull();
  });

  test('8. replay a nivel relay: el relay REENVÍA el mismo envelope dos veces (sin deduplicar); el anti-replay lo hace el cliente', async () => {
    // CONTRATO FIJADO: el relay es un router opaco sin memoria de nonces:
    // validate() solo comprueba forma/tamaño/exp, nunca recuerda nonces.
    // Reenviar duplicados es el comportamiento esperado; detectar replays
    // (nonce/counter por emisor) es responsabilidad del CLIENTE receptor.
    const relay = startRelay();
    const { a, b, wsA, wsB } = await pair(relay);
    try {
      const plaintext = 'replay-me';
      const opaque = sealToOpaque(plaintext, b.publicKey, a.secretKey);
      const wire = JSON.stringify(
        baseMsg('signal', { nonce: 'fixed-nonce-replay', to: 'dev-b', payloadEncrypted: opaque }),
      );
      const first = nextOf(wsB, (m) => m.type === 'signal');
      wsA.send(wire);
      const got1 = await first;
      const second = nextOf(wsB, (m) => m.type === 'signal');
      wsA.send(wire); // mismo envelope, mismo nonce: replay exacto
      const got2 = await second;
      expect(got2.payloadEncrypted).toBe(got1.payloadEncrypted);
      // Ambos descifran igual: el relay no filtra el duplicado.
      expect(Buffer.from(openFromOpaque(got1.payloadEncrypted, b.secretKey)!).toString('utf8')).toBe(
        plaintext,
      );
      expect(Buffer.from(openFromOpaque(got2.payloadEncrypted, b.secretKey)!).toString('utf8')).toBe(
        plaintext,
      );
    } finally {
      wsA.close();
      wsB.close();
    }
  });
});
