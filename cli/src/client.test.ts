import { describe, expect, test } from 'bun:test';
import {
  API_PREFIX,
  ENDPOINTS,
  discoverWsPort,
  resolveApiBase,
  resolveWsUrl,
  selectPluginInstall,
} from './client';
import { DEFAULT_WS_PORT } from './cli-utils';

describe('ENDPOINTS', () => {
  test('toda la API usa el prefijo /api/v1 (server.ts solo enruta /api/*)', () => {
    expect(API_PREFIX).toBe('/api/v1');
    for (const [name, path] of Object.entries(ENDPOINTS)) {
      if (name === 'health' || name === 'config') continue; // servidos directos por server.ts
      expect(path.startsWith('/api/v1')).toBe(true);
    }
  });
  test('contratos contra daemon/src/api/routes.ts', () => {
    expect(ENDPOINTS.plugins).toBe('/api/v1/plugins');
    expect(ENDPOINTS.pluginInstall).toBe('/api/v1/plugins/install');
    expect(ENDPOINTS.pluginUpload).toBe('/api/v1/plugins/upload');
    expect(ENDPOINTS.profiles).toBe('/api/v1/profiles');
    expect(ENDPOINTS.pages).toBe('/api/v1/pages');
    expect(ENDPOINTS.buttons).toBe('/api/v1/buttons');
    expect(ENDPOINTS.logs).toBe('/api/v1/logs');
    expect(ENDPOINTS.shutdown).toBe('/api/v1/admin/shutdown');
    expect(ENDPOINTS.health).toBe('/health');
    expect(ENDPOINTS.config).toBe('/config');
  });
});

describe('resolveApiBase / resolveWsUrl', () => {
  test('construyen base http/ws con los puertos del daemon', () => {
    expect(resolveApiBase(4000)).toBe('http://localhost:4000');
    expect(resolveWsUrl(4000)).toBe('ws://localhost:4000');
    expect(resolveWsUrl(undefined)).toBe(`ws://localhost:${DEFAULT_WS_PORT}`);
  });
});

describe('selectPluginInstall', () => {
  test('URL a .zip -> install marketplace', () => {
    expect(selectPluginInstall('https://example.com/p.zip')).toEqual({
      kind: 'zip-url',
      url: 'https://example.com/p.zip',
      sourceType: 'marketplace',
    });
  });
  test('URL git -> install git', () => {
    expect(selectPluginInstall('https://github.com/org/plugin.git')).toMatchObject({
      kind: 'git-url',
      sourceType: 'git',
    });
  });
  test('fichero local .zip/.plectro -> upload', () => {
    expect(selectPluginInstall('./mi-plugin.zip')).toEqual({ kind: 'zip-file', path: './mi-plugin.zip' });
    expect(selectPluginInstall('C:/tmp/p.plectro')).toMatchObject({ kind: 'zip-file' });
  });
  test('carpeta local -> install directory', () => {
    expect(selectPluginInstall('./mi-plugin/')).toMatchObject({ kind: 'dir' });
  });
});

describe('discoverWsPort', () => {
  test('si el daemon no responde, devuelve el fallback', async () => {
    // Puerto 1: conexión rechazada al instante -> fallback sin red real.
    const port = await discoverWsPort('http://localhost:1', 3999);
    expect(port).toBe(3999);
  });
  test('fallback por defecto es el WS del daemon (3003)', async () => {
    const port = await discoverWsPort('http://localhost:1', undefined);
    expect(port).toBe(DEFAULT_WS_PORT);
  });
});
