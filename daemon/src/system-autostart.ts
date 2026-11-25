/**
 * system-autostart.ts — ajuste persistente `system.autostart`.
 *
 * FLUJO COMPLETO (leer antes de tocar):
 * 1. La web (SettingsDialog → useAutostart) hace GET/POST
 *    `/api/v1/settings?key=system.autostart` (daemon/src/api/system.ts).
 *    El POST emite broadcast WS `settings.changed` (topic `settings`).
 * 2. El valor vive en la tabla `settings` vía `DatabaseService`
 *    (daemon/src/db.ts; semilla `false` en `defaultSettings`). Nunca SQL
 *    crudo fuera de DatabaseService.
 * 3. El launcher Rust (launcher/src/autostart.rs) lee ese mismo setting
 *    en su sondeo cada 2s y aplica el autostart del SO:
 *    Windows HKCU…\Run, Linux ~/.config/autostart/*.desktop,
 *    macOS ~/Library/LaunchAgents/*.plist.
 *    En dev (DEV_MODE=true) solo lo registra, no toca el sistema.
 *
 * El daemon NO toca el autostart del SO: solo guarda la preferencia.
 * El dueño del SO es el launcher; la web es solo el interruptor.
 */

import type { DatabaseService } from './db';

/** Clave canónica en la tabla `settings`. */
export const AUTOSTART_KEY = 'system.autostart';

/**
 * Normaliza cualquier representación a booleano.
 * Acepta booleanos, números y cadenas habituales ('true', '1', 'on',
 * 'yes', 'enabled'). Todo lo demás (incluido null/undefined) es false.
 */
export function parseAutostart(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    // La web guarda JSON.stringify(bool) → "true"/"false"; el launcher y
    // semillas antiguas pueden usar "1"/"0".
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === 'boolean') return parsed;
      if (typeof parsed === 'number') return parsed !== 0;
    } catch {
      // No era JSON: seguir con la comparación textual de abajo.
    }
    return v === '1' || v === 'true' || v === 'on' || v === 'yes' || v === 'enabled';
  }
  return false;
}

/** Serialización canónica para guardar en `settings` (siempre string). */
export function formatAutostart(enabled: boolean): string {
  return enabled ? 'true' : 'false';
}

/** Lee la preferencia (false si no existe o es ilegible). */
export function readAutostart(db: Pick<DatabaseService, 'getSetting'>): boolean {
  try {
    return parseAutostart(db.getSetting(AUTOSTART_KEY));
  } catch {
    return false;
  }
}

/** Guarda la preferencia normalizada a 'true'/'false'. */
export function writeAutostart(db: Pick<DatabaseService, 'setSetting'>, enabled: boolean): void {
  db.setSetting(AUTOSTART_KEY, formatAutostart(enabled));
}
