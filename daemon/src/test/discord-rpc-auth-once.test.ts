/**
 * discord-rpc-auth-once.test.ts — AUTHENTICATE idempotente.
 *
 * Sin red ni Discord real: WS mockeado vía `connectFn`. Cubre la regresión
 * del "Already authenticated": reutilizar la conexión NO debe re-autenticar
 * con el mismo token (Discord rechaza el 2º AUTHENTICATE y la acción caía
 * al fallback de hotkey en silencio).
 */
import { describe, expect, test } from 'bun:test';
import { DiscordRpcConnection, type MinimalRpcSocket } from '../plugins/discord-rpc';

const READY = JSON.stringify({ cmd: 'DISPATCH', evt: 'READY', data: { v: 1 }, nonce: null });

function okFrame(nonce: string | null) {
    return JSON.stringify({ cmd: 'AUTHENTICATE', data: { application: { id: 'x' } }, nonce });
}

function makeSocket(sent: string[]): MinimalRpcSocket {
    const sock: MinimalRpcSocket = {
        send(data: string) {
            sent.push(data);
            let parsed: any = null;
            try { parsed = JSON.parse(data); } catch { /* noop */ }
            queueMicrotask(() => {
                if (parsed && parsed.cmd === 'AUTHENTICATE') {
                    sock.onmessage?.({ data: okFrame(parsed.nonce ?? null) });
                } else {
                    sock.onmessage?.({ data: READY });
                }
            });
        },
        close() {},
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
    };
    return sock;
}

async function connected(sent: string[]): Promise<DiscordRpcConnection> {
    const conn = new DiscordRpcConnection({
        clientId: '123',
        timeoutMs: 2000,
        pipeConnectFn: async () => { throw new Error('sin pipe en test'); },
        connectFn: async () => makeSocket(sent),
    });
    await conn.connect();
    return conn;
}

describe('discord-rpc: AUTHENTICATE idempotente', () => {
    test('re-autenticar con el mismo token no reenvía AUTHENTICATE', async () => {
        const sent: string[] = [];
        const conn = await connected(sent);
        const countAuth = () => sent.filter((s) => { try { return JSON.parse(s).cmd === 'AUTHENTICATE'; } catch { return false; } }).length;

        const r1: any = await conn.authenticate('tok-1');
        expect(countAuth()).toBe(1);
        expect(r1.application.id).toBe('x');

        const r2: any = await conn.authenticate('tok-1');
        expect(r2.alreadyAuthenticated).toBe(true);
        expect(countAuth()).toBe(1);
    });

    test('token distinto sí re-autentica, y tras disconnect también', async () => {
        const sent: string[] = [];
        const conn = await connected(sent);
        const countAuth = () => sent.filter((s) => { try { return JSON.parse(s).cmd === 'AUTHENTICATE'; } catch { return false; } }).length;

        await conn.authenticate('tok-1');
        expect(countAuth()).toBe(1);
        await conn.authenticate('tok-2');
        expect(countAuth()).toBe(2);

        await conn.disconnect();
        const conn2 = await connected(sent);
        await conn2.authenticate('tok-2');
        // Nueva conexión (authedToken reseteado): vuelve a autenticar.
        expect(countAuth()).toBe(3);
        await conn.disconnect().catch(() => {});
        await conn2.disconnect().catch(() => {});
    });
});
