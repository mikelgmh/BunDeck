/**
 * relay-auth.ts — Estado de enlace con el relay + orquestación del claim.
 *
 * Compartido por `relay-client.ts` (señalización E2E) y `tunnel.ts` (túnel
 * UI): ambos abren su propio WS contra el mismo relay y siguen las mismas
 * reglas (ver contrato en `device-claim.ts`):
 *
 * - Arranque: si el relay anuncia `deviceAuth` (caps) y no hay deviceToken
 *   guardado → UN claim antes del primer connect. Sin provisión o con
 *   claim deshabilitado → `auth-required` aparcado (sin hot loop).
 *   EXCEPCIÓN: `claim-disabled` (503: relay abierto/dev sin provisión
 *   configurada) NO es error → proceder BARE sin token (comportamiento
 *   open-relay de siempre); el estado se resuelve al conectar (`ok`) o
 *   al fallar el handshake (`unreachable`).
 * - Handshakes fallidos seguidos (`onclose` sin `onopen` previo): tras 3
 *   con token guardado → UN re-claim (fresco: si el claim devuelve el mismo
 *   valor se rota); si sigue fallando → `invalid-token` + backoff lento.
 *   Sin ningún token (bare) → `unreachable` (sin hot loop).
 * - Claim 429 → `rate-limited` + UN reintento tras `retryAfterMs`.
 *
 * El estado se expone tal cual en `GET /api/v1/remote/status` (`relay.auth`
 * + `relay.deviceLinked`): se deriva de lo observado, nunca se inventa.
 */

import {
  claimDeviceToken,
  rotateDeviceToken,
  fetchRelayCaps,
  secretsEqual,
  type ClaimArgs,
  type ClaimResult,
} from './device-claim';

export type RelayAuthState =
  | 'ok'
  | 'auth-required'
  | 'invalid-token'
  | 'rate-limited'
  | 'unreachable'
  | 'unsupported';

export interface RelayAuthDeps {
  getDeviceToken: () => string;
  setDeviceToken: (token: string) => void;
  getProvision: () => string;
  getDeviceId: () => string;
  /** Pública ed25519 (raw 32B b64) de `getRelaySigningKeys`. */
  getPubKeyB64: () => string;
  /** Master legacy (`RELAY_TOKEN`): el relay lo acepta como socket de
   *  confianza aunque anuncie deviceAuth; se usa como respaldo si el claim
   *  falla (nunca para firmar: el register firmado exige device-token). */
  getMasterToken: () => string;
  fetchCaps: (relayWsUrl: string) => Promise<import('./device-claim').CapsResult>;
  claim: (args: ClaimArgs) => Promise<ClaimResult>;
  rotate: (args: { relayUrl: string; deviceToken: string }) => Promise<ClaimResult>;
}

export function defaultAuthDeps(overrides?: Partial<RelayAuthDeps>): RelayAuthDeps {
  return {
    getDeviceToken: () => '',
    setDeviceToken: () => {},
    getProvision: () => '',
    getDeviceId: () => '',
    getPubKeyB64: () => '',
    getMasterToken: () => '',
    fetchCaps: (url) => fetchRelayCaps(url),
    claim: (args) => claimDeviceToken(args),
    rotate: (args) => rotateDeviceToken(args),
    ...overrides,
  };
}

type AuthListener = (state: RelayAuthState) => void;

/**
 * Contador de handshakes + estado. Lógica pura (sin red ni timers):
 * testeable en aislamiento.
 */
export class RelayAuthTracker {
  state: RelayAuthState = 'ok';
  consecutiveHandshakeFailures = 0;
  /** Claim inicial ya intentado (antes del primer connect). */
  initialClaimDone = false;
  /** Re-claim tras racha de fallos ya intentado (uno por episodio). */
  reclaimedThisEpisode = false;
  /** Reintento tras 429 ya programado/consumido. */
  rateRetryUsed = false;
  private listeners = new Set<AuthListener>();

  onChange(cb: AuthListener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  set(s: RelayAuthState): void {
    if (this.state === s) return;
    this.state = s;
    for (const cb of [...this.listeners]) {
      try { cb(s); } catch { /* noop */ }
    }
  }

  /** Un `open` rompe la racha de fallos (el episodio de reclaim se cierra). */
  noteConnected(): void {
    this.consecutiveHandshakeFailures = 0;
    this.reclaimedThisEpisode = false;
  }

  /** Un `close` tras un `open` también rompe la racha de handshakes. */
  noteClosedAfterOpen(): void {
    this.consecutiveHandshakeFailures = 0;
  }

  /**
   * Un `close` SIN `open` previo: cuenta la racha.
   * - 3ª seguida con token guardado y sin reclaim previo → `'reclaim'`.
   * - Más allá (o sin token) → `'invalid'` (superficie) / `'none'`.
   */
  noteHandshakeFailure(hasStoredToken: boolean): 'reclaim' | 'invalid' | 'none' {
    this.consecutiveHandshakeFailures += 1;
    if (!hasStoredToken) return 'none';
    if (this.consecutiveHandshakeFailures === 3 && !this.reclaimedThisEpisode) return 'reclaim';
    if (this.consecutiveHandshakeFailures > 3 || this.reclaimedThisEpisode) {
      return this.consecutiveHandshakeFailures > 3 ? 'invalid' : 'none';
    }
    return 'none';
  }

  resetFailures(): void {
    this.consecutiveHandshakeFailures = 0;
  }
}

export interface EnsureResult {
  /** ¿Proceder al `connect()` del WS? (`false` = aparcado, sin hot loop.) */
  proceed: boolean;
  /** Token a usar (puede ser '' si el relay no exige auth). */
  token: string;
  rateLimited: boolean;
  retryAfterMs?: number;
  /** ¿El relay exige device-auth? (`null` = caps ilegibles.) */
  deviceAuth: boolean | null;
}

/**
 * Puerta de arranque: caps → claim único si hace falta. Sin reintento dentro;
 * el llamante decide (aparcar / programar UN reintento 429 / conectar).
 */
export async function ensureDeviceClaim(
  deps: RelayAuthDeps,
  relayWsUrl: string,
  tracker: RelayAuthTracker,
  opts?: { isRetry?: boolean },
): Promise<EnsureResult> {
  const none: EnsureResult = { proceed: false, token: '', rateLimited: false, deviceAuth: null };
  const caps = await deps.fetchCaps(relayWsUrl);
  if (!caps.ok) {
    // Caps ausente/ilegible en un relay no desactivado → relay viejo.
    tracker.set('unsupported');
    return { proceed: true, token: deps.getDeviceToken() || '', rateLimited: false, deviceAuth: null };
  }
  if (!caps.deviceAuth) {
    tracker.set('ok');
    return { proceed: true, token: deps.getDeviceToken() || '', rateLimited: false, deviceAuth: false };
  }
  const stored = deps.getDeviceToken();
  if (stored) {
    tracker.set('ok');
    return { proceed: true, token: stored, rateLimited: false, deviceAuth: true };
  }
  if (tracker.initialClaimDone && !opts?.isRetry) return { ...none, deviceAuth: true };
  tracker.initialClaimDone = true;
  const res = await deps.claim({
    relayUrl: relayWsUrl,
    provision: deps.getProvision(),
    deviceId: deps.getDeviceId(),
    pubKeyB64: deps.getPubKeyB64(),
  });
  if (res.ok) {
    try { deps.setDeviceToken(res.deviceToken); } catch { /* noop */ }
    tracker.set('ok');
    return { proceed: true, token: res.deviceToken, rateLimited: false, deviceAuth: true };
  }
  // El relay acepta sockets master legacy aunque anuncie deviceAuth: si hay
  // master configurado, se conecta con él (el open posterior pone `ok`).
  const master = (() => { try { return deps.getMasterToken(); } catch { return ''; } })();
  const masterFallback = { proceed: true, token: '', rateLimited: false, deviceAuth: true as const };
  if (res.error === 'claim-disabled') {
    // Relay abierto/dev sin provisión: NO necesita device-tokens. Proceder
    // BARE (sin token); `ok` provisional — el connect lo confirma o el
    // handshake fallido lo pasa a `unreachable`.
    tracker.set('ok');
    return { proceed: true, token: '', rateLimited: false, deviceAuth: true };
  }
  if (res.error === 'rate-limited') {
    tracker.set('rate-limited');
    if (master) return masterFallback;
    return { proceed: false, token: '', rateLimited: true, retryAfterMs: res.retryAfterMs, deviceAuth: true };
  }
  if (res.error === 'unreachable') {
    tracker.set('unreachable');
    if (master) return masterFallback;
    return { ...none, deviceAuth: true };
  }
  tracker.set('auth-required');
  if (master) return masterFallback;
  return { ...none, deviceAuth: true };
}

export interface RefreshResult {
  refreshed: boolean;
  token: string;
  rateLimited: boolean;
  retryAfterMs?: number;
}

/**
 * Re-claim tras 3 handshakes fallidos: menta fresco (si el claim devuelve el
 * MISMO valor —comparación en tiempo constante— se rota para forzar uno
 * nuevo). Marca estados `ok` / `rate-limited` / `invalid-token`.
 */
export async function refreshDeviceClaim(
  deps: RelayAuthDeps,
  relayWsUrl: string,
  tracker: RelayAuthTracker,
): Promise<RefreshResult> {
  tracker.reclaimedThisEpisode = true;
  const fail: RefreshResult = { refreshed: false, token: '', rateLimited: false };
  const res = await deps.claim({
    relayUrl: relayWsUrl,
    provision: deps.getProvision(),
    deviceId: deps.getDeviceId(),
    pubKeyB64: deps.getPubKeyB64(),
  });
  if (res.ok) {
    if (!secretsEqual(res.deviceToken, deps.getDeviceToken())) {
      try { deps.setDeviceToken(res.deviceToken); } catch { /* noop */ }
      tracker.resetFailures();
      tracker.set('ok');
      return { refreshed: true, token: res.deviceToken, rateLimited: false };
    }
    // Mismo valor: forzar menta fresca vía rotate (gracia 5 min del viejo).
    const rot = await deps.rotate({ relayUrl: relayWsUrl, deviceToken: res.deviceToken });
    if (rot.ok) {
      try { deps.setDeviceToken(rot.deviceToken); } catch { /* noop */ }
      tracker.resetFailures();
      tracker.set('ok');
      return { refreshed: true, token: rot.deviceToken, rateLimited: false };
    }
    if (rot.error === 'rate-limited') {
      tracker.set('rate-limited');
      return { refreshed: false, token: '', rateLimited: true, retryAfterMs: rot.retryAfterMs };
    }
    tracker.set('invalid-token');
    return fail;
  }
  if (res.error === 'rate-limited') {
    tracker.set('rate-limited');
    return { refreshed: false, token: '', rateLimited: true, retryAfterMs: res.retryAfterMs };
  }
  tracker.set('invalid-token');
  return fail;
}
