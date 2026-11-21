import { describe, expect, test } from 'bun:test';
import {
  buildApiBase,
  buildWsUrl,
  compareDaemonVersions,
  extractDaemonVersion,
  normalizePort,
  parseHealth,
  pickLatestDaemonExe,
  pidFilePath,
  daemonLogPath,
  resolveDataDir,
  sortDaemonExes,
  DEFAULT_API_PORT,
  DEFAULT_WS_PORT,
} from './cli-utils';

describe('normalizePort', () => {
  test('acepta puertos válidos como string o number', () => {
    expect(normalizePort('3001', 3001)).toBe(3001);
    expect(normalizePort(3003, 3001)).toBe(3003);
  });
  test('aplica fallback con valores inválidos', () => {
    expect(normalizePort('abc', 3001)).toBe(3001);
    expect(normalizePort(-1, 3001)).toBe(3001);
    expect(normalizePort(0, 3001)).toBe(3001);
    expect(normalizePort(undefined, 3003)).toBe(3003);
    expect(normalizePort(NaN, 3003)).toBe(3003);
  });
});

describe('URL builders', () => {
  test('buildApiBase respeta el puerto configurado', () => {
    expect(buildApiBase(4000)).toBe('http://localhost:4000');
    expect(buildApiBase('5000')).toBe('http://localhost:5000');
    expect(buildApiBase(undefined)).toBe(`http://localhost:${DEFAULT_API_PORT}`);
  });
  test('buildWsUrl usa 3003 por defecto', () => {
    expect(DEFAULT_WS_PORT).toBe(3003);
    expect(buildWsUrl(undefined)).toBe('ws://localhost:3003');
    expect(buildWsUrl(3003)).toBe('ws://localhost:3003');
    expect(buildWsUrl(4000)).toBe('ws://localhost:4000');
  });
});

describe('parseHealth', () => {
  test('parsea el /health real (websocket como número)', () => {
    const parsed = parseHealth({
      status: 'ok',
      timestamp: 1234567890,
      version: '0.1.0',
      websocket: 3003,
    });
    expect(parsed.online).toBe(true);
    expect(parsed.wsPort).toBe(3003);
    expect(parsed.wsClients).toBeUndefined();
    expect(parsed.timestamp).toBe(1234567890);
    expect(parsed.version).toBe('0.1.0');
  });
  test('tolera websocket como objeto legacy { port, clients }', () => {
    const parsed = parseHealth({
      status: 'ok',
      timestamp: 1,
      websocket: { port: 3003, clients: 2 },
    });
    expect(parsed.wsPort).toBe(3003);
    expect(parsed.wsClients).toBe(2);
  });
  test('marca offline con payloads no objeto', () => {
    expect(parseHealth(null).online).toBe(false);
    expect(parseHealth(undefined).online).toBe(false);
    expect(parseHealth('ok').online).toBe(false);
  });
});

describe('daemon exe version sorting', () => {
  test('extractDaemonVersion distingue versionados de genéricos', () => {
    expect(extractDaemonVersion('libredeck-daemon-v1.3.0-windows-x64.exe')).toEqual({
      file: 'libredeck-daemon-v1.3.0-windows-x64.exe',
      version: '1.3.0',
      hasVersion: true,
    });
    expect(extractDaemonVersion('libredeck-daemon.exe')).toMatchObject({
      version: '0.0.0',
      hasVersion: false,
    });
  });
  test('ordena semver descendente, versionados primero', () => {
    const sorted = sortDaemonExes([
      'libredeck-daemon.exe',
      'libredeck-daemon-v1.2.0-windows-x64.exe',
      'libredeck-daemon-v1.10.0-windows-x64.exe',
      'libredeck-daemon-v1.3.0-windows-x64.exe',
      'libredeck-daemon-v1.3.0-windows-x64-backup.exe',
      'README.md',
    ]);
    expect(sorted).toEqual([
      'libredeck-daemon-v1.10.0-windows-x64.exe',
      'libredeck-daemon-v1.3.0-windows-x64.exe',
      'libredeck-daemon-v1.2.0-windows-x64.exe',
      'libredeck-daemon.exe',
    ]);
  });
  test('pickLatestDaemonExe devuelve null sin candidatos', () => {
    expect(pickLatestDaemonExe(['README.md', 'other.exe'])).toBeNull();
    expect(pickLatestDaemonExe([])).toBeNull();
  });
  test('compareDaemonVersions es estable ante patch/minor/major', () => {
    expect(
      compareDaemonVersions(
        extractDaemonVersion('libredeck-daemon-v2.0.0-windows-x64.exe'),
        extractDaemonVersion('libredeck-daemon-v1.99.99-windows-x64.exe'),
      ),
    ).toBe(-1);
  });
});

describe('data dir / pidfile', () => {
  test('respeta LIBREDECK_DATA_DIR', () => {
    const dir = resolveDataDir({
      execPath: '/usr/bin/bun',
      cwd: '/repo/cli',
      env: { LIBREDECK_DATA_DIR: '/custom/data' },
    });
    expect(dir).toBe('/custom/data');
  });
  test('en dev desde cli/ resuelve ../data', () => {
    const dir = resolveDataDir({
      execPath: '/usr/bin/bun',
      cwd: '/repo/cli',
      env: {},
    });
    expect(dir.endsWith('data')).toBe(true);
    expect(dir).toContain('repo');
  });
  test('pidfile y log cuelgan del data dir', () => {
    expect(pidFilePath('/x/data')).toContain('daemon.pid');
    expect(daemonLogPath('/x/data')).toContain('daemon.log');
  });
});
