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
  setUiSessionDeviceName, readUiSessionByToken, validateUiSession,
  notifyTunnelUiUnbind, queueUiUnbind,
} from '../remote/ui-policy';
import {
  createLanInvite, getLanInviteMeta, revokeLanInvite, redeemLanInvite,
  listLanSessions, revokeLanSessionByPrefix,
} from '../remote/lan-invites';
import { devicesForTokenPrefix } from '../remote/device-bindings';
import { forgetDeviceEverywhere } from './devices';
import { allowLanRedeem, getLanContext } from '../http/lan-guard';
import { DEFAULT_POLICY, isAllowlisted } from '../remote/remote-actions';
import { encryptTo } from '../remote/crypto';
import { resolveRelayUrl, RELAY_URL_KEY, isValidRelayUrl, isRelayDisabledValue, normalizeRelayUrl, DEFAULT_PUBLIC_RELAY_URL } from '../remote/public-relay';

export const handleRemote: ApiHandler = async (req, { url, method, path, db, services }) => {
  const remote: any = (globalThis as any).__libredeckRemote;

  if (path === '/api/v1/remote/status' && method === 'GET') {
    const pub = publicIdentity(db);
    return jsonResponse({
      deviceId: pub.deviceId,
      fingerprint: pub.fingerprint,
      publicKey: pub.publicKey,
      relay: {
        url: resolveRelayUrl(db),
        status: remote?.relay?.getState?.() ?? 'unknown',
        envOverride: typeof process.env.RELAY_URL === 'string' && process.env.RELAY_URL.length > 0,
      },
      tunnel: {
        status: remote?.tunnel?.getState?.() ?? 'unknown',
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
    const relayUrl = resolveRelayUrl(db);
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

  // Relay público configurable (`PUT /api/v1/remote/relay { url }`):
  // - `url: null` (o ausente) → borra el setting → vuelve al relay público
  //   por defecto (`DEFAULT_PUBLIC_RELAY_URL`).
  // - `url: 'off'/'none'/'disabled'` → desactiva el relay ('' efectivo).
  // - URL `ws(s)://` (o `http(s)://`, que se normaliza a `ws(s)://`) →
  //   relay personalizado. Resto (incluida `''`) → 400.
  // Tras persistir, reinicia relay+túnel para que relean la URL efectiva.
  if (path === '/api/v1/remote/relay' && method === 'PUT') {
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const hasUrl = body != null && Object.prototype.hasOwnProperty.call(body, 'url');
    const url = hasUrl ? (body as any).url : null;
    if (url === null || url === undefined) {
      try { db.deleteSetting(RELAY_URL_KEY); } catch { /* noop */ }
    } else if (typeof url !== 'string') {
      return jsonResponse({ error: 'url debe ser string o null' }, 400);
    } else if (!isValidRelayUrl(url)) {
      return jsonResponse({ error: 'URL de relay inválida: usa ws(s):// (o http(s)://), "off" para desactivar o null para el relay público' }, 400);
    } else if (isRelayDisabledValue(url)) {
      try { db.setSetting(RELAY_URL_KEY, String(url).trim().toLowerCase()); } catch { /* noop */ }
    } else {
      try { db.setSetting(RELAY_URL_KEY, normalizeRelayUrl(url) as string); } catch { /* noop */ }
    }
    const effective = resolveRelayUrl(db);
    try { remote?.relay?.stop?.(); } catch { /* noop */ }
    try { remote?.tunnel?.stop?.(); } catch { /* noop */ }
    try { remote?.relay?.start?.(); } catch { /* noop */ }
    try { remote?.tunnel?.start?.(); } catch { /* noop */ }
    try {
      services.wsManager?.broadcast('remote.relay-changed', {
        url: effective,
        status: remote?.relay?.getState?.() ?? 'unknown',
        ts: Date.now(),
      }, 'remote');
    } catch { /* noop */ }
    return jsonResponse({ ok: true, url: effective, default: DEFAULT_PUBLIC_RELAY_URL });
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
    // Fast-path LAN: `createUiCode` asegura además un lan-invite pareado
    // (`ui-fastpath`, reutilizado si le quedan >60 s) y lo publica al relay
    // como `ui-publish {…, lan?}`. Aquí se devuelve SOLO al host el mismo
    // objeto `lan` (invite code + IPs/puertos/fp/dev públicos, sin token de
    // sesión); si el host no tiene IPs LAN, `lan` se omite en origen.
    const c = createUiCode(db) as { code: string; urlCode: string; expiresAt: number; lan?: unknown };
    const https = relayHttpsUrl(db);
    const url = https ? `${https}/ui/${c.urlCode}` : '';
    try { services.wsManager?.broadcast('remote.ui-code', { expiresAt: c.expiresAt, ts: Date.now() }, 'remote'); } catch { /* noop */ }
    return jsonResponse({
      code: c.code,
      urlCode: c.urlCode,
      url,
      expiresAt: c.expiresAt,
      ...(c.lan ? { lan: c.lan } : {}),
    });
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

  // Nombre del dispositivo propuesto al aprobar (lo escribe el dueño en la
  // vista de éxito; el móvil lo adopta al arrancar con su token). Si el
  // dispositivo ya conectó, se renombra de inmediato.
  const devNameMatch = path.match(/^\/api\/v1\/remote\/ui-sessions\/([^/]+)\/device-name$/);
  if (devNameMatch && method === 'POST') {
    if (!isUiEnabled(db)) return uiDisabled();
    const prefix = decodeURIComponent(devNameMatch[1]).slice(0, 8);
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const clean = String(body?.name ?? '').trim().slice(0, 80);
    const r = setUiSessionDeviceName(db, prefix, String(body?.name ?? ''));
    if (!r.ok) return jsonResponse({ error: r.error ?? 'No se pudo guardar' }, r.error === 'Sesión desconocida' ? 404 : 400);
    // Renombrado inmediato si el dispositivo ya está vinculado a la sesión.
    let renamed: string[] = [];
    try {
      for (const deviceId of devicesForTokenPrefix(db, 'ui', prefix)) {
        const updated = db.updateDevice(deviceId, { name: clean });
        if (updated) {
          try { db.upsertDeviceSession({ device_id: deviceId, name: updated.name }); } catch { /* noop */ }
          renamed.push(deviceId);
        }
      }
      if (renamed.length > 0) {
        try { services.wsManager?.broadcast('device.updated', { deviceIds: renamed, ts: Date.now() }, 'pages'); } catch { /* noop */ }
      }
    } catch { /* la sesión ya guarda el nombre: el móvil lo adopta al arrancar */ }
    try { services.wsManager?.broadcast('remote.ui-device-name', { tokenPrefix: prefix, name: clean, ts: Date.now() }, 'remote'); } catch { /* noop */ }
    return jsonResponse({ ok: true, tokenPrefix: prefix, renamed });
  }

  // Nombre propuesto para la sesión del llamante (el móvil lo pide al
  // arrancar con su token completo: solo quien lo posee lo conoce).
  if (path === '/api/v1/remote/ui-session/device-name' && method === 'GET') {
    if (!isUiEnabled(db)) return uiDisabled();
    const token = String(url.searchParams.get('token') ?? '');
    const v = validateUiSession(db, token);
    if (!v.ok) return jsonResponse({ error: `Sesión ${v.reason ?? 'desconocida'}` }, 404);
    const s = readUiSessionByToken(db, token);
    return jsonResponse({ deviceName: typeof s?.deviceName === 'string' && s.deviceName ? s.deviceName : null });
  }

  const sessDel = path.match(/^\/api\/v1\/remote\/ui-sessions\/([^/]+)$/);
  if (sessDel && method === 'DELETE') {
    if (!isUiEnabled(db)) return uiDisabled();
    const prefix = decodeURIComponent(sessDel[1]);
    const r = revokeUiSessionByPrefix(db, prefix);
    if (!r) return jsonResponse({ error: 'Sesión desconocida' }, 404);
    try { services.wsManager?.broadcast('remote.ui-revoked', { scope: 'session', tokenPrefix: prefix, ts: Date.now() }, 'remote'); } catch { /* noop */ }
    // Tombstone durable + unbind best-effort: si el túnel está caído el
    // envío se pierde, pero resyncUiState lo re-emite al reconectar.
    try { queueUiUnbind(db, r.token, r.session.exp); } catch { /* noop */ }
    notifyTunnelUiUnbind(r.token);
    // P2P directo: el DataChannel ya establecido no pasa por el relay.
    try { (globalThis as any).__libredeckRemote?.tunnel?.closeRtcForToken?.(r.token); } catch { /* noop */ }
    // Revocar = prohibir + ocultar: olvidar los dispositivos vinculados.
    try {
      for (const deviceId of devicesForTokenPrefix(db, 'ui', prefix)) {
        forgetDeviceEverywhere(db, services, deviceId, { revokeTokens: false });
      }
    } catch { /* noop */ }
    return jsonResponse({ ok: true, revoked: prefix });
  }

  // ---------- Invitaciones LAN (QR/enlace solo-por-invitación) ----------
  // Gestión (invite/sessions): SOLO el anfitrión (loopback). El guard HTTP
  // ya denegó a no-invitados (401) e invitados sin rango (403); aquí se
  // refuerza por si el dispatcher se reutiliza sin guard.
  // Canje (lan-redeem): público + rate-limit (el código de 128 bits es la
  // única credencial necesaria; el éxito devuelve la sesión UNA vez).
  const lanHostOnly = () =>
    jsonResponse(
      { error: 'Solo el anfitrión (localhost) puede gestionar invitaciones.', code: 'LAN_HOST_ONLY' },
      403,
    );
  const isLanHost = () => getLanContext(req)?.via === 'loopback';

  if (path === '/api/v1/remote/lan-invite' && method === 'POST') {
    if (!isLanHost()) return lanHostOnly();
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const invite = createLanInvite(db, typeof body?.label === 'string' ? body.label : '');
    return jsonResponse({ code: invite.code, expiresAt: invite.expiresAt, createdAt: invite.createdAt, label: invite.label });
  }

  if (path === '/api/v1/remote/lan-invite' && method === 'GET') {
    if (!isLanHost()) return lanHostOnly();
    return jsonResponse(getLanInviteMeta(db));
  }

  if (path === '/api/v1/remote/lan-invite' && method === 'DELETE') {
    if (!isLanHost()) return lanHostOnly();
    const revoked = revokeLanInvite(db);
    try { services.wsManager?.broadcast('remote.lan-revoked', { scope: 'invite', ts: Date.now() }, 'remote'); } catch { /* noop */ }
    return jsonResponse({ ok: true, revoked });
  }

  if (path === '/api/v1/remote/lan-redeem' && method === 'POST') {
    const ctx = getLanContext(req);
    const ip = ctx?.peerIp ?? 'unknown';
    if (!allowLanRedeem(ip)) {
      return jsonResponse({ error: 'Demasiados intentos: espera un minuto.', code: 'LAN_RATE_LIMITED' }, 429);
    }
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const r = redeemLanInvite(db, String(body?.code ?? ''), {
      ua: req.headers.get('user-agent') ?? '',
      ip: ctx?.peerIp ?? '',
      label: typeof body?.label === 'string' ? body.label : '',
    });
    if (!r.ok) return jsonResponse({ error: r.error ?? 'Código denegado', code: 'LAN_INVITE_REQUIRED' }, 401);
    try { services.wsManager?.broadcast('remote.lan-allowed', { tokenPrefix: r.token!.slice(0, 8), ts: Date.now() }, 'remote'); } catch { /* noop */ }
    const res = jsonResponse({ ok: true, sessionToken: r.token, exp: r.exp });
    // Cookie de sesión para que la UI (assets/WS del navegador) viaje
    // autenticada sin que el JS tenga que reenviar el token.
    try {
      const { buildLanSessionCookie } = await import('../http/lan-guard');
      res.headers.append('Set-Cookie', buildLanSessionCookie(r.token!, r.exp!));
    } catch { /* sin cookie: el token del body basta */ }
    return res;
  }

  if (path === '/api/v1/remote/lan-sessions' && method === 'GET') {
    if (!isLanHost()) return lanHostOnly();
    // Solo prefijos: el token completo jamás sale del servidor salvo al canjear.
    return jsonResponse({ sessions: listLanSessions(db) });
  }

  const lanSessDel = path.match(/^\/api\/v1\/remote\/lan-sessions\/([^/]+)$/);
  if (lanSessDel && method === 'DELETE') {
    if (!isLanHost()) return lanHostOnly();
    const prefix = decodeURIComponent(lanSessDel[1]);
    const ok = revokeLanSessionByPrefix(db, prefix);
    if (!ok) return jsonResponse({ error: 'Sesión desconocida' }, 404);
    try { services.wsManager?.broadcast('remote.lan-revoked', { scope: 'session', tokenPrefix: prefix, ts: Date.now() }, 'remote'); } catch { /* noop */ }
    // Revocar = prohibir + ocultar: olvidar los dispositivos vinculados.
    try {
      for (const deviceId of devicesForTokenPrefix(db, 'lan', prefix)) {
        forgetDeviceEverywhere(db, services, deviceId, { revokeTokens: false });
      }
    } catch { /* noop */ }
    return jsonResponse({ ok: true, revoked: prefix });
  }

  return null;
};
