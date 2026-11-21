#!/usr/bin/env bun
// Prebuild para Electrobun: asegura que web/dist existe (Astro build)
// Si no existe, lo compila. En dev ya existe via npm run dev:web (web usa npm).
// Además sincroniza electrobun.config.ts `app.version` con root package.json
// (fuente canónica). Electrobun es dev-only/experimental: no forma parte del
// release canónico (ver AGENTS.md “Releases”).
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';

const rootPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const canonical = rootPkg.version as string;
const cfgPath = new URL('../electrobun.config.ts', import.meta.url);
const cfg = readFileSync(cfgPath, 'utf8');
const synced = cfg.replace(/version:\s*"[^"]*"/, `version: "${canonical}"`);
if (synced !== cfg) {
  writeFileSync(cfgPath, synced);
  console.log(`[electrobun-prebuild] app.version sincronizada a ${canonical}`);
} else {
  console.log(`[electrobun-prebuild] app.version ya en ${canonical}`);
}

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
