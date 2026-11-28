/**
 * system-autostart.test.ts — el setting `system.autostart` persiste y se
 * normaliza (web ↔ daemon ↔ launcher Rust; ver system-autostart.ts).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-autostart-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import {
  AUTOSTART_KEY,
  START_MINIMIZED_KEY,
  parseAutostart,
  parseStartMinimized,
  formatAutostart,
  readAutostart,
  writeAutostart,
  readStartMinimized,
  writeStartMinimized,
} from '../system-autostart';

let db: DatabaseService;

beforeAll(async () => {
  // bun importa TODOS los ficheros antes de ejecutar: re-fijar el data dir
  // aquí (patrón del resto de la suite) para no heredar el de otro fichero.
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
});

describe('system.autostart: parseo tolerante', () => {
  it('acepta booleanos y números', () => {
    expect(parseAutostart(true)).toBe(true);
    expect(parseAutostart(false)).toBe(false);
    expect(parseAutostart(1)).toBe(true);
    expect(parseAutostart(0)).toBe(false);
  });

  it('acepta las formas que guardan la web y semillas ("true", "1", JSON)', () => {
    expect(parseAutostart('true')).toBe(true);
    expect(parseAutostart('false')).toBe(false);
    expect(parseAutostart('1')).toBe(true);
    expect(parseAutostart('0')).toBe(false);
    expect(parseAutostart('  TRUE  ')).toBe(true);
    expect(parseAutostart('on')).toBe(true);
  });

  it('todo lo demás es false (nunca arrancar por defecto)', () => {
    expect(parseAutostart(null)).toBe(false);
    expect(parseAutostart(undefined)).toBe(false);
    expect(parseAutostart('')).toBe(false);
    expect(parseAutostart('maybe')).toBe(false);
    expect(parseAutostart({})).toBe(false);
  });

  it('format siempre produce "true"/"false"', () => {
    expect(formatAutostart(true)).toBe('true');
    expect(formatAutostart(false)).toBe('false');
  });
});

describe('system.autostart: persistencia en settings', () => {
  it('la semilla por defecto es false (o ausente bajo el mock de suite)', () => {
    // DB fresca real (initDatabase): INSERT con 'false'. Bajo el mock
    // in-memory compartido de la suite completa no hay semilla: en ambos
    // casos la lectura debe ser false (nunca arrancar por defecto).
    const raw = db.getSetting(AUTOSTART_KEY);
    expect(raw === null || raw === 'false').toBe(true);
    expect(readAutostart(db)).toBe(false);
  });

  it('get/set roundtrip', () => {
    writeAutostart(db, true);
    expect(db.getSetting(AUTOSTART_KEY)).toBe('true');
    expect(readAutostart(db)).toBe(true);

    writeAutostart(db, false);
    expect(db.getSetting(AUTOSTART_KEY)).toBe('false');
    expect(readAutostart(db)).toBe(false);
  });

  it('normaliza valores heredados raros al leer', () => {
    db.setSetting(AUTOSTART_KEY, '1');
    expect(readAutostart(db)).toBe(true);
    db.setSetting(AUTOSTART_KEY, 'basura');
    expect(readAutostart(db)).toBe(false);
    // Dejar la DB como estaba.
    writeAutostart(db, false);
  });
});

describe('system.start_minimized: persistencia en settings', () => {
  it('la semilla por defecto es true (o ausente bajo el mock de suite → true)', () => {
    const raw = db.getSetting(START_MINIMIZED_KEY);
    expect(raw === null || raw === 'true').toBe(true);
    // Con semilla presente la lectura es true.
    db.setSetting(START_MINIMIZED_KEY, 'true');
    expect(readStartMinimized(db)).toBe(true);
  });

  it('ausente → true (nunca robar la ventana en arranque automático)', () => {
    db.deleteSetting(START_MINIMIZED_KEY);
    expect(readStartMinimized(db)).toBe(true);
    expect(parseStartMinimized(null)).toBe(true);
    expect(parseStartMinimized(undefined)).toBe(true);
    expect(parseStartMinimized('')).toBe(true);
    expect(parseStartMinimized('basura')).toBe(true);
    expect(parseStartMinimized('false')).toBe(false);
    expect(parseStartMinimized('0')).toBe(false);
    expect(parseStartMinimized('off')).toBe(false);
    db.setSetting(START_MINIMIZED_KEY, 'basura');
    expect(readStartMinimized(db)).toBe(true);
    db.setSetting(START_MINIMIZED_KEY, '1');
    expect(readStartMinimized(db)).toBe(true);
    db.setSetting(START_MINIMIZED_KEY, 'false');
    expect(readStartMinimized(db)).toBe(false);
    // Dejar la DB como estaba (default ON).
    writeStartMinimized(db, true);
  });

  it('get/set roundtrip', () => {
    writeStartMinimized(db, false);
    expect(db.getSetting(START_MINIMIZED_KEY)).toBe('false');
    expect(readStartMinimized(db)).toBe(false);

    writeStartMinimized(db, true);
    expect(db.getSetting(START_MINIMIZED_KEY)).toBe('true');
    expect(readStartMinimized(db)).toBe(true);
  });
});
