#!/usr/bin/env bun
// update.ts — Update gestionado del CLI/daemon (standalone).
//
// Instalaciones gestionadas (launcher con versions/active.json): el dueño
// del update es el launcher; aquí solo se informa (`--check`) y se guía.
// Instalaciones standalone (binarios sueltos manuales): descarga verificada
// (sha256 del manifiesto) a fichero versionado
// `libredeck-daemon-v<ver><ext>`; `getLatestDaemonExe()` ya elige el más
// nuevo al arrancar, así que basta reiniciar el daemon para aplicar.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { getVersion } from './version';

export const MANIFEST_URL =
  'https://github.com/mikelgmh/libredeck/releases/latest/download/bundeck-update-manifest.json';

export interface UpdateAsset {
  bundle: string;
  url: string;
  sha256: string;
  size: number;
  signature?: string | null;
}

export interface UpdateManifest {
  version: string;
  channel?: string;
  assets: Record<string, UpdateAsset>;
}

export interface UpdateCheck {
  current: string;
  latest: string;
  notesUrl: string;
  asset: UpdateAsset;
}

/** Target del manifiesto para esta plataforma. */
export function currentTarget(): string {
  if (process.platform === 'win32') return 'windows-x64';
  if (process.platform === 'darwin') return 'darwin-x64';
  return 'linux-x64';
}

function numParts(s: string): number[] {
  return s
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((p) => {
      const m = p.match(/^\d+/);
      return m ? parseInt(m[0], 10) : 0;
    });
}

/** true si `latest` es más nuevo que `installed`. */
export function isNewer(installed: string, latest: string): boolean {
  const a = numParts(installed);
  const b = numParts(latest);
  const n = Math.max(a.length, b.length, 1);
  while (a.length < n) a.push(0);
  while (b.length < n) b.push(0);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

/** Directorio de instalación: override o junto al ejecutable. */
export function installDir(): string {
  if (process.env.LIBREDECK_INSTALL_DIR?.trim()) return process.env.LIBREDECK_INSTALL_DIR;
  return dirname(process.execPath);
}

/** ¿Instalación gestionada por el launcher? */
export function isManagedInstall(dir?: string): boolean {
  const root = dir ?? installDir();
  return existsSync(join(root, 'active.json')) || existsSync(join(root, 'versions'));
}

export async function fetchManifest(): Promise<UpdateManifest> {
  const res = await fetch(MANIFEST_URL, {
    headers: { 'User-Agent': 'libredeck-cli' },
  });
  if (!res.ok) throw new Error(`manifiesto inaccesible (HTTP ${res.status})`);
  const m = (await res.json()) as UpdateManifest;
  if (!m?.version || !m?.assets) throw new Error('manifiesto inválido');
  return m;
}

export async function checkForUpdate(): Promise<UpdateCheck | null> {
  const current = getVersion();
  const m = await fetchManifest();
  if (!isNewer(current, m.version)) return null;
  const asset = m.assets[currentTarget()];
  if (!asset) throw new Error(`la release ${m.version} no trae bundle para ${currentTarget()}`);
  return {
    current,
    latest: m.version,
    notesUrl: `https://github.com/mikelgmh/libredeck/releases/tag/v${m.version}`,
    asset,
  };
}

/**
 * Descarga el daemon standalone verificado a fichero versionado.
 * Devuelve la ruta final. (El bundle gestionado trae launcher+web-dist;
 * en standalone solo se extrae el daemon: el zip se descarga entero y se
 * saca `libredeck-daemon*` con el lector zip mínimo de abajo.)
 */
export async function downloadStandaloneDaemon(
  check: UpdateCheck,
  onProgress?: (downloaded: number, total?: number) => void,
): Promise<string> {
  const dir = installDir();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const bundleUrl = check.asset.url;

  const res = await fetch(bundleUrl, { headers: { 'User-Agent': 'libredeck-cli' } });
  if (!res.ok || !res.body) throw new Error(`descarga fallida (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || check.asset.size || undefined;

  const tmp = join(dir, `.bundeck-dl-${Date.now()}.zip`);
  const hash = createHash('sha256');
  const file = Bun.file(tmp);
  const writer = file.writer();
  let downloaded = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      writer.write(value);
      downloaded += value.length;
      onProgress?.(downloaded, total);
    }
  } finally {
    await writer.end();
  }
  const got = hash.digest('hex');
  if (got.toLowerCase() !== check.asset.sha256.trim().toLowerCase()) {
    throw new Error(`sha256 no coincide (esperado ${check.asset.sha256}, obtenido ${got})`);
  }

  // Extrae libredeck-daemon* del bundle (zip STORED/DEFLATED, sin cifrado).
  const daemonName = `libredeck-daemon-v${check.latest}${ext}`;
  const dest = join(dir, daemonName);
  extractDaemonFromZip(tmp, dest);
  if (process.platform !== 'win32') {
    try {
      chmodSync(dest, 0o755);
    } catch {
      /* best-effort */
    }
  }
  return dest;
}

/**
 * Lector zip mínimo: local headers + central directory parse para un
 * único fichero. Soporta STORED (0) y DEFLATED (8). Sin dependencias.
 */
function extractDaemonFromZip(zipPath: string, dest: string): void {
  const buf: Buffer = readFileSync(zipPath);
  // Busca End Of Central Directory.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('bundle zip inválido (sin EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let coff = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(coff) !== 0x02014b50) throw new Error('bundle zip inválido');
    const method = buf.readUInt16LE(coff + 10);
    const compSize = buf.readUInt32LE(coff + 20);
    const nameLen = buf.readUInt16LE(coff + 28);
    const extraLen = buf.readUInt16LE(coff + 30);
    const commentLen = buf.readUInt16LE(coff + 32);
    const lho = buf.readUInt32LE(coff + 42);
    const name = buf.subarray(coff + 46, coff + 46 + nameLen).toString('utf8');
    const base = name.split('/').pop() ?? '';
    const isDaemon = /^libredeck-daemon(\.exe)?$/.test(base) || /^libredeck-daemon-v[\d.]+(\.exe)?$/.test(base);
    if (!name.endsWith('/') && isDaemon) {
      if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('bundle zip inválido');
      const lhNameLen = buf.readUInt16LE(lho + 26);
      const lhExtraLen = buf.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + lhNameLen + lhExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      const data = method === 8 ? inflateRawSync(comp) : Buffer.from(comp);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      return;
    }
    coff += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('el bundle no trae libredeck-daemon');
}

/** Nombres esperados dentro de dist/ para el bundle de esta plataforma. */
export function expectedDistFiles(): string[] {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return [
    `libredeck-daemon${ext}`,
    `libredeck-cli${ext}`,
    `libredeck-launcher${ext}`,
    `libredeck-updater${ext}`,
  ];
}
