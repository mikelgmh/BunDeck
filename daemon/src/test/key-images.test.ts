/**
 * key-images.test.ts — subida de imágenes de tecla.
 * Sin DB real (stub) y con dataDir temporal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import {
  classifyKeyImageUpload,
  normalizeKeyImage,
  safeAssetName,
  handleKeyImageUpload,
  handleKeyImageDelete,
  KEY_IMAGE_MAX_BYTES,
} from '../http/key-images';

// PNG 1x1 (base64) y GIF 1x1 (base64) como fixtures mínimos.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const GIF_1X1 = Buffer.from('R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=', 'base64');

const created: Array<{ id: string; path: string }> = [];
const dbStub = {
  createAsset(a: { id: string; path: string; hash: string; size: number; created_at: number }) {
    created.push({ id: a.id, path: a.path });
  },
};

let tmpDir = '';
beforeEach(async () => {
  tmpDir = path.join(process.cwd(), `.tmp-keyimg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  created.length = 0;
});
afterEach(async () => {
  try {
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function postReq(file: Blob, name: string): Request {
  const fd = new FormData();
  (fd as any).set('file', file, name);
  return new Request('http://localhost/api/v1/assets', { method: 'POST', body: fd as any });
}

describe('classifyKeyImageUpload', () => {
  it('acepta png/jpg/webp/gif/svg', () => {
    const cases: Array<[string, string]> = [
      ['a.png', 'image/png'],
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpg'],
      ['a.webp', 'image/webp'],
      ['a.gif', 'image/gif'],
      ['a.svg', 'image/svg+xml'],
      ['a.png', ''], // curl sin mime también vale
    ];
    for (const [n, m] of cases) {
      const r = classifyKeyImageUpload(n, m, 100);
      expect('ok' in r).toBe(true);
    }
  });
  it('rechaza ejecutables y sin extensión', () => {
    expect('error' in classifyKeyImageUpload('a.exe', 'application/x-msdownload', 100)).toBe(true);
    expect('error' in classifyKeyImageUpload('a', 'image/png', 100)).toBe(true);
  });
  it('rechaza mime que no acompaña a la extensión', () => {
    const r = classifyKeyImageUpload('evil.png', 'application/x-msdownload', 100);
    expect('error' in r).toBe(true);
  });
  it('rechaza vacío y oversize', () => {
    expect('error' in classifyKeyImageUpload('a.png', 'image/png', 0)).toBe(true);
    expect('error' in classifyKeyImageUpload('a.png', 'image/png', KEY_IMAGE_MAX_BYTES + 1)).toBe(true);
  });
});

describe('normalizeKeyImage (Bun.Image)', () => {
  it('normaliza un PNG a PNG dentro de 512px', async () => {
    const out = await normalizeKeyImage(new Uint8Array(PNG_1X1));
    expect(out.ext).toBe('png');
    expect(out.mime).toBe('image/png');
    expect(out.bytes.byteLength).toBeGreaterThan(0);
    // PNG mágico
    expect(out.bytes[0]).toBe(0x89);
    expect(out.bytes[1]).toBe(0x50);
  });
  it('lanza con contenido no-imagen', async () => {
    await expect(normalizeKeyImage(new TextEncoder().encode('no soy imagen'))).rejects.toThrow();
  });
});

describe('safeAssetName', () => {
  it('acepta un segmento simple y rechaza traversal', () => {
    expect(safeAssetName('key-abc.png')).toBe('key-abc.png');
    expect(safeAssetName('../evil.png')).toBe(null);
    expect(safeAssetName('..\\evil.png')).toBe(null);
    expect(safeAssetName('sub/dir.png')).toBe(null);
    expect(safeAssetName('')).toBe(null);
    expect(safeAssetName('/etc/passwd')).toBe(null);
  });
});

describe('handleKeyImageUpload (handler)', () => {
  it('sube un PNG y devuelve url /assets/...', async () => {
    const file = new File([PNG_1X1 as any], 'icono.png', { type: 'image/png' });
    const res = await handleKeyImageUpload(postReq(file, 'icono.png'), dbStub as any, tmpDir);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.url).toMatch(/^\/assets\/key-.*\.png$/);
    expect(body.format).toBe('png');
    expect(body.animated).toBe(false);
    expect(created).toHaveLength(1);
    expect(await Bun.file(path.join(tmpDir, body.name)).exists()).toBe(true);
  });

  it('conserva los GIF tal cual (animados)', async () => {
    const file = new File([GIF_1X1 as any], 'anim.gif', { type: 'image/gif' });
    const res = await handleKeyImageUpload(postReq(file, 'anim.gif'), dbStub as any, tmpDir);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.url).toMatch(/\.gif$/);
    expect(body.animated).toBe(true);
    // Bytes idénticos: no se re-comprime la animación
    const saved = new Uint8Array(await Bun.file(path.join(tmpDir, body.name)).arrayBuffer());
    expect(saved.byteLength).toBe(GIF_1X1.byteLength);
  });

  it('400 sin fichero y 400 con tipo malo', async () => {
    const empty = new Request('http://localhost/api/v1/assets', { method: 'POST', body: new FormData() as any });
    expect((await handleKeyImageUpload(empty, dbStub as any, tmpDir)).status).toBe(400);
    const exe = new File(['MZ...'], 'run.exe', { type: 'application/x-msdownload' });
    expect((await handleKeyImageUpload(postReq(exe, 'run.exe'), dbStub as any, tmpDir)).status).toBe(400);
  });
});

describe('handleKeyImageDelete', () => {
  it('borra el fichero subido', async () => {
    const file = new File([PNG_1X1 as any], 'icono.png', { type: 'image/png' });
    const up = await handleKeyImageUpload(postReq(file, 'icono.png'), dbStub as any, tmpDir);
    const { url, name }: any = await up.json();
    expect(await Bun.file(path.join(tmpDir, name)).exists()).toBe(true);
    const del = new Request('http://localhost/api/v1/assets', {
      method: 'DELETE',
      body: JSON.stringify({ url }),
    });
    const res = await handleKeyImageDelete(del, tmpDir);
    expect(res.status).toBe(200);
    expect(await Bun.file(path.join(tmpDir, name)).exists()).toBe(false);
  });
  it('rechaza traversal', async () => {
    const del = new Request('http://localhost/api/v1/assets', {
      method: 'DELETE',
      body: JSON.stringify({ url: '../../secret.txt' }),
    });
    expect((await handleKeyImageDelete(del, tmpDir)).status).toBe(400);
  });
});
