import { join, dirname } from 'path';

function parsePort(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Puertos centralizados — evita colisión WS vs Frontend (bug original ambos en 3002)
// API: 3001, WS: 3003, Frontend: 3002 (LAN accesible incluso con Electrobun)
export const API_PORT = parsePort(
  process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] || process.env.PORT,
  3001
);
export const WS_PORT = parsePort(process.env.WS_PORT, 3003);
export const FRONTEND_PORT = parsePort(
  process.argv.find(arg => arg.startsWith('--web-port='))?.split('=')[1] || process.env.FRONTEND_PORT,
  3002
);

export const DEV_MODE = process.env.DEV_MODE === 'true';
export const ELECTROBUN_MODE = process.env.ELECTROBUN === 'true' || !!process.env.ELECTROBUN_DATA_DIR;

// Data dir absoluto — compatible con Bun --compile y Electrobun
export function resolveDataDir(): string {
  if (process.env.LIBREDECK_DATA_DIR) return process.env.LIBREDECK_DATA_DIR;
  if (process.env.ELECTROBUN_DATA_DIR) return join(process.env.ELECTROBUN_DATA_DIR, 'libredeck');
  // Electrobun: Utils.getDataPath() no disponible aquí, fallback a APPDATA
  const execPath = process.execPath || '';
  const isInstalled = execPath.includes('Program Files') || execPath.includes('Program Files (x86)') || execPath.includes('libredeck');
  if (isInstalled) {
    const base = process.env.APPDATA || process.env.LOCALAPPDATA || process.cwd();
    return join(base, 'LibreDeck', 'data');
  }
  // Dev: daemon/src -> ../../data (projectRoot/data) absoluto, no relativo
  return join(import.meta.dir, '..', '..', 'data');
}

export const config = {
  apiPort: API_PORT,
  wsPort: WS_PORT,
  frontendPort: FRONTEND_PORT,
  devMode: DEV_MODE,
  electrobunMode: ELECTROBUN_MODE,
} as const;
