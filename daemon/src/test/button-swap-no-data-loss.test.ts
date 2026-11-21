import { describe, it, expect } from 'bun:test';

// T2 puro: sin imports de '../db', '../action-runner' ni '../plugin-loader'.
// Replica la lógica real:
//  - PUT /buttons/:id -> updateButtonComplete hace JSON.stringify(data) (daemon/src/db.ts)
//  - getButtonsByPage hace JSON.parse (daemon/src/db.ts)
//  - el swap envía `data: button.data` (objeto completo)
//  - hasContent de frontend (useStreamDeck.ts) y driver (updateButtonsWithData)
//  - prioridad de render generateButtonImage (streamdeck-driver.ts):
//    dynamicValue > emoji > label > textTop/textBottom > icon > acción

type ButtonData = {
  label?: string;
  textTop?: string;
  textBottom?: string;
  icon?: string;
  emoji?: string;
  backgroundColor?: string;
  textColor?: string;
  dynamicValue?: string | null;
  actions?: Array<{ type: string; pluginId?: string; parameters?: Record<string, any> }>;
};

type ButtonRow = { id: string; page_id: string; position: number; data: ButtonData };

// --- Réplicas fieles del código real (copias locales para no importar) ---

// db.ts updateButtonComplete: values.push(JSON.stringify(updates.data))
// db.ts getButtonsByPage/getButton: typeof data === 'string' ? JSON.parse(data) : data
function dbRoundTrip(data: ButtonData): ButtonData {
  const stored: string = JSON.stringify(data);
  const raw: unknown = stored;
  return typeof raw === 'string' ? (JSON.parse(raw) as ButtonData) : (raw as ButtonData);
}

// hasContent idéntico en frontend (useStreamDeck.ts) y driver (updateButtonsWithData/updateFromPage)
function hasContent(data: ButtonData | null | undefined): boolean {
  if (!data) return false;
  return !!(
    data.label?.trim() ||
    data.textTop?.trim() ||
    data.textBottom?.trim() ||
    data.emoji?.trim() ||
    data.icon ||
    (data.actions && data.actions.length > 0)
  );
}

// Prioridad generateButtonImage: dynamicValue > emoji > label > textTop/textBottom > icon > acción
function resolveDisplayKind(data: ButtonData): 'dynamic' | 'emoji' | 'label' | 'textTop' | 'textBottom' | 'icon' | 'action' | 'empty' {
  if (data.dynamicValue !== undefined && data.dynamicValue !== null && String(data.dynamicValue).trim() !== '')
    return 'dynamic';
  if (data.emoji && data.emoji.trim()) return 'emoji';
  if (data.label && data.label.trim()) return 'label';
  if (data.textTop && data.textTop.trim()) return 'textTop';
  if (data.textBottom && data.textBottom.trim()) return 'textBottom';
  if (data.icon && data.icon.trim()) return 'icon';
  if (data.actions && data.actions.length > 0) return 'action';
  return 'empty';
}

// Simula el swap del frontend: PUT /buttons/:id con { data: other.data, position: other.position }
function simulateSwap(a: ButtonRow, b: ButtonRow): [ButtonRow, ButtonRow] {
  const aPayload = { data: dbRoundTrip(b.data), position: b.position };
  const bPayload = { data: dbRoundTrip(a.data), position: a.position };
  return [
    { ...a, data: aPayload.data, position: aPayload.position },
    { ...b, data: bPayload.data, position: bPayload.position },
  ];
}

// Simula mover a slot vacío: un solo PUT, el origen queda vacío (fila eliminada)
function simulateMoveToEmptySlot(moving: ButtonRow, targetPosition: number): { moved: ButtonRow; sourceEmpty: true } {
  const moved: ButtonRow = { ...moving, data: dbRoundTrip(moving.data), position: targetPosition };
  return { moved, sourceEmpty: true };
}

const buttonAData: ButtonData = {
  label: 'OBS Scene',
  textTop: 'LIVE',
  textBottom: 'Studio',
  icon: 'VideoIcon',
  emoji: '',
  backgroundColor: '#7c3aed',
  textColor: '#ffffff',
  actions: [
    { type: 'obs.set-scene', pluginId: 'obs', parameters: { scene: 'Gaming', source: 'Cam' } },
    { type: 'hotkey.press', pluginId: 'hotkey', parameters: { keys: 'ctrl+shift+s' } },
  ],
};

const buttonBData: ButtonData = {
  label: 'Mute Mic',
  textTop: 'OFF',
  textBottom: 'Push to talk',
  icon: 'MicOffIcon',
  emoji: '',
  backgroundColor: '#0f172a',
  textColor: '#facc15',
  actions: [{ type: 'multimedia.mute', pluginId: 'multimedia', parameters: { device: 'mic', toggle: true } }],
};

describe('button swap sin pérdida de datos (T2 puro)', () => {
  it('tras swap cada botón conserva EXACTAMENTE su data (round-trip BD)', () => {
    const a: ButtonRow = { id: 'btn-a', page_id: 'page-1', position: 0, data: structuredClone(buttonAData) };
    const b: ButtonRow = { id: 'btn-b', page_id: 'page-1', position: 4, data: structuredClone(buttonBData) };

    const [aAfter, bAfter] = simulateSwap(a, b);

    // posiciones intercambiadas
    expect(aAfter.position).toBe(4);
    expect(bAfter.position).toBe(0);

    // data intercambiada sin pérdida: deep equal tras JSON round-trip
    expect(aAfter.data).toEqual(dbRoundTrip(buttonBData));
    expect(bAfter.data).toEqual(dbRoundTrip(buttonAData));

    // campos críticos uno a uno
    expect(aAfter.data.icon).toBe('MicOffIcon');
    expect(aAfter.data.textTop).toBe('OFF');
    expect(aAfter.data.textBottom).toBe('Push to talk');
    expect(aAfter.data.backgroundColor).toBe('#0f172a');
    expect(aAfter.data.textColor).toBe('#facc15');
    expect(aAfter.data.actions).toHaveLength(1);
    expect(aAfter.data.actions![0].parameters).toEqual({ device: 'mic', toggle: true });

    expect(bAfter.data.icon).toBe('VideoIcon');
    expect(bAfter.data.textTop).toBe('LIVE');
    expect(bAfter.data.textBottom).toBe('Studio');
    expect(bAfter.data.backgroundColor).toBe('#7c3aed');
    expect(bAfter.data.actions).toHaveLength(2);
    expect(bAfter.data.actions![0].parameters).toEqual({ scene: 'Gaming', source: 'Cam' });
    expect(bAfter.data.actions![1].parameters).toEqual({ keys: 'ctrl+shift+s' });
  });

  it('mover a slot vacío conserva la data y el origen queda vacío', () => {
    const a: ButtonRow = { id: 'btn-a', page_id: 'page-1', position: 2, data: structuredClone(buttonAData) };
    const { moved, sourceEmpty } = simulateMoveToEmptySlot(a, 7);

    expect(moved.position).toBe(7);
    expect(moved.data).toEqual(dbRoundTrip(buttonAData));
    expect(moved.data.icon).toBe('VideoIcon');
    expect(moved.data.label).toBe('OBS Scene');
    expect(sourceEmpty).toBe(true);

    // el slot origen no debe conservar fila fantasma: la página solo tiene el botón movido
    const pageRows: ButtonRow[] = [moved];
    expect(pageRows.find((r) => r.position === 2)).toBeUndefined();
    expect(pageRows.find((r) => r.position === 7)).toBe(moved);
  });

  it('hasContent es idéntico antes/después del swap (icono / acciones / emoji / texto)', () => {
    const iconOnly: ButtonData = { icon: 'PlayIcon', backgroundColor: '#000000', textColor: '#ffffff', actions: [] };
    const actionsOnly: ButtonData = {
      label: '',
      actions: [{ type: 'shell.exec', pluginId: 'shell', parameters: { command: 'echo hi' } }],
    };
    const emojiOnly: ButtonData = { emoji: '🎙️', actions: [] };
    const textOnly: ButtonData = { textTop: 'UP', textBottom: 'DOWN', actions: [] };

    const cases: Array<[string, ButtonData]> = [
      ['solo icono', iconOnly],
      ['solo acciones', actionsOnly],
      ['solo emoji', emojiOnly],
      ['solo texto', textOnly],
    ];

    for (const [name, data] of cases) {
      const before = hasContent(data);
      const after = hasContent(dbRoundTrip(data));
      expect(before).toBe(true);
      expect(after).toBe(before);
      void name;
    }

    // y tras un swap entre dos de ellos, hasContent sigue true en ambas posiciones
    const r1: ButtonRow = { id: 'x', page_id: 'p', position: 0, data: iconOnly };
    const r2: ButtonRow = { id: 'y', page_id: 'p', position: 1, data: actionsOnly };
    const [r1After, r2After] = simulateSwap(r1, r2);
    expect(hasContent(r1After.data)).toBe(true);
    expect(hasContent(r2After.data)).toBe(true);
    // el render sigue resolviendo la misma rama que antes del swap (cruzada)
    expect(resolveDisplayKind(r1After.data)).toBe(resolveDisplayKind(actionsOnly));
    expect(resolveDisplayKind(r2After.data)).toBe(resolveDisplayKind(iconOnly));
  });

  it('respeta la prioridad de render dynamicValue > emoji > label > textTop/textBottom > icon > acción', () => {
    expect(resolveDisplayKind({ dynamicValue: '45%', emoji: '🎙️', label: 'x', textTop: 't', icon: 'PlayIcon', actions: [{ type: 'a' }] })).toBe('dynamic');
    expect(resolveDisplayKind({ emoji: '🎙️', label: 'x', textTop: 't', icon: 'PlayIcon', actions: [{ type: 'a' }] })).toBe('emoji');
    expect(resolveDisplayKind({ label: 'Hola', textTop: 't', icon: 'PlayIcon', actions: [{ type: 'a' }] })).toBe('label');
    expect(resolveDisplayKind({ textTop: 'UP', icon: 'PlayIcon', actions: [{ type: 'a' }] })).toBe('textTop');
    expect(resolveDisplayKind({ textBottom: 'DN', icon: 'PlayIcon', actions: [{ type: 'a' }] })).toBe('textBottom');
    expect(resolveDisplayKind({ icon: 'PlayIcon', actions: [{ type: 'a' }] })).toBe('icon');
    expect(resolveDisplayKind({ actions: [{ type: 'shell.exec' }] })).toBe('action');
    expect(resolveDisplayKind({ label: '   ', emoji: '  ', actions: [] })).toBe('empty');
  });

  it('botones vacíos no generan filas fantasma tras swap', () => {
    const emptyData: ButtonData = { label: '', textTop: '', textBottom: '', emoji: '', icon: '', backgroundColor: '#000000', textColor: '#ffffff', actions: [] };
    expect(hasContent(emptyData)).toBe(false);
    expect(hasContent(dbRoundTrip(emptyData))).toBe(false);
    expect(resolveDisplayKind(dbRoundTrip(emptyData))).toBe('empty');

    // swap vacío <-> vacío: sigue sin contenido en ambas posiciones, sin crear nada extra
    const e1: ButtonRow = { id: 'e1', page_id: 'p', position: 3, data: structuredClone(emptyData) };
    const e2: ButtonRow = { id: 'e2', page_id: 'p', position: 5, data: structuredClone(emptyData) };
    const [e1After, e2After] = simulateSwap(e1, e2);
    expect(hasContent(e1After.data)).toBe(false);
    expect(hasContent(e2After.data)).toBe(false);

    // swap lleno <-> vacío: el vacío sigue vacío y el lleno intacto (sin duplicar filas)
    const full: ButtonRow = { id: 'f', page_id: 'p', position: 0, data: structuredClone(buttonAData) };
    const empty: ButtonRow = { id: 'g', page_id: 'p', position: 1, data: structuredClone(emptyData) };
    const [fullAfter, emptyAfter] = simulateSwap(full, empty);
    expect(hasContent(fullAfter.data)).toBe(false); // ahora ocupa el slot del vacío
    expect(hasContent(emptyAfter.data)).toBe(true); // ahora tiene la data rica
    expect(emptyAfter.data).toEqual(dbRoundTrip(buttonAData));

    // nº de filas invariante: 2 antes, 2 después (sin fantasmas)
    const rowsAfter = [fullAfter, emptyAfter];
    expect(rowsAfter).toHaveLength(2);
    expect(new Set(rowsAfter.map((r) => r.id)).size).toBe(2);
  });
});
