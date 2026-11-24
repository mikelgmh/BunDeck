/**
 * elgato.test.ts — conversor Elgato (Fase 0): análisis, conversión y rechazo.
 * Fixture con la forma real del manifest de DeckCal (com.ewels.deckcal).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-elgato-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { analyzeElgatoManifest, convertElgatoManifest } from '../elgato/manifest';
import { importElgatoPlugin } from '../elgato/import';

let db: DatabaseService;
beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
});

// Forma real (campos relevantes) del manifest de DeckCal
function deckCalManifest() {
  return {
    Name: 'DeckCal',
    Version: '1.1.1.0',
    Author: 'Phil Ewels',
    UUID: 'com.ewels.deckcal',
    Description: 'Meeting countdown',
    CodePath: 'bin/plugin.js',
    Nodejs: { Version: '24' },
    SDKVersion: 3,
    Category: 'DeckCal',
    URL: 'https://github.com/ewels/DeckCal',
    Actions: [
      {
        Name: 'Meeting countdown',
        UUID: 'com.ewels.deckcal.countdown',
        Tooltip: 'Countdown to next meeting',
        Icon: 'imgs/actions/countdown/icon',
        PropertyInspectorPath: 'ui/countdown.html',
        Controllers: ['Keypad'],
        States: [{ Image: 'imgs/actions/countdown/key', ShowTitle: false }],
      },
      {
        Name: 'Meeting alert',
        UUID: 'com.ewels.deckcal.alert',
        Tooltip: 'Flash when meeting starts',
        Icon: 'imgs/actions/alert/icon',
        Controllers: ['Keypad'],
        States: [{ Image: 'imgs/actions/alert/key' }],
      },
    ],
  };
}

describe('Elgato manifest (DeckCal)', () => {
  it('analiza y convierte un plugin JS Keypad', () => {
    const report = analyzeElgatoManifest(deckCalManifest());
    expect(report.detected).toBe(true);
    expect(report.uuid).toBe('com.ewels.deckcal');
    expect(report.semver).toBe('1.1.1');
    expect(report.runtime).toBe('node');
    expect(report.compatible).toBe(true);
    expect(report.reasons).toEqual([]);

    const ours = convertElgatoManifest(deckCalManifest(), report);
    expect(ours.id).toBe('com.ewels.deckcal');
    expect(ours.version).toBe('1.1.1');
    expect(ours.actions.map((a: any) => a.id)).toEqual(['countdown', 'alert']);
    expect(ours['x-elgato'].runtime).toBe('node');
  });

  it('rechaza binarios nativos', () => {
    const m = deckCalManifest();
    (m as any).CodePath = 'bin/plugin.exe';
    delete (m as any).Nodejs;
    const report = analyzeElgatoManifest(m);
    expect(report.runtime).toBe('native');
    expect(report.compatible).toBe(false);
    expect(report.reasons.join(' ')).toMatch(/nativo/i);
  });

  it('rechaza acciones sin Keypad', () => {
    const m = deckCalManifest();
    m.Actions.forEach((a: any) => { a.Controllers = ['Encoder']; });
    const report = analyzeElgatoManifest(m);
    expect(report.compatible).toBe(false);
    expect(report.actions.every((a) => a.status === 'skip')).toBe(true);
  });

  it('rechaza manifests no-Elgato', () => {
    const report = analyzeElgatoManifest({ id: 'x', name: 'y' });
    expect(report.compatible).toBe(false);
  });
});

describe('importElgatoPlugin (local)', () => {
  function makeSdPlugin(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-elg-src-'));
    const dir = path.join(root, 'com.ejemplo.demo.sdPlugin');
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      ...deckCalManifest(),
      UUID: 'com.ejemplo.demo',
      Name: 'Demo',
      Actions: [{
        Name: 'Contar', UUID: 'com.ejemplo.demo.contar',
        Controllers: ['Keypad'], Icon: 'imgs/icon',
      }],
    }));
    fs.writeFileSync(path.join(dir, 'bin', 'plugin.js'), '// fake\n');
    return dir;
  }

  it('dryRun diagnostica sin instalar', async () => {
    const dir = makeSdPlugin();
    const res = await importElgatoPlugin(db, { dir }, { dryRun: true });
    expect(res.report.compatible).toBe(true);
    expect(res.installed).toBe(false);
    expect(db.getPlugin('com.ejemplo.demo')).toBeNull();
  });

  it('instala habilitado con shim en-Worker (bridge + arranque perezoso)', async () => {
    const dir = makeSdPlugin();
    const res = await importElgatoPlugin(db, { dir }, {});
    expect(res.installed).toBe(true);
    const rec = db.getPlugin('com.ejemplo.demo') as any;
    expect(rec).not.toBeNull();
    expect(Number(rec.enabled)).toBe(1);
    expect(rec.source_type).toBe('elgato');
    expect(rec.status).toBe('active');
    const folder = path.join(TMP, 'plugins', 'com.ejemplo.demo');
    expect(fs.existsSync(path.join(folder, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'elgato-manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'elgato', 'bin', 'plugin.js'))).toBe(true);
    // Shim: bridge + SDK en-Worker, sin stub main.js legacy ni procesos node.
    expect(fs.existsSync(path.join(folder, 'shim-bridge.js'))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'elgato-shim-sdk.js'))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'elgato', 'node_modules', '@elgato', 'streamdeck', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'main.js'))).toBe(false);
    const ours = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    expect(ours['x-elgato']).toBeDefined();
    expect(ours['x-elgato'].shim?.mode).toBe('worker-lazy');
    expect(ours.main).toBe('shim-bridge.js');
    expect(ours.actions.map((a: any) => a.id)).toEqual(['contar']);
  });

  it('CodePath ausente queda needs-manual (diagnóstico apagado)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-elg-src-'));
    const dir = path.join(root, 'com.ejemplo.falta.sdPlugin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      ...deckCalManifest(),
      UUID: 'com.ejemplo.falta',
      Name: 'Falta',
      CodePath: 'bin/plugin.js',
      Nodejs: { Version: '20' },
      Actions: [{
        Name: 'Contar', UUID: 'com.ejemplo.falta.contar',
        Controllers: ['Keypad'], Icon: 'imgs/icon',
      }],
    }));
    // Sin bin/plugin.js en disco: compatible pero sin fichero ejecutable.
    const res = await importElgatoPlugin(db, { dir }, {});
    expect(res.installed).toBe(true);
    const rec = db.getPlugin('com.ejemplo.falta') as any;
    expect(rec).not.toBeNull();
    expect(Number(rec.enabled)).toBe(0);
    expect(rec.status).toBe('needs-manual');
  });
});
