/**
 * discord-rpc-pipe.test.ts — pipe IPC como transporte primario.
 *
 * Sin red ni Discord real: sockets pipe/WS mockeados vía `pipeConnectFn` y
 * `connectFn` inyectados. Cubre framing partido en chunks + READY, orden
 * pipe-antes-que-ws y handshake plano (opcode 0 + JSON sin `d`).
 */
import { describe, it, expect } from 'bun:test'
import {
    DISCORD_IPC_IDS,
    DiscordRpcConnection,
    DiscordRpcError,
    RPC_OP_FRAME,
    RPC_OP_HANDSHAKE,
    buildRpcHandshake,
    discordIpcPipePath,
    encodeRpcPipeFrame,
    inferRpcPipeOpcode,
    RpcPipeFrameDecoder,
    type MinimalRpcSocket,
} from '../plugins/discord-rpc'

const READY_JSON = JSON.stringify({
    cmd: 'DISPATCH',
    evt: 'READY',
    data: { v: 1, user: { id: 'u1', username: 'tester' } },
    nonce: null,
})

function makePipeSocket(sent: string[], feedReadySplitAt: number): MinimalRpcSocket {
    const sock: MinimalRpcSocket = {
        send(data: string) {
            sent.push(data)
            // Simula al Discord real: responde READY en UN frame opcode 1
            // partido en 2 chunks (medio frame / frame completo).
            const frame = encodeRpcPipeFrame(RPC_OP_FRAME, READY_JSON)
            const at = Math.max(1, Math.min(feedReadySplitAt, frame.length - 1))
            const c1 = frame.slice(0, at)
            const c2 = frame.slice(at)
            const decoder = new RpcPipeFrameDecoder()
            queueMicrotask(() => {
                for (const f of decoder.push(c1)) sock.onmessage?.({ data: f.json })
                for (const f of decoder.push(c2)) sock.onmessage?.({ data: f.json })
            })
        },
        close() {},
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
    }
    return sock
}

function makeWsReadySocket(sent: string[]): MinimalRpcSocket {
    const sock: MinimalRpcSocket = {
        send(data: string) {
            sent.push(data)
            queueMicrotask(() => sock.onmessage?.({ data: READY_JSON }))
        },
        close() {},
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
    }
    return sock
}

describe('discord-rpc pipe: rutas IPC', () => {
    it('expone 10 índices y rutas con discord-ipc-{n}', () => {
        expect([...DISCORD_IPC_IDS]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        expect(discordIpcPipePath(0)).toContain('discord-ipc-0')
        expect(discordIpcPipePath(9)).toContain('discord-ipc-9')
    })
})

describe('discord-rpc pipe: framing', () => {
    it('encode = [opcode u32LE][len u32LE][JSON] y el decoder reensambla splits + coalesced', () => {
        const payload = { v: 1, client_id: 'abc' }
        const bytes = encodeRpcPipeFrame(RPC_OP_HANDSHAKE, payload)
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        expect(view.getUint32(0, true)).toBe(0)
        expect(view.getUint32(4, true)).toBeGreaterThan(0)
        expect(Buffer.from(bytes.slice(8)).toString('utf8')).toBe(JSON.stringify(payload))

        const f1 = encodeRpcPipeFrame(RPC_OP_FRAME, { cmd: 'A' })
        const f2 = encodeRpcPipeFrame(RPC_OP_FRAME, { cmd: 'B' })
        const joined = new Uint8Array(f1.length + f2.length)
        joined.set(f1, 0)
        joined.set(f2, f1.length)
        // 3 chunks irregulares: medio frame / resto+medio / resto.
        const decoder = new RpcPipeFrameDecoder()
        const got: string[] = []
        for (const chunk of [joined.slice(0, 5), joined.slice(5, f1.length + 3), joined.slice(f1.length + 3)]) {
            for (const f of decoder.push(chunk)) got.push(f.json)
        }
        expect(got).toHaveLength(2)
        expect(JSON.parse(got[0])).toEqual({ cmd: 'A' })
        expect(JSON.parse(got[1])).toEqual({ cmd: 'B' })
    })

    it('inferRpcPipeOpcode: handshake plano → 0, comandos → 1', () => {
        expect(inferRpcPipeOpcode(JSON.stringify(buildRpcHandshake('abc')))).toBe(RPC_OP_HANDSHAKE)
        expect(inferRpcPipeOpcode(JSON.stringify({ cmd: 'AUTHENTICATE', args: {}, nonce: 'n' }))).toBe(RPC_OP_FRAME)
    })
})

describe('discord-rpc pipe: handshake plano', () => {
    it('primer send por pipe: JSON sin `d` ni `op`, opcode inferido 0', async () => {
        const sent: string[] = []
        const conn = new DiscordRpcConnection({
            clientId: 'abc',
            timeoutMs: 500,
            pipeConnectFn: async () => makePipeSocket(sent, 7),
            connectFn: async () => { throw new DiscordRpcError('discord-closed', 'ws no usado', { retryable: true }) },
        })
        const res = await conn.connect()
        expect(res.transport).toBe('pipe')
        expect(sent).toHaveLength(1)
        const first = JSON.parse(sent[0])
        expect(first).toEqual({ v: 1, client_id: 'abc' })
        expect('d' in first).toBe(false)
        expect('op' in first).toBe(false)
        // El frame que viajaría por el pipe lleva opcode 0 en el header.
        expect(inferRpcPipeOpcode(sent[0])).toBe(RPC_OP_HANDSHAKE)
        const bytes = encodeRpcPipeFrame(inferRpcPipeOpcode(sent[0]), sent[0])
        expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)).toBe(0)
        expect(conn.connectedTransport).toBe('pipe')
        expect(conn.connectedPipe).toContain('discord-ipc-0')
        expect(conn.connectedLabel).toContain('discord-ipc-0')
        await conn.disconnect()
    })
})

describe('discord-rpc pipe: framing partido en 2 chunks + READY', () => {
    it('un data con medio frame no resuelve antes de tiempo; el frame completo da READY', async () => {
        const sent: string[] = []
        const conn = new DiscordRpcConnection({
            clientId: 'abc',
            timeoutMs: 500,
            // Parte el frame READY casi por la mitad del header+body.
            pipeConnectFn: async () => makePipeSocket(sent, 6),
            connectFn: async () => { throw new DiscordRpcError('discord-closed', 'ws no usado', { retryable: true }) },
        })
        const res = await conn.connect()
        expect(res.transport).toBe('pipe')
        expect(conn.isReady).toBe(true)
        await conn.disconnect()
        expect(conn.isReady).toBe(false)
    })
})

describe('discord-rpc pipe: orden pipe-antes-que-ws', () => {
    it('prueba pipes 0..9 primero y usa el WS solo si ningún pipe responde', async () => {
        const order: string[] = []
        const wsSent: string[] = []
        const conn = new DiscordRpcConnection({
            clientId: 'abc',
            timeoutMs: 500,
            pipeConnectFn: async (i) => {
                order.push(`pipe-${i}`)
                throw new DiscordRpcError('discord-closed', `sin pipe ${i}`, { retryable: true })
            },
            connectFn: async (port) => {
                order.push(`ws-${port}`)
                return makeWsReadySocket(wsSent)
            },
        })
        const res = await conn.connect()
        expect(res.transport).toBe('ws')
        expect(res.port).toBe(6463)
        expect(order).toEqual([...DISCORD_IPC_IDS.map((i) => `pipe-${i}`), 'ws-6463'])
        // El handshake por WS también es plano.
        expect(JSON.parse(wsSent[0])).toEqual({ v: 1, client_id: 'abc' })
        expect(conn.connectedTransport).toBe('ws')
        expect(conn.connectedPort).toBe(6463)
        expect(conn.connectedPipe).toBeNull()
        await conn.disconnect()
    })

    it('si hay pipe y WS, gana el pipe (no toca el WS)', async () => {
        const wsCalls: number[] = []
        const sent: string[] = []
        const conn = new DiscordRpcConnection({
            clientId: 'abc',
            timeoutMs: 500,
            ipcIds: [2],
            pipeConnectFn: async () => makePipeSocket(sent, 10),
            connectFn: async (port) => {
                wsCalls.push(port)
                return makeWsReadySocket([])
            },
        })
        const res = await conn.connect()
        expect(res.transport).toBe('pipe')
        expect(res.pipe).toContain('discord-ipc-2')
        expect(wsCalls).toEqual([])
        await conn.disconnect()
    })

    it('sin pipe NI ws: mismo error accionable discord-closed', async () => {
        const conn = new DiscordRpcConnection({
            clientId: 'abc',
            timeoutMs: 200,
            ipcIds: [0, 1],
            ports: [6463],
            pipeConnectFn: async () => { throw new DiscordRpcError('discord-closed', 'sin pipe', { retryable: true }) },
            connectFn: async () => { throw new DiscordRpcError('discord-closed', 'sin ws', { retryable: true }) },
        })
        const err: unknown = await conn.connect().catch((e) => e)
        expect(err).toBeInstanceOf(DiscordRpcError)
        expect((err as DiscordRpcError).code).toBe('discord-closed')
        expect((err as DiscordRpcError).retryable).toBe(true)
    })
})
