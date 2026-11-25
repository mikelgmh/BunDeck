/**
 * hw-repaint-diff.test.ts — repaint por diff: solo se escriben las teclas
 * que cambiaron (daemon/src/hw-driver/streamdeck-driver.ts).
 *
 * Contexto: cada write HID (fillKeyColor/fillKeyBuffer) tarda 60-500 ms en
 * este equipo; un repaint completo (15 teclas) bloquea el loop ~0.7-3.5 s.
 * Ya existían coalescing (ráfaga→1), skip-if-same por página, throttle de
 * hellos y backoff ante HID muerto (hw-repaint-coalescing.test.ts): NO se
 * tocan, se regresan de paso.
 *
 * Cubierto aquí (driver real, HW mockeado, sin HID):
 *  1. 1er pintado tras "conectar" pinta todo (15 writes).
 *  2. 2º repaint idéntico escribe 0 teclas (omite render + write por diff).
 *  3. Cambio en 1 tecla escribe SOLO esa (1 write en esa posición).
 *  4. Página distinta fuerza repintado completo.
 *  5. Reset (nueva conexión) vacía hashes: vuelve a pintar todo.
 *  6. Caché de imágenes: teclas vacías idénticas comparten 1 render
 *     (keyImageCacheHits > 0) y el diff no re-renderiza.
 *  7. Medición separada gen vs write: contadores en getRepaintStats().
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-hw-diff-test-'));
process.env.BUNDECK_DATA_DIR = TMP;
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';

let db: DatabaseService;
let profId = '';
let pageA = '';
let pageB = '';
let btnId = '';

/** Fake StreamDeck de 5×3 (15 teclas) con conteo de writes por posición. */
function makeFakeDeck() {
  const keyCount = 15;
  const controls = Array.from({ length: keyCount }, (_, i) => ({
    type: 'button',
    column: i % 5,
    row: Math.floor(i / 5),
    pixelSize: { width: 72, height: 72 },
  }));
  return {
    CONTROLS: controls,
    writes: 0,
    byKey: new Map<number, number>(),
    failWith: null as Error | null,
    async fillKeyBuffer(idx: number, _buf: Buffer, _opts?: unknown) {
      this.writes += 1;
      this.byKey.set(idx, (this.byKey.get(idx) ?? 0) + 1);
      if (this.failWith) throw this.failWith;
    },
    async fillKeyColor(idx: number, _r: number, _g: number, _b: number) {
      this.writes += 1;
      this.byKey.set(idx, (this.byKey.get(idx) ?? 0) + 1);
      if (this.failWith) throw this.failWith;
    },
    removeAllListeners() {},
    async close() {},
  };
}

let fake: ReturnType<typeof makeFakeDeck>;
let prevStreamDeck: unknown;
let prevSession: { profileId: string | null; pageId: string | null };

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
  const tag = Date.now();
  const prof = db.createProfile({ id: `prof-hwdiff-${tag}`, name: 'HWDIFF', data: {} });
  profId = prof.id;
  pageA = `page-hwdiff-a-${tag}`;
  pageB = `page-hwdiff-b-${tag}`;
  db.createPage({ id: pageA, profile_id: profId, name: 'DeckA', order_idx: 0, is_folder: 0, data: {} });
  db.createPage({ id: pageB, profile_id: profId, name: 'DeckB', order_idx: 1, is_folder: 0, data: {} });
  btnId = `btn-hwdiff-${tag}`;
  db.createButton({
    id: btnId,
    page_id: pageA,
    position: 0,
    data: { label: 'A', backgroundColor: '#111111', textColor: '#ffffff' },
  } as any);
  db.createButton({
    id: `btn-hwdiff-b-${tag}`,
    page_id: pageB,
    position: 7,
    data: { label: 'B', backgroundColor: '#222222', textColor: '#ffffff' },
  } as any);

  prevStreamDeck = (streamDeckDriver as any).streamDeck;
  prevSession = streamDeckDriver.getSessionView();
  fake = makeFakeDeck();
  (streamDeckDriver as any).streamDeck = fake;
  (streamDeckDriver as any).connectedDevice = 'test-deck-diff';
  streamDeckDriver.__resetHwPaintStateForTests();
});

afterAll(async () => {
  streamDeckDriver.__resetHwPaintStateForTests();
  (streamDeckDriver as any).streamDeck = prevStreamDeck ?? null;
  (streamDeckDriver as any).connectedDevice = prevStreamDeck ? 'test-deck-diff' : null;
  try {
    if (prevSession?.profileId && prevSession?.pageId) {
      (streamDeckDriver as any).sessionProfileId = prevSession.profileId;
      (streamDeckDriver as any).sessionPageId = prevSession.pageId;
    } else {
      (streamDeckDriver as any).sessionProfileId = null;
      (streamDeckDriver as any).sessionPageId = null;
    }
  } catch { /* noop */ }
  // Sin intervalos vivos: botones sin pc-vitals ni {{vars}} → no hay polling.
});

describe('HW repaint por diff (solo teclas cambiadas)', () => {
  it('1. primer pintado tras conectar pinta todo (15 writes)', async () => {
    streamDeckDriver.__resetHwPaintStateForTests();
    fake.writes = 0;
    fake.byKey.clear();
    fake.failWith = null;
    await streamDeckDriver.updateFromPage(pageA, { force: true });
    expect(fake.writes).toBe(15);
    expect(streamDeckDriver.getRepaintStats().lastPaintedPageId).toBe(pageA);
  });

  it('2. repaint idéntico escribe 0 teclas (diff omite render + write)', async () => {
    fake.writes = 0;
    fake.byKey.clear();
    const genBefore = streamDeckDriver.getRepaintStats().keyGenCount;
    await streamDeckDriver.updateFromPage(pageA, { force: true });
    expect(fake.writes).toBe(0);
    const stats = streamDeckDriver.getRepaintStats();
    expect(stats.skippedSameKey).toBeGreaterThanOrEqual(15);
    // Sin renders nuevos: todo omitido antes de generar.
    expect(stats.keyGenCount).toBe(genBefore);
  });

  it('3. cambio en 1 tecla escribe SOLO esa posición', async () => {
    const btn = db.getButtonsByPage(pageA).find((b) => b.position === 0)!;
    db.updateButton(btn.id, { ...btn.data, label: 'A2' });
    fake.writes = 0;
    fake.byKey.clear();
    await streamDeckDriver.updateFromPage(pageA, { force: true });
    expect(fake.writes).toBe(1);
    expect(fake.byKey.get(0)).toBe(1);
    // Restaurar para no contaminar los siguientes tests.
    const cur = db.getButtonsByPage(pageA).find((b) => b.position === 0)!;
    db.updateButton(cur.id, { ...cur.data, label: 'A' });
    fake.writes = 0;
    fake.byKey.clear();
    await streamDeckDriver.updateFromPage(pageA, { force: true });
    expect(fake.writes).toBe(1); // vuelve a cambiar → solo tecla 0
    expect(fake.byKey.get(0)).toBe(1);
  });

  it('4. página distinta fuerza repintado completo', async () => {
    fake.writes = 0;
    fake.byKey.clear();
    await streamDeckDriver.updateFromPage(pageB, { force: true });
    expect(fake.writes).toBe(15);
    expect(streamDeckDriver.getRepaintStats().lastPaintedPageId).toBe(pageB);
    // Y volver a la anterior también es completo (firmas de otra página).
    fake.writes = 0;
    await streamDeckDriver.updateFromPage(pageA, { force: true });
    expect(fake.writes).toBe(15);
  });

  it('5. reset (nueva conexión) vacía hashes: repinta todo aunque nada cambió', async () => {
    // Estado estable: nada pendiente de pintar.
    fake.writes = 0;
    await streamDeckDriver.updateFromPage(pageA, { force: true });
    expect(fake.writes).toBe(0);
    // Nueva conexión (connect()/disconnect() vacían paintedKeySigs; el hook
    // de tests hace lo mismo sin tocar la sesión).
    streamDeckDriver.__resetHwPaintStateForTests();
    fake.writes = 0;
    fake.byKey.clear();
    await streamDeckDriver.updateFromPage(pageA, { force: true });
    expect(fake.writes).toBe(15);
  });

  it('6. caché de imágenes: teclas vacías idénticas comparten 1 render', async () => {
    streamDeckDriver.__resetHwPaintStateForTests();
    fake.writes = 0;
    fake.failWith = null;
    await streamDeckDriver.updateFromPage(pageA, { force: true });
    const stats = streamDeckDriver.getRepaintStats();
    // 14 teclas vacías idénticas (misma página/env/size): 1 render + 13 hits.
    expect(stats.keyImageCacheHits).toBeGreaterThanOrEqual(13);
    expect(stats.keyImageCacheSize).toBeGreaterThan(0);
    // El diff posterior no genera nada nuevo (ni hits ni renders).
    const hitsBefore = stats.keyImageCacheHits;
    const genBefore = stats.keyGenCount;
    fake.writes = 0;
    await streamDeckDriver.updateFromPage(pageA, { force: true });
    expect(fake.writes).toBe(0);
    const after = streamDeckDriver.getRepaintStats();
    expect(after.keyImageCacheHits).toBe(hitsBefore);
    expect(after.keyGenCount).toBe(genBefore);
  });

  it('7. medición separada gen vs write disponible en stats', async () => {
    streamDeckDriver.__resetHwPaintStateForTests();
    fake.writes = 0;
    fake.failWith = null;
    await streamDeckDriver.updateFromPage(pageA, { force: true });
    const s = streamDeckDriver.getRepaintStats();
    // 15 writes medidos (1 por tecla) y renders medidos (>0 por caché fría).
    expect(s.keyWriteCount).toBe(15);
    expect(s.keyGenCount).toBeGreaterThan(0);
    expect(s.keyWriteMsTotal).toBeGreaterThanOrEqual(0);
    expect(s.keyGenMsTotal).toBeGreaterThanOrEqual(0);
    // Coherencia: writes mock == writes medidos.
    expect(fake.writes).toBe(s.keyWriteCount);
  });
});
