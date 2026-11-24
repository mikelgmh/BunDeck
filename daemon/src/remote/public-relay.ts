/**
 * Relay público de BunDeck.
 *
 * Por defecto todos los daemons usan el relay público
 * (`wss://relay.bundeck.app`) sin necesidad de configurar nada:
 * el emparejamiento entre equipos y la UI remota funcionan nada más
 * arrancar. Para usar un relay propio (o desactivarlo):
 *
 * - `RELAY_URL` env o setting `remote.relay.url` → relay propio.
 * - Setting `remote.relay.url` a cadena vacía explícita → desactivado
 *   (`disabled`, el resto del módulo remoto sigue funcionando en local).
 * - `RELAY_TOKEN` env o setting `remote.relay.token` → secreto compartido
 *   si el relay lo exige (el público no pide).
 */

export const DEFAULT_PUBLIC_RELAY_URL = 'wss://relay.bundeck.app';

export interface RelaySettingsLike {
  getSetting: (key: string) => string | null;
}

/** Valores del setting `remote.relay.url` que desactivan el relay. */
const DISABLED_VALUES = new Set(['off', 'none', 'disabled']);

/** URL efectiva: env > settings > relay público por defecto. */
export function resolveRelayUrl(db: RelaySettingsLike): string {
  const raw = process.env.RELAY_URL ?? db.getSetting('remote.relay.url') ?? DEFAULT_PUBLIC_RELAY_URL;
  // Nota: DatabaseService.getSetting coacciona '' a null, así que el
  // apagado explícito usa centinela ('off'/'none'/'disabled').
  if (DISABLED_VALUES.has(raw.trim().toLowerCase())) return '';
  return raw;
}

/** Token efectivo (puede ser '' en relays públicos). */
export function resolveRelayToken(db: RelaySettingsLike): string {
  return process.env.RELAY_TOKEN ?? db.getSetting('remote.relay.token') ?? '';
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
