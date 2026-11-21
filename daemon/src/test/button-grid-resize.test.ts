import { describe, it, expect } from 'bun:test';

/**
 * T4 button-grid-resize (PURO: sin imports de '../db', '../action-runner', '../plugin-loader').
 *
 * Réplicas mínimas de la lógica REAL (no se importa código para mantener el
 * test hermético; cada réplica cita su fuente):
 *
 * - Web (web/src/composables/useStreamDeck.ts):
 *   - `gridCols` 3..8, `gridRows` 2..6 (`changeGridSize` clampa).
 *   - `updateStreamDeckButtons`: `totalButtons = gridCols*gridRows`, envía
 *     `buttonStates` de longitud gridCols*gridRows, slot i ↔ position i
 *     (índice lineal row-major, `getButton(i)` busca por `position === i`).
 * - Driver (daemon/src/hw-driver/streamdeck-driver.ts):
 *   - `maxButtons = 15` (5x3 físico), `initializeButtons` loop 15,
 *     `updateButtonsWithData` itera `Math.min(buttons.length, 15)`,
 *     `updateFromPage` loop 15 con `find(b => b.position === i)`.
 *   - `updateButtonStates(buttonStates)` IGNORA el array y delega a
 *     `updateFromPage(current.page_id)` (relee BD).
 */

type DbButton = { id: string; position: number; label?: string };

// ---- Constantes reales ----
const HW_MAX_BUTTONS = 15; // driver: 15 teclas físicas (5x3)
const GRID_COLS_MIN = 3;
const GRID_COLS_MAX = 8;
const GRID_ROWS_MIN = 2;
const GRID_ROWS_MAX = 6;

// ---- Réplicas puras ----

/** Web: nº de slots = gridCols * gridRows (updateStreamDeckButtons). */
function webSlotCount(gridCols: number, gridRows: number): number {
  return gridCols * gridRows;
}

/** Web: slot i ↔ position i (identidad row-major, getButton(position)). */
function webSlotToPosition(slot: number): number {
  return slot;
}

/** Driver: teclas físicas existentes = 0..14. */
function hwKeyIndexes(): number[] {
  return Array.from({ length: HW_MAX_BUTTONS }, (_, i) => i);
}

/** Réplica de changeGridSize (clamp 3-8 cols, 2-6 rows). */
function applyGridResize(
  grid: { cols: number; rows: number },
  deltaX: number,
  deltaY: number,
): { cols: number; rows: number } {
  let { cols, rows } = grid;
  if (deltaX !== 0) {
    const next = cols + deltaX;
    if (next >= GRID_COLS_MIN && next <= GRID_COLS_MAX) cols = next;
  }
  if (deltaY !== 0) {
    const next = rows + deltaY;
    if (next >= GRID_ROWS_MIN && next <= GRID_ROWS_MAX) rows = next;
  }
  return { cols, rows };
}

/** Web: posiciones visibles = slots 0..cols*rows-1 presentes en BD. */
function webVisiblePositions(dbButtons: DbButton[], cols: number, rows: number): number[] {
  const total = webSlotCount(cols, rows);
  return dbButtons
    .map((b) => b.position)
    .filter((p) => p >= 0 && p < total)
    .sort((a, b) => a - b);
}

/**
 * Driver updateFromPage: pinta posiciones 0..14 que existan en BD
 * (loop `for i < 15` + `find(b => b.position === i)`).
 */
function hwPaintedPositions(dbButtons: DbButton[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < HW_MAX_BUTTONS; i++) {
    if (dbButtons.some((b) => b.position === i)) out.push(i);
  }
  return out;
}

/**
 * Driver updateButtonsWithData: corta en 15 (`Math.min(len, 15)`).
 * `buttonsByPosition` es array indexado por posición (updateFromPage lo
 * construye así antes de llamar).
 */
function hwPaintedFromOrdered(buttonsByPosition: (DbButton | null)[]): number[] {
  const out: number[] = [];
  const n = Math.min(buttonsByPosition.length, HW_MAX_BUTTONS);
  for (let i = 0; i < n; i++) {
    if (buttonsByPosition[i]) out.push(i);
  }
  return out;
}

/**
 * Réplica del comportamiento de updateButtonStates: IGNORA `buttonStates`
 * y relee BD (delega a updateFromPage). Devuelve qué posiciones físicas
 * pintarían con contenido según BD.
 */
function updateButtonStatesSim(_buttonStates: boolean[], dbButtons: DbButton[]): number[] {
  void _buttonStates; // ignorado a propósito, como el driver real
  return hwPaintedPositions(dbButtons);
}

function makeDb(n: number, offset = 0): DbButton[] {
  return Array.from({ length: n }, (_, i) => ({ id: `btn-${offset + i}`, position: offset + i }));
}

// ---- Tests ----

describe('T4 grid 5x3=15: mapeo web ↔ tecla física es identidad', () => {
  it('15 slots web coinciden 1:1 con las 15 teclas físicas', () => {
    const cols = 5;
    const rows = 3;
    expect(webSlotCount(cols, rows)).toBe(15);
    expect(hwKeyIndexes()).toHaveLength(15);
    for (let i = 0; i < 15; i++) {
      expect(webSlotToPosition(i)).toBe(i); // identidad
      expect(hwKeyIndexes()).toContain(i);
    }
  });

  it('BD con posiciones 0..14: web y físico pintan exactamente lo mismo', () => {
    const db = makeDb(15);
    expect(webVisiblePositions(db, 5, 3)).toEqual(hwPaintedPositions(db));
    expect(webVisiblePositions(db, 5, 3)).toEqual(
      Array.from({ length: 15 }, (_, i) => i),
    );
  });
});

describe('T4 grid 3x2=6 con 10 botones en BD: divergencia web/físico', () => {
  const db = makeDb(10); // posiciones 0..9

  it('web solo muestra 0..5', () => {
    expect(webSlotCount(3, 2)).toBe(6);
    expect(webVisiblePositions(db, 3, 2)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('físico pinta 0..9 (posiciones 6..9 existen en BD y el driver las pinta)', () => {
    const painted = hwPaintedPositions(db);
    expect(painted).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('documenta divergencia: 6..9 invisibles en web pero visibles en hardware', () => {
    const web = new Set(webVisiblePositions(db, 3, 2));
    const hw = hwPaintedPositions(db);
    const onlyHw = hw.filter((p) => !web.has(p));
    expect(onlyHw).toEqual([6, 7, 8, 9]); // el usuario no los ve pero existen y se pintan
  });
});

describe('T4 grid 8x6=48: botones fantasma sin tecla física', () => {
  it('el máximo web (48) supera al hardware (15)', () => {
    expect(webSlotCount(8, 6)).toBe(48);
    expect(HW_MAX_BUTTONS).toBe(15);
  });

  it('posiciones 15..47 son visibles en web pero nunca llegan al hardware', () => {
    const db = makeDb(48); // posiciones 0..47
    const web = webVisiblePositions(db, 8, 6);
    expect(web).toHaveLength(48);
    // updateFromPage solo itera 0..14
    expect(hwPaintedPositions(db)).toEqual(Array.from({ length: 15 }, (_, i) => i));
    // updateButtonsWithData corta en 15 aunque reciba 48
    const ordered: (DbButton | null)[] = db.map((b) => b);
    expect(hwPaintedFromOrdered(ordered)).toHaveLength(15);
    const ghosts = web.filter((p) => p >= HW_MAX_BUTTONS);
    expect(ghosts).toEqual(Array.from({ length: 33 }, (_, i) => 15 + i));
  });
});

describe('T4 updateButtonStates ignora el array y relee BD', () => {
  it('buttonStates=[true×15] con BD vacía → físico pinta vacío (nada con contenido)', () => {
    const buttonStates = Array(15).fill(true); // lo que envía el frontend
    const dbEmpty: DbButton[] = []; // BD vacía
    expect(updateButtonStatesSim(buttonStates, dbEmpty)).toEqual([]);
  });

  it('el resultado no depende del array: all-true y all-false dan lo mismo', () => {
    const db = makeDb(3); // solo posiciones 0,1,2 en BD
    const withAllTrue = updateButtonStatesSim(Array(15).fill(true), db);
    const withAllFalse = updateButtonStatesSim(Array(15).fill(false), db);
    expect(withAllTrue).toEqual([0, 1, 2]);
    expect(withAllFalse).toEqual(withAllTrue);
  });
});

describe('T4 resize 5x3 → 3x2 → 5x3: ninguna fila de BD se pierde', () => {
  it('las posiciones 6..14 sobreviven al resize aunque queden temporalmente invisibles', () => {
    let grid = { cols: 5, rows: 3 };
    const db = makeDb(15); // BD: 0..14 (el resize solo cambia gridCols/gridRows del perfil, no borra botones)

    // Estado inicial 5x3: todo visible
    expect(webVisiblePositions(db, grid.cols, grid.rows)).toHaveLength(15);

    // Resize a 3x2 (changeGridSize con clamp)
    grid = applyGridResize(grid, -2, -1);
    expect(grid).toEqual({ cols: 3, rows: 2 });
    expect(webVisiblePositions(db, grid.cols, grid.rows)).toEqual([0, 1, 2, 3, 4, 5]);

    // La BD no pierde filas: siguen existiendo 15 (6..14 ocultas pero presentes)
    expect(db).toHaveLength(15);
    expect(db.map((b) => b.position).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 15 }, (_, i) => i),
    );

    // Resize de vuelta a 5x3
    grid = applyGridResize(grid, 2, 1);
    expect(grid).toEqual({ cols: 5, rows: 3 });
    expect(webVisiblePositions(db, grid.cols, grid.rows)).toEqual(
      Array.from({ length: 15 }, (_, i) => i),
    );
    expect(db).toHaveLength(15); // ninguna fila perdida
  });

  it('changeGridSize respeta límites 3-8 cols / 2-6 rows', () => {
    expect(applyGridResize({ cols: 3, rows: 2 }, -1, -1)).toEqual({ cols: 3, rows: 2 });
    expect(applyGridResize({ cols: 8, rows: 6 }, 1, 1)).toEqual({ cols: 8, rows: 6 });
  });
});
