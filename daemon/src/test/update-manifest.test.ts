/**
 * update-manifest.test.ts — genera el manifiesto desde bundles falsos:
 * sha256, tamaños, URLs y firma ed25519 (con clave efímera de test).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { buildManifest } from '../../../scripts/build-update-manifest.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-manifest-test-'));
const VER = '9.9.9';

beforeAll(() => {
  for (const t of ['windows-x64', 'linux-x64', 'darwin-x64']) {
    fs.writeFileSync(path.join(TMP, `bundeck-v${VER}-${t}.zip`), `fake-bundle-${t}`);
  }
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.LIBREDECK_UPDATE_PRIVKEY;
});

describe('buildManifest', () => {
  it('emite sha256, size y URLs por target (sin firma)', () => {
    delete process.env.LIBREDECK_UPDATE_PRIVKEY;
    const m: any = buildManifest({ version: VER, assetsDir: TMP });
    expect(m.version).toBe(VER);
    expect(m.signed).toBe(false);
    for (const t of ['windows-x64', 'linux-x64', 'darwin-x64']) {
      const a = m.assets[t];
      expect(a.bundle).toBe(`bundeck-v${VER}-${t}.zip`);
      expect(a.url).toContain(`releases/download/v${VER}/bundeck-v${VER}-${t}.zip`);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.size).toBeGreaterThan(0);
      expect(a.signature).toBeNull();
    }
  });

  it('firma cada asset si hay LIBREDECK_UPDATE_PRIVKEY', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const jwk = privateKey.export({ format: 'jwk' }) as any;
    process.env.LIBREDECK_UPDATE_PRIVKEY = Buffer.from(jwk.d, 'base64url').toString('hex');
    const m: any = buildManifest({ version: VER, assetsDir: TMP });
    expect(m.signed).toBe(true);
    for (const t of Object.keys(m.assets)) {
      expect(m.assets[t].signature).toMatch(/^[0-9a-f]{128}$/);
    }
  });

  it('falla sin bundles', () => {
    expect(() => buildManifest({ version: '0.0.0', assetsDir: TMP })).toThrow();
  });
});
