/**
 * process.ts — Gestión del proceso del daemon (spawn, pidfile, kill).
 *
 * El CLI es cliente HTTP del daemon + herramienta de gestión de su proceso:
 * este módulo concentra todo lo que toca el SO (ficheros, PIDs, spawns) para
 * que cli.ts solo defina comandos.
 */

import { spawn as bunSpawn, type SpawnOptions } from 'bun';
import { spawn as nodeSpawn } from 'node:child_process';
import { readdirSync, existsSync, unlinkSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { pickLatestDaemonExe, pidFilePath, daemonLogPath } from './cli-utils';
import type { LogFn } from './client';

const noop: LogFn = () => {};

/** Ejecuta un comando heredando stdio y devuelve su exit code. */
export async function runCommand(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): Promise<number> {
  const proc = bunSpawn({
    cmd: [command, ...args],
    stdio: ['inherit', 'inherit', 'inherit'],
    ...options,
  });
  await proc.exited;
  return proc.exitCode || 0;
}

/**
 * Localiza el exe del daemon con la versión más alta junto al CLI compilado.
 * `searchDir` solo existe para testear (por defecto: dirname(process.execPath)).
 */
export async function getLatestDaemonExe(searchDir?: string): Promise<string | null> {
  const path = await import('path');
  const dir = searchDir ?? path.dirname(process.execPath);
  try {
    const files = readdirSync(dir);
    const selected = pickLatestDaemonExe(files);
    if (!selected) return null;
    return path.join(dir, selected);
  } catch {
    return null;
  }
}

export async function readPidFile(pidFile: string): Promise<number | null> {
  try {
    const raw = (await Bun.file(pidFile).text()).trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

export async function removePidFile(pidFile: string): Promise<void> {
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile);
  } catch {
    // best effort
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Mata por PID de forma dirigida (sin /IM a ciegas en Windows). */
export async function killByPid(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      // Primero intento graceful, luego forzado solo sobre ese PID.
      let code = await runCommand('taskkill', ['/PID', String(pid)]);
      if (code !== 0 || isPidAlive(pid)) {
        await new Promise((r) => setTimeout(r, 1000));
        if (isPidAlive(pid)) {
          code = await runCommand('taskkill', ['/F', '/PID', String(pid)]);
        }
      }
      await new Promise((r) => setTimeout(r, 500));
      return !isPidAlive(pid);
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
    return !isPidAlive(pid);
  } catch {
    return false;
  }
}

export interface DetachedResult {
  pid: number | undefined;
  logPath: string;
  pidFile: string;
}

/**
 * Arranca el daemon desacoplado (detached multiplataforma, sin `cmd /c start /B`
 * huérfano): stdio a data/logs/daemon.log + pidfile en data/daemon.pid.
 */
export async function spawnDetached(
  daemonExe: string,
  env: NodeJS.ProcessEnv,
  dataDir: string,
  opts?: { log?: LogFn },
): Promise<DetachedResult> {
  const log = opts?.log ?? noop;
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  const logPath = daemonLogPath(dataDir);
  const pidFile = pidFilePath(dataDir);
  const logFd = openSync(logPath, 'a');

  const child = nodeSpawn(daemonExe, [], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
    cwd: process.cwd(),
    windowsHide: true,
  });
  child.unref();
  // El hijo hereda su propio fd; cerramos el nuestro.
  try {
    closeSync(logFd);
  } catch {
    /* noop */
  }

  if (child.pid) {
    await Bun.write(pidFile, String(child.pid));
    log(`PID ${child.pid} escrito en ${pidFile}, logs en ${logPath}`);
  }
  return { pid: child.pid, logPath, pidFile };
}

/**
 * Arranca el daemon en primer plano: proceso atado a la terminal, stdio
 * heredado, Ctrl+C limpio. Resuelve con el exit code del daemon.
 */
export async function runForeground(
  daemonExe: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const proc = bunSpawn({
    cmd: [daemonExe],
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: process.cwd(),
  });
  const onSigint = () => {
    try {
      proc.kill();
    } catch {
      /* noop */
    }
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
  await proc.exited;
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigint);
  return proc.exitCode ?? 0;
}
