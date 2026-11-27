/**
 * device-claim.ts — Aprovisionamiento del device-token del relay.
 *
 * Contrato del relay (programar contra ÉL):
 * - `GET /api/caps` → `{deviceAuth:true, version}` (ausente → relay viejo).
 * - `POST /api/device-claim` auth `Bearer <provision>` (o `?token=`),
 *   body `{deviceId, pubKeyB64}` (ed25519 raw 32B b64, ver `identity.ts`
 *   `getRelaySigningKeys`) → `200 {deviceToken}`.
 *   Errores: 401 provision-required/bad-provision, 429 rate-limited
 *   (+retryAfterMs), 503 claim-disabled, 400 bad-device/bad-pubkey.
 * - `POST /api/device-revoke` (self-revoke con device-token; master +
 *   `{deviceId}` revoca un dispositivo).
 * - `POST /api/device-rotate` (device-token → token nuevo, el viejo con
 *   5 min de gracia).
 *
 * REGLAS: un solo intento por llamada (sin reintento dentro), timeout 10 s,
 * nunca loguear tokens (ni provision ni deviceToken).
 */

import { relayHttpOrigin } from './public-relay';

export const DEVICE_CLAIM_TIMEOUT_MS = 10_000;

export type ClaimError =
  | 'provision-required'
  | 'bad-provision'
  | 'rate-limited'
  | 'claim-disabled'
  | 'bad-request'
  | 'unreachable';

export type ClaimResult =
  | { ok: true; deviceToken: string }
  | { ok: false; error: ClaimError; retryAfterMs?: number };

export type CapsResult =
  | { ok: true; deviceAuth: boolean; version?: string }
  | { ok: false; error: 'unreachable' | 'unparseable' };

export interface ClaimArgs {
  /** URL ws(s) del relay (se deriva el origen http(s)). */
  relayUrl: string;
  /** Secreto de provisión (env/horneado). Puede ser '' (el relay dirá 401). */
  provision: string;
  deviceId: string;
  /** Pública ed25519 (raw 32B b64) de `getRelaySigningKeys`. */
  pubKeyB64: string;
}

export interface DeviceTokenArgs {
  relayUrl: string;
  deviceToken: string;
  deviceId?: string;
}

/** Comparación en tiempo constante para secretos (evita oráculo por timing). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');

export function secretsEqual(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(String(a ?? ''), 'utf8');
    const bb = Buffer.from(String(b ?? ''), 'utf8');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function redact(s: string): string {
  const v = String(s ?? '');
  if (v.length <= 8) return '***';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function retryAfterMsFrom(res: Response, body: any): number | undefined {
  const fromBody = Number(body?.retryAfterMs);
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.floor(fromBody);
  const header = res.headers.get('retry-after');
  if (header != null) {
    const secs = Number(String(header).trim());
    if (Number.isFinite(secs) && secs > 0) return Math.floor(secs * 1000);
  }
  return undefined;
}

/** `GET {origin}/api/caps`. 200+JSON con `deviceAuth` bool → ok. */
export async function fetchRelayCaps(
  relayUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<CapsResult> {
  const origin = relayHttpOrigin(relayUrl);
  if (!origin) return { ok: false, error: 'unparseable' };
  let res: Response;
  try {
    res = await fetchFn(`${origin}/api/caps`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DEVICE_CLAIM_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  if (!res.ok) return { ok: false, error: 'unparseable' };
  const body = await readJson(res);
  if (!body || typeof body.deviceAuth !== 'boolean') return { ok: false, error: 'unparseable' };
  return {
    ok: true,
    deviceAuth: body.deviceAuth,
    ...(typeof body.version === 'string' ? { version: body.version } : {}),
  };
}

/**
 * Un solo intento de `POST /api/device-claim` (sin reintento dentro).
 * La `pubKeyB64` debe ser la ed25519 de `getRelaySigningKeys`.
 */
export async function claimDeviceToken(
  args: ClaimArgs,
  fetchFn: typeof fetch = fetch,
): Promise<ClaimResult> {
  const origin = relayHttpOrigin(args.relayUrl);
  if (!origin) return { ok: false, error: 'bad-request' };
  if (!args.deviceId || !args.pubKeyB64) return { ok: false, error: 'bad-request' };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (args.provision) headers.authorization = `Bearer ${args.provision}`;
  let res: Response;
  try {
    res = await fetchFn(`${origin}/api/device-claim`, {
      method: 'POST',
      headers,
      // Compat: el contrato del daemon dice `pubKeyB64`, pero la
      // implementación del relay en paralelo lee `pubKey`. Se envían ambos
      // con el mismo valor (raw 32B ed25519 b64) hasta unificar el contrato.
      body: JSON.stringify({ deviceId: args.deviceId, pubKey: args.pubKeyB64, pubKeyB64: args.pubKeyB64 }),
      signal: AbortSignal.timeout(DEVICE_CLAIM_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  const body = await readJson(res);
  if (res.status === 200) {
    const token = typeof body?.deviceToken === 'string' ? body.deviceToken : '';
    if (!token) return { ok: false, error: 'bad-request' };
    return { ok: true, deviceToken: token };
  }
  if (res.status === 429) {
    return { ok: false, error: 'rate-limited', retryAfterMs: retryAfterMsFrom(res, body) };
  }
  if (res.status === 503) return { ok: false, error: 'claim-disabled' };
  if (res.status === 400) return { ok: false, error: 'bad-request' };
  if (res.status === 401) {
    const code = typeof body?.error === 'string' ? body.error.toLowerCase() : '';
    if (code.includes('provision-required') || code.includes('missing')) {
      return { ok: false, error: 'provision-required' };
    }
    // Sin provision enviada, el 401 casi seguro es falta de provisión.
    if (!args.provision) return { ok: false, error: 'provision-required' };
    return { ok: false, error: 'bad-provision' };
  }
  return { ok: false, error: 'unreachable' };
}

/** Self-revoke best-effort (`Bearer deviceToken`). Nunca lanza. */
export async function revokeDeviceToken(
  args: DeviceTokenArgs,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  const origin = relayHttpOrigin(args.relayUrl);
  if (!origin || !args.deviceToken) return { ok: false, error: 'bad-request' };
  try {
    const res = await fetchFn(`${origin}/api/device-revoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${args.deviceToken}`,
      },
      body: JSON.stringify(args.deviceId ? { deviceId: args.deviceId } : {}),
      signal: AbortSignal.timeout(DEVICE_CLAIM_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `revoke-${res.status}` };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

/** Rota el device-token (`Bearer` viejo → `{deviceToken}` nuevo). */
export async function rotateDeviceToken(
  args: DeviceTokenArgs,
  fetchFn: typeof fetch = fetch,
): Promise<ClaimResult> {
  const origin = relayHttpOrigin(args.relayUrl);
  if (!origin || !args.deviceToken) return { ok: false, error: 'bad-request' };
  let res: Response;
  try {
    res = await fetchFn(`${origin}/api/device-rotate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${args.deviceToken}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(DEVICE_CLAIM_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  const body = await readJson(res);
  if (res.status === 200) {
    const token = typeof body?.deviceToken === 'string' ? body.deviceToken : '';
    if (!token) return { ok: false, error: 'bad-request' };
    return { ok: true, deviceToken: token };
  }
  if (res.status === 401) return { ok: false, error: 'bad-provision' };
  if (res.status === 429) {
    return { ok: false, error: 'rate-limited', retryAfterMs: retryAfterMsFrom(res, body) };
  }
  if (res.status === 400) return { ok: false, error: 'bad-request' };
  return { ok: false, error: 'unreachable' };
}

/** Solo para diagnóstico interno: nunca el token completo. */
export function describeTokenForLog(token: string): string {
  return redact(token);
}
