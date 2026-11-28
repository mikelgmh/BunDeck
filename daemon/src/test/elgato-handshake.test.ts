/**
 * elgato-handshake.test.ts — handshake HW contra @elgato-stream-deck/node 7.x
 * (+ node-lib 7.x con jpeg-turbo 3.x como backend de encodeJPEG).
 *
 * Contexto: subida 7.6.3 → 7.9.0 (oleada 2). Sin HID físico en CI, el
 * handshake se prueba con el módulo Elgato mockeado y un deck falso:
 *  1. listDevices() ve el deck anunciado por listStreamDecks.
 *  2. connect(path) abre el deck (openStreamDeck), registra handlers
 *     down/up/error, inicializa las teclas y devuelve true.
 *  3. Sin decks anunciados, connect() devuelve false sin tumbar nada
 *     (ruta "sin hardware" del driver).
 *  4. node-lib encodeJPEG usa jpeg-turbo 3.x: el JPEG resultante es válido
 *     (magia FFD8) y el roundtrip contra renders reales del driver
 *     (generateButtonImage, canvas+lucide) conserva dimensiones y color
 *     medio (tolerancia lossy).
 *
 * Nota de suite: mock.module es global al proceso; ningún otro fichero de
 * test importa '@elgato-stream-deck/node' en runtime (el driver lo carga de
 * forma perezosa y solo estos tests ejercitan esa ruta), así que el mock
 * no contamina al resto.
 */
import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-elgato-hs-test-'));
process.env.BUNDECK_DATA_DIR = TMP;
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

/** Deck falso de 6 teclas con registro de handlers y writes. */
function makeFakeDeck() {
  return {
    CONTROLS: Array.from({ length: 6 }, (_, i) => ({
      type: 'button',
      column: i % 3,
      row: Math.floor(i / 3),
      pixelSize: { width: 72, height: 72 },
    })),
    handlers: new Map<string, (...args: any[]) => void>(),
    openedWith: null as string | null,
    colorFills: 0,
    closed: false,
    on(ev: string, cb: (...args: any[]) => void) {
      this.handlers.set(ev, cb);
    },
    removeAllListeners() {
      this.handlers.clear();
    },
    async fillKeyColor(_idx: number, _r: number, _g: number, _b: number) {
      this.colorFills += 1;
    },
    async setBrightness(_n: number) {},
    async fillKeyBuffer(_idx: number, _buf: Buffer, _opts?: unknown) {},
    async close() {
      this.closed = true;
    },
  };
}

const fake = makeFakeDeck();
let announced: Array<{ path: string }> = [{ path: 'fake-deck-0' }];

mock.module('@elgato-stream-deck/node', () => ({
  listStreamDecks: async () => [...announced],
  openStreamDeck: async (devicePath: string) => {
    fake.openedWith = devicePath;
    return fake;
  },
}));

import { initDatabase } from '../db';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';

let prevStreamDeck: unknown;
let prevDevice: unknown;
let prevView: { profileId: string | null; pageId: string | null };

beforeAll(async () => {
  await initDatabase();
  prevStreamDeck = (streamDeckDriver as any).streamDeck;
  prevDevice = (streamDeckDriver as any).connectedDevice;
  prevView = streamDeckDriver.getSessionView();
  streamDeckDriver.__resetHwPaintStateForTests();
});

afterAll(async () => {
  try {
    await streamDeckDriver.disconnect();
  } catch { /* mejor esfuerzo */ }
  streamDeckDriver.__resetHwPaintStateForTests();
  (streamDeckDriver as any).streamDeck = prevStreamDeck ?? null;
  (streamDeckDriver as any).connectedDevice = prevDevice ?? null;
  try {
    await streamDeckDriver.setSessionView(prevView);
  } catch { /* mejor esfuerzo */ }
});

describe('handshake Elgato (mock HID)', () => {
  it('listDevices() anuncia el deck de listStreamDecks', async () => {
    announced = [{ path: 'fake-deck-0' }];
    const devs = await streamDeckDriver.listDevices();
    expect(devs.length).toBe(1);
    expect(devs[0].path).toBe('fake-deck-0');
  });

  it('connect() abre el deck, registra handlers e inicializa teclas', async () => {
    announced = [{ path: 'fake-deck-0' }];
    const ok = await streamDeckDriver.connect();
    expect(ok).toBe(true);
    expect(fake.openedWith).toBe('fake-deck-0');
    // Handlers down/up/error registrados (handshake de eventos 7.x).
    expect(fake.handlers.has('down')).toBe(true);
    expect(fake.handlers.has('up')).toBe(true);
    expect(fake.handlers.has('error')).toBe(true);
    // initializeButtons: 1 fillKeyColor por tecla (6).
    expect(fake.colorFills).toBe(6);
    expect(streamDeckDriver.getKeyCount()).toBe(6);
    expect(streamDeckDriver.getGridGeometry()).toEqual({ cols: 3, rows: 2 });
  });

  it('sin decks anunciados connect() devuelve false sin lanzar', async () => {
    announced = [];
    await streamDeckDriver.disconnect();
    const ok = await streamDeckDriver.connect();
    expect(ok).toBe(false);
  });
});

describe('jpeg-turbo 3.x (vía node-lib encodeJPEG)', () => {
  // generateButtonImage devuelve RGB top-down; encodeJPEG con jpeg-turbo
  // exige RGBA (si no, cae a jpeg-js). Conversión explícita.
  function rgbToRgba(rgb: Buffer): Buffer {
    const n = rgb.length / 3;
    const out = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      out[i * 4] = rgb[i * 3];
      out[i * 4 + 1] = rgb[i * 3 + 1];
      out[i * 4 + 2] = rgb[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  // El binario turbo no carga dentro de `bun test` (pkg-prebuilds choca con
  // el global `jest` del runner: `jest.requireActual is not a function`).
  // Fuera del runner carga bien (daemon real), así que el roundtrip con el
  // codec nativo 3.1.0 se ejecuta en un proceso `bun` hijo limpio: el padre
  // renderiza (canvas+lucide) y el hijo codifica+decodifica con turbo.
  async function jpegRoundtripInChild(
    raw: Buffer,
  ): Promise<{ magic: number[]; len: number; w: number; h: number; mae: number; turbo: boolean }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-jpeg-rt-'));
    const rawPath = path.join(dir, 'raw.rgb');
    const outPath = path.join(dir, 'out.json');
    fs.writeFileSync(rawPath, raw);
    const script = `
      import fs from 'node:fs';
      // OJO: con \`bun -e\` los args empiezan en argv[1] (no hay fichero en argv[1]).
      const [rawPath, outPath] = process.argv.slice(1);
      const raw = fs.readFileSync(rawPath);
      const rgba = Buffer.alloc(72 * 72 * 4);
      for (let i = 0; i < 72 * 72; i++) {
        rgba[i * 4] = raw[i * 3];
        rgba[i * 4 + 1] = raw[i * 3 + 1];
        rgba[i * 4 + 2] = raw[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
      const { encodeJPEG } = await import('@elgato-stream-deck/node-lib');
      const turbo = await import('@julusian/jpeg-turbo');
      const usedTurbo = typeof turbo.compress === 'function';
      const jpg = Buffer.from(await encodeJPEG(rgba, 72, 72, undefined));
      const dec = turbo.decompressSync(jpg, { format: turbo.FORMAT_RGBA });
      const dd = Buffer.from(dec.data);
      let acc = 0;
      for (let i = 0; i < dd.length; i += 4) {
        acc += Math.abs(dd[i] - rgba[i]) + Math.abs(dd[i + 1] - rgba[i + 1]) + Math.abs(dd[i + 2] - rgba[i + 2]);
      }
      fs.writeFileSync(outPath, JSON.stringify({
        magic: [jpg[0], jpg[1]], len: jpg.length,
        w: dec.width, h: dec.height,
        mae: acc / (dd.length / 4 / 3), turbo: usedTurbo,
      }));
    `;
    const bunBin = Bun.which('bun') ?? 'bun';
    // cwd = dir del daemon (resuelve node_modules con node-lib + turbo).
    const proc = Bun.spawnSync([bunBin, '-e', script, rawPath, outPath], {
      cwd: process.cwd(),
      timeout: 60000,
    });
    if (proc.exitCode !== 0) {
      throw new Error('hijo JPEG falló: STDERR=' + proc.stderr.toString().slice(0, 1500) + ' STDOUT=' + proc.stdout.toString().slice(0, 1500));
    }
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  }

  it('encodeJPEG produce un JPEG válido con el backend turbo', async () => {
    const { encodeJPEG } = await import('@elgato-stream-deck/node-lib');
    expect(typeof encodeJPEG).toBe('function');
    const rgba = rgbToRgba(Buffer.alloc(72 * 72 * 3, 0).map((_, i) =>
      i % 3 === 0 ? 124 : i % 3 === 1 ? 58 : 237,
    ));
    const jpg = Buffer.from(await encodeJPEG(rgba, 72, 72, undefined));
    expect(jpg[0]).toBe(0xff);
    expect(jpg[1]).toBe(0xd8);
    expect(jpg.length).toBeGreaterThan(100);
    expect(jpg.length).toBeLessThan(72 * 72 * 4);
  });

  it('roundtrip de renders reales del driver: dimensiones + color (tolerancia lossy)', async () => {
    const d = streamDeckDriver;
    const refs = [
      { label: 'Micro', icon: 'Mic', backgroundColor: '#101010', textColor: '#facc15' },
      { textTop: 'ARRIBA', icon: '', backgroundColor: '#000000', textColor: '#ffffff', showTitle: true },
      { icon: 'si:youtube', backgroundColor: '#101010', textColor: '#ffffff', showTitle: false },
    ];
    for (const ref of refs) {
      const raw = await (d as any).generateButtonImage(ref, 72);
      expect(raw.length).toBe(72 * 72 * 3);
      const rt = await jpegRoundtripInChild(raw);
      // El hijo debe usar el backend nativo turbo (no el fallback jpeg-js).
      expect(rt.turbo).toBe(true);
      expect(rt.magic).toEqual([255, 216]);
      expect(rt.len).toBeGreaterThan(100);
      expect(rt.len).toBeLessThan(72 * 72 * 4);
      expect(rt.w).toBe(72);
      expect(rt.h).toBe(72);
      // Calidad 95 + SAMP_444: el error medio por canal debe ser mínimo.
      expect(rt.mae).toBeLessThan(12);
    }
  });
});
