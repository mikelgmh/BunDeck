/**
 * REST remoto E2E (`/api/v1/remote/*`).
 *
 * - `GET status`: identidad pública (NUNCA la privada) + estado relay.
 * - `POST pair-code`: genera código 6 dígitos (TTL 10 min) con fingerprint.
 * - `POST pair-accept`: valida el código y registra el peer como trusted.
 * - `GET devices` / `DELETE devices/:id` (revoca: borra clave + cierra
 *   sesión) / `PUT policy` (toggle de acciones permitidas).
 * - `POST rotate`: rota el par de claves (invalida sesiones anteriores).
 * - `POST send` (opcional/dev): cifra un comando al peer y lo emite por el
 *   relay — útil para probar E2E entre dos daemons locales sin app móvil.
 */
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';
import { DatabaseService } from '../db';
import { publicIdentity, rotateKeys, getIdentity } from '../remote/identity';
import { generatePairCode, acceptInvite, listDevices, listPending, revokeDevice, updatePolicy } from '../remote/pairing';
import {
  isUiEnabled, setUiEnabled, relayHttpsUrl, createUiCode, revokeUiCode, listUiPendingCombined,
  approveUiPending, denyUiPending, listUiSessions, revokeUiSessionByPrefix,
  notifyTunnelUiUnbind,
} from '../remote/ui-policy';
import { DEFAULT_POLICY, isAllowlisted } from '../remote/remote-actions';
import { encryptTo } from '../remote/crypto';

function single(db: DatabaseService, key: string): string {
  return db.getSetting(key) ?? '';
}

export const handleRemote: ApiHandler = async (req, { url, method, path, db, services }) => {
  const remote: any = (globalThis as any).__libredeckRemote;

  if (path === '/api/v1/remote/status' && method === 'GET') {
    const pub = publicIdentity(db);
    return jsonResponse({
      deviceId: pub.deviceId,
      fingerprint: pub.fingerprint,
      publicKey: pub.publicKey,
      relay: {
        url: process.env.RELAY_URL ?? single(db, 'remote.relay.url') ?? '',
        status: remote?.relay?.getState?.() ?? 'unknown',
      },
      pending: listPending(db).length,
      trusted: listDevices(db).filter((d) => !d.revoked).length,
      policy: [...DEFAULT_POLICY],
      uiEnabled: isUiEnabled(db),
    });
  }

  // Toggle maestro de la UI remota (NO gated: es el propio interruptor).
  // POST y PUT como alias; body {enabled: boolean} → {ok, uiEnabled}.
  if (path === '/api/v1/remote/ui-enabled' && (method === 'POST' || method === 'PUT')) {
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    if (typeof body?.enabled !== 'boolean') {
      return jsonResponse({ error: 'enabled (boolean) requerido' }, 400);
    }
    const uiEnabled = setUiEnabled(db, body.enabled);
    try { services.wsManager?.broadcast('remote.ui-enabled', { uiEnabled, ts: Date.now() }, 'remote'); } catch { /* noop */ }
    return jsonResponse({ ok: true, uiEnabled });
  }

  if (path === '/api/v1/remote/pair-code' && method === 'POST') {
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const pub = publicIdentity(db);
    const pending = generatePairCode(db, {
      deviceId: pub.deviceId,
      pubKey: pub.publicKey,
      fingerprint: pub.fingerprint,
      name: typeof body?.name === 'string' ? body.name : undefined,
      allowedActions: Array.isArray(body?.allowedActions) ? body.allowedActions.filter((a: unknown) => typeof a === 'string' && isAllowlisted(a)) : undefined,
    });
    try { services.wsManager?.broadcast('remote.paired', { code: pending.code, expiresAt: pending.expiresAt }, 'remote'); } catch { /* noop */ }
    return jsonResponse({ code: pending.code, fingerprint: pending.fingerprint, expiresAt: pending.expiresAt, deviceId: pub.deviceId, publicKey: pub.publicKey });
  }

  if (path === '/api/v1/remote/qr' && method === 'GET') {
    const pub = publicIdentity(db);
    const pending = generatePairCode(db, {
      deviceId: pub.deviceId,
      pubKey: pub.publicKey,
      fingerprint: pub.fingerprint,
    });
    const relayUrl = process.env.RELAY_URL ?? single(db, 'remote.relay.url') ?? '';
    const payload = {
      v: 1,
      relay: relayUrl,
      code: pending.code,
      dev: pub.deviceId,
      pub: pub.publicKey,
      fp: pub.fingerprint,
      exp: pending.expiresAt,
    };
    try { services.wsManager?.broadcast('remote.paired', { code: pending.code, expiresAt: pending.expiresAt }, 'remote'); } catch { /* noop */ }
    return jsonResponse({
      code: pending.code,
      fingerprint: pub.fingerprint,
      deviceId: pub.deviceId,
      publicKey: pub.publicKey,
      expiresAt: pending.expiresAt,
      relayUrl,
      qr: JSON.stringify(payload),
    });
  }

  if (path === '/api/v1/remote/pair-accept' && method === 'POST') {
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    try {
      const device = acceptInvite(db, {
        code: String(body?.code ?? ''),
        remoteDeviceId: String(body?.remoteDeviceId ?? ''),
        remotePubKey: String(body?.remotePubKey ?? ''),
        name: typeof body?.name === 'string' ? body.name : undefined,
        allowedActions: Array.isArray(body?.allowedActions)
          ? body.allowedActions.filter((a: unknown) => typeof a === 'string' && isAllowlisted(a))
          : undefined,
      });
      try { services.wsManager?.broadcast('remote.paired', { deviceId: device.deviceId, name: device.name, ts: Date.now() }, 'remote'); } catch { /* noop */ }
      return jsonResponse({ ok: true, device: { ...device, pubKey: device.pubKey ? `${device.pubKey.slice(0, 8)}…` : '' } });
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  if (path === '/api/v1/remote/devices' && method === 'GET') {
    const devices = listDevices(db).map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      // La clave completa NO se expone: solo prefijo para identificar.
      pubKeyPrefix: d.pubKey ? `${d.pubKey.slice(0, 12)}…` : '',
      allowedActions: d.allowedActions,
      createdAt: d.createdAt,
      revoked: d.revoked,
    }));
    return jsonResponse({ devices });
  }

  const delMatch = path.match(/^\/api\/v1\/remote\/devices\/([^/]+)$/);
  if (delMatch && method === 'DELETE') {
    const id = decodeURIComponent(delMatch[1]);
    const ok = revokeDevice(db, id);
    if (!ok) return jsonResponse({ error: 'Dispositivo desconocido' }, 404);
    try { services.wsManager?.broadcast('remote.paired', { deviceId: id, revoked: true, ts: Date.now() }, 'remote'); } catch { /* noop */ }
    return jsonResponse({ ok: true, revoked: id });
  }

  if (path === '/api/v1/remote/policy' && method === 'PUT') {
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const deviceId = String(body?.deviceId ?? '');
    const allowed = Array.isArray(body?.allowedActions) ? body.allowedActions.filter((a: unknown) => typeof a === 'string') : null;
    if (!deviceId || !allowed) return jsonResponse({ error: 'deviceId y allowedActions[] requeridos' }, 400);
    for (const a of allowed) {
      if (!isAllowlisted(a)) return jsonResponse({ error: `acción no permitida por el motor: ${a}` }, 400);
    }
    try {
      const next = updatePolicy(db, deviceId, allowed);
      return jsonResponse({ ok: true, deviceId, allowedActions: next.allowedActions });
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  if (path === '/api/v1/remote/rotate' && method === 'POST') {
    const next = rotateKeys(db);
    try { remote?.relay?.updateIdentity?.(next.deviceId, next.publicKeyB64); } catch { /* noop */ }
    try { services.wsManager?.broadcast('remote.paired', { rotated: true, fingerprint: next.fingerprint, ts: Date.now() }, 'remote'); } catch { /* noop */ }
    return jsonResponse({ ok: true, deviceId: next.deviceId, fingerprint: next.fingerprint, publicKey: next.publicKeyB64 });
  }

  // Dev/E2E: cifrar un comando al peer y enviarlo por el relay.
  // También útil para probar E2E entre dos daemons locales: el emisor cifra
  // con la pub del destino y el relay (o `pair-accept` cruzado) lo entrega.
  if (path === '/api/v1/remote/send' && method === 'POST') {
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const to = String(body?.to ?? '');
    const type = String(body?.type ?? '');
    if (!to || !type) return jsonResponse({ error: 'to y type requeridos' }, 400);
    const me = getIdentity(db);
    const { getTrusted } = await import('../remote/pairing');
    const peer = getTrusted(db, to);
    if (!peer || peer.revoked || !peer.pubKey) return jsonResponse({ error: 'peer no emparejado' }, 400);
    if (!isAllowlisted(type)) return jsonResponse({ error: `acción no permitida: ${type}` }, 400);
    if (!peer.allowedActions.includes(type)) return jsonResponse({ error: 'fuera de la política del dispositivo' }, 403);
    const env = encryptTo(peer.pubKey, me.secretKeyB64, me.deviceId, to, { type, params: body?.params ?? {} });
    const sent = remote?.relay?.sendEnvelope?.(to, env) ?? false;
    // Loopback local (dos daemons en el mismo proceso de test o sin relay):
    // si el envío por relay no está disponible, se devuelve el envelope
    // para entregarlo manualmente al otro daemon (ver docs en el test).
    return jsonResponse({ ok: true, sent, envelope: sent ? undefined : env });
  }

  if (path === '/api/v1/remote/inbox' && method === 'POST') {
    // Entrega manual de un envelope (pruebas E2E sin relay): descifra y ejecuta.
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const env = body?.envelope;
    if (!env?.from) return jsonResponse({ error: 'envelope.from requerido' }, 400);
    const me = getIdentity(new DatabaseService());
    void me;
    const { getTrusted: gt } = await import('../remote/pairing');
    const { decryptFrom: dec } = await import('../remote/crypto');
    const { executeRemoteAction: exec } = await import('../remote/remote-actions');
    const peer = gt(db, String(env.from));
    if (!peer || peer.revoked || !peer.pubKey) return jsonResponse({ error: 'peer no emparejado' }, 400);
    try {
      const meId = getIdentity(db);
      const cmd = dec(peer.pubKey, meId.secretKeyB64, env);
      const r = await exec({ db, actionRunner: services.actionRunner, wsManager: services.wsManager }, String(env.from), { type: String((cmd as any).type ?? ''), params: (cmd as any).params ?? {} });
      return jsonResponse(r);
    } catch (e) {
      return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  // ---------- Política de UI remota (aprobación en host) ----------
  // Interruptor maestro: remote.ui.enabled ("0"/"1", default "0").
  // Todo lo de abajo devuelve 403 si está a "0".
  // NOTA seguridad (también en los mensajes): el tráfico UI lo ve el
  // operador del relay (TLS+token, opt-in explícito, default OFF). Se
  // guardan ua+ip tal cual para que el dueño decida.
  const uiDisabled = () =>
    jsonResponse(
      { error: 'UI remota deshabilitada (remote.ui.enabled=0). Actívala solo si aceptas que el operador del relay ve el tráfico UI (TLS+token, opt-in explícito).' },
      403,
    );

  if (path === '/api/v1/remote/ui-code' && method === 'POST') {
    if (!isUiEnabled(db)) return uiDisabled();
    const c = createUiCode(db);
    const https = relayHttpsUrl(db);
    const url = https ? `${https}/ui/${c.urlCode}` : '';
    try { services.wsManager?.broadcast('remote.ui-code', { expiresAt: c.expiresAt, ts: Date.now() }, 'remote'); } catch { /* noop */ }
    return jsonResponse({ code: c.code, urlCode: c.urlCode, url, expiresAt: c.expiresAt });
  }

  if (path === '/api/v1/remote/ui-code' && method === 'DELETE') {
    if (!isUiEnabled(db)) return uiDisabled();
    const revoked = revokeUiCode(db);
    if (revoked) {
      try { services.wsManager?.broadcast('remote.ui-revoked', { scope: 'code', ts: Date.now() }, 'remote'); } catch { /* noop */ }
    }
    return jsonResponse({ ok: true, revoked });
  }

  if (path === '/api/v1/remote/ui-pending' && method === 'GET') {
    if (!isUiEnabled(db)) return uiDisabled();
    return jsonResponse({ pending: listUiPendingCombined(db) });
  }

  const allowMatch = path.match(/^\/api\/v1\/remote\/ui-pending\/([^/]+)\/allow$/);
  if (allowMatch && method === 'POST') {
    if (!isUiEnabled(db)) return uiDisabled();
    const reqId = decodeURIComponent(allowMatch[1]);
    // Delega en el TunnelClient si tiene el reqId (emite ui-decision +
    // ui-bind al relay); si no, store local. En ambos casos el token
    // completo SOLO se muestra aquí, una vez.
    const r = approveUiPending(db, reqId);
    if (!r.ok) return jsonResponse({ error: r.error ?? 'Solicitud desconocida o caducada' }, 404);
    try { services.wsManager?.broadcast('remote.ui-allowed', { reqId, tokenPrefix: r.sessionToken!.slice(0, 8), ts: Date.now() }, 'remote'); } catch { /* noop */ }
    return jsonResponse({ ok: true, sessionToken: r.sessionToken });
  }

  const denyMatch = path.match(/^\/api\/v1\/remote\/ui-pending\/([^/]+)\/deny$/);
  if (denyMatch && method === 'POST') {
    if (!isUiEnabled(db)) return uiDisabled();
    const reqId = decodeURIComponent(denyMatch[1]);
    const r = denyUiPending(db, reqId);
    if (!r.ok) return jsonResponse({ error: r.error ?? 'Solicitud desconocida o caducada' }, 404);
    try { services.wsManager?.broadcast('remote.ui-denied', { reqId, ts: Date.now() }, 'remote'); } catch { /* noop */ }
    return jsonResponse({ ok: true });
  }

  if (path === '/api/v1/remote/ui-sessions' && method === 'GET') {
    if (!isUiEnabled(db)) return uiDisabled();
    // Solo prefijos: el token completo jamás sale del servidor salvo al aprobar.
    return jsonResponse({ sessions: listUiSessions(db) });
  }

  const sessDel = path.match(/^\/api\/v1\/remote\/ui-sessions\/([^/]+)$/);
  if (sessDel && method === 'DELETE') {
    if (!isUiEnabled(db)) return uiDisabled();
    const prefix = decodeURIComponent(sessDel[1]);
    const r = revokeUiSessionByPrefix(db, prefix);
    if (!r) return jsonResponse({ error: 'Sesión desconocida' }, 404);
    try { services.wsManager?.broadcast('remote.ui-revoked', { scope: 'session', tokenPrefix: prefix, ts: Date.now() }, 'remote'); } catch { /* noop */ }
    notifyTunnelUiUnbind(r.token);
    return jsonResponse({ ok: true, revoked: prefix });
  }

  return null;
};
