/**
 * test-data-dir.ts — aislamiento del data-dir entre ficheros de test.
 *
 * Causa raíz de los flakes solo-CI (ver phase1-model/elgato/plugin-lifecycle):
 * `resolveDataDir()` (config.ts) prefiere `BUNDECK_DATA_DIR` sobre el
 * deprecated `LIBREDECK_DATA_DIR`. Los ficheros press-logs*.test.ts fijaban
 * `BUNDECK_DATA_DIR` sin restaurarlo, y `process.env` es global al proceso
 * de `bun test`: según el orden de descubrimiento de ficheros del SO
 * (alfabético en Windows/NTFS, hash en Linux/ext4) ese resto apuntaba el
 * data-dir de OTRO fichero (DB, plugins, shims) mientras las aserciones
 * miraban el TMP propio → existsSync/ENOENT/getStatus-null/getProfile-null
 * solo en CI Linux y de forma variable.
 *
 * Invariante: durante la ejecución de un fichero, ambas vars apuntan a SU
 * tmpdir (`setDataDir`), y al terminar restaura los valores previos
 * (`restore`) para no envenenar a los siguientes. Patrón:
 *
 *   const CLAIM = claimDataDir('ld-xxx-test-');
 *   const TMP = CLAIM.dir;
 *   // ...imports...
 *   beforeAll(async () => { setDataDir(TMP); ... });
 *   afterAll(() => { ...; CLAIM.restore(); CLAIM.cleanup(); });
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Fija AMBAS vars canónica+deprecated al mismo dir (la canónica gana). */
export function setDataDir(dir: string): void {
  process.env.BUNDECK_DATA_DIR = dir;
  process.env.LIBREDECK_DATA_DIR = dir;
}

export function claimDataDir(prefix: string): {
  dir: string;
  restore: () => void;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prevBundeck = process.env.BUNDECK_DATA_DIR;
  const prevLibre = process.env.LIBREDECK_DATA_DIR;
  setDataDir(dir);
  let restored = false;
  return {
    dir,
    restore() {
      if (restored) return;
      restored = true;
      if (prevBundeck === undefined) delete process.env.BUNDECK_DATA_DIR;
      else process.env.BUNDECK_DATA_DIR = prevBundeck;
      if (prevLibre === undefined) delete process.env.LIBREDECK_DATA_DIR;
      else process.env.LIBREDECK_DATA_DIR = prevLibre;
    },
    cleanup() {
      // Best-effort: en Windows un handle sqlite abierto puede bloquear el rm.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* noop: /tmp lo reclama el SO */
      }
    },
  };
}
