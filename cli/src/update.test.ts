/**
 * update.test.ts — lógica del update standalone del CLI:
 * comparación de versiones, detección de instalación gestionada y
 * descarga verificada (sha256) con extracción del daemon desde bundle.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { isNewer, currentTarget, isManagedInstall } from './update';

describe('isNewer', () => {
  it('detecta versiones más nuevas', () => {
    expect(isNewer('1.5.0', '1.6.0')).toBe(true);
    expect(isNewer('1.5.0', 'v1.6.0')).toBe(true);
    expect(isNewer('1.6.0', '1.6.0')).toBe(false);
    expect(isNewer('1.7.0', '1.6.0')).toBe(false);
    expect(isNewer('1.5.10', '1.5.11')).toBe(true);
  });
});

describe('currentTarget', () => {
  it('devuelve un target conocido', () => {
    expect(['windows-x64', 'linux-x64', 'darwin-x64']).toContain(currentTarget());
  });
});

describe('isManagedInstall', () => {
  it('detecta active.json y versions/', () => {
    const d = mkdtempSync(join(tmpdir(), 'ld-managed-'));
    try {
      expect(isManagedInstall(d)).toBe(false);
      writeFileSync(join(d, 'active.json'), '{"version":"1.6.0"}');
      expect(isManagedInstall(d)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

/** Construye un zip mínimo (STORED) con un único fichero. */
function tinyZip(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = zipCrc(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(8, 8); // deflated
  lh.writeUInt16LE(0, 10);
  lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc >>> 0, 14);
  const comp = deflateRawSync(data);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc >>> 0, 16);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  const cdOff = lh.length + nameBuf.length + comp.length;
  const cdLen = cd.length + nameBuf.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cdOff, 16);
  end.writeUInt32LE(cdLen, 12);
  return Buffer.concat([lh, nameBuf, comp, cd, nameBuf, end]);
}

// CRC32 (tabla estándar).
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function zipCrc(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c;
}

describe('downloadStandaloneDaemon (servidor local)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ld-dl-'));
  let server: ReturnType<typeof Bun.serve> | null = null;
  let bundle: Buffer;
  let sha: string;

  beforeAll(() => {
    const daemonBin = Buffer.from('#!/bin/sh\necho fake-daemon\n', 'utf8');
    bundle = tinyZip('bundeck-daemon', daemonBin);
    sha = createHash('sha256').update(bundle).digest('hex');
    const url = `http://127.0.0.1:0/bundle.zip`;
    void url;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === '/bundle.zip') {
          return new Response(new Uint8Array(bundle), {
            headers: { 'content-length': String(bundle.length) },
          });
        }
        return new Response('nf', { status: 404 });
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('descarga, verifica sha256 y extrae el daemon', async () => {
    const port = (server as any).port as number;
    const { downloadStandaloneDaemon } = await import('./update');
    process.env.BUNDECK_INSTALL_DIR = dir;
    const dest = await downloadStandaloneDaemon(
      {
        current: '1.5.0',
        latest: '9.9.9',
        notesUrl: 'https://example.invalid/notes',
        asset: {
          bundle: 'bundeck-v9.9.9-test.zip',
          url: `http://127.0.0.1:${port}/bundle.zip`,
          sha256: sha,
          size: bundle.length,
          signature: null,
        },
      },
      () => {},
    );
    const ext = process.platform === 'win32' ? '.exe' : '';
    expect(dest.endsWith(`bundeck-daemon-v9.9.9${ext}`)).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toContain('fake-daemon');
    delete process.env.BUNDECK_INSTALL_DIR;
  });

  it('rechaza sha256 incorrecto', async () => {
    const port = (server as any).port as number;
    const { downloadStandaloneDaemon } = await import('./update');
    process.env.BUNDECK_INSTALL_DIR = dir;
    await expect(
      downloadStandaloneDaemon({
        current: '1.5.0',
        latest: '9.9.9',
        notesUrl: '',
        asset: {
          bundle: 'x.zip',
          url: `http://127.0.0.1:${port}/bundle.zip`,
          sha256: '00'.repeat(32),
          size: bundle.length,
          signature: null,
        },
      }),
    ).rejects.toThrow();
    delete process.env.BUNDECK_INSTALL_DIR;
  });
});
