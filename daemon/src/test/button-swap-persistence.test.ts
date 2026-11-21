import { describe, it, expect } from 'bun:test';

// T1: button-swap persistence — puro, sin imports de db/action-runner/plugin-loader
// Replica: web handleSwap (useStreamDeck.ts) hace PUT /buttons/:id {data, position}
// por cada botón movido (Promise.allSettled) pero NUNCA actualiza currentButtons local,
// y durante el swap isSwapping=true ignora broadcasts WS button.updated.
// La BD persiste (ORDER BY position en getButtonsByPage, daemon/src/db.ts).

type Row = { id: string; position: number };

function makeDb(initial: Row[]) {
  let rows: Row[] = initial.map((r) => ({ ...r }));
  return {
    // Replica PUT /buttons/:id { position } -> UPDATE buttons SET position
    putPosition(id: string, newPos: number) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`button not found: ${id}`);
      row.position = newPos;
    },
    // Replica GET buttons ORDER BY position (getButtonsByPage)
    reload(): Row[] {
      return [...rows].sort((a, b) => a.position - b.position);
    },
    snapshot(): Row[] {
      return rows.map((r) => ({ ...r }));
    },
  };
}

// Replica el algoritmo de handleSwap: dado slotItemMap {slot-N: item-<id>}
// y estado local stale [{id, position}], calcula positionUpdates comparando
// la posición derivada del slot contra la posición del estado local.
function computePositionUpdates(
  slotItemMap: Record<string, string>,
  localState: Row[],
): Array<{ id: string; newPos: number }> {
  const posOf = new Map(localState.map((b) => [b.id, b.position]));
  const updates: Array<{ id: string; newPos: number }> = [];
  for (const [slot, itemId] of Object.entries(slotItemMap)) {
    const newPos = parseInt(slot.replace('slot-', ''), 10);
    const id = itemId.replace('item-', '');
    if (posOf.get(id) !== newPos) updates.push({ id, newPos });
  }
  return updates;
}

// Replica Promise.allSettled de PUTs + NO tocar estado local (el bug).
async function handleSwapLike(
  db: ReturnType<typeof makeDb>,
  updates: Array<{ id: string; newPos: number }>,
  failId?: string,
) {
  await Promise.allSettled(
    updates.map(async (u) => {
      if (failId !== undefined && u.id === failId) throw new Error(`PUT failed: ${u.id}`);
      db.putPosition(u.id, u.newPos);
    }),
  );
  // Intencionado: NO se toca el estado local (replica el bug web).
}

describe('button-swap persistence (T1)', () => {
  it('swap A(0)<->B(1) persiste en reload ordenado por position', async () => {
    const db = makeDb([
      { id: 'A', position: 0 },
      { id: 'B', position: 1 },
      { id: 'C', position: 2 },
    ]);
    const localStale: Row[] = [
      { id: 'A', position: 0 },
      { id: 'B', position: 1 },
      { id: 'C', position: 2 },
    ];
    // Tras drag: slot-0 <- B, slot-1 <- A
    const slotItemMap = { 'slot-0': 'item-B', 'slot-1': 'item-A', 'slot-2': 'item-C' };
    const updates = computePositionUpdates(slotItemMap, localStale);
    expect(updates).toHaveLength(2);
    await handleSwapLike(db, updates);
    const reloaded = db.reload();
    expect(reloaded.map((r) => r.id)).toEqual(['B', 'A', 'C']);
    expect(reloaded.find((r) => r.id === 'A')!.position).toBe(1);
    expect(reloaded.find((r) => r.id === 'B')!.position).toBe(0);
  });

  it('estado local stale sigue con posiciones viejas (bug web vs BD)', async () => {
    const db = makeDb([
      { id: 'A', position: 0 },
      { id: 'B', position: 1 },
    ]);
    const localStale: Row[] = [
      { id: 'A', position: 0 },
      { id: 'B', position: 1 },
    ];
    const slotItemMap = { 'slot-0': 'item-B', 'slot-1': 'item-A' };
    const updates = computePositionUpdates(slotItemMap, localStale);
    await handleSwapLike(db, updates);
    // BD actualizada...
    expect(db.reload().map((r) => r.id)).toEqual(['B', 'A']);
    // ...pero el estado local nunca se tocó: documenta el bug
    // (handleSwap no actualiza currentButtons + isSwapping ignora WS).
    expect(localStale.find((b) => b.id === 'A')!.position).toBe(0);
    expect(localStale.find((b) => b.id === 'B')!.position).toBe(1);
    // Un re-render desde localStale mostraría el orden viejo:
    const localOrder = [...localStale].sort((a, b) => a.position - b.position);
    expect(localOrder.map((b) => b.id)).toEqual(['A', 'B']);
  });

  it('fallo parcial de un PUT deja BD inconsistente (sin transacción)', async () => {
    const db = makeDb([
      { id: 'A', position: 0 },
      { id: 'B', position: 1 },
    ]);
    const localStale: Row[] = [
      { id: 'A', position: 0 },
      { id: 'B', position: 1 },
    ];
    const slotItemMap = { 'slot-0': 'item-B', 'slot-1': 'item-A' };
    const updates = computePositionUpdates(slotItemMap, localStale);
    expect(updates).toHaveLength(2);
    // Falla el PUT de A: solo B se mueve a 0 -> posiciones duplicadas (0,0)
    await handleSwapLike(db, updates, 'A');
    const snap = db.snapshot();
    const positions = snap.map((r) => r.position).sort();
    const inconsistent =
      new Set(positions).size !== positions.length || // duplicadas
      snap.find((r) => r.id === 'A')!.position === 0; // A sin mover
    expect(inconsistent).toBe(true);
  });

  it('swap encadenado 0->1->2->0 persiste si todos los PUTs tienen éxito', async () => {
    const db = makeDb([
      { id: 'A', position: 0 },
      { id: 'B', position: 1 },
      { id: 'C', position: 2 },
    ]);
    const localStale: Row[] = [
      { id: 'A', position: 0 },
      { id: 'B', position: 1 },
      { id: 'C', position: 2 },
    ];
    // Ciclo: A->slot1, B->slot2, C->slot0
    const slotItemMap = { 'slot-0': 'item-C', 'slot-1': 'item-A', 'slot-2': 'item-B' };
    const updates = computePositionUpdates(slotItemMap, localStale);
    expect(updates).toHaveLength(3);
    await handleSwapLike(db, updates);
    expect(db.reload().map((r) => r.id)).toEqual(['C', 'A', 'B']);
  });
});
