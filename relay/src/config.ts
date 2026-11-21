import { join } from 'path';

function parsePort(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface RelayConfig {
  port: number;
  token: string;
  domain: string;
  dataDir: string;
  version: string;
}

export const VERSION = '0.1.0';

/**
 * Configuración del relay, solo por variables de entorno
 * (misma convención que daemon/src/config.ts).
 *
 * - RELAY_PORT (def 8787). PORT tiene prioridad (openship/openpanel inyectan $PORT).
 * - RELAY_TOKEN: secreto compartido para conectar (WS y POST /pair). Vacío = abierto (solo dev).
 * - RELAY_DOMAIN: solo informativo para logs (p.ej. bundeck.mikelgranero.com).
 * - DATA_DIR / RELAY_DATA_DIR: dónde vive relay.db (def relay/data).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const token = (env.RELAY_TOKEN ?? '').trim();
  return {
    port: parsePort(env.PORT ?? env.RELAY_PORT, 8787),
    token,
    domain: (env.RELAY_DOMAIN ?? '').trim(),
    dataDir:
      env.RELAY_DATA_DIR?.trim() ||
      env.DATA_DIR?.trim() ||
      join(import.meta.dir, '..', 'data'),
    version: VERSION,
  };
}
