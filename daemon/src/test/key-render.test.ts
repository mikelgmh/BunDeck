/**
 * key-render.test.ts — el renderer HW replica la web: fondo + icono tintado
 * + texto conviviendo, orientación top-down y tamaño nativo del modelo.
 * Sin HID: solo canvas. BD aislada en tmp (getDaemonDisplayEnv la toca).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { StreamDeckDriver } from '../hw-driver/streamdeck-driver';

let TMP = '';
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-keyrender-'));
  process.env.LIBREDECK_DATA_DIR = TMP;
});

function px(buf: Buffer, w: number, x: number, y: number): [number, number, number] {
  const o = (y * w + x) * 3;
  return [buf[o], buf[o + 1], buf[o + 2]];
}

function countNonBg(buf: Buffer, w: number, h: number, bg: [number, number, number], x0 = 0, y0 = 0, x1?: number, y1?: number): number {
  let n = 0;
  const X1 = x1 ?? w;
  const Y1 = y1 ?? h;
  for (let y = y0; y < Y1; y++) {
    for (let x = x0; x < X1; x++) {
      const [r, g, b] = px(buf, w, x, y);
      if (r !== bg[0] || g !== bg[1] || b !== bg[2]) n++;
    }
  }
  return n;
}

describe('generateButtonImage', () => {
  it('fondo sólido + longitud nativa (72 sin HW)', async () => {
    const d = new StreamDeckDriver();
    const buf = await d.generateButtonImage({ backgroundColor: '#7c3aed' }, 72);
    expect(buf.length).toBe(72 * 72 * 3);
    // #7c3aed = (124, 58, 237) en RGB top-down (antes salía cruzado BGR).
    expect(px(buf, 72, 0, 0)).toEqual([124, 58, 237]);
    expect(px(buf, 72, 71, 71)).toEqual([124, 58, 237]);
  });

  it('icono + label conviven: icono tintado en el centro y texto abajo', async () => {
    const d = new StreamDeckDriver();
    const buf = await d.generateButtonImage(
      { label: 'Micro', icon: 'Mic', backgroundColor: '#101010', textColor: '#facc15' },
      72,
    );
    // #facc15 = (250, 204, 21): el icono debe tener píxeles amarillentos.
    let yellowish = 0;
    for (let y = 14; y < 50; y++) {
      for (let x = 14; x < 58; x++) {
        const [r, g, b] = px(buf, 72, x, y);
        if (r > 180 && g > 140 && b < 120) yellowish++;
      }
    }
    expect(yellowish).toBeGreaterThan(20);
    // Texto abajo: última franja con píxeles distintos del fondo.
    const inkBottom = countNonBg(buf, 72, 72, [16, 16, 16], 0, 56);
    expect(inkBottom).toBeGreaterThan(10);
  });

  it('textTop arriba y orientación top-down (no invertida)', async () => {
    const d = new StreamDeckDriver();
    const buf = await d.generateButtonImage(
      { textTop: 'ARRIBA', icon: '', backgroundColor: '#000000', textColor: '#ffffff', showTitle: true },
      72,
    );
    const topInk = countNonBg(buf, 72, 72, [0, 0, 0], 0, 0, 72, 24);
    const bottomInk = countNonBg(buf, 72, 72, [0, 0, 0], 0, 48, 72, 72);
    expect(topInk).toBeGreaterThan(bottomInk);
    expect(topInk).toBeGreaterThan(10);
  });

  it('tecla vacía: fondo por defecto web, sin tinta', async () => {
    const d = new StreamDeckDriver();
    const buf = await d.generateButtonImage({ icon: '' }, 72);
    // #2d3036 = (45, 48, 54)
    expect(px(buf, 72, 0, 0)).toEqual([45, 48, 54]);
    expect(countNonBg(buf, 72, 72, [45, 48, 54])).toBe(0);
  });

  it('respeta el tamaño nativo del modelo (p. ej. XL 96)', async () => {
    const d = new StreamDeckDriver();
    const buf = await d.generateButtonImage({ label: 'XL', icon: 'Zap' }, 96);
    expect(buf.length).toBe(96 * 96 * 3);
  });

  it('marcas simple-icons: `si:<slug>` pinta el glifo (no texto)', async () => {
    const d = new StreamDeckDriver();
    const buf = await d.generateButtonImage(
      { icon: 'si:youtube', backgroundColor: '#101010', textColor: '#ffffff', showTitle: false },
      72,
    );
    // Sin label ni textos: si el glifo se dibuja hay tinta en el centro;
    // si cayera al fallback de texto no habría nada que pintar.
    expect(countNonBg(buf, 72, 72, [16, 16, 16], 14, 14, 58, 58)).toBeGreaterThan(20);
  });

  it('marcas heredadas de Lucide (Youtube/Twitch/Github) ya no caen a texto en el HW', async () => {
    const d = new StreamDeckDriver();
    for (const icon of ['Youtube', 'Twitch', 'Github']) {
      const buf = await d.generateButtonImage(
        { icon, backgroundColor: '#101010', textColor: '#ffffff', showTitle: false },
        72,
      );
      expect(countNonBg(buf, 72, 72, [16, 16, 16], 14, 14, 58, 58)).toBeGreaterThan(20);
    }
  });

  it('icono desconocido sin label: sin tinta (no inventa nada)', async () => {
    const d = new StreamDeckDriver();
    const buf = await d.generateButtonImage(
      { icon: 'DefinitivamenteNoExiste', backgroundColor: '#101010', textColor: '#ffffff', showTitle: false },
      72,
    );
    expect(countNonBg(buf, 72, 72, [16, 16, 16])).toBe(0);
  });
});
