import { join } from 'path';

function parsePort(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseLimit(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface RelayConfig {
  port: number;
  token: string;
  domain: string;
  dataDir: string;
  version: string;
  rateLimitT: number;
  rateLimitUi: number;
  rateLimitWs: number;
  rateLimitWsData: number;
  rateLimitPair: number;
  trustProxy: boolean;
  /** App de Discord del maintainer (cero-config): el secret NUNCA sale del servidor. */
  discordClientId: string;
  discordClientSecret: string;
  /** Secreto de aprovisionamiento para POST /api/device-claim. Vacío = claim deshabilitado. */
  provisionToken: string;
  /** Cuota de claims por IP y día (def 200). */
  claimPerDay: number;
  /** Ráfaga de claims por IP y hora (def 50). */
  claimBurstPerHour: number;
  /** Ventana de gracia tras rotar: el token viejo sigue válido este tiempo (def 5 min). */
  rotateGraceMs: number;
  /**
   * Ventana de gracia para tokens desconocidos tras arrancar (def 90 s):
   * un `/t/<token>/` o `/s/<sid>/` que no existe en memoria PERO el relay
   * acaba de arrancar (redespliegue con base vacía/efímera) responde
   * `502 daemon-offline` + `Retry-After` (reintentable) en vez de 401
   * definitivo. Cubre el tiempo que tarda el daemon en reconectar y
   * re-emitir `ui-rebind` (backoff 1s→30s). Pasada la ventana, desconocido =
   * 401 `invalid-token` (pedir QR nuevo). 0 = desactivar (solo tests).
   */
  unknownTokenGraceMs: number;
}

export const VERSION = '0.2.0';

/**
 * Configuración del relay, solo por variables de entorno
 * (misma convención que daemon/src/config.ts).
 *
 * - RELAY_PORT (def 8787). PORT tiene prioridad (openship/openpanel inyectan $PORT).
 * - RELAY_TOKEN: secreto compartido para conectar (WS y POST /pair). Vacío = abierto (solo dev).
 * - RELAY_DOMAIN: solo informativo para logs (p.ej. relay.bundeck.app).
 * - DATA_DIR / RELAY_DATA_DIR: dónde vive relay.db (def relay/data).
 * - RELAY_RATE_LIMIT_T (def 600): cuota /t/* por token (plano de datos). Antes 60 global.
 * - RELAY_RATE_LIMIT_UI (def 120): cuota /ui/* por IP.
 * - RELAY_RATE_LIMIT_WS (def 120): cuota mensajes WS de control por IP.
 * - RELAY_RATE_LIMIT_WS_DATA (def 600): cuota tráfico de datos daemon→relay
 *   (`http-res`, `ws-msg`, `ws-close`, `tunnel-pong`) por IP. Una carga
 *   inicial tras aprobar supera 120 msg/min y el limiter único tiraba
 *   `http-res` a la basura (petición colgada 30 s hasta 504).
 * - RELAY_RATE_LIMIT_PAIR (def 30): cuota POST /pair por IP.
 * - RELAY_PROVISION_TOKEN: secreto de aprovisionamiento para POST
 *   /api/device-claim (auto-provisión de device tokens). Vacío = claim
 *   deshabilitado (POST /api/device-claim responde 503 claim-disabled).
 * - RELAY_CLAIM_PER_DAY (def 200): cuota de claims por IP y día.
 * - RELAY_CLAIM_BURST_PER_HOUR (def 50): ráfaga de claims por IP y hora.
 * - RELAY_ROTATE_GRACE_MS (def 300000 = 5 min): tras POST /api/device-rotate
 *   el token viejo sigue aceptado este tiempo y luego muere.
 * - TRUST_PROXY=1: respeta X-Forwarded-For / X-Real-IP / CF-Connecting-IP para rate-limit
 *   (solo activar detrás de proxy confiable como openship; si no, todas las IPs colapsan).
 * - DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET: app de Discord del maintainer para
 *   el proxy OAuth `POST /api/discord/rpc-token` (el secret NUNCA sale del
 *   servidor; ver docs/discord-app-setup.md). Sin ellos el proxy responde
 *   `discord-not-configured` (500) y el callback https sigue sirviendo la
 *   página de auto-captura / copiado manual.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const token = (env.RELAY_TOKEN ?? '').trim();
  const trustProxy = ['1', 'true', 'yes', 'on'].includes((env.TRUST_PROXY ?? '').trim().toLowerCase());
  return {
    port: parsePort(env.PORT ?? env.RELAY_PORT, 8787),
    token,
    domain: (env.RELAY_DOMAIN ?? '').trim(),
    dataDir:
      env.RELAY_DATA_DIR?.trim() ||
      env.DATA_DIR?.trim() ||
      join(import.meta.dir, '..', 'data'),
    version: VERSION,
    rateLimitT: parseLimit(env.RELAY_RATE_LIMIT_T, 600),
    rateLimitUi: parseLimit(env.RELAY_RATE_LIMIT_UI, 120),
    rateLimitWs: parseLimit(env.RELAY_RATE_LIMIT_WS, 120),
    rateLimitWsData: parseLimit(env.RELAY_RATE_LIMIT_WS_DATA, 600),
    rateLimitPair: parseLimit(env.RELAY_RATE_LIMIT_PAIR, 30),
    trustProxy,
    discordClientId: (env.DISCORD_CLIENT_ID ?? '').trim(),
    discordClientSecret: (env.DISCORD_CLIENT_SECRET ?? '').trim(),
    provisionToken: (env.RELAY_PROVISION_TOKEN ?? '').trim(),
    claimPerDay: parseLimit(env.RELAY_CLAIM_PER_DAY, 200),
    claimBurstPerHour: parseLimit(env.RELAY_CLAIM_BURST_PER_HOUR, 50),
    rotateGraceMs: parseLimit(env.RELAY_ROTATE_GRACE_MS, 5 * 60_000),
    unknownTokenGraceMs: parseLimit(env.RELAY_UNKNOWN_TOKEN_GRACE_MS, 90_000),
  };
}
