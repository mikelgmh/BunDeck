import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import {
  getLatestDaemonExe,
  isPidAlive,
  readPidFile,
  removePidFile,
} from './process';

describe('isPidAlive', () => {
  test('el proceso actual está vivo', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
  test('un PID imposible no está vivo', () => {
    expect(isPidAlive(2147483647)).toBe(false);
  });
});

describe('pidfile', () => {
  test('read/remove roundtrip', async () => {
    const dir = join(tmpdir(), `sdctl-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const pidFile = join(dir, 'daemon.pid');
      await Bun.write(pidFile, String(process.pid));
      expect(await readPidFile(pidFile)).toBe(process.pid);
      await Bun.write(pidFile, 'no-un-numero');
      expect(await readPidFile(pidFile)).toBeNull();
      await removePidFile(pidFile);
      expect(await readPidFile(pidFile)).toBeNull();
      // remove idempotente
      await removePidFile(pidFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('getLatestDaemonExe', () => {
  test('elige la versión más alta en un dir dado', async () => {
    const dir = join(tmpdir(), `sdctl-exe-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      for (const f of [
        'bundeck-daemon.exe',
        'bundeck-daemon-v1.2.0-windows-x64.exe',
        'bundeck-daemon-v1.10.0-windows-x64.exe',
        'README.md',
      ]) {
        writeFileSync(join(dir, f), 'x');
      }
      const exe = await getLatestDaemonExe(dir);
      expect(exe?.endsWith('bundeck-daemon-v1.10.0-windows-x64.exe')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('null sin candidatos o dir inexistente', async () => {
    const dir = join(tmpdir(), `sdctl-empty-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      expect(await getLatestDaemonExe(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await getLatestDaemonExe(join(tmpdir(), 'sdctl-noexiste-xyz'))).toBeNull();
  });
});
