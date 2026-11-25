import { describe, expect, test } from 'bun:test';
import {
  DiscordRpcConnection,
  DiscordRpcError,
  type MinimalRpcSocket,
} from '../plugins/discord-rpc';

function hangingSocket(): MinimalRpcSocket {
  return {
    send() {},
    close() {},
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
}

describe('DiscordRpcConnection waitReady (carrera disconnect/timeout)', () => {
  test('disconnect() antes del timeout rechaza con discord-closed, sin TypeError', async () => {
    const conn = new DiscordRpcConnection({
      clientId: '123',
      ports: [6463],
      timeoutMs: 60,
      connectFn: async () => hangingSocket(),
    });
    const p = conn.connect();
    await new Promise((r) => setTimeout(r, 10));
    await conn.disconnect();
    let err: unknown = null;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DiscordRpcError);
    expect((err as DiscordRpcError).code).toBe('discord-closed');
  });

  test('timeout sin READY rechaza con discord-closed (sin reventar)', async () => {
    const conn = new DiscordRpcConnection({
      clientId: '123',
      ports: [6463],
      timeoutMs: 40,
      connectFn: async () => hangingSocket(),
    });
    let err: unknown = null;
    try {
      await conn.connect();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DiscordRpcError);
    expect((err as DiscordRpcError).code).toBe('discord-closed');
  });
});
