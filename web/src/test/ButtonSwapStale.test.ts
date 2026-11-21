import { describe, it, expect } from 'vitest';

/**
 * W2 — ButtonSwapStale (vitest puro, sin montar componentes).
 *
 * Replica fiel del código real de web/src/composables/useStreamDeck.ts:
 * - handleSwap pone isSwapping=true, hace PUTs y NUNCA actualiza currentButtons;
 *   desbloquea a los 100ms (aquí modelado con expireSwap() síncrono).
 * - WS handler 'button.updated': si isSwapping ignora, si no reload vía loadButtons().
 * - Los PUT del propio swap disparan broadcast button.updated desde el daemon
 *   (routes.ts broadcastButtonUpdate) que llegan al mismo cliente MIENTRAS
 *   isSwapping=true → se ignoran → tras desbloquear ya no hay reload →
 *   currentButtons queda stale para siempre hasta reload manual o recarga.
 * - getButton(position) = currentButtons.find(b => b.position === position);
 *   executeButton y updateStreamDeckButtons usan getButton.
 */

// ---------------------------------------------------------------------------
// Harness local: imita al composable + al daemon (sin Vue, sin red).
// ---------------------------------------------------------------------------

interface FakeButton {
  id: string;
  page_id: string;
  position: number;
  data: { label: string; actions: Array<{ type: string }> };
}

type SlotMap = Record<string, string>; // 'slot-0' -> 'item-<buttonId>'

/** Estado "servidor" (BD del daemon): la verdad tras los PUTs. */
class FakeServer {
  positions = new Map<string, number>();

  seed(buttons: FakeButton[]) {
    this.positions = new Map(buttons.map((b) => [b.id, b.position]));
  }

  /** PUT /buttons/:id { position } + broadcast button.updated al cliente. */
  put(buttonId: string, newPosition: number, onBroadcast: () => void) {
    this.positions.set(buttonId, newPosition);
    // El daemon hace broadcastButtonUpdate tras cada PUT (routes.ts),
    // que llega al MISMO cliente que hizo el swap.
    onBroadcast();
  }

  positionOf(id: string): number | undefined {
    return this.positions.get(id);
  }
}

class FakeClient {
  currentButtons: FakeButton[];
  isSwapping = false;
  reloads = 0;
  /** Acciones "ejecutadas" por executeButton (para inspección). */
  executed: Array<{ position: string; actionType: string }> = [];
  /** PUTs enviados al servidor (para inspección). */
  puts: Array<{ buttonId: string; newPosition: number }> = [];

  constructor(
    private server: FakeServer,
    initial: FakeButton[],
    private onLoadButtons?: () => void,
  ) {
    // Copia local como la que tendría el composable tras loadButtons().
    this.currentButtons = initial.map((b) => ({
      ...b,
      data: { ...b.data, actions: [...b.data.actions] },
    }));
  }

  // --- Réplica de loadButtons(): recarga desde la "BD" ---
  loadButtons() {
    this.reloads++;
    for (const b of this.currentButtons) {
      const truth = this.server.positionOf(b.id);
      if (truth !== undefined) b.position = truth;
    }
    this.onLoadButtons?.();
  }

  // --- Réplica del WS handler real (useStreamDeck.ts) ---
  onWsButtonUpdated() {
    if (!this.isSwapping) {
      this.loadButtons();
    } else {
      // console.log('🚫 Ignoring WebSocket button update during swap')
    }
  }

  // --- Réplica de getButton real ---
  getButton(position: number): FakeButton | undefined {
    return this.currentButtons.find((b) => b.position === position);
  }

  // --- Réplica de executeButton real (recoge actions vía getButton) ---
  executeButton(position: number): Array<{ type: string }> {
    const button = this.getButton(position);
    if (!button?.data?.actions?.length) return [];
    const collected = button.data.actions.map((a) => ({ ...a }));
    for (const a of collected) {
      this.executed.push({ position: String(position), actionType: a.type });
    }
    return collected;
  }

  /**
   * Réplica fiel de handleSwap real: calcula updates desde currentButtons +
   * slotMap, hace PUTs (cada uno genera un broadcast que llega con
   * isSwapping=true → ignorado) y NO toca currentButtons.
   */
  async handleSwapBuggy(slotMap: SlotMap): Promise<void> {
    this.isSwapping = true;
    try {
      const updates: Array<{ button: FakeButton; newPosition: number }> = [];
      for (const button of this.currentButtons) {
        const newSlot = Object.keys(slotMap).find(
          (slot) => slotMap[slot] === `item-${button.id}`,
        );
        if (newSlot) {
          const newPosition = parseInt(newSlot.replace('slot-', ''), 10);
          if (button.position !== newPosition) {
            updates.push({ button, newPosition });
          }
        }
      }
      for (const { button, newPosition } of updates) {
        this.puts.push({ buttonId: button.id, newPosition });
        this.server.put(button.id, newPosition, () => this.onWsButtonUpdated());
        // BUG real: no se actualiza button.position aquí.
      }
    } finally {
      // El código real desbloquea con setTimeout(..., 100).
      // El test lo expira explícitamente con expireSwap().
    }
  }

  /** Modela el setTimeout(..., 100) del finally real. Sin reload pendiente. */
  expireSwap() {
    this.isSwapping = false;
    // El código real NO programa ningún reload al desbloquear:
    // el `loadButtons()` de 'button.updated' ya se perdió.
  }

  /**
   * Versión FIXED (especificación de la solución): tras PUTs OK aplica
   * newPosition al estado local, como debería hacer handleSwap.
   */
  async handleSwapFixed(slotMap: SlotMap): Promise<void> {
    this.isSwapping = true;
    try {
      const updates: Array<{ button: FakeButton; newPosition: number }> = [];
      for (const button of this.currentButtons) {
        const newSlot = Object.keys(slotMap).find(
          (slot) => slotMap[slot] === `item-${button.id}`,
        );
        if (newSlot) {
          const newPosition = parseInt(newSlot.replace('slot-', ''), 10);
          if (button.position !== newPosition) {
            updates.push({ button, newPosition });
          }
        }
      }
      for (const { button, newPosition } of updates) {
        this.puts.push({ buttonId: button.id, newPosition });
        this.server.put(button.id, newPosition, () => this.onWsButtonUpdated());
        button.position = newPosition; // <-- FIX: estado local al día
      }
    } finally {
      this.isSwapping = false;
    }
  }
}

function makeButtons(): FakeButton[] {
  return [
    {
      id: 'A',
      page_id: 'p1',
      position: 0,
      data: { label: 'Alpha', actions: [{ type: 'shell' }] },
    },
    {
      id: 'B',
      page_id: 'p1',
      position: 1,
      data: { label: 'Beta', actions: [{ type: 'http' }] },
    },
    {
      id: 'C',
      page_id: 'p1',
      position: 2,
      data: { label: 'Gamma', actions: [{ type: 'hotkey' }] },
    },
  ];
}

function setup() {
  const server = new FakeServer();
  const initial = makeButtons();
  server.seed(initial);
  const client = new FakeClient(server, initial);
  return { server, client };
}

// Swap A@0 <-> B@1 : el mapa visual post-swap de Swapy.
const SWAP_A_B: SlotMap = {
  'slot-0': 'item-B',
  'slot-1': 'item-A',
  'slot-2': 'item-C',
};

describe('W2 ButtonSwapStale', () => {
  it('1. durante isSwapping=true, un broadcast button.updated NO dispara reload', async () => {
    const { client } = setup();
    expect(client.isSwapping).toBe(false);

    await client.handleSwapBuggy(SWAP_A_B);

    // Los 2 PUTs generaron 2 broadcasts, ambos con isSwapping=true → ignorados.
    expect(client.isSwapping).toBe(true);
    expect(client.puts).toHaveLength(2);
    expect(client.reloads).toBe(0);
  });

  it('2. tras expirar isSwapping sin más broadcasts, NO hay reload pendiente (stale permanente)', async () => {
    const { server, client } = setup();
    await client.handleSwapBuggy(SWAP_A_B);
    expect(client.reloads).toBe(0);

    // Expira el bloqueo de 100ms del finally real. No llega ningún broadcast
    // tardío (los del propio swap ya se perdieron) y el código no reintenta.
    client.expireSwap();

    expect(client.isSwapping).toBe(false);
    expect(client.reloads).toBe(0); // documenta el bug: nada recarga
    // La BD sí cambió, pero el estado local no:
    expect(server.positionOf('A')).toBe(1);
    expect(server.positionOf('B')).toBe(0);
    expect(client.getButton(0)?.id).toBe('A'); // stale
    expect(client.getButton(1)?.id).toBe('B'); // stale
  });

  it('3. getButton tras swap con estado stale devuelve el botón VIEJO (equivocado)', async () => {
    const { client } = setup();
    await client.handleSwapBuggy(SWAP_A_B);
    client.expireSwap();

    // Verdad del servidor: B@0, A@1. Estado local stale: A@0, B@1.
    expect(client.getButton(0)?.id).toBe('A'); // equivocado, debería ser B
    expect(client.getButton(1)?.id).toBe('B'); // equivocado, debería ser A
    expect(client.getButton(2)?.id).toBe('C'); // no movido, sigue bien
  });

  it('4. executeButton(pos) con estado stale recoge las acciones del botón equivocado', async () => {
    const { client } = setup();
    await client.handleSwapBuggy(SWAP_A_B);
    client.expireSwap();

    // El usuario pulsa la casilla 0, donde visualmente (y en BD) está B/http,
    // pero getButton(0) devuelve A/shell por el estado stale.
    const collected = client.executeButton(0);
    expect(collected.map((a) => a.type)).toEqual(['shell']); // equivocado
    expect(collected.map((a) => a.type)).not.toContain('http'); // la correcta
    expect(client.executed).toEqual([{ position: '0', actionType: 'shell' }]);
  });

  it('5. FIX hipotético: aplicar newPosition al estado local tras PUTs OK deja getButton correcto', async () => {
    const { server, client } = setup();
    await client.handleSwapFixed(SWAP_A_B);

    expect(client.isSwapping).toBe(false);
    // Estado local coincide con la BD sin necesidad de reload.
    expect(server.positionOf('A')).toBe(1);
    expect(server.positionOf('B')).toBe(0);
    expect(client.getButton(0)?.id).toBe('B');
    expect(client.getButton(1)?.id).toBe('A');
    // Y executeButton ya recoge la acción correcta.
    expect(client.executeButton(0).map((a) => a.type)).toEqual(['http']);
    expect(client.executeButton(1).map((a) => a.type)).toEqual(['shell']);
  });

  it('6. doble swap rápido: el segundo cálculo parte de estado stale y genera posiciones incorrectas', async () => {
    const { server, client } = setup();

    // Swap1 (buggy): A<->B. BD: A@1 B@0. Local stale: A@0 B@1. Sin reload.
    await client.handleSwapBuggy(SWAP_A_B);
    client.expireSwap();
    expect(client.reloads).toBe(0);

    // El usuario vuelve a arrastrar 0<->1 para revertir lo que VE
    // (visualmente B@0 A@1 → quiere A@0 B@1). Swapy emite el mapa revertido:
    const REVERT_MAP: SlotMap = {
      'slot-0': 'item-A',
      'slot-1': 'item-B',
      'slot-2': 'item-C',
    };
    client.puts.length = 0;
    await client.handleSwapBuggy(REVERT_MAP);
    client.expireSwap();

    // Calculado desde el estado stale (A@0 B@1) el mapa "revertido" parece
    // no cambiar nada → 0 PUTs → la BD se queda con el swap1.
    expect(client.puts).toHaveLength(0);
    expect(server.positionOf('A')).toBe(1); // corrupción: el revert no llegó
    expect(server.positionOf('B')).toBe(0);
    // Local y servidor divergen de forma silenciosa: el usuario cree haber
    // revertido (Swapy mueve el DOM) pero la BD conserva A@1 B@0.
    expect(client.getButton(0)?.id).toBe('A');
    expect(server.positionOf('A')).not.toBe(0);
  });
});
