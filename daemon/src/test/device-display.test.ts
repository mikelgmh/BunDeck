/**
 * device-display.test.ts — Brillo por dispositivo + dim + idle.
 *
 * Sin HID ni canvas: la lógica temporal es pura (`device-display.ts`) y el
 * driver se prueba con un `store` en memoria (misma forma que
 * DatabaseService.getSetting/setSetting). Cubre:
 *  1. Claves por dispositivo (dos paths no se pisan).
 *  2. Normalización/clamp + validación del patch del POST.
 *  3. resolvePhase: active → dimmed → idle con 0 = nunca.
 *  4. DeviceIdleTracker: transiciones únicas + wake por actividad.
 *  5. Driver.setDisplaySettings persiste por dispositivo y valida (400-like).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-devdisplay-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase } from '../db';
import {
  DEFAULT_DISPLAY_SETTINGS,
  DeviceIdleTracker,
  dimLevelFor,
  displaySettingKey,
  hasDisplaySettings,
  normalizeBrightness,
  normalizeDimAfterSec,
  normalizeIdleAction,
  normalizeIdleMinutes,
  parseDisplaySettings,
  resolveEffectiveDisplaySettings,
  resolvePhase,
  validateDisplayPatch,
} from '../hw-driver/device-display';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';

beforeAll(async () => {
  // bun importa TODOS los ficheros antes de ejecutar: re-fijar el data dir
  // aquí (patrón del resto de la suite) para no heredar el de otro fichero.
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
});

// Store en memoria con la forma de DatabaseService (para el driver).
function memStore(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getSetting: (k: string) => m.get(k) ?? null,
    setSetting: (k: string, v: string) => void m.set(k, v),
    raw: m,
  };
}

describe('claves por dispositivo', () => {
  it('1. dos paths distintos generan claves distintas', () => {
    const a = displaySettingKey('\\\\?\\hid#vid_05f3&pid_0405', 'brightness');
    const b = displaySettingKey('/dev/hidraw0', 'brightness');
    expect(a).not.toBe(b);
    expect(a.startsWith('devices.')).toBe(true);
    expect(a.endsWith('.brightness')).toBe(true);
  });

  it('2. parse lee lo suyo y defaultea lo ausente', () => {
    const store = memStore({
      [displaySettingKey('deck-A', 'brightness')]: '70',
    });
    const a = parseDisplaySettings(store.getSetting, 'deck-A');
    expect(a.brightness).toBe(70);
    expect(a.dimAfterSec).toBe(DEFAULT_DISPLAY_SETTINGS.dimAfterSec);
    const b = parseDisplaySettings(store.getSetting, 'deck-B');
    expect(b).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });
});

describe('virgen vs configurado (dim automático desactivado por defecto)', () => {
  it('14. virgen (sin claves) → efectivo 100/0/0/off', () => {
    const store = memStore();
    expect(hasDisplaySettings(store.getSetting, 'deck-new')).toBe(false);
    expect(hasDisplaySettings(store.getSetting, '')).toBe(false);
    expect(resolveEffectiveDisplaySettings(store.getSetting, 'deck-new')).toEqual({
      brightness: 100,
      dimAfterSec: 0,
      idleMinutes: 0,
      idleAction: 'off',
    });
  });

  it('15. con ≥1 clave → parse actual (parcial respeta lo guardado, resto 0/0)', () => {
    const store = memStore({ [displaySettingKey('deck-A', 'brightness')]: '70' });
    expect(hasDisplaySettings(store.getSetting, 'deck-A')).toBe(true);
    expect(hasDisplaySettings(store.getSetting, 'deck-B')).toBe(false);
    expect(resolveEffectiveDisplaySettings(store.getSetting, 'deck-A')).toEqual({
      brightness: 70,
      dimAfterSec: 0,
      idleMinutes: 0,
      idleAction: 'off',
    });
  });

  it('16. tracker virgen (todo 0) nunca atenúa ni reposa', () => {
    const tr = new DeviceIdleTracker();
    expect(tr.getSettings()).toMatchObject({ brightness: 100, dimAfterSec: 0, idleMinutes: 0 });
    tr.noteActivity(0);
    expect(tr.poll(10_000_000_000)).toBeNull();
    expect(tr.currentPhase()).toBe('active');
  });
});

describe('normalización y validación', () => {
  it('3. clamp de rangos', () => {
    expect(normalizeBrightness(1000)).toBe(100);
    expect(normalizeBrightness(-5)).toBe(0);
    expect(normalizeBrightness('abc')).toBe(DEFAULT_DISPLAY_SETTINGS.brightness);
    expect(normalizeDimAfterSec(0)).toBe(0);
    expect(normalizeIdleMinutes(0)).toBe(0);
    expect(normalizeIdleAction('CLOCK')).toBe('clock');
    expect(normalizeIdleAction('apagar')).toBe(DEFAULT_DISPLAY_SETTINGS.idleAction);
  });

  it('4. dimLevelFor es el 25 % con suelo en 5', () => {
    expect(dimLevelFor(100)).toBe(25);
    expect(dimLevelFor(80)).toBe(20);
    expect(dimLevelFor(0)).toBe(5);
    expect(dimLevelFor(8)).toBe(5);
  });

  it('5. validateDisplayPatch acepta parcial y rechaza basura', () => {
    expect(validateDisplayPatch({ brightness: 42 })).toEqual({ brightness: 42 });
    expect(validateDisplayPatch({})).toEqual({});
    expect(() => validateDisplayPatch({ brightness: 'mucho' })).toThrow();
    expect(() => validateDisplayPatch({ idleAction: 'fiesta' })).toThrow(/idleAction/);
    expect(() => validateDisplayPatch({ dimAfterSec: 'pronto' })).toThrow();
  });
});

describe('resolvePhase (puro)', () => {
  const cfg = { brightness: 80, dimAfterSec: 300, idleMinutes: 15, idleAction: 'off' as const };
  it('6. active → dimmed → idle por tiempo', () => {
    const t0 = 1_000_000;
    expect(resolvePhase(cfg, t0, t0 + 299_999)).toBe('active');
    expect(resolvePhase(cfg, t0, t0 + 300_000)).toBe('dimmed');
    expect(resolvePhase(cfg, t0, t0 + 899_999)).toBe('dimmed');
    expect(resolvePhase(cfg, t0, t0 + 900_000)).toBe('idle');
  });

  it('7. 0 = nunca (ni dim ni idle)', () => {
    const never = { ...cfg, dimAfterSec: 0, idleMinutes: 0 };
    expect(resolvePhase(never, 0, 10_000_000_000)).toBe('active');
  });

  it('8. sin actividad registrada no hay fase de reposo', () => {
    expect(resolvePhase(cfg, null, Date.now())).toBe('active');
  });

  it('9. solo dim (idle desactivado) se queda en dimmed', () => {
    const onlyDim = { ...cfg, idleMinutes: 0 };
    expect(resolvePhase(onlyDim, 0, 10_000_000_000)).toBe('dimmed');
  });
});

describe('DeviceIdleTracker', () => {
  it('10. transiciones únicas y wake por actividad', () => {
    const tr = new DeviceIdleTracker({ dimAfterSec: 60, idleMinutes: 2, idleAction: 'off' });
    tr.noteActivity(0);
    expect(tr.poll(59_999)).toBeNull(); // sin cambio
    expect(tr.poll(60_000)).toBe('dimmed');
    expect(tr.poll(61_000)).toBeNull(); // ya dimmed: no repetir
    expect(tr.poll(120_000)).toBe('idle');
    tr.noteActivity(130_000); // pulsar despierta
    expect(tr.currentPhase()).toBe('active');
    expect(tr.poll(130_001)).toBeNull();
  });

  it('11. updateSettings cambia umbrales en caliente', () => {
    const tr = new DeviceIdleTracker({ dimAfterSec: 3600, idleMinutes: 0, idleAction: 'off' });
    tr.noteActivity(0);
    expect(tr.poll(61_000)).toBeNull();
    tr.updateSettings({ dimAfterSec: 60 });
    expect(tr.poll(61_000)).toBe('dimmed');
  });
});

describe('driver.setDisplaySettings (store inyectado, sin HID)', () => {
  it('12. persiste por dispositivo y valida', async () => {
    const store = memStore();
    const s = await streamDeckDriver.setDisplaySettings(
      { brightness: 60, dimAfterSec: 120, idleMinutes: 5, idleAction: 'dim' },
      'test-deck-1',
      store,
    );
    expect(s).toMatchObject({ brightness: 60, dimAfterSec: 120, idleMinutes: 5, idleAction: 'dim' });
    expect(store.raw.get(displaySettingKey('test-deck-1', 'brightness'))).toBe('60');
    // El otro dispositivo sigue con defaults.
    expect(parseDisplaySettings(store.getSetting, 'test-deck-2')).toEqual(DEFAULT_DISPLAY_SETTINGS);
    await expect(
      streamDeckDriver.setDisplaySettings({ brightness: 'mucho' }, 'test-deck-1', store),
    ).rejects.toThrow();
  });

  it('13. setBrightness atajo con clamp', async () => {
    const store = memStore();
    const s = await streamDeckDriver.setBrightness('test-deck-9', 1000, store);
    expect(s.brightness).toBe(100);
    expect(store.raw.get(displaySettingKey('test-deck-9', 'brightness'))).toBe('100');
  });
});
