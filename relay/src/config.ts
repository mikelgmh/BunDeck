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
  rateLimitPair: number;
  trustProxy: boolean;
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
 * - RELAY_RATE_LIMIT_WS (def 120): cuota mensajes WS por IP.
 * - RELAY_RATE_LIMIT_PAIR (def 30): cuota POST /pair por IP.
 * - TRUST_PROXY=1: respeta X-Forwarded-For / X-Real-IP / CF-Connecting-IP para rate-limit
 *   (solo activar detrás de proxy confiable como openship; si no, todas las IPs colapsan).
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
    rateLimitPair: parseLimit(env.RELAY_RATE_LIMIT_PAIR, 30),
    trustProxy,
  };
}
