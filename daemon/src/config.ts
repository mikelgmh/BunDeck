import { join, dirname } from 'path';
import { existsSync } from 'node:fs';

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

// Env canónico BUNDECK_*, con fallback deprecated LIBREDECK_*.
function envCompat(name: string): string | undefined {
  return process.env[`BUNDECK_${name}`] ?? process.env[`LIBREDECK_${name}`];
}

// Bind de los Bun.serve del daemon (API, WS y frontend embebido).
// Seguro por defecto: solo loopback. Para LAN (QR del panel, móvil):
//   BUNDECK_BIND=0.0.0.0 (o BUNDECK_BIND_LAN=1)
// dev.sh y el launcher Rust ya ponen BUNDECK_BIND_LAN=1 al spawnear.
// Para forzar loopback aunque haya LAN: BUNDECK_BIND=127.0.0.1 (o BUNDECK_BIND_LAN=0).
function resolveBindHost(): string {
  const explicit = envCompat('BIND')?.trim();
  if (explicit) return explicit;
  const lan = envCompat('BIND_LAN');
  if (lan === '1' || lan === 'true') return '0.0.0.0';
  return '127.0.0.1';
}
export const BIND_HOST = resolveBindHost();

// Data dir absoluto — compatible con Bun --compile y Electrobun.
//
// Decisión de rename: canónico %APPDATA%/BunDeck/data (instalado). Para no
// huérfanas datos de instalaciones antiguas, si el canónico aún no tiene
// db.sqlite pero %APPDATA%/LibreDeck/data sí, se REUTILIZA el antiguo
// (read-fallback, sin copiar: plugins/assets/logs siguen en su sitio) y se
// avisa por consola. Misma semántica que launcher/src/updater.rs::user_data_dir
// (el launcher no puede importar TS, así que ambas réplicas deben coincidir).
// En dev (<repo>/data) no hay nada que migrar: la ruta deriva del checkout.
export function resolveDataDir(): string {
  const custom = envCompat('DATA_DIR');
  if (custom) return custom;
  if (process.env.ELECTROBUN_DATA_DIR) return join(process.env.ELECTROBUN_DATA_DIR, 'bundeck');
  // Electrobun: Utils.getDataPath() no disponible aquí, fallback a APPDATA
  const execPath = process.execPath || '';
  const isInstalled = execPath.includes('Program Files') || execPath.includes('Program Files (x86)') || execPath.includes('libredeck') || execPath.includes('bundeck');
  if (isInstalled) {
    const base = process.env.APPDATA || process.env.LOCALAPPDATA || process.cwd();
    const canonical = join(base, 'BunDeck', 'data');
    const legacy = join(base, 'LibreDeck', 'data');
    try {
      if (!existsSync(join(canonical, 'db.sqlite')) && existsSync(join(legacy, 'db.sqlite'))) {
        console.warn(`[config] Usando data-dir heredado ${legacy} (canónico ${canonical} aún sin db.sqlite). Mueve tus datos o define BUNDECK_DATA_DIR para fijar la ruta.`);
        return legacy;
      }
    } catch {
      // Si no se puede inspeccionar el FS, canónico y que el arranque decida.
    }
    return canonical;
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
