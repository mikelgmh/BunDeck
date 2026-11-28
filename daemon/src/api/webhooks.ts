/**
 * Rutas `/api/v1/webhooks/*` — webhooks LAN (hogar inteligente y similares).
 *
 * Concepto: endpoints HTTP que viven SOLO en red local y que al recibir una
 * petición ejecutan una lista de acciones vía el ActionRunner existente
 * (p. ej. cambiar de perfil desde Home Assistant).
 *
 * Modelo de seguridad (documentado):
 * - Cada webhook tiene un token aleatorio de 256 bits (hex, 64 chars) que
 *   forma parte de la URL: `POST /api/v1/webhooks/<token>`. No hay IDs
 *   predecibles: el token ES la credencial (capability URL).
 * - SOLO red local: si la petición llega por el túnel/relay
 *   (`getLanContext(req)?.via === 'tunnel'`), TODAS las rutas de este
 *   módulo (gestión Y disparo) responden 403 `WEBHOOK_RELAY_FORBIDDEN`.
 *   Defensa en profundidad: además `remote/tunnel.ts` (`isAllowedTunnelPath`)
 *   y `remote/rtc.ts` deniegan estas rutas antes de llegar aquí.
 * - La gestión (CRUD/regenerar/probar) solo es alcanzable por la UI local o
 *   la API local (el guard LAN general ya exige invitación/sesión LAN para
 *   no-loopback; aquí se refuerza el veto al relay).
 * - El token NUNCA se loguea (ni en `logs` ni en broadcasts: solo viaja en
 *   las respuestas de gestión, que solo existen en local).
 * - Rate-limit best-effort en memoria: 60 disparos/min por token
 *   (anti-spam LAN; no es una defensa anti-DDoS, solo evita bucles
 *   accidentales de un sistema domótico). 429 si se supera.
 */
import { v4 as uuidv4 } from 'uuid';
import { jsonResponse } from './http-helpers';
import { getLanContext } from '../http/lan-guard';
import { RateLimiter } from '../http/rate-limit';
import type { ApiHandler } from './types';

export const WEBHOOK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Tokens de 256 bits en hex (64 chars); se acepta 48–128 por holgura. */
export const WEBHOOK_TOKEN_RE = /^[0-9a-f]{48,128}$/i;

/** Máximo de acciones por webhook (igual que execute-many). */
export const WEBHOOK_MAX_ACTIONS = 32;

/** Disparos por minuto y por token (ventana deslizante en memoria). */
export const WEBHOOK_TRIGGER_LIMIT = 60;

const triggerLimiter = new RateLimiter(WEBHOOK_TRIGGER_LIMIT, 60_000);

/** Solo tests: resetea el limiter de disparo. */
export function __resetWebhookLimiterForTests(): void {
  triggerLimiter.clear();
}

function randomToken(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('node:crypto');
  return randomBytes(32).toString('hex');
}

function relayBlocked(): ReturnType<typeof jsonResponse> {
  return jsonResponse(
    { error: 'Webhooks solo disponibles en red local (túnel/relay rechazado)', code: 'WEBHOOK_RELAY_FORBIDDEN' },
    403,
  );
}

function validateActions(actions: unknown): { ok: true; actions: any[] } | { ok: false; error: string } {
  if (actions === undefined) return { ok: true, actions: [] };
  if (!Array.isArray(actions)) return { ok: false, error: 'actions debe ser un array' };
  if (actions.length > WEBHOOK_MAX_ACTIONS) {
    return { ok: false, error: `demasiadas acciones (máx ${WEBHOOK_MAX_ACTIONS})` };
  }
  for (const a of actions) {
    if (!a || typeof a !== 'object' || typeof (a as any).type !== 'string' || !(a as any).type) {
      return { ok: false, error: 'cada acción necesita type (string no vacío)' };
    }
  }
  return { ok: true, actions: actions as any[] };
}

function validateMethod(method: unknown): { ok: true; method: string } | { ok: false; error: string } {
  if (method === undefined) return { ok: true, method: 'POST' };
  const m = String(method).toUpperCase();
  if (!(WEBHOOK_METHODS as readonly string[]).includes(m)) {
    return { ok: false, error: `method inválido (usa ${WEBHOOK_METHODS.join('|')})` };
  }
  return { ok: true, method: m };
}

/** Ejecuta la lista de acciones y devuelve el resumen (sin tokens). */
async function runWebhookActions(services: any, webhook: any): Promise<{ executed: number; failed: number; results: any[] }> {
  const results: any[] = [];
  let executed = 0;
  let failed = 0;
  const actions: any[] = Array.isArray(webhook.actions) ? webhook.actions : [];
  for (const action of actions) {
    try {
      const r = await services.actionRunner?.executeAction?.(action, {
        source: 'webhook',
        webhookId: webhook.id,
        timestamp: Date.now(),
      });
      results.push({ type: action?.type ?? 'unknown', success: r?.success !== false });
      if (r?.success !== false) executed++;
      else failed++;
    } catch (e) {
      results.push({ type: action?.type ?? 'unknown', success: false, error: e instanceof Error ? e.message : String(e) });
      failed++;
    }
  }
  return { executed, failed, results };
}

export const handleWebhooks: ApiHandler = async (req, { method, path, db, services }) => {
  // Veto relay/túnel: los webhooks viven SOLO en LAN (ver cabecera).
  // En tests directos sin contexto LAN el veto no aplica (local).
  if (path === '/api/v1/webhooks' || path.startsWith('/api/v1/webhooks/')) {
    if (getLanContext(req)?.via === 'tunnel') return relayBlocked();
  } else {
    return null;
  }

  // ---- Gestión: lista y creación ----
  if (path === '/api/v1/webhooks' && method === 'GET') {
    return jsonResponse(db.listWebhooks());
  }
  if (path === '/api/v1/webhooks' && method === 'POST') {
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const name = String(body?.name ?? '').trim();
    if (!name) return jsonResponse({ error: 'name requerido' }, 400);
    const m = validateMethod(body?.method);
    if (!m.ok) return jsonResponse({ error: (m as any).error }, 400);
    const a = validateActions(body?.actions);
    if (!a.ok) return jsonResponse({ error: (a as any).error }, 400);
    try {
      const created = db.createWebhook({
        id: uuidv4(),
        name: name.slice(0, 120),
        token: randomToken(),
        method: (m as any).method,
        enabled: body?.enabled === false ? 0 : 1,
        actions: (a as any).actions,
      });
      try { services.wsManager?.broadcast?.('webhook.created', { id: created.id, name: created.name, ts: Date.now() }, 'webhooks'); } catch { /* noop */ }
      return jsonResponse(created, 201);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  const base = '/api/v1/webhooks/';
  const seg = decodeURIComponent(path.slice(base.length));

  // ---- Sub-acciones de gestión (antes del disparo por token) ----
  const regenMatch = seg.match(/^([^/]+)\/regenerate$/);
  if (regenMatch && method === 'POST') {
    const id = regenMatch[1];
    if (WEBHOOK_TOKEN_RE.test(id)) return jsonResponse({ error: 'Webhook no encontrado' }, 404);
    try {
      const next = db.regenerateWebhookToken(id, randomToken());
      try { services.wsManager?.broadcast?.('webhook.updated', { id: next.id, name: next.name, ts: Date.now() }, 'webhooks'); } catch { /* noop */ }
      return jsonResponse(next);
    } catch {
      return jsonResponse({ error: 'Webhook no encontrado' }, 404);
    }
  }
  const testMatch = seg.match(/^([^/]+)\/test$/);
  if (testMatch && method === 'POST') {
    const id = testMatch[1];
    if (WEBHOOK_TOKEN_RE.test(id)) return jsonResponse({ error: 'Webhook no encontrado' }, 404);
    const webhook = db.getWebhook(id);
    if (!webhook) return jsonResponse({ error: 'Webhook no encontrado' }, 404);
    // Prueba manual local: dispara aunque esté deshabilitado (gesto
    // explícito del usuario; el on/off solo gobierna el endpoint HTTP).
    const summary = await runWebhookActions(services, webhook);
    try { db.recordWebhookTrigger(id); } catch { /* noop */ }
    try {
      services.wsManager?.broadcast?.(
        'webhook.triggered',
        { id: webhook.id, name: webhook.name, via: 'test', executed: summary.executed, failed: summary.failed, ts: Date.now() },
        'webhooks',
      );
    } catch { /* noop */ }
    return jsonResponse({ ok: true, id: webhook.id, ...summary });
  }

  // ---- Gestión por id (solo si NO parece un token) ----
  if (!WEBHOOK_TOKEN_RE.test(seg) && !seg.includes('/')) {
    const id = seg;
    if (method === 'GET') {
      const w = db.getWebhook(id);
      if (!w) return jsonResponse({ error: 'Webhook no encontrado' }, 404);
      return jsonResponse(w);
    }
    if (method === 'PUT') {
      let body: any = {};
      try { body = await req.json(); } catch { body = {}; }
      const patch: { name?: string; method?: string; enabled?: number; actions?: any[] } = {};
      if (body?.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return jsonResponse({ error: 'name inválido' }, 400);
        patch.name = name.slice(0, 120);
      }
      if (body?.method !== undefined) {
        const m = validateMethod(body.method);
        if (!m.ok) return jsonResponse({ error: (m as any).error }, 400);
        patch.method = (m as any).method;
      }
      if (body?.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
      if (body?.actions !== undefined) {
        const a = validateActions(body.actions);
        if (!a.ok) return jsonResponse({ error: (a as any).error }, 400);
        patch.actions = (a as any).actions;
      }
      try {
        const updated = db.updateWebhook(id, patch);
        try { services.wsManager?.broadcast?.('webhook.updated', { id: updated.id, name: updated.name, ts: Date.now() }, 'webhooks'); } catch { /* noop */ }
        return jsonResponse(updated);
      } catch {
        return jsonResponse({ error: 'Webhook no encontrado' }, 404);
      }
    }
    if (method === 'DELETE') {
      const w = db.getWebhook(id);
      if (!w) return jsonResponse({ error: 'Webhook no encontrado' }, 404);
      db.deleteWebhook(id);
      try { services.wsManager?.broadcast?.('webhook.deleted', { id, ts: Date.now() }, 'webhooks'); } catch { /* noop */ }
      return jsonResponse({ ok: true, deleted: id });
    }
    return null;
  }

  // ---- Disparo por token: (GET|POST|PUT|PATCH|DELETE) /api/v1/webhooks/<token> ----
  // Sin subpaths: solo el token pelado (los tokens nunca llevan `/`).
  if (seg.includes('/')) return jsonResponse({ error: 'Webhook no encontrado' }, 404);
  const token = seg;
  const webhook = db.getWebhookByToken(token);
  // Deshabilitado o inexistente: 404 indistinguible (no filtrar existencia).
  if (!webhook || webhook.enabled !== 1) {
    return jsonResponse({ error: 'Webhook no encontrado' }, 404);
  }
  if (webhook.method !== method.toUpperCase()) {
    return jsonResponse({ error: `usa ${webhook.method}`, code: 'WEBHOOK_METHOD_MISMATCH' }, 405);
  }
  if (!triggerLimiter.allow(`webhook:${webhook.id}`)) {
    return jsonResponse({ error: 'Demasiadas peticiones: espera un momento.', code: 'WEBHOOK_RATE_LIMITED' }, 429);
  }
  const summary = await runWebhookActions(services, webhook);
  try { db.recordWebhookTrigger(webhook.id); } catch { /* noop */ }
  try {
    db.addLog?.({
      level: summary.failed > 0 ? 'error' : 'info',
      message: `Webhook "${webhook.name}": ${summary.executed}/${summary.executed + summary.failed} acciones ok`,
      meta: { webhookId: webhook.id, executed: summary.executed, failed: summary.failed },
      ts: Date.now(),
    });
  } catch { /* mejor esfuerzo */ }
  try {
    services.wsManager?.broadcast?.(
      'webhook.triggered',
      { id: webhook.id, name: webhook.name, executed: summary.executed, failed: summary.failed, ts: Date.now() },
      'webhooks',
    );
  } catch { /* noop */ }
  return jsonResponse({ ok: true, id: webhook.id, ...summary });
};
