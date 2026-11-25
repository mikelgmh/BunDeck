/**
 * streamdeck-conflict.ts — Detección y cierre de la app oficial de Elgato.
 *
 * La app oficial (StreamDeck.exe en Windows, "Stream Deck" en macOS) se queda
 * el HID en exclusiva y BunDeck no puede abrir el dispositivo. Este módulo
 * solo conoce una allowlist de nombres de proceso oficiales: nunca expone
 * el listado general de procesos ni permite cerrar nada fuera de la lista.
 */

export interface ConflictProcess {
  name: string;
  pid: number | null;
}

/** Nombres oficiales por plataforma (comparación case-insensitive). */
export const CONFLICT_PROCESS_NAMES: Record<string, string[]> = {
  win32: ['streamdeck.exe', 'stream deck.exe', 'elgato stream deck.exe'],
  darwin: ['stream deck', 'elgato stream deck'],
  linux: ['streamdeck', 'elgato-streamdeck', 'stream deck'],
};

/** Nombres conocidos en cualquier plataforma (para tests y logs). */
export const ALL_CONFLICT_NAMES: string[] = [
  ...new Set(Object.values(CONFLICT_PROCESS_NAMES).flat()),
];

function wantedForThisPlatform(): string[] {
  const list = CONFLICT_PROCESS_NAMES[process.platform];
  if (list) return list;
  return ALL_CONFLICT_NAMES;
}

/** ¿Es un proceso de la app oficial? Comparación exacta case-insensitive
 *  (con o sin extensión / ruta). */
export function isConflictProcessName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let base = String(raw).trim().toLowerCase();
  if (!base) return false;
  // Quitar ruta: `C:\...\StreamDeck.exe` → `streamdeck.exe`, y normalizar `/`.
  base = base.replace(/\\/g, '/');
  const slash = base.lastIndexOf('/');
  if (slash >= 0) base = base.slice(slash + 1);
  return ALL_CONFLICT_NAMES.some((n) => n.toLowerCase() === base);
}

function parseNamesFromLines(lines: string[]): ConflictProcess[] {
  const out: ConflictProcess[] = [];
  for (const line of lines) {
    const name = line.trim();
    if (name && isConflictProcessName(name)) out.push({ name, pid: null });
  }
  return out;
}

/** Filtra una lista `nombre,pid` quedándose solo con la app oficial. */
export function filterConflictProcesses(entries: Array<{ name: string; pid?: number | null }>): ConflictProcess[] {
  const out: ConflictProcess[] = [];
  for (const e of entries) {
    if (isConflictProcessName(e?.name)) {
      const pid = typeof e?.pid === 'number' && Number.isFinite(e.pid) ? e.pid : null;
      out.push({ name: String(e.name).trim(), pid });
    }
  }
  return out;
}

async function runCmd(cmd: string[], timeoutMs = 8000): Promise<{ exitCode: number; stdout: string }> {
  try {
    const proc = Bun.spawn({ windowsHide: true, cmd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* timeout: best-effort */ }
    }, timeoutMs);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    return { exitCode: proc.exitCode, stdout };
  } catch {
    return { exitCode: 1, stdout: '' };
  }
}

async function listWindows(): Promise<ConflictProcess[]> {
  // PowerShell con JSON: robusto ante nombres con espacios y rutas.
  const ps = `Get-Process | Where-Object { $_.ProcessName -match '^(StreamDeck|Stream Deck|Elgato Stream Deck)$' } | Select-Object ProcessName, Id, Path | ConvertTo-Json -Compress`;
  const out = await runCmd(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps]);
  if (out.exitCode !== 0 || !out.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(out.stdout.trim());
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return filterConflictProcesses(
      arr.map((p: any) => ({
        name: String(p?.ProcessName ?? '') +
          (String(p?.ProcessName ?? '').toLowerCase().endsWith('.exe') ? '' : '.exe'),
        pid: typeof p?.Id === 'number' ? p.Id : null,
      })),
    );
  } catch {
    return [];
  }
}

async function listUnix(): Promise<ConflictProcess[]> {
  // `ps` es universal (macOS y Linux); pgrep no siempre existe.
  const out = await runCmd(['ps', '-ax', '-o', 'comm=,pid=']);
  if (out.exitCode !== 0 || !out.stdout.trim()) return [];
  const found: ConflictProcess[] = [];
  for (const line of out.stdout.split('\n')) {
    const m = line.trim().match(/^(.*?)\s+(\d+)\s*$/);
    if (!m) continue;
    // `ps -o comm=,pid=`: en algunas variantes el orden puede invertirse;
    // aceptar ambos anclando el pid al grupo numérico.
    const a = m[1].trim();
    const b = m[2].trim();
    const nameFirst = isConflictProcessName(a);
    if (nameFirst) {
      found.push({ name: a, pid: Number(b) });
    } else if (isConflictProcessName(b)) {
      const pid = Number(a);
      found.push({ name: b, pid: Number.isFinite(pid) ? pid : null });
    }
  }
  return filterConflictProcesses(found);
}

/** Procesos de la app oficial en ejecución (allowlist estricta). */
export async function listConflictProcesses(): Promise<ConflictProcess[]> {
  try {
    if (process.platform === 'win32') return await listWindows();
    return await listUnix();
  } catch {
    return [];
  }
}

/** Caché: la UI sondea el status y cada sondeo costaría un powershell nuevo
 *  en Windows (~0.5-2 s por arranque, bloquea percepción de todo el panel
 *  por el límite de 6 conexiones). TTL 30 s + deduplicación in-flight.
 *  Además el endpoint omite el scan por completo cuando ya estamos
 *  conectados (si tenemos el HID abierto, la app oficial no lo tiene). */
let cache: { ts: number; data: ConflictProcess[] } | null = null;
let inFlight: Promise<ConflictProcess[]> | null = null;
const CACHE_TTL_MS = 30_000;

export function clearConflictCache(): void {
  cache = null;
}

export async function getConflictProcessesCached(): Promise<ConflictProcess[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data;
  if (inFlight) {
    try {
      return await inFlight;
    } catch {
      // cae a la recolección de abajo
    }
  }
  const p = listConflictProcesses();
  inFlight = p;
  try {
    const data = await p;
    cache = { ts: Date.now(), data };
    return data;
  } finally {
    if (inFlight === p) inFlight = null;
  }
}

/**
 * Cierra la app oficial (solo nombres de la allowlist, nunca PIDs
 * arbitrarios). Devuelve lo cerrado y lo que sigue en ejecución.
 */
export async function closeConflictProcesses(): Promise<{
  closed: ConflictProcess[];
  remaining: ConflictProcess[];
}> {
  const before = await listConflictProcesses();
  if (before.length === 0) return { closed: [], remaining: [] };

  const wanted = wantedForThisPlatform();
  try {
    if (process.platform === 'win32') {
      // taskkill por nombre de imagen (solo allowlist).
      for (const name of wanted) {
        const exe = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`;
        await runCmd(['taskkill.exe', '/F', '/IM', exe]);
      }
    } else if (process.platform === 'darwin') {
      for (const name of wanted) {
        await runCmd(['/usr/bin/killall', name]);
      }
    } else {
      for (const name of wanted) {
        await runCmd(['pkill', '-x', name]);
      }
    }
  } catch {
    // best-effort: lo que quede se reporta como remaining
  }

  // Sin caché: comprobar el estado real tras el cierre.
  clearConflictCache();
  // Pequeña espera: el proceso tarda ~1 s en morir.
  await new Promise((r) => setTimeout(r, 1200));
  const after = await listConflictProcesses();
  cache = { ts: Date.now(), data: after };
  const afterKeys = new Set(after.map((p) => `${p.name.toLowerCase()}#${p.pid}`));
  const closed = before.filter((p) => !afterKeys.has(`${p.name.toLowerCase()}#${p.pid}`));
  return { closed, remaining: after };
}

/** Para tests: parsear la salida de `ps` sin spawnear nada. */
export function parsePsOutput(stdout: string): ConflictProcess[] {
  const found: ConflictProcess[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(.*?)\s+(\d+)\s*$/);
    if (!m) continue;
    const a = m[1].trim();
    const b = m[2].trim();
    if (isConflictProcessName(a)) found.push({ name: a, pid: Number(b) });
    else if (isConflictProcessName(b)) {
      const pid = Number(a);
      found.push({ name: b, pid: Number.isFinite(pid) ? pid : null });
    }
  }
  return filterConflictProcesses(found);
}

export { parseNamesFromLines };

/** Motivo del conflicto para el endpoint de status (puro, testeable). */
export type ConflictReason = 'none' | 'process' | 'hid-busy' | 'both';
export function conflictReason(detected: boolean, hidBusyHint: boolean): ConflictReason {
  if (detected) return hidBusyHint ? 'both' : 'process';
  return hidBusyHint ? 'hid-busy' : 'none';
}
