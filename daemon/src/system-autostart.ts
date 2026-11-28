/**
 * system-autostart.ts — preferencias persistentes de arranque.
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
 * `system.start_minimized` (semilla `true`): cuando el launcher arranca por
 * autostart (o con el flag `--minimized` registrado en el SO), no muestra la
 * ventana: solo ancla + tray. La web lo edita igual que `system.autostart`;
 * el daemon solo guarda la preferencia, nunca toca el SO.
 *
 * El daemon NO toca el autostart del SO: solo guarda la preferencia.
 * El dueño del SO es el launcher; la web es solo el interruptor.
 */

import type { DatabaseService } from './db';

/** Clave canónica en la tabla `settings`. */
export const AUTOSTART_KEY = 'system.autostart';
/** Iniciar el panel minimizado (solo tray) cuando arranca por autostart. */
export const START_MINIMIZED_KEY = 'system.start_minimized';

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

/** Lee `system.start_minimized` (true si no existe: default ON). */
export function readStartMinimized(db: Pick<DatabaseService, 'getSetting'>): boolean {
  try {
    const raw = db.getSetting(START_MINIMIZED_KEY);
    if (raw === null || raw === undefined) return true;
    return parseStartMinimized(raw);
  } catch {
    return true;
  }
}

/**
 * Normaliza `system.start_minimized` a booleano con fail-open: ausente o
 * ilegible → true (el arranque automático no debe robar la ventana).
 * Solo las formas explícitas de apagado ('false', '0', 'no', 'off',
 * 'disabled') dan false; el resto (incluida basura heredada) da true.
 */
export function parseStartMinimized(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === '') return true;
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === 'boolean') return parsed;
      if (typeof parsed === 'number') return parsed !== 0;
    } catch {
      // No era JSON: comparación textual con veto explícito.
    }
    if (v === 'false' || v === '0' || v === 'no' || v === 'off' || v === 'disabled') return false;
    return true;
  }
  return true;
}

/** Guarda `system.start_minimized` normalizado a 'true'/'false'. */
export function writeStartMinimized(db: Pick<DatabaseService, 'setSetting'>, enabled: boolean): void {
  db.setSetting(START_MINIMIZED_KEY, formatAutostart(enabled));
}
