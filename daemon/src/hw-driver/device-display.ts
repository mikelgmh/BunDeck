/**
 * device-display.ts — Brillo por dispositivo + dim + idle para Stream Deck HW.
 *
 * Persistencia: settings del daemon con clave por dispositivo
 * (`devices.<id>.brightness`, `.dimAfterSec`, `.idleMinutes`, `.idleAction`),
 * mismo patrón que `input.longpress_ms`. El `<id>` va URI-codificado para
 * que paths HID (`\\?\hid#...`, `/dev/hidraw0`) no rompan la clave.
 *
 * Todo lo temporalmente sensible es puro e inyectable (nowMs) para poder
 * probarlo con bun:test sin HID ni timers reales. El driver (`streamdeck-driver.ts`)
 * solo aporta el bucle (setInterval) y el pintado (setBrightness nativo de
 * `@elgato-stream-deck/node`, clearPanel/repintado como fallback).
 */

export type IdleAction = 'off' | 'dim' | 'clock';

export const IDLE_ACTIONS: IdleAction[] = ['off', 'dim', 'clock'];

export interface DeviceDisplaySettings {
  /** 0-100. Nivel base cuando está activo. */
  brightness: number;
  /** Segundos sin pulsar antes de atenuar. 0 = nunca. */
  dimAfterSec: number;
  /** Minutos sin pulsar antes de la acción de reposo. 0 = nunca. */
  idleMinutes: number;
  /** Qué hacer en reposo: apagar, atenuar o mostrar reloj. */
  idleAction: IdleAction;
}

export const DEFAULT_DISPLAY_SETTINGS: DeviceDisplaySettings = {
  brightness: 100,
  dimAfterSec: 300,
  idleMinutes: 15,
  idleAction: 'off',
};

export const DISPLAY_SETTING_FIELDS = ['brightness', 'dimAfterSec', 'idleMinutes', 'idleAction'] as const;
export type DisplaySettingField = (typeof DISPLAY_SETTING_FIELDS)[number];

/** Codifica el id/path del dispositivo para usarlo dentro de una clave de setting. */
export function encodeDeviceKey(deviceId: string): string {
  return encodeURIComponent(String(deviceId ?? ''));
}

/** Clave de setting para un campo de pantalla de un dispositivo concreto. */
export function displaySettingKey(deviceId: string, field: DisplaySettingField): string {
  return `devices.${encodeDeviceKey(deviceId)}.${field}`;
}

const clampInt = (v: unknown, min: number, max: number, fb: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return fb;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** Brillo 0-100 (100 = valor de fábrica / sin atenuar). */
export function normalizeBrightness(v: unknown): number {
  return clampInt(v, 0, 100, DEFAULT_DISPLAY_SETTINGS.brightness);
}

/** Nivel atenuado para `dim`: 25 % del base, con suelo en 5 para no apagar del todo. */
export function dimLevelFor(brightness: number): number {
  const b = normalizeBrightness(brightness);
  return Math.max(5, Math.round(b * 0.25));
}

export function normalizeDimAfterSec(v: unknown): number {
  // 0 = nunca; tope 24 h.
  return clampInt(v, 0, 86400, DEFAULT_DISPLAY_SETTINGS.dimAfterSec);
}

export function normalizeIdleMinutes(v: unknown): number {
  // 0 = nunca; tope 24 h.
  return clampInt(v, 0, 1440, DEFAULT_DISPLAY_SETTINGS.idleMinutes);
}

export function normalizeIdleAction(v: unknown): IdleAction {
  const s = String(v ?? '').toLowerCase();
  return (IDLE_ACTIONS as string[]).includes(s) ? (s as IdleAction) : DEFAULT_DISPLAY_SETTINGS.idleAction;
}

/**
 * Lee los ajustes de un dispositivo desde un lector `getSetting`
 * (DatabaseService.getSetting en producción, un Map en tests).
 * Cada dispositivo tiene los suyos: dos paths distintos nunca se pisan.
 */
export function parseDisplaySettings(
  get: (key: string) => string | null | undefined,
  deviceId: string,
): DeviceDisplaySettings {
  if (!deviceId) return { ...DEFAULT_DISPLAY_SETTINGS };
  const raw = (f: DisplaySettingField) => {
    try {
      return get(displaySettingKey(deviceId, f));
    } catch {
      return null;
    }
  };
  return {
    brightness: normalizeBrightness(raw('brightness')),
    dimAfterSec: normalizeDimAfterSec(raw('dimAfterSec')),
    idleMinutes: normalizeIdleMinutes(raw('idleMinutes')),
    idleAction: normalizeIdleAction(raw('idleAction')),
  };
}

/** Valida un patch parcial (del POST del API). Lanza Error con mensaje claro si inválido. */
export function validateDisplayPatch(patch: Record<string, unknown>): Partial<DeviceDisplaySettings> {
  const out: Partial<DeviceDisplaySettings> = {};
  if (patch.brightness !== undefined) {
    if (!Number.isFinite(Number(patch.brightness))) throw new Error('brightness debe ser un entero 0-100');
    out.brightness = normalizeBrightness(patch.brightness);
  }
  if (patch.dimAfterSec !== undefined) {
    if (!Number.isFinite(Number(patch.dimAfterSec))) throw new Error('dimAfterSec debe ser segundos (0 = nunca)');
    out.dimAfterSec = normalizeDimAfterSec(patch.dimAfterSec);
  }
  if (patch.idleMinutes !== undefined) {
    if (!Number.isFinite(Number(patch.idleMinutes))) throw new Error('idleMinutes debe ser minutos (0 = nunca)');
    out.idleMinutes = normalizeIdleMinutes(patch.idleMinutes);
  }
  if (patch.idleAction !== undefined) {
    if (!(IDLE_ACTIONS as string[]).includes(String(patch.idleAction))) {
      throw new Error(`idleAction debe ser una de: ${IDLE_ACTIONS.join(', ')}`);
    }
    out.idleAction = normalizeIdleAction(patch.idleAction);
  }
  return out;
}

export type IdlePhase = 'active' | 'dimmed' | 'idle';

/**
 * Fase pura según el tiempo desde la última actividad. `dim` precede a `idle`
 * cuando ambos están configurados (dimAfterSec < idleMinutes*60).
 */
export function resolvePhase(
  settings: DeviceDisplaySettings,
  lastActivityMs: number | null,
  nowMs: number,
): IdlePhase {
  if (lastActivityMs == null) return 'active';
  const idleAt =
    settings.idleMinutes > 0 ? lastActivityMs + settings.idleMinutes * 60_000 : Number.POSITIVE_INFINITY;
  const dimAt =
    settings.dimAfterSec > 0 ? lastActivityMs + settings.dimAfterSec * 1000 : Number.POSITIVE_INFINITY;
  if (nowMs >= idleAt) return 'idle';
  if (nowMs >= dimAt) return 'dimmed';
  return 'active';
}

/**
 * Seguidor de inactividad con callbacks inyectables (sin timers propios:
 * el driver lo sondea con su bucle y los tests avanzan el reloj a mano).
 */
export class DeviceIdleTracker {
  private settings: DeviceDisplaySettings;
  private lastActivityMs: number | null = null;
  private phase: IdlePhase = 'active';

  constructor(initial?: Partial<DeviceDisplaySettings>) {
    this.settings = { ...DEFAULT_DISPLAY_SETTINGS, ...initial };
  }

  updateSettings(patch: Partial<DeviceDisplaySettings>): void {
    this.settings = { ...this.settings, ...patch };
  }

  getSettings(): DeviceDisplaySettings {
    return { ...this.settings };
  }

  noteActivity(nowMs: number): void {
    this.lastActivityMs = nowMs;
    this.phase = 'active';
  }

  /**
   * Avanza el estado al instante `nowMs`. Devuelve la fase nueva solo si
   * cambió (para que el llamador repinte/aplique una sola vez).
   */
  poll(nowMs: number): IdlePhase | null {
    const next = resolvePhase(this.settings, this.lastActivityMs, nowMs);
    if (next === this.phase) return null;
    this.phase = next;
    return next;
  }

  currentPhase(): IdlePhase {
    return this.phase;
  }
}
