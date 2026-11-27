import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { DeviceStore } from '../src/store';
import { PairingStore } from '../src/pairing';
import { RelayServer } from '../src/relay';
import { verifyDeviceRegisterSignature, hashDeviceToken } from '../src/device-auth';

const MASTER = 'master-test-token';
const PROVISION = 'provision-test-token';
const servers: RelayServer[] = [];
const stores: DeviceStore[] = [];
const sockets: WebSocket[] = [];

function startRelay(
  opts: {
    provisionToken?: string;
    claimPerDay?: number;
    claimBurstPerHour?: number;
    rotateGraceMs?: number;
    token?: string;
    now?: () => number;
  } = {},
): { relay: RelayServer; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'relay-device-auth-'));
  const store = new DeviceStore(dir);
  stores.push(store);
  const relay = new RelayServer({
    token: opts.token ?? MASTER,
    provisionToken: opts.provisionToken ?? PROVISION,
    claimPerDay: opts.claimPerDay,
    claimBurstPerHour: opts.claimBurstPerHour,
    rotateGraceMs: opts.rotateGraceMs,
    dataDir: dir,
    store,
    pairing: new PairingStore(),
    now: opts.now,
    version: '0.2.0',
  });
  relay.listen(0, '127.0.0.1');
  servers.push(relay);
  return { relay, dir };
}

afterEach(async () => {
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

function edKeys(): { pubB64: string; sec: Uint8Array } {
  const kp = nacl.sign.keyPair();
  return { pubB64: Buffer.from(kp.publicKey).toString('base64'), sec: kp.secretKey };
}

function signRegister(deviceId: string, ts: number, sec: Uint8Array): string {
  const msg = new Uint8Array(Buffer.from(`${deviceId}|${ts}`, 'utf8'));
  return Buffer.from(nacl.sign.detached(msg, sec)).toString('hex');
}

async function claim(
  port: number,
  body: unknown,
  provision: string | null = PROVISION,
  viaQuery = false,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let url = `http://127.0.0.1:${port}/api/device-claim`;
  if (provision !== null && !viaQuery) headers.authorization = `Bearer ${provision}`;
  if (provision !== null && viaQuery) url += `?token=${encodeURIComponent(provision)}`;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
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
    sockets.push(ws);
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

function tryOpen(url: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    ws.addEventListener('close', (e) => resolve(`close:${(e as CloseEvent).code}`));
    ws.addEventListener('open', () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve('open');
    });
    ws.addEventListener('error', () => resolve('error'));
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve('timeout');
    }, timeoutMs);
  });
}

describe('device-auth (per-device tokens)', () => {
  test('GET /api/caps público -> {deviceAuth:true, version}', async () => {
    const { relay } = startRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/caps`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deviceAuth: true, version: '0.2.0' });
  });

  test('claim deshabilitado sin provisionToken -> 503 claim-disabled', async () => {
    const { relay } = startRelay({ provisionToken: '' });
    const res = await claim(relay.port, { deviceId: 'd1', pubKey: edKeys().pubB64 }, null);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'claim-disabled' });
  });

  test('claim sin credencial -> 401 provision-required; mala -> 401 bad-provision', async () => {
    const { relay } = startRelay();
    const k = edKeys();
    const noCred = await claim(relay.port, { deviceId: 'd1', pubKey: k.pubB64 }, null);
    expect(noCred.status).toBe(401);
    expect(await noCred.json()).toEqual({ error: 'provision-required' });
    const bad = await claim(relay.port, { deviceId: 'd1', pubKey: k.pubB64 }, 'wrong-provision');
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: 'bad-provision' });
  });

  test('claim acepta provision por ?token= y valida body -> 400 bad-device/bad-pubkey', async () => {
    const { relay } = startRelay();
    const k = edKeys();
    const viaQuery = await claim(relay.port, { deviceId: 'dq', pubKey: k.pubB64 }, PROVISION, true);
    expect(viaQuery.status).toBe(200);
    expect(await viaQuery.json()).toMatchObject({});
    for (const badDevice of ['', 'x'.repeat(129)]) {
      const res = await claim(relay.port, { deviceId: badDevice, pubKey: k.pubB64 });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad-device' });
    }
    for (const badPub of ['', 'no-base64!!!', Buffer.from([1, 2, 3]).toString('base64')]) {
      const res = await claim(relay.port, { deviceId: 'd1', pubKey: badPub });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad-pubkey' });
    }
  });

  test('claim ok -> {deviceToken} 64 hex, persiste en dataDir y otro relay lo acepta', async () => {
    const { relay, dir } = startRelay();
    const k = edKeys();
    const res = await claim(relay.port, { deviceId: 'dev-persist', pubKey: k.pubB64 });
    expect(res.status).toBe(200);
    const { deviceToken } = (await res.json()) as { deviceToken: string };
    expect(deviceToken).toMatch(/^[0-9a-f]{64}$/);
    // Persistencia atómica en dataDir (solo hashes, jamás el token plano).
    const file = join(dir, 'device-tokens.json');
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(deviceToken);
    const doc = JSON.parse(raw) as { tokens: Record<string, any> };
    expect(doc.tokens[hashDeviceToken(deviceToken)]).toMatchObject({ deviceId: 'dev-persist' });
    // Segundo relay con el mismo dataDir acepta el token (supervivencia a reinicio).
    relay.stop();
    servers.splice(servers.indexOf(relay), 1);
    const store2 = new DeviceStore(dir);
    stores.push(store2);
    const relay2 = new RelayServer({
      token: MASTER,
      provisionToken: PROVISION,
      dataDir: dir,
      store: store2,
      pairing: new PairingStore(),
      version: '0.2.0',
    });
    relay2.listen(0, '127.0.0.1');
    servers.push(relay2);
    const ws = await connect(relay2.port, deviceToken);
    try {
      await nextOf(ws, (m) => m.type === 'connected');
    } finally {
      ws.close();
    }
  });

  test('WS upgrade: sin token -> 401 auth-required; malo -> 401 invalid-token (JSON)', async () => {
    const { relay } = startRelay();
    const probe = `http://127.0.0.1:${relay.port}/__auth_probe`;
    const noTok = await fetch(probe);
    expect(noTok.status).toBe(401);
    expect(await noTok.json()).toEqual({ error: 'auth-required' });
    const bad = await fetch(`${probe}?token=token-malo`);
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: 'invalid-token' });
    // Y el upgrade WS se rechaza en ambos casos; con master abre.
    expect(await tryOpen(`ws://127.0.0.1:${relay.port}/`)).not.toBe('open');
    expect(await tryOpen(`ws://127.0.0.1:${relay.port}/?token=token-malo`)).not.toBe('open');
    expect(await tryOpen(`ws://127.0.0.1:${relay.port}/?token=${MASTER}`)).toBe('open');
  });

  test('revoke propio: el token se invalida y el socket abierto se cierra', async () => {
    const { relay } = startRelay();
    const k = edKeys();
    const { deviceToken } = (await (await claim(relay.port, { deviceId: 'dev-rev', pubKey: k.pubB64 })).json()) as {
      deviceToken: string;
    };
    const ws = await connect(relay.port, deviceToken);
    await nextOf(ws, (m) => m.type === 'connected');
    const closed = new Promise((r) => ws.addEventListener('close', r, { once: true }));
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/device-revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    await closed;
    const probe = await fetch(`http://127.0.0.1:${relay.port}/__auth_probe?token=${deviceToken}`);
    expect(probe.status).toBe(401);
    expect(await probe.json()).toEqual({ error: 'invalid-token' });
    expect(await tryOpen(`ws://127.0.0.1:${relay.port}/?token=${deviceToken}`)).not.toBe('open');
  });

  test('revoke master con {deviceId} revoca todos los tokens del dispositivo', async () => {
    const { relay } = startRelay();
    const k = edKeys();
    const t1 = (
      (await (await claim(relay.port, { deviceId: 'dev-multi', pubKey: k.pubB64 })).json()) as { deviceToken: string }
    ).deviceToken;
    const t2 = (
      (await (await claim(relay.port, { deviceId: 'dev-multi', pubKey: k.pubB64 })).json()) as { deviceToken: string }
    ).deviceToken;
    expect(t1).not.toBe(t2);
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/device-revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-multi' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(await tryOpen(`ws://127.0.0.1:${relay.port}/?token=${t1}`)).not.toBe('open');
    expect(await tryOpen(`ws://127.0.0.1:${relay.port}/?token=${t2}`)).not.toBe('open');
  });

  test('rotate: token nuevo válido, viejo en gracia y luego muerto', async () => {
    const { relay } = startRelay({ rotateGraceMs: 250 });
    const k = edKeys();
    const { deviceToken: old } = (await (await claim(relay.port, { deviceId: 'dev-rot', pubKey: k.pubB64 })).json()) as {
      deviceToken: string;
    };
    const rot = await fetch(`http://127.0.0.1:${relay.port}/api/device-rotate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${old}` },
    });
    expect(rot.status).toBe(200);
    const { deviceToken: fresh } = (await rot.json()) as { deviceToken: string };
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh).not.toBe(old);
    // En gracia: ambos abren.
    expect(await tryOpen(`ws://127.0.0.1:${relay.port}/?token=${old}`)).toBe('open');
    expect(await tryOpen(`ws://127.0.0.1:${relay.port}/?token=${fresh}`)).toBe('open');
    await new Promise((r) => setTimeout(r, 450));
    expect(await tryOpen(`ws://127.0.0.1:${relay.port}/?token=${old}`)).not.toBe('open');
    expect(await tryOpen(`ws://127.0.0.1:${relay.port}/?token=${fresh}`)).toBe('open');
  });

  test('tunnel-register: master legacy aceptado; device exige firma ed25519', async () => {
    const { relay } = startRelay();
    // Master: legacy sin firma.
    const m = await connect(relay.port, MASTER);
    m.send(JSON.stringify({ v: 1, kind: 'tunnel-register', deviceId: 'daemon-legacy' }));
    expect(await nextOf(m, (x) => x.kind === 'tunnel-registered')).toMatchObject({ deviceId: 'daemon-legacy' });

    // Device: claim + conexión ligada.
    const k = edKeys();
    const deviceId = 'daemon-signed';
    const { deviceToken } = (await (await claim(relay.port, { deviceId, pubKey: k.pubB64 })).json()) as {
      deviceToken: string;
    };
    const ws = await connect(relay.port, deviceToken);
    await nextOf(ws, (x) => x.type === 'connected');

    // Sin firma -> bad-register y bloqueo de kind: posteriores.
    ws.send(JSON.stringify({ v: 1, kind: 'tunnel-register', deviceId }));
    expect(await nextOf(ws, (x) => x.kind === 'error')).toMatchObject({ error: 'bad-register' });
    (ws as any)._buf.length = 0;
    ws.send(JSON.stringify({ v: 1, kind: 'ui-publish', urlCode: 'signed-code-abc123', exp: Date.now() + 600_000 }));
    await new Promise((r) => setTimeout(r, 300));
    expect((ws as any)._buf as any[]).toHaveLength(0);

    // deviceId ajeno -> bad-register.
    ws.send(JSON.stringify({ v: 1, kind: 'tunnel-register', deviceId: 'otro', ts: Date.now(), sig: 'ab'.repeat(64) }));
    expect(await nextOf(ws, (x) => x.kind === 'error')).toMatchObject({ error: 'bad-register' });

    // ts rancio -> bad-register.
    const staleTs = Date.now() - 10 * 60_000;
    ws.send(
      JSON.stringify({ v: 1, kind: 'tunnel-register', deviceId, ts: staleTs, sig: signRegister(deviceId, staleTs, k.sec) }),
    );
    expect(await nextOf(ws, (x) => x.kind === 'error')).toMatchObject({ error: 'bad-register' });

    // Firma manipulada -> bad-register.
    const ts = Date.now();
    const good = signRegister(deviceId, ts, k.sec);
    const tampered = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
    ws.send(JSON.stringify({ v: 1, kind: 'tunnel-register', deviceId, ts, sig: tampered }));
    expect(await nextOf(ws, (x) => x.kind === 'error')).toMatchObject({ error: 'bad-register' });

    // Válido -> tunnel-registered y el bloqueo se levanta (ui-publish funciona).
    const ts2 = Date.now();
    ws.send(JSON.stringify({ v: 1, kind: 'tunnel-register', deviceId, ts: ts2, sig: signRegister(deviceId, ts2, k.sec) }));
    expect(await nextOf(ws, (x) => x.kind === 'tunnel-registered')).toMatchObject({ deviceId });
    ws.send(JSON.stringify({ v: 1, kind: 'ui-publish', urlCode: 'signed-code-abc123', exp: Date.now() + 600_000 }));
    expect(await nextOf(ws, (x) => x.kind === 'ui-published')).toMatchObject({ urlCode: 'signed-code-abc123' });
  });

  test('rate-limit de claim: ráfaga/hora -> 429 con retryAfterMs', async () => {
    const { relay } = startRelay({ claimPerDay: 10, claimBurstPerHour: 2 });
    const k = edKeys();
    for (let i = 0; i < 2; i++) {
      const res = await claim(relay.port, { deviceId: `dev-rl-${i}`, pubKey: k.pubB64 });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    const limited = await claim(relay.port, { deviceId: 'dev-rl-x', pubKey: k.pubB64 });
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: string; retryAfterMs: number };
    expect(body.error).toBe('rate-limited');
    expect(typeof body.retryAfterMs).toBe('number');
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  test('lastSeen se refresca al usar el token', async () => {
    const { relay, dir } = startRelay();
    const k = edKeys();
    const { deviceToken } = (await (await claim(relay.port, { deviceId: 'dev-seen', pubKey: k.pubB64 })).json()) as {
      deviceToken: string;
    };
    const read = (): any => JSON.parse(readFileSync(join(dir, 'device-tokens.json'), 'utf8'));
    const before = read().tokens[hashDeviceToken(deviceToken)].lastSeen as number;
    await new Promise((r) => setTimeout(r, 15));
    const ws = await connect(relay.port, deviceToken);
    try {
      await nextOf(ws, (m) => m.type === 'connected');
    } finally {
      ws.close();
    }
    const after = read().tokens[hashDeviceToken(deviceToken)].lastSeen as number;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test('verify helper (tweetnacl sign): vector autogenerado, tamper falla, ts rancio falla', () => {
    const kp = nacl.sign.keyPair();
    const pubB64 = Buffer.from(kp.publicKey).toString('base64');
    const deviceId = 'dev-sig-unit';
    const now = 1_700_000_000_000;
    const msg = new Uint8Array(Buffer.from(`${deviceId}|${now}`, 'utf8'));
    const sigHex = Buffer.from(nacl.sign.detached(msg, kp.secretKey)).toString('hex');
    expect(verifyDeviceRegisterSignature({ deviceId, ts: now, sigHex, pubKeyB64: pubB64, now })).toBe(true);
    // Mensaje manipulado.
    expect(
      verifyDeviceRegisterSignature({ deviceId: 'dev-otro', ts: now, sigHex, pubKeyB64: pubB64, now }),
    ).toBe(false);
    // Firma manipulada.
    const badSig = sigHex.slice(0, -1) + (sigHex.endsWith('0') ? '1' : '0');
    expect(verifyDeviceRegisterSignature({ deviceId, ts: now, sigHex: badSig, pubKeyB64: pubB64, now })).toBe(false);
    // ts fuera de ±5 min.
    expect(
      verifyDeviceRegisterSignature({ deviceId, ts: now - 6 * 60_000, sigHex, pubKeyB64: pubB64, now }),
    ).toBe(false);
    expect(
      verifyDeviceRegisterSignature({ deviceId, ts: now + 6 * 60_000, sigHex, pubKeyB64: pubB64, now }),
    ).toBe(false);
    // Dentro del margen vale.
    const tsOk = now - 4 * 60_000;
    const msgOk = new Uint8Array(Buffer.from(`${deviceId}|${tsOk}`, 'utf8'));
    const sigOk = Buffer.from(nacl.sign.detached(msgOk, kp.secretKey)).toString('hex');
    expect(verifyDeviceRegisterSignature({ deviceId, ts: tsOk, sigHex: sigOk, pubKeyB64: pubB64, now })).toBe(true);
    // PubKey ajena falla.
    const other = nacl.sign.keyPair();
    expect(
      verifyDeviceRegisterSignature({
        deviceId,
        ts: now,
        sigHex,
        pubKeyB64: Buffer.from(other.publicKey).toString('base64'),
        now,
      }),
    ).toBe(false);
  });
});
