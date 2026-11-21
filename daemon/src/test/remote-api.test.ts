/**
 * remote-api.test.ts — REST remoto E2E (handlers directos, DB real temporal).
 *
 * Cubre: pair-code/pair-accept, devices/revoke, rotate, policy,
 * matriz allowlist vía POST /inbox, replay/exp/seq y flujo E2E dos
 * daemons lógicos (A→B vía POST /send + entrega manual en /inbox).
 *
 * Aislamiento: LIBREDECK_DATA_DIR temporal por test (patrón
 * elgato-host.test.ts) + replay store en memoria fresco por test.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-remote-api-test-'));
process.env.LIBREDECK_DATA_DIR = ROOT;

import { initDatabase, DatabaseService } from '../db';
import { handleRemote } from '../api/remote';
import { getIdentity } from '../remote/identity';
import {
  encryptTo,
  resetLocalSeq,
  resetReplay,
  configureReplayStore,
  generateKeyPair,
} from '../remote/crypto';
import { acceptInvite } from '../remote/pairing';
import { DEFAULT_POLICY } from '../remote/remote-actions';

let db: DatabaseService;
let services: any;
let uidCounter = 0;
/** Sufijo único por test: evita colisiones aunque dos tests compartan DB. */
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function freshReplayStore() {
  const seq = new Map<string, number>();
  const nonces = new Set<string>();
  return {
    getSeq: (p: string) => seq.get(p) ?? -1,
    setSeq: (p: string, s: number) => { seq.set(p, s); },
    hasNonce: (n: string) => nonces.has(n),
    addNonce: (n: string) => { nonces.add(n); },
  };
}

function makeServices(extraRunner?: any): any {
  return {
    wsManager: { broadcast: () => {} },
    actionRunner: extraRunner ?? {
      executeAction: async (a: any) => ({ success: true, action: a?.type ?? '?' }),
    },
    pluginLoader: {},
    windowWatcher: {},
  };
}

async function remoteCall(d: DatabaseService, s: any, p: string, method: string, body?: any) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://localhost:3001${p}`, init);
  const res = await handleRemote(req, {
    url: new URL(`http://localhost:3001${p}`),
    method,
    path: p,
    db: d,
    services: s,
  });
  if (!res) throw new Error(`sin handler para ${method} ${p}`);
  let json: any = {};
  try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, body: json };
}

function trustPeerDirect(d: DatabaseService, peerId: string, peerPub: string, allowed = [...DEFAULT_POLICY]) {
  return acceptInvite(d, { code: '123456', remoteDeviceId: peerId, remotePubKey: peerPub, name: peerId.slice(0, 8), allowedActions: allowed });
}

function peerKeys() {
  const kp = generateKeyPair();
  return { id: `peer-${Math.random().toString(36).slice(2, 8)}`, pub: kp.publicKeyB64, priv: kp.secretKeyB64 };
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 't-'));
  process.env.LIBREDECK_DATA_DIR = dir;
  await initDatabase();
  db = new DatabaseService();
  services = makeServices();
  resetReplay();
  resetLocalSeq();
  configureReplayStore(freshReplayStore());
  try { delete (globalThis as any).__libredeckRemote; } catch { /* noop */ }
});

// ---------- 1. pair-code / pair-accept ----------

describe('remote-api: pair-code / pair-accept', () => {
  it('POST pair-code devuelve {code, fingerprint, publicKey}', async () => {
    const r = await remoteCall(db, services, '/api/v1/remote/pair-code', 'POST', {});
    expect(r.status).toBe(200);
    expect(r.body.code).toMatch(/^\d{6}$/);
    expect(typeof r.body.fingerprint).toBe('string');
    expect(r.body.fingerprint.length).toBeGreaterThan(0);
    expect(typeof r.body.publicKey).toBe('string');
    expect(typeof r.body.deviceId).toBe('string');
  });

  it('POST pair-accept válido registra trusted; pending es de un solo uso', async () => {
    const pc = await remoteCall(db, services, '/api/v1/remote/pair-code', 'POST', {});
    const code = pc.body.code as string;
    expect(db.getSetting(`remote.pending.${code}`)).not.toBeNull();

    const peer = peerKeys();
    const acc = await remoteCall(db, services, '/api/v1/remote/pair-accept', 'POST', {
      code, remoteDeviceId: peer.id, remotePubKey: peer.pub, name: 'Móvil',
    });
    expect(acc.status).toBe(200);
    expect(acc.body.ok).toBe(true);
    // Pending consumido (un solo uso)
    expect(db.getSetting(`remote.pending.${code}`)).toBeNull();

    const devs = await remoteCall(db, services, '/api/v1/remote/devices', 'GET');
    expect(devs.body.devices.some((d: any) => d.deviceId === peer.id)).toBe(true);
  });

  it('POST pair-accept con formato inválido → 400', async () => {
    for (const bad of ['abc', '123', '', '1234567', '12 345']) {
      const r = await remoteCall(db, services, '/api/v1/remote/pair-accept', 'POST', {
        code: bad, remoteDeviceId: 'x', remotePubKey: 'y',
      });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/inválido|dígitos/i);
    }
  });

  it('POST pair-accept sin identidad remota → 400', async () => {
    const pc = await remoteCall(db, services, '/api/v1/remote/pair-code', 'POST', {});
    const r1 = await remoteCall(db, services, '/api/v1/remote/pair-accept', 'POST', {
      code: pc.body.code, remoteDeviceId: '', remotePubKey: '',
    });
    expect(r1.status).toBe(400);
    const r2 = await remoteCall(db, services, '/api/v1/remote/pair-accept', 'POST', {
      code: '999999',
    });
    expect(r2.status).toBe(400);
  });

  it('POST pair-accept con código caducado → 400', async () => {
    const pc = await remoteCall(db, services, '/api/v1/remote/pair-code', 'POST', {});
    const code = pc.body.code as string;
    const raw = db.getSetting(`remote.pending.${code}`)!;
    const p = JSON.parse(raw);
    p.expiresAt = Date.now() - 1000;
    db.setSetting(`remote.pending.${code}`, JSON.stringify(p));
    const peer = peerKeys();
    const r = await remoteCall(db, services, '/api/v1/remote/pair-accept', 'POST', {
      code, remoteDeviceId: peer.id, remotePubKey: peer.pub,
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/caducado/i);
  });
});

// ---------- 2/3/4. devices / rotate / policy ----------

describe('remote-api: devices / rotate / policy', () => {
  it('GET /devices lista trusted', async () => {
    const a = peerKeys(); const b = peerKeys();
    trustPeerDirect(db, a.id, a.pub);
    trustPeerDirect(db, b.id, b.pub);
    const r = await remoteCall(db, services, '/api/v1/remote/devices', 'GET');
    expect(r.status).toBe(200);
    const ids = (r.body.devices as any[]).map((d) => d.deviceId);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    for (const d of (r.body.devices as any[]).filter((d) => d.deviceId === a.id || d.deviceId === b.id)) {
      expect(d.pubKeyPrefix.length).toBeGreaterThan(0);
      expect(d.revoked).toBe(false);
    }
  });

  it('DELETE /devices/:id revoca (clave borrada, revoked) y bloquea send/inbox', async () => {
    const peer = peerKeys();
    trustPeerDirect(db, peer.id, peer.pub);
    const me = getIdentity(db);

    const del = await remoteCall(db, services, `/api/v1/remote/devices/${peer.id}`, 'DELETE');
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const stored = JSON.parse(db.getSetting(`remote.trusted.${peer.id}`)!);
    expect(stored.pubKey).toBe('');
    expect(stored.revoked).toBe(true);

    const devs = await remoteCall(db, services, '/api/v1/remote/devices', 'GET');
    const row = devs.body.devices.find((d: any) => d.deviceId === peer.id);
    expect(row.revoked).toBe(true);
    expect(row.pubKeyPrefix).toBe('');

    // send posterior falla
    const send = await remoteCall(db, services, '/api/v1/remote/send', 'POST', {
      to: peer.id, type: 'page.select', params: { pageId: 'p1' },
    });
    expect(send.status).toBe(400);
    expect(String(send.body.error)).toMatch(/no emparejado/i);

    // inbox posterior denegado
    const env = encryptTo(me.publicKeyB64, peer.priv, peer.id, me.deviceId, { type: 'page.select', params: { pageId: 'p1' } });
    const inbox = await remoteCall(db, services, '/api/v1/remote/inbox', 'POST', { envelope: env });
    expect(inbox.status).toBe(400);
    expect(String(inbox.body.error)).toMatch(/no emparejado|revocado/i);

    // DELETE de desconocido → 404
    const missing = await remoteCall(db, services, '/api/v1/remote/devices/nope', 'DELETE');
    expect(missing.status).toBe(404);
  });

  it('POST /rotate cambia publicKey, conserva deviceId e invalida sobres viejos', async () => {
    const before = getIdentity(db);
    const peer = peerKeys();
    trustPeerDirect(db, peer.id, peer.pub);
    const prof = uid('prof'); const page = uid('page'); const seqKey = `remote.seq.${uid('peer')}`;
    db.createProfile({ id: prof, name: 'R', data: {} });
    db.createPage({ id: page, profile_id: prof, name: uid('Main'), order_idx: 0, is_folder: 0, data: {} });
    db.setSetting(seqKey, '5');

    // Sobre válido con la clave vieja (se entrega tras rotar → debe fallar al abrir)
    const oldEnv = encryptTo(before.publicKeyB64, peer.priv, peer.id, before.deviceId, {
      type: 'page.select', params: { pageId: page },
    });

    const r = await remoteCall(db, services, '/api/v1/remote/rotate', 'POST', {});
    expect(r.status).toBe(200);
    expect(r.body.publicKey).not.toBe(before.publicKeyB64);
    expect(r.body.deviceId).toBe(before.deviceId);
    expect(r.body.fingerprint).not.toBe(before.fingerprint);
    // Contadores antiguos purgados
    expect(db.getSetting(seqKey)).toBeNull();

    const inboxOld = await remoteCall(db, services, '/api/v1/remote/inbox', 'POST', { envelope: oldEnv });
    expect(inboxOld.body.ok ?? false).toBe(false);

    // Con la clave nueva sí funciona (el peer re-cifra a la nueva pub)
    const after = getIdentity(db);
    expect(after.publicKeyB64).toBe(r.body.publicKey);
    resetLocalSeq();
    configureReplayStore(freshReplayStore());
    const newEnv = encryptTo(after.publicKeyB64, peer.priv, peer.id, after.deviceId, {
      type: 'page.select', params: { pageId: page },
    });
    const inboxNew = await remoteCall(db, services, '/api/v1/remote/inbox', 'POST', { envelope: newEnv });
    expect(inboxNew.body.ok).toBe(true);
  });

  it('PUT /policy restringe allowedActions; send fuera de política → denegado', async () => {
    const peer = peerKeys();
    trustPeerDirect(db, peer.id, peer.pub); // DEFAULT_POLICY completa
    const put = await remoteCall(db, services, '/api/v1/remote/policy', 'PUT', {
      deviceId: peer.id, allowedActions: ['page.select'],
    });
    expect(put.status).toBe(200);
    expect(put.body.allowedActions).toEqual(['page.select']);

    // send con acción fuera de política → 403
    const send = await remoteCall(db, services, '/api/v1/remote/send', 'POST', {
      to: peer.id, type: 'button.press', params: { buttonId: 'b1' },
    });
    expect(send.status).toBe(403);
    expect(String(send.body.error)).toMatch(/política/i);

    // inbox con acción fuera de política → ok:false
    const me = getIdentity(db);
    const env = encryptTo(me.publicKeyB64, peer.priv, peer.id, me.deviceId, {
      type: 'button.press', params: { buttonId: 'b1' },
    });
    const inbox = await remoteCall(db, services, '/api/v1/remote/inbox', 'POST', { envelope: env });
    expect(inbox.body.ok).toBe(false);
    expect(String(inbox.body.error ?? '')).toMatch(/política/i);

    // PUT con acción no allowlist → 400
    const bad = await remoteCall(db, services, '/api/v1/remote/policy', 'PUT', {
      deviceId: peer.id, allowedActions: ['shell.exec'],
    });
    expect(bad.status).toBe(400);
  });
});

// ---------- 5. matriz allowlist vía /inbox ----------

describe('remote-api: matriz allowlist vía /inbox', () => {
  function seedPageProfileButton() {
    const prof = uid('prof'); const page = uid('page'); const btn = uid('btn');
    db.createProfile({ id: prof, name: 'P', data: {} });
    db.createPage({ id: page, profile_id: prof, name: uid('Main'), order_idx: 0, is_folder: 0, data: {} });
    db.createButton({ id: btn, page_id: page, position: 0, data: { actions: [{ type: 'utility.delay', parameters: { delay: 1 } }] } as any });
    return { prof, page, btn };
  }

  async function inboxAs(peer: { id: string; pub: string; priv: string }, type: string, params: any) {
    const me = getIdentity(db);
    const env = encryptTo(me.publicKeyB64, peer.priv, peer.id, me.deviceId, { type, params });
    return remoteCall(db, services, '/api/v1/remote/inbox', 'POST', { envelope: env });
  }

  it('permitidas → ok:true (page/profile/button existente, obs.scene, multimedia.*)', async () => {
    const { prof, page, btn } = seedPageProfileButton();
    const peer = peerKeys();
    trustPeerDirect(db, peer.id, peer.pub);
    expect((await inboxAs(peer, 'page.select', { pageId: page })).body.ok).toBe(true);
    expect((await inboxAs(peer, 'profile.select', { profileId: prof })).body.ok).toBe(true);
    expect((await inboxAs(peer, 'button.press', { buttonId: btn })).body.ok).toBe(true);
    expect((await inboxAs(peer, 'obs.scene', { scene: 'Live' })).body.ok).toBe(true);
    expect((await inboxAs(peer, 'multimedia.play', {})).body.ok).toBe(true);
    expect((await inboxAs(peer, 'multimedia.pause', {})).body.ok).toBe(true);
  });

  it('bloqueadas por defecto → mensaje claro (shell/http/open-app/browser/hotkey/type-text)', async () => {
    const peer = peerKeys();
    // Registro directo con política que pide bloqueadas: el motor las deniega igual.
    trustPeerDirect(db, peer.id, peer.pub, [
      'shell.exec', 'http.request', 'open-app.open', 'browser.open', 'hotkey.press', 'type-text.type', 'page.select',
    ]);
    const blocked = ['shell.exec', 'http.request', 'open-app.open', 'browser.open', 'hotkey.press', 'type-text.type'];
    for (const t of blocked) {
      const r = await inboxAs(peer, t, {});
      expect(r.body.ok).toBe(false);
      expect(String(r.body.error ?? '')).toMatch(/bloqueada|no permitida/i);
    }
    // También /send las rechaza antes de cifrar
    const s = await remoteCall(db, services, '/api/v1/remote/send', 'POST', { to: peer.id, type: 'shell.exec', params: {} });
    expect(s.status).toBe(400);
  });

  it('button.press inexistente → error; peer desconocido → denegado', async () => {
    const { page } = seedPageProfileButton();
    const peer = peerKeys();
    trustPeerDirect(db, peer.id, peer.pub);
    const badBtn = await inboxAs(peer, 'button.press', { buttonId: 'no-existe' });
    expect(badBtn.body.ok).toBe(false);
    expect(String(badBtn.body.error ?? '')).toMatch(/inexistente/i);

    const ghost = peerKeys();
    const me = getIdentity(db);
    const env = encryptTo(me.publicKeyB64, ghost.priv, ghost.id, me.deviceId, { type: 'page.select', params: { pageId: page } });
    const r = await remoteCall(db, services, '/api/v1/remote/inbox', 'POST', { envelope: env });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/no emparejado/i);
  });
});

// ---------- 6. replay / exp / seq ----------

describe('remote-api: replay / exp / seq', () => {
  function seedPage() {
    const prof = uid('prof'); const page = uid('page');
    db.createProfile({ id: prof, name: 'P', data: {} });
    db.createPage({ id: page, profile_id: prof, name: uid('Main'), order_idx: 0, is_folder: 0, data: {} });
    return page;
  }

  it('mismo envelope dos veces → segunda denegada (nonce visto)', async () => {
    const page = seedPage();
    const peer = peerKeys();
    trustPeerDirect(db, peer.id, peer.pub);
    const me = getIdentity(db);
    const env = encryptTo(me.publicKeyB64, peer.priv, peer.id, me.deviceId, { type: 'page.select', params: { pageId: page } });
    const first = await remoteCall(db, services, '/api/v1/remote/inbox', 'POST', { envelope: env });
    expect(first.body.ok).toBe(true);
    const second = await remoteCall(db, services, '/api/v1/remote/inbox', 'POST', { envelope: env });
    expect(second.status).toBe(400);
    expect(String(second.body.error)).toMatch(/replay|nonce/i);
  });

  it('envelope expirado (>5min) → denegado', async () => {
    const page = seedPage();
    const peer = peerKeys();
    trustPeerDirect(db, peer.id, peer.pub);
    const me = getIdentity(db);
    const env = encryptTo(me.publicKeyB64, peer.priv, peer.id, me.deviceId, { type: 'page.select', params: { pageId: page } }, { ts: Date.now() - 10 * 60 * 1000 });
    const r = await remoteCall(db, services, '/api/v1/remote/inbox', 'POST', { envelope: env });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/expirado/i);
  });

  it('counter desordenado según contrato configureReplayStore → viejo rechazado', async () => {
    const page = seedPage();
    const peer = peerKeys();
    trustPeerDirect(db, peer.id, peer.pub);
    const me = getIdentity(db);
    const e1 = encryptTo(me.publicKeyB64, peer.priv, peer.id, me.deviceId, { type: 'page.select', params: { pageId: page } });
    const e2 = encryptTo(me.publicKeyB64, peer.priv, peer.id, me.deviceId, { type: 'page.select', params: { pageId: page } });
    expect(e2.seq).toBeGreaterThan(e1.seq);
    const okNew = await remoteCall(db, services, '/api/v1/remote/inbox', 'POST', { envelope: e2 });
    expect(okNew.body.ok).toBe(true);
    const old = await remoteCall(db, services, '/api/v1/remote/inbox', 'POST', { envelope: e1 });
    expect(old.status).toBe(400);
    expect(String(old.body.error)).toMatch(/replay|seq/i);
  });
});

// ---------- 7. E2E dos daemons lógicos ----------

describe('remote-api: E2E dos daemons (A→B sin relay)', () => {
  it('pair-code en A, pair-accept en B, send A→B, inbox en B ejecuta page.select real', async () => {
    // Daemon A
    const dirA = fs.mkdtempSync(path.join(ROOT, 'e2e-a-'));
    process.env.LIBREDECK_DATA_DIR = dirA;
    await initDatabase();
    const dbA = new DatabaseService();
    const idA = getIdentity(dbA);

    // Daemon B
    const dirB = fs.mkdtempSync(path.join(ROOT, 'e2e-b-'));
    process.env.LIBREDECK_DATA_DIR = dirB;
    await initDatabase();
    const dbB = new DatabaseService();
    const idB = getIdentity(dbB);

    resetLocalSeq();
    configureReplayStore(freshReplayStore());
    const svcA = makeServices();
    const svcB = makeServices();

    // pair-code en A (REST real)
    const pc = await remoteCall(dbA, svcA, '/api/v1/remote/pair-code', 'POST', {});
    expect(pc.body.code).toMatch(/^\d{6}$/);

    // pair-accept en B con la identidad de A (canal out-of-band: QR)
    const accB = await remoteCall(dbB, svcB, '/api/v1/remote/pair-accept', 'POST', {
      code: pc.body.code, remoteDeviceId: idA.deviceId, remotePubKey: idA.publicKeyB64, name: 'DaemonA',
    });
    expect(accB.body.ok).toBe(true);

    // A confía en B para poder cifrar hacia él
    const accA = await remoteCall(dbA, svcA, '/api/v1/remote/pair-accept', 'POST', {
      code: '123456', remoteDeviceId: idB.deviceId, remotePubKey: idB.publicKeyB64, name: 'DaemonB',
    });
    expect(accA.body.ok).toBe(true);

    // Página real en B
    const e2ePage = uid('page');
    dbB.createProfile({ id: uid('prof'), name: 'E2E', data: {} });
    const e2eProf = dbB.getProfiles().find((p) => p.name === 'E2E')!;
    dbB.createPage({ id: e2ePage, profile_id: e2eProf.id, name: uid('Main'), order_idx: 0, is_folder: 0, data: {} });

    // send A→B (sin relay: devuelve envelope)
    const send = await remoteCall(dbA, svcA, '/api/v1/remote/send', 'POST', {
      to: idB.deviceId, type: 'page.select', params: { pageId: e2ePage },
    });
    expect(send.body.ok).toBe(true);
    expect(send.body.sent).toBe(false);
    expect(send.body.envelope?.ciphertext).toBeTruthy();

    // entrega manual en B
    const inbox = await remoteCall(dbB, svcB, '/api/v1/remote/inbox', 'POST', { envelope: send.body.envelope });
    expect(inbox.body.ok).toBe(true);
    expect(dbB.getSetting('current.page_id')).toBe(e2ePage);
  });
});
