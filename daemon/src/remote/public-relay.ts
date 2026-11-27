/**
 * Relay público de BunDeck.
 *
 * Por defecto todos los daemons usan el relay público
 * (`wss://relay.bundeck.app`) sin necesidad de configurar nada:
 * el emparejamiento entre equipos y la UI remota funcionan nada más
 * arrancar. Para usar un relay propio (o desactivarlo):
 *
 * - `RELAY_URL` env o setting `remote.relay.url` → relay propio.
 * - Setting `remote.relay.url` a centinela ('off'/'none'/'disabled') →
 *   desactivado (`''` efectivo; el resto del módulo remoto sigue
 *   funcionando en local).
 * - Ausencia del setting (o `null`: fila borrada) → relay público
 *   por defecto. Nota: `DatabaseService.getSetting` coacciona '' a
 *   `null`, así que '' nunca desactiva: se trata como ausente.
 * - `RELAY_TOKEN` env o setting `remote.relay.token` → secreto compartido
 *   si el relay lo exige (el público no pide).
 */

export const DEFAULT_PUBLIC_RELAY_URL = 'wss://relay.bundeck.app';

/** Clave del setting que configura la URL del relay. */
export const RELAY_URL_KEY = 'remote.relay.url';

export interface RelaySettingsLike {
  getSetting: (key: string) => string | null;
}

/** Valores del setting `remote.relay.url` que desactivan el relay. */
const DISABLED_VALUES = new Set(['off', 'none', 'disabled']);

/** `true` si el valor (setting o cuerpo del PUT) significa "relay apagado". */
export function isRelayDisabledValue(value: string | null | undefined): boolean {
  if (value == null) return false;
  return DISABLED_VALUES.has(String(value).trim().toLowerCase());
}

/**
 * Normaliza una URL de relay a su forma canónica `ws(s)://`.
 * - Acepta `ws://` / `wss://` tal cual.
 * - Acepta `http://` / `https://` solo para normalizar a `ws://` / `wss://`.
 * - Acepta los centinelas `off` / `none` / `disabled` (devuelve el
 *   centinela en minúsculas).
 * - Devuelve `null` si es inválida (incluida `''`).
 */
export function normalizeRelayUrl(input: string): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (DISABLED_VALUES.has(lower)) return lower;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  let protocol = u.protocol.toLowerCase();
  if (protocol === 'http:') protocol = 'ws:';
  else if (protocol === 'https:') protocol = 'wss:';
  else if (protocol !== 'ws:' && protocol !== 'wss:') return null;
  try {
    const out = new URL(u.toString());
    out.protocol = protocol;
    out.hash = '';
    return out.toString();
  } catch {
    return null;
  }
}

/**
 * `true` si el valor es asignable al setting (centinela o URL
 * ws(s)/http(s) normalizable). `''`, `null` y otros esquemas → `false`.
 */
export function isValidRelayUrl(input: string | null | undefined): boolean {
  if (input == null) return false;
  if (typeof input !== 'string') return false;
  return normalizeRelayUrl(input) !== null;
}

/** URL efectiva: env > settings > relay público por defecto. */
export function resolveRelayUrl(db: RelaySettingsLike): string {
  const raw = process.env.RELAY_URL ?? db.getSetting(RELAY_URL_KEY) ?? DEFAULT_PUBLIC_RELAY_URL;
  // Nota: DatabaseService.getSetting coacciona '' a null, así que el
  // apagado explícito usa centinela ('off'/'none'/'disabled').
  if (DISABLED_VALUES.has(raw.trim().toLowerCase())) return '';
  return raw;
}

/** Token efectivo (puede ser '' en relays públicos). */
export function resolveRelayToken(db: RelaySettingsLike): string {
  return process.env.RELAY_TOKEN ?? db.getSetting('remote.relay.token') ?? '';
}

/** Clave del setting que guarda el device-token del relay (SECRETO). */
export const DEVICE_TOKEN_KEY = 'remote.relay.deviceToken';

/** Device-token efectivo ('' si el equipo aún no está vinculado). */
export function resolveDeviceToken(db: RelaySettingsLike): string {
  try {
    return db.getSetting(DEVICE_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Provision para `POST /api/device-claim`: env `RELAY_PROVISION_TOKEN` en
 * runtime, o valor horneado en el binario (`--define
 * process.env.BUNDECK_RELAY_PROVISION_TOKEN=...`, vacío en dev).
 * NUNCA se persiste en settings ni se expone por REST/WS/logs.
 */
export function resolveProvisionToken(): string {
  return process.env.RELAY_PROVISION_TOKEN ?? process.env.BUNDECK_RELAY_PROVISION_TOKEN ?? '';
}

/**
 * Claves de settings con secretos del relay: NUNCA exponer por REST/WS ni
 * meter en logs/broadcasts. NOTA: `GET /api/v1/settings` (api/system.ts,
 * fuera del alcance de este módulo) vuelca settings sin redactar: no guardar
 * ahí nada sensible es responsabilidad del llamante; aquí se redacta en
 * `api/remote.ts`.
 */
export const RELAY_SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  DEVICE_TOKEN_KEY,
  'remote.relay.token',
  'remote.relay.signPriv',
]);

/** `true` si la clave es un secreto del relay (no serializable). */
export function isRelaySecretSetting(key: string): boolean {
  return RELAY_SECRET_SETTING_KEYS.has(String(key ?? ''));
}

/**
 * Origen `http(s)://` del relay a partir de su URL `ws(s)://`
 * (para `/api/caps` y `/api/device-*`). Devuelve `null` si no es
 * una URL de relay válida.
 */
export function relayHttpOrigin(wsUrl: string): string | null {
  try {
    const u = new URL(String(wsUrl ?? '').trim());
    if (u.protocol === 'ws:') u.protocol = 'http:';
    else if (u.protocol === 'wss:') u.protocol = 'https:';
    else return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Añade `?token=` a la URL del WS cuando hay token configurado.
 * El relay lo acepta por query, `Authorization: Bearer` o `x-relay-token`;
 * para WS en el navegador/Bun lo simple y compatible es la query.
 */
export function withRelayToken(url: string, token: string): string {
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}
