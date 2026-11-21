import { join, dirname, resolve, basename } from 'path';

export const DEFAULT_API_PORT = 3001;
export const DEFAULT_WS_PORT = 3003;

export function normalizePort(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : fallback;
}

export function buildApiBase(port: unknown): string {
  return `http://localhost:${normalizePort(port, DEFAULT_API_PORT)}`;
}

export function buildWsUrl(port: unknown): string {
  return `ws://localhost:${normalizePort(port, DEFAULT_WS_PORT)}`;
}

export interface ParsedHealth {
  online: boolean;
  timestamp?: number;
  version?: string;
  /** Puerto del WS tal como lo devuelve /health (number) o objetos legacy. */
  wsPort?: number;
  /** Solo presente si el daemon devuelve objeto { clients } (legacy). */
  wsClients?: number;
  raw: unknown;
}

/**
 * Parsea el /health real del daemon:
 *   { status, timestamp, version, websocket: <port number> }
 * Tolera variantes legacy: websocket como { port, clients } o { clients }.
 */
export function parseHealth(data: any): ParsedHealth {
  if (!data || typeof data !== 'object') {
    return { online: false, raw: data };
  }
  const ws = (data as any).websocket;
  let wsPort: number | undefined;
  let wsClients: number | undefined;
  if (typeof ws === 'number' && Number.isFinite(ws)) {
    wsPort = ws;
  } else if (ws && typeof ws === 'object') {
    if (Number.isFinite(Number((ws as any).port))) {
      wsPort = Number((ws as any).port);
    }
    if (Number.isFinite(Number((ws as any).clients))) {
      wsClients = Number((ws as any).clients);
    }
  }
  return {
    online: true,
    timestamp: typeof data.timestamp === 'number' ? data.timestamp : undefined,
    version: typeof data.version === 'string' ? data.version : undefined,
    wsPort,
    wsClients,
    raw: data,
  };
}

export interface DaemonExeVersion {
  file: string;
  version: string;
  hasVersion: boolean;
}

export function extractDaemonVersion(file: string): DaemonExeVersion {
  const versionMatch = file.match(/libredeck-daemon-v([0-9]+\.[0-9]+\.[0-9]+)/);
  if (versionMatch) {
    return { file, version: versionMatch[1], hasVersion: true };
  }
  return { file, version: '0.0.0', hasVersion: false };
}

/** Devuelve -1 si a va antes (mayor versión primero). */
export function compareDaemonVersions(a: DaemonExeVersion, b: DaemonExeVersion): number {
  if (a.hasVersion && !b.hasVersion) return -1;
  if (!a.hasVersion && b.hasVersion) return 1;
  const aParts = a.version.split('.').map(Number);
  const bParts = b.version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const ap = aParts[i] ?? 0;
    const bp = bParts[i] ?? 0;
    if (ap > bp) return -1;
    if (ap < bp) return 1;
  }
  return 0;
}

export function isDaemonExeFile(file: string): boolean {
  return (
    file.startsWith('libredeck-daemon') &&
    (file.endsWith('.exe') || !file.includes('.')) &&
    !file.includes('-backup')
  );
}

/** Ordena candidatos de mayor a menor versión (versionados primero). */
export function sortDaemonExes(files: string[]): string[] {
  return files
    .filter(isDaemonExeFile)
    .map(extractDaemonVersion)
    .sort(compareDaemonVersions)
    .map((v) => v.file);
}

/** Elige el exe con versión más alta o null si no hay candidatos. */
export function pickLatestDaemonExe(files: string[]): string | null {
  const sorted = sortDaemonExes(files);
  return sorted.length > 0 ? sorted[0] : null;
}

export interface DataDirEnv {
  LIBREDECK_DATA_DIR?: string;
  APPDATA?: string;
  LOCALAPPDATA?: string;
}

/**
 * Replica la resolución del daemon (daemon/src/config.ts) desde el CLI:
 * LIBREDECK_DATA_DIR > %APPDATA%/LibreDeck/data (instalado) > <repo>/data (dev).
 */
export function resolveDataDir(opts?: {
  execPath?: string;
  cwd?: string;
  env?: DataDirEnv;
}): string {
  const env = opts?.env ?? (process.env as DataDirEnv);
  if (env.LIBREDECK_DATA_DIR) return env.LIBREDECK_DATA_DIR;
  const execPath = opts?.execPath ?? process.execPath ?? '';
  const cwd = opts?.cwd ?? process.cwd();
  const isInstalled =
    execPath.includes('Program Files') ||
    execPath.includes('Program Files (x86)') ||
    basename(execPath).toLowerCase().startsWith('libredeck');
  if (isInstalled) {
    const base = env.APPDATA || env.LOCALAPPDATA || cwd;
    return join(base, 'LibreDeck', 'data');
  }
  // Dev: si el CWD es cli/, el data dir es ../data; si no, ./data
  if (basename(resolve(cwd)).toLowerCase() === 'cli') {
    return resolve(cwd, '..', 'data');
  }
  return resolve(cwd, 'data');
}

export function pidFilePath(dataDir: string): string {
  return join(dataDir, 'daemon.pid');
}

export function daemonLogPath(dataDir: string): string {
  return join(dataDir, 'logs', 'daemon.log');
}

export function pidFileDir(dataDir: string): string {
  return dirname(pidFilePath(dataDir));
}
