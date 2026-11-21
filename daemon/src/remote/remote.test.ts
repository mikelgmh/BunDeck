import { describe, it, expect, beforeEach } from 'bun:test';
import {
  generateKeyPair, encryptTo, decryptFrom, fingerprint,
  resetReplay, resetLocalSeq, configureReplayStore,
} from '../remote/crypto';
import { getIdentity, rotateKeys } from '../remote/identity';
import { generatePairCode, acceptInvite, listDevices, revokeDevice, updatePolicy } from '../remote/pairing';
import { checkRemotePermission, executeRemoteAction, DEFAULT_POLICY } from '../remote/remote-actions';

/** Fake mínima de DatabaseService (settings + logs + páginas/botones). */
function makeDb() {
  const settings = new Map<string, string>();
  const logs: any[] = [];
  return {
    settings,
    logs,
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string) => { settings.set(k, v); },
    deleteSetting: (k: string) => { settings.delete(k); },
    getAllSettings: () => Object.fromEntries(settings),
    addLog: (e: any) => { logs.push(e); },
    getPage: (_id: string) => null as any,
    getProfile: (_id: string) => null as any,
    getButton: (_id: string) => null as any,
    setCurrentPage: (_id: string) => {},
    setCurrentProfile: (_id: string) => {},
  } as any;
}

beforeEach(() => {
  resetReplay();
  resetLocalSeq();
  configureReplayStore((() => {
    const seq = new Map<string, number>();
    const nonces = new Set<string>();
    return {
      getSeq: (p: string) => seq.get(p) ?? -1,
      setSeq: (p: string, s: number) => { seq.set(p, s); },
      hasNonce: (n: string) => nonces.has(n),
      addNonce: (n: string) => { nonces.add(n); },
    };
  })());
});

describe('remote crypto (NaCl box E2E)', () => {
  it('roundtrip: A cifra → B descifra el comando intacto', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const env = encryptTo(b.publicKeyB64, a.secretKeyB64, 'devA', 'devB', { type: 'page.select', params: { pageId: 'p1' } });
    expect(env.from).toBe('devA');
    expect(env.to).toBe('devB');
    expect(typeof env.nonce).toBe('string');
    const cmd = decryptFrom(a.publicKeyB64, b.secretKeyB64, env);
    expect(cmd.type).toBe('page.select');
    expect((cmd.params as any).pageId).toBe('p1');
  });

  it('fingerprint estable y legible', () => {
    const a = generateKeyPair();
    expect(fingerprint(a.publicKeyB64)).toBe(fingerprint(a.publicKeyB64));
    expect(fingerprint(a.publicKeyB64)).toMatch(/^([0-9a-f]{4}:){7}[0-9a-f]{4}$/);
  });

  it('replay: el mismo envelope dos veces → rechaza el segundo', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const env = encryptTo(b.publicKeyB64, a.secretKeyB64, 'devA', 'devB', { type: 'button.press', params: { buttonId: 'x' } });
    decryptFrom(a.publicKeyB64, b.secretKeyB64, env);
    expect(() => decryptFrom(a.publicKeyB64, b.secretKeyB64, env)).toThrow(/replay/i);
  });

  it('exp: envelope viejo (>5min) → rechaza', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const env = encryptTo(b.publicKeyB64, a.secretKeyB64, 'devA', 'devB', { type: 'page.select' }, { ts: Date.now() - 10 * 60 * 1000 });
    expect(() => decryptFrom(a.publicKeyB64, b.secretKeyB64, env, { now: Date.now() })).toThrow(/expirado/i);
  });

  it('seq monotónico: entregar desordenado rechaza el viejo', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const e1 = encryptTo(b.publicKeyB64, a.secretKeyB64, 'devA', 'devB', { type: 'page.select' });
    const e2 = encryptTo(b.publicKeyB64, a.secretKeyB64, 'devA', 'devB', { type: 'page.select' });
    decryptFrom(a.publicKeyB64, b.secretKeyB64, e2);
    expect(() => decryptFrom(a.publicKeyB64, b.secretKeyB64, e1)).toThrow(/replay|seq/i);
  });
});

describe('remote identity', () => {
  it('getIdentity crea y persiste; segunda llamada devuelve lo mismo', () => {
    const db = makeDb();
    const i1 = getIdentity(db);
    const i2 = getIdentity(db);
    expect(i1.deviceId).toBe(i2.deviceId);
    expect(i1.publicKeyB64).toBe(i2.publicKeyB64);
    expect(db.getSetting('remote.device.priv')).toBeTruthy();
  });

  it('rotateKeys cambia claves pero conserva deviceId', () => {
    const db = makeDb();
    const before = getIdentity(db);
    const after = rotateKeys(db);
    expect(after.deviceId).toBe(before.deviceId);
    expect(after.publicKeyB64).not.toBe(before.publicKeyB64);
  });
});

describe('remote pairing', () => {
  it('generatePairCode → acceptInvite registra trusted; revoke lo cierra', () => {
    const db = makeDb();
    const me = getIdentity(db);
    const pending = generatePairCode(db, { deviceId: me.deviceId, pubKey: me.publicKeyB64, fingerprint: 'fp' });
    expect(pending.code).toMatch(/^\d{6}$/);

    const peer = generateKeyPair();
    const trusted = acceptInvite(db, { code: pending.code, remoteDeviceId: 'peer-1', remotePubKey: peer.publicKeyB64, name: 'Móvil' });
    expect(trusted.deviceId).toBe('peer-1');
    expect(listDevices(db).length).toBe(1);

    // El código es de un solo uso
    expect(db.getSetting(`remote.pending.${pending.code}`)).toBeNull();

    // Revocar borra la clave y cierra la sesión
    expect(revokeDevice(db, 'peer-1')).toBe(true);
    const perm = checkRemotePermission(db, 'peer-1', 'page.select');
    expect(perm.ok).toBe(false);
  });

  it('acceptInvite rechaza códigos con formato inválido', () => {
    const db = makeDb();
    expect(() => acceptInvite(db, { code: 'abc', remoteDeviceId: 'x', remotePubKey: 'y' })).toThrow(/inválido/i);
  });

  it('updatePolicy cambia allowedActions', () => {
    const db = makeDb();
    const peer = generateKeyPair();
    acceptInvite(db, { code: '123456', remoteDeviceId: 'peer-2', remotePubKey: peer.publicKeyB64 });
    const next = updatePolicy(db, 'peer-2', ['page.select']);
    expect(next.allowedActions).toEqual(['page.select']);
  });
});

describe('remote allowlist', () => {
  function trustedDb(actionOverrides?: string[]) {
    const db = makeDb();
    const peer = generateKeyPair();
    acceptInvite(db, {
      code: '654321', remoteDeviceId: 'peer-9', remotePubKey: peer.publicKeyB64,
      allowedActions: actionOverrides ?? [...DEFAULT_POLICY],
    });
    return db;
  }

  it('BLOQUEA shell por defecto aunque esté en policy (executeRemoteAction)', async () => {
    const db = trustedDb(['shell.exec', 'page.select']);
    const r = await executeRemoteAction({ db }, 'peer-9', { type: 'shell.exec', params: { command: 'whoami' } });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/bloqueada/i);
    expect(db.logs.length).toBeGreaterThan(0);
  });

  it('BLOQUEA http arbitrario y open-app', () => {
    const db = trustedDb(['http.request', 'open-app.open']);
    expect(checkRemotePermission(db, 'peer-9', 'http.request').ok).toBe(false);
    expect(checkRemotePermission(db, 'peer-9', 'open-app.open').ok).toBe(false);
  });

  it('PERMITE page.select dentro de policy y lo ejecuta', async () => {
    const db = trustedDb();
    (db as any).getPage = (id: string) => (id === 'p1' ? { id } : null);
    let current = '';
    (db as any).setCurrentPage = (id: string) => { current = id; };
    const r = await executeRemoteAction({ db }, 'peer-9', { type: 'page.select', params: { pageId: 'p1' } });
    expect(r.ok).toBe(true);
    expect(current).toBe('p1');
  });

  it('button.press exige id existente', async () => {
    const db = trustedDb();
    const r = await executeRemoteAction({ db }, 'peer-9', { type: 'button.press', params: { buttonId: 'nope' } });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/inexistente/i);
  });

  it('peer desconocido → denegado', async () => {
    const db = makeDb();
    const r = await executeRemoteAction({ db }, 'ghost', { type: 'page.select', params: { pageId: 'p1' } });
    expect(r.ok).toBe(false);
  });
});
