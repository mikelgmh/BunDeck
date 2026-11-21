#!/usr/bin/env bun
// Prebuild para Electrobun: asegura que web/dist existe (Astro build)
// Si no existe, lo compila. En dev ya existe via npm run dev:web (web usa npm).
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';

if (!existsSync('web/dist/index.html')) {
  console.log('[electrobun-prebuild] web/dist no existe, compilando web...');
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npmBin, ['run', 'build'], { cwd: 'web', stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    console.error('[electrobun-prebuild] fallo compilando web');
    process.exit(res.status ?? 1);
  }
} else {
  console.log('[electrobun-prebuild] web/dist OK');
}
