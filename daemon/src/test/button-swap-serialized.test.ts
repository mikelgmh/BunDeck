/**
 * button-swap-serialized.test.ts — regresión del rebote al mover teclas.
 * Réplica pura (sin imports) del problema y del fix:
 *  - bug: dos POST /buttons/reorder del MISMO botón en vuelo podían aplicarse
 *    en la BD en orden inverso al inicio (red) y el intent stale pisaba al
 *    último → al recargar, la tecla "volvía" a su posición anterior.
 *  - fix: el frontend los encadena en FIFO (swapChain) + el broadcast lleva
 *    mutationId para ignorar el eco propio sin recargar.
 * Los botones llevan ACCIONES para probar que el reorder solo toca posiciones.
 */

import { describe, it, expect } from 'bun:test';

interface Action { id: string; type: string; parameters: Record<string, unknown> }
interface Row { id: string; pageId: string; position: number; label: string; actions: Action[] }

const shell = (command: string): Action => ({ id: `a-${command}`, type: 'shell.shell', parameters: { command } });
const http = (url: string): Action => ({ id: `a-${url}`, type: 'http.http', parameters: { url, method: 'GET' } });

function seed(): Row[] {
  return [
    { id: 'A', pageId: 'p1', position: 0, label: 'Shell', actions: [shell('notepad.exe')] },
    { id: 'B', pageId: 'p1', position: 1, label: 'HTTP', actions: [http('http://luz/salon')] },
  ];
}

// Réplica de DatabaseService.reorderButtons (transacción atómica por request)
function makeDb(initial: Row[]) {
  let rows: Row[] = initial.map((r) => ({ ...r, actions: r.actions.map((a) => ({ ...a })) }));
  return {
    reorder(pageId: string, order: Array<{ id: string; position: number }>) {
      const seen = new Set<number>();
      for (const o of order) {
        if (seen.has(o.position)) throw new Error(`duplicada: ${o.position}`);
        seen.add(o.position);
      }
      for (const o of order) {
        const row = rows.find((r) => r.id === o.id);
        if (!row) throw new Error(`no encontrado: ${o.id}`);
        if (row.pageId !== pageId) throw new Error(`no pertenece: ${o.id}`);
      }
      ordersLog.push(order.map((o) => ({ ...o })));
      for (const o of order) rows.find((r) => r.id === o.id)!.position = -1;
      for (const o of order) rows.find((r) => r.id === o.id)!.position = o.position;
    },
    pos: (id: string) => rows.find((r) => r.id === id)!.position,
    data: (id: string) => rows.find((r) => r.id === id)!,
  };
}
let ordersLog: Array<Array<{ id: string; position: number }>> = [];

// Grid visible para ver que se mueven (slot -> "label[nAcciones]")
function renderGrid(rows: Row[], slots: number): string[] {
  return Array.from({ length: slots }, (_, i) => {
    const b = rows.find((r) => r.position === i);
    return b ? `${b.label}[${b.actions.length}]` : '·';
  });
}

// Eco WS con mutationId (réplica del broadcast del daemon)
function makeEchoServer() {
  const broadcasts: Array<{ pageId: string; mutationId?: string }> = [];
  return {
    broadcasts,
    emitReordered(pageId: string, mutationId?: string) {
      broadcasts.push({ pageId, mutationId });
    },
    // El cliente ignora su propio eco; el ajeno recarga
    shouldReload(pending: Set<string>, payload: { mutationId?: string }): boolean {
      if (payload.mutationId && pending.has(payload.mutationId)) {
        pending.delete(payload.mutationId);
        return false;
      }
      return true;
    },
  };
}

describe('button swap serializado (fix rebote)', () => {
  it('1. en vuelo sin orden: el intent stale pisa al último (rebote documentado)', async () => {
    ordersLog = [];
    const db = makeDb(seed());
    // Dos reorders concurrentes del MISMO botón con acciones (A: 0→5, A: 5→2).
    // La red invierte la llegada: se aplica primero el último y luego el stale.
    const r2 = [{ id: 'A', position: 2 }]; // último intent del usuario
    const r1 = [{ id: 'A', position: 5 }]; // primero (stale)
    db.reorder('p1', r2);
    db.reorder('p1', r1);
    expect(db.pos('A')).toBe(5); // ¡gana el stale!
    expect(renderGrid([{ ...db.data('A') }, { ...db.data('B') }], 6)[2]).toBe('·');
    // Las acciones no se tocan (el reorder solo mueve posiciones)…
    expect(db.data('A').actions).toEqual([shell('notepad.exe')]);
    // …pero la posición final NO es la que dejó el usuario: al recargar rebota.
  });

  it('2. cadena FIFO: el último movimiento gana y las acciones siguen intactas', async () => {
    ordersLog = [];
    const db = makeDb(seed());
    let chain: Promise<void> = Promise.resolve();
    const queue = (order: Array<{ id: string; position: number }>) => {
      chain = chain.then(async () => {
        db.reorder('p1', order);
      });
      return chain;
    };
    await queue([{ id: 'A', position: 5 }]);
    await queue([{ id: 'A', position: 2 }]);
    expect(ordersLog).toEqual([[{ id: 'A', position: 5 }], [{ id: 'A', position: 2 }]]);
    expect(db.pos('A')).toBe(2);
    expect(db.data('A').label).toBe('Shell');
    expect(db.data('A').actions).toEqual([shell('notepad.exe')]);
    expect(db.data('B').actions).toEqual([http('http://luz/salon')]);
    expect(renderGrid([{ ...db.data('A') }, { ...db.data('B') }], 6)).toEqual(
      ['·', 'HTTP[1]', 'Shell[1]', '·', '·', '·'],
    );
  });

  it('3. el broadcast lleva mutationId: eco propio se ignora, ajeno recarga', () => {
    const srv = makeEchoServer();
    const pending = new Set<string>(['mid-mio']);
    srv.emitReordered('p1', 'mid-mio');
    expect(srv.shouldReload(pending, srv.broadcasts[0])).toBe(false);
    expect(pending.size).toBe(0);
    srv.emitReordered('p1', 'mid-otro-cliente');
    expect(srv.shouldReload(pending, srv.broadcasts[1])).toBe(true);
    // Sin mutationId (clientes viejos/CLI): también recarga, sin romper nada
    srv.emitReordered('p1', undefined);
    expect(srv.shouldReload(pending, srv.broadcasts[2])).toBe(true);
  });
});
