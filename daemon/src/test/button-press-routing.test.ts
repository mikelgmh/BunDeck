import { describe, it, expect } from 'bun:test';

// T3 puro: routing press físico (driver lee BD) vs web (getButton lee estado local).
// Sin imports de '../db', '../action-runner' ni '../plugin-loader'.

type Action = { type: string; cmd: string };
type Button = { id: string; position: number; actions: Action[] };

function makeDb(): Button[] {
  return [
    { id: 'btn-a', position: 0, actions: [{ type: 'shell', cmd: 'A' }] },
    { id: 'btn-b', position: 1, actions: [{ type: 'shell', cmd: 'B' }] },
    { id: 'btn-c', position: 2, actions: [{ type: 'shell', cmd: 'C' }] },
  ];
}

// Replica daemon/src/hw-driver/streamdeck-driver.ts handleButtonPress:
// db.getButtonsByPage(page).find(b => b.position === keyIndex) → ejecuta SUS acciones.
function pressPhysical(keyIndex: number, dbState: Button[]): Action[] {
  const btn = dbState.find((b) => b.position === keyIndex);
  return btn?.actions ?? [];
}

// Replica web/src/composables/useStreamDeck.ts executeButton/getButton:
// currentButtons.find(b => b.position === position) sobre estado local (stale tras swap).
function pressWeb(position: number, localState: Button[]): Action[] {
  const btn = localState.find((b) => b.position === position);
  return btn?.actions ?? [];
}

describe('button press routing: fisico (BD) vs web (estado local)', () => {
  it('sin swap: ambas vias devuelven las mismas acciones', () => {
    const db = makeDb();
    const local = structuredClone(db);
    expect(pressPhysical(0, db)).toEqual([{ type: 'shell', cmd: 'A' }]);
    expect(pressWeb(0, local)).toEqual(pressPhysical(0, db));
  });

  it('tras swap 0<->1 (BD actualizada, local stale): divergen', () => {
    const db = makeDb();
    const local = structuredClone(db);
    // Swap solo en BD: A pasa a position 1, B a position 0.
    db.find((b) => b.id === 'btn-a')!.position = 1;
    db.find((b) => b.id === 'btn-b')!.position = 0;

    const physical = pressPhysical(0, db);
    const web = pressWeb(0, local);
    // Fisico ejecuta B (nuevo ocupante del slot 0), web ejecuta A (stale).
    expect(physical).toEqual([{ type: 'shell', cmd: 'B' }]);
    expect(web).toEqual([{ type: 'shell', cmd: 'A' }]);
    expect(web).not.toEqual(physical);
  });

  it('tras reload (local = reload de BD): ambas vuelven a coincidir', () => {
    const db = makeDb();
    db.find((b) => b.id === 'btn-a')!.position = 1;
    db.find((b) => b.id === 'btn-b')!.position = 0;
    const local = structuredClone(db); // reload
    expect(pressWeb(0, local)).toEqual(pressPhysical(0, db));
    expect(pressWeb(0, local)).toEqual([{ type: 'shell', cmd: 'B' }]);
  });

  it('slot vacio: ninguna via ejecuta nada y no lanza', () => {
    const db = makeDb();
    const local = structuredClone(db);
    expect(() => pressPhysical(9, db)).not.toThrow();
    expect(() => pressWeb(9, local)).not.toThrow();
    expect(pressPhysical(9, db)).toEqual([]);
    expect(pressWeb(9, local)).toEqual([]);
  });

  it('boton sin acciones: no ejecuta nada', () => {
    const db: Button[] = [{ id: 'empty', position: 0, actions: [] }];
    const local = structuredClone(db);
    expect(pressPhysical(0, db)).toEqual([]);
    expect(pressWeb(0, local)).toEqual([]);
  });
});
