/**
 * Centralized path management for BunDeck
 * Handles development vs production environment paths.
 * Data-dir canónica: %APPDATA%/BunDeck/data con read-fallback a
 * %APPDATA%/LibreDeck/data (ver resolveDataDir en ./config).
 */

import { join } from 'path';

// Detect if running from installed location (Program Files)
const isInstalled = process.execPath.includes('Program Files') || 
                    process.execPath.includes('Program Files (x86)');

/**
 * Get the data directory path
 * Delega a config.resolveDataDir() para path absoluto compatible con Bun --compile y Electrobun
 */
export function getDataDir(): string {
  // Lazy import para evitar ciclo
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveDataDir } = require('./config');
    return resolveDataDir();
  } catch {
    const custom = process.env.BUNDECK_DATA_DIR || process.env.LIBREDECK_DATA_DIR;
    if (custom) {
      return custom;
    }
    if (isInstalled) {
      const appDataDir = process.env.APPDATA || process.env.LOCALAPPDATA || process.cwd();
      // Réplica mínima del fallback de config.resolveDataDir: no huérfanas
      // %APPDATA%/LibreDeck/data si ya contiene la DB (esta rama solo se
      // alcanza si require('./config') falla).
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs');
        const canonical = join(appDataDir, 'BunDeck', 'data');
        const legacy = join(appDataDir, 'LibreDeck', 'data');
        if (!fs.existsSync(join(canonical, 'db.sqlite')) && fs.existsSync(join(legacy, 'db.sqlite'))) {
          return legacy;
        }
      } catch {}
      return join(appDataDir, 'BunDeck', 'data');
    }
    return join(process.cwd(), '..', 'data');
  }
}

/**
 * Get the plugins directory path
 */
export function getPluginsDir(): string {
  return join(getDataDir(), 'plugins');
}

/**
 * Get the assets directory path
 */
export function getAssetsDir(): string {
  return join(getDataDir(), 'assets');
}

/**
 * Get the logs directory path
 */
export function getLogsDir(): string {
  return join(getDataDir(), 'logs');
}

/**
 * Get the database path
 */
export function getDbPath(): string {
  return join(getDataDir(), 'db.sqlite');
}

/**
 * Ensure all data directories exist
 */
export async function ensureDataDirectories(): Promise<void> {
  const fs = await import('fs');
  const dirs = [
    getDataDir(),
    getPluginsDir(),
    getAssetsDir(),
    getLogsDir()
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
