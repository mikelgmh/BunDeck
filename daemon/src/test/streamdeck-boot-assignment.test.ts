/**
 * streamdeck-boot-assignment.test.ts — el HW abre con SU página asignada.
 *
 * Regresión: al abrir la app (boot / POST connect) el daemon nunca leía
 * `profile_assignments` para 'streamdeck-local', y el PUT assignments
 * saltaba el repintado en silencio cuando `pickHwDeckForRepaint`
 * devolvía null. Cubre:
 * - `resolveAssignedPageForDevice`: asignada válida vs fallback.
 * - `diagnoseHwPickMiss`: motivo del pick nulo (sin silencio).
 * - `applyProfileAssignment` (boot/connect): resuelve la asignación del
 *   perfil actual y fija la sesión del driver.
 * - PUT assignments: aunque el pick falle, repinta 'streamdeck-local'
 *     (fallback con warn) y sigue respondiendo 200 + guardado.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-hwboot-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import {
  resolveAssignedPageForDevice,
  diagnoseHwPickMiss,
  pickHwDeckForRepaint,
} from '../devices';
import { handleDevices, alignHardwareRowWithLiveGeometry } from '../api/devices';
import { WebSocketManager } from '../ws';

let db: DatabaseService;
let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeManager(): WebSocketManager {
  const mgr = Object.create(WebSocketManager.prototype) as WebSocketManager;
  (mgr as any).clients = new Map();
  (mgr as any).db = new DatabaseService();
  (mgr as any).server = null;
  (mgr as any).broadcast = function (_type: string, _payload: any, _topic?: string) {};
  return mgr;
}

let profId = '';
let pageA = '';
let pageB = '';
let otherProfId = '';
let otherPage = '';

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
  const prof = db.createProfile({ id: uid('prof'), name: 'HW', data: {} });
  profId = prof.id;
  pageA = uid('page');
  pageB = uid('page');
  db.createPage({ id: pageA, profile_id: profId, name: 'A', order_idx: 0, is_folder: 0, data: {} });
  db.createPage({ id: pageB, profile_id: profId, name: 'B', order_idx: 1, is_folder: 0, data: {} });
  const other = db.createProfile({ id: uid('prof'), name: 'OTRO', data: {} });
  otherProfId = other.id;
  otherPage = uid('page');
  db.createPage({ id: otherPage, profile_id: otherProfId, name: 'O', order_idx: 0, is_folder: 0, data: {} });
  // Fila del HW físico (la que escucha el deck real).
  try {
    db.createDevice({ id: 'streamdeck-local', name: 'Stream Deck', kind: 'deck', model: null, cols: null, rows: null, hw_path: null } as any);
  } catch { /* ya existe */ }
  db.setCurrentProfile(profId);
});

describe('resolveAssignedPageForDevice (regla pageFor)', () => {
  const pages: Record<string, string> = {};
  const first = () => pageA;

  it('asignación válida del perfil → la asignada', () => {
    pages[pageB] = profId;
    expect(resolveAssignedPageForDevice({
      assignments: { 'streamdeck-local': pageB },
      pageProfileIdOf: (id) => pages[id] ?? null,
      profileId: profId,
      deviceId: 'streamdeck-local',
      firstPageId: first(),
    })).toBe(pageB);
  });

  it('asignación de otro perfil → fallback a la primera', () => {
    pages[otherPage] = otherProfId;
    expect(resolveAssignedPageForDevice({
      assignments: { 'streamdeck-local': otherPage },
      pageProfileIdOf: (id) => pages[id] ?? null,
      profileId: profId,
      deviceId: 'streamdeck-local',
      firstPageId: first(),
    })).toBe(pageA);
  });

  it('sin asignación → fallback a la primera; sin páginas → null', () => {
    expect(resolveAssignedPageForDevice({
      assignments: {},
      pageProfileIdOf: () => null,
      profileId: profId,
      deviceId: 'streamdeck-local',
      firstPageId: pageA,
    })).toBe(pageA);
    expect(resolveAssignedPageForDevice({
      assignments: {},
      pageProfileIdOf: () => null,
      profileId: profId,
      deviceId: 'streamdeck-local',
      firstPageId: null,
    })).toBeNull();
  });
});

describe('diagnoseHwPickMiss', () => {
  it('explica el bloqueo por hw_path enlazado en otro deck', () => {
    const devices = [
      { id: 'streamdeck-local', name: 'HW', kind: 'deck' as const, model: 'mk2', cols: 5, rows: 3, hw_path: null },
      { id: 'deck-extra', name: 'X', kind: 'deck' as const, model: 'mk2', cols: 5, rows: 3, hw_path: '/dev/other' },
    ];
    expect(pickHwDeckForRepaint({
      devices, changedDeckIds: ['streamdeck-local'], connectedPath: null, hwGrid: null,
    })).toBeNull();
    const reason = diagnoseHwPickMiss({
      devices, changedDeckIds: ['streamdeck-local'], connectedPath: null, hwGrid: null,
    });
    expect(reason).toMatch(/hw_path/);
  });

  it('explica el mismatch de geometría viva', () => {
    const devices = [
      { id: 'streamdeck-local', name: 'HW', kind: 'deck' as const, model: null, cols: null, rows: null, hw_path: null },
    ];
    // model:null → mk2 5×3 por defecto; HW real XL 8×4 → sin candidato.
    expect(pickHwDeckForRepaint({
      devices, changedDeckIds: ['streamdeck-local'], connectedPath: null, hwGrid: { cols: 8, rows: 4 },
    })).toBeNull();
    expect(diagnoseHwPickMiss({
      devices, changedDeckIds: ['streamdeck-local'], connectedPath: null, hwGrid: { cols: 8, rows: 4 },
    })).toMatch(/8×4/);
  });
});

describe('boot: applyProfileAssignment', () => {
  it('resuelve la asignación del perfil actual y fija la sesión', async () => {
    const { streamDeckDriver } = await import('../hw-driver/streamdeck-driver');
    const prev = streamDeckDriver.getSessionView();
    try {
      db.setCurrentProfile(profId);
      db.setAssignment(profId, 'streamdeck-local', pageB);
      // Sesión vieja (p. ej. de otro arranque): el boot debe corregirla.
      await streamDeckDriver.setSessionView({ profileId: profId, pageId: pageA });
      expect(streamDeckDriver.getSessionView().pageId).toBe(pageA);

      const applied = await streamDeckDriver.applyProfileAssignment();
      expect(applied).toBe(pageB);
      expect(streamDeckDriver.getSessionView()).toEqual({ profileId: profId, pageId: pageB });
      expect(db.getDeviceSession('streamdeck-local')?.page_id).toBe(pageB);
    } finally {
      try {
        if (prev.profileId && prev.pageId) {
          await streamDeckDriver.setSessionView({ profileId: prev.profileId, pageId: prev.pageId });
        } else {
          (streamDeckDriver as any).sessionProfileId = prev.profileId;
          (streamDeckDriver as any).sessionPageId = prev.pageId;
        }
      } catch { /* mejor esfuerzo */ }
    }
  });

  it('sin asignación → primera página del perfil (fallback pageFor)', async () => {
    const { streamDeckDriver } = await import('../hw-driver/streamdeck-driver');
    const prev = streamDeckDriver.getSessionView();
    try {
      db.setCurrentProfile(profId);
      db.clearAssignment(profId, 'streamdeck-local');
      const applied = await streamDeckDriver.applyProfileAssignment();
      expect(applied).toBe(pageA);
      expect(streamDeckDriver.getSessionView()).toEqual({ profileId: profId, pageId: pageA });
    } finally {
      try {
        if (prev.profileId && prev.pageId) {
          await streamDeckDriver.setSessionView({ profileId: prev.profileId, pageId: prev.pageId });
        } else {
          (streamDeckDriver as any).sessionProfileId = prev.profileId;
          (streamDeckDriver as any).sessionPageId = prev.pageId;
        }
      } catch { /* mejor esfuerzo */ }
    }
  });

  it('asignación inválida (página de otro perfil) → fallback', async () => {
    const { streamDeckDriver } = await import('../hw-driver/streamdeck-driver');
    expect(streamDeckDriver.resolveHwAssignedPageId(db, profId)).not.toBe(otherPage);
    db.setAssignment(profId, 'streamdeck-local', otherPage);
    try {
      expect(streamDeckDriver.resolveHwAssignedPageId(db, profId)).toBe(pageA);
    } finally {
      db.clearAssignment(profId, 'streamdeck-local');
    }
  });
});

describe('PUT assignments: fallback con warn cuando el pick falla', () => {
  it('repinta streamdeck-local aunque otro deck tenga hw_path enlazado', async () => {
    const { streamDeckDriver } = await import('../hw-driver/streamdeck-driver');
    const prev = streamDeckDriver.getSessionView();
    const mgr = makeManager();
    try {
      // Deck lógico extra con hw_path a otro path: bloquea el pick clásico.
      try {
        db.createDevice({ id: 'deck-extra', name: 'Extra', kind: 'deck', model: 'mk2', cols: 5, rows: 3, hw_path: '/dev/other' } as any);
      } catch {
        db.updateDevice('deck-extra', { hw_path: '/dev/other' } as any);
      }
      await streamDeckDriver.setSessionView({ profileId: profId, pageId: pageA });

      const req = new Request(`http://localhost:3001/api/v1/profiles/${profId}/assignments`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: { 'streamdeck-local': pageB } }),
      });
      const res = await handleDevices(req, {
        url: new URL(req.url), method: 'PUT', path: `/api/v1/profiles/${profId}/assignments`,
        db, services: { wsManager: mgr } as any,
      });
      expect(res!.status).toBe(200);
      expect(db.getAssignments(profId)['streamdeck-local']).toBe(pageB);
      // Sin el fallback, la sesión se quedaba clavada en A (pick null).
      expect(streamDeckDriver.getSessionView()).toEqual({ profileId: profId, pageId: pageB });
    } finally {
      try { db.deleteDevice('deck-extra'); } catch { /* noop */ }
      try { db.clearAssignment(profId, 'deck-extra'); } catch { /* noop */ }
      try {
        if (prev.profileId && prev.pageId) {
          await streamDeckDriver.setSessionView({ profileId: prev.profileId, pageId: prev.pageId });
        } else {
          (streamDeckDriver as any).sessionProfileId = prev.profileId;
          (streamDeckDriver as any).sessionPageId = prev.pageId;
        }
      } catch { /* mejor esfuerzo */ }
    }
  });

  it('alignHardwareRowWithLiveGeometry sin HW no toca la fila ni falla', () => {
    const before = db.getDevice('streamdeck-local');
    expect(() => alignHardwareRowWithLiveGeometry(db)).not.toThrow();
    const after = db.getDevice('streamdeck-local');
    expect(after).toEqual(before);
  });

  it('refreshHardwareToAssignment sin HW conectado es no-op', () => {
    const mgr = makeManager();
    expect(() => mgr.refreshHardwareToAssignment(profId)).not.toThrow();
  });
});
