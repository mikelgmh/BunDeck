/**
 * default-profile-icons.test.ts — seeds y migración de marcas a Simple Icons.
 *
 * - Los seeds nuevos usan `si:youtube` / `si:twitch` / `si:spotify` (Lucide
 *   eliminó las marcas y el HW las pintaba como texto).
 * - La migración (`default.brandicons_si_v1`, una sola vez) convierte los
 *   botones con la firma exacta del seed antiguo y respeta cualquier
 *   personalización del usuario (etiqueta o icono distintos).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-brandicons-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;

import { initDatabase, DatabaseService } from '../db';
import {
  ensureDefaultProfile,
  DEFAULT_BRANDICONS_MIGRATION_KEY,
} from '../default-profile';

// Como en phase1-model.test.ts: action-runner.test.ts sustituye '../db' por
// un mock global en la run completa; la parte física solo corre con la real.
const UNDER_MOCK = DatabaseService.name !== 'DatabaseService';
const itReal: typeof it = UNDER_MOCK ? (it.skip as any) : it;

let db: DatabaseService;

beforeAll(async () => {
  process.env.LIBREDECK_DATA_DIR = TMP;
  await initDatabase();
  db = new DatabaseService();
}, 120_000);

function iconByPosition(pageId: string, position: number): string | undefined {
  const btn = db.getButtonsByPage(pageId).find((b) => b.position === position);
  return (btn?.data as any)?.icon;
}

describe('default profile: marcas Simple Icons', () => {
  itReal('los seeds nuevos usan `si:` para YouTube/Twitch/Spotify', () => {
    const r = ensureDefaultProfile(db);
    expect(r).not.toBeNull();
    const deck = r!.deckPageId;
    expect(iconByPosition(deck, 6)).toBe('si:youtube');
    expect(iconByPosition(deck, 7)).toBe('si:spotify');
    expect(iconByPosition(deck, 8)).toBe('si:twitch');
  });

  itReal('la migración convierte la firma del seed y respeta lo personalizado', () => {
    const r = ensureDefaultProfile(db);
    const deck = r!.deckPageId;
    const btns = db.getButtonsByPage(deck);
    const byPos = new Map(btns.map((b) => [b.position, b]));

    // Simula seeds antiguos + dos personalizaciones del usuario.
    db.updateButton(byPos.get(6)!.id, { ...byPos.get(6)!.data, icon: 'Youtube' });
    db.updateButton(byPos.get(8)!.id, { ...byPos.get(8)!.data, icon: 'Twitch' });
    db.updateButton(byPos.get(7)!.id, { ...byPos.get(7)!.data, label: 'Mi música', icon: 'Music' });
    db.updateButton(byPos.get(5)!.id, { ...byPos.get(5)!.data, label: 'YouTube', icon: 'Play' });
    db.deleteSetting(DEFAULT_BRANDICONS_MIGRATION_KEY);

    const out = ensureDefaultProfile(db);
    expect(out!.seeded).toBe(true);
    expect(iconByPosition(deck, 6)).toBe('si:youtube');
    expect(iconByPosition(deck, 8)).toBe('si:twitch');
    // Personalizados intactos: otra etiqueta / otro icono no se tocan.
    const seven = db.getButtonsByPage(deck).find((b) => b.position === 7);
    expect((seven?.data as any)?.icon).toBe('Music');
    expect((seven?.data as any)?.label).toBe('Mi música');
    expect(iconByPosition(deck, 5)).toBe('Play');
    // Idempotente: segunda pasada con el ajuste marcado no cambia nada.
    db.updateButton(byPos.get(6)!.id, { ...db.getButton(byPos.get(6)!.id)!.data, icon: 'si:youtube' });
    ensureDefaultProfile(db);
    expect(iconByPosition(deck, 6)).toBe('si:youtube');
    expect(db.getSetting(DEFAULT_BRANDICONS_MIGRATION_KEY)).toBe('1');
  });
});
