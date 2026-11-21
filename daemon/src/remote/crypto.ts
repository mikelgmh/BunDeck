/**
 * Crypto E2E del relay (NaCl `box`: X25519 + XSalsa20-Poly1305 vía `tweetnacl`).
 *
 * Por qué `tweetnacl` y no `@noble/curves`:
 * - API estable y auditada, sin dependencias, síncrona y sin builders
 *   nativos (funciona igual en `bun build --compile`, Electrobun y tests).
 * - `@noble/*` es más moderna y modular, pero su API ha tenido churn
 *   (v1 vs v2) y el ECIES habría que montarlo a mano; `nacl.box` ya es
 *   el E2E completo (autenticado + cifrado) en una llamada.
 *
 * SEGURIDAD — lee esto antes de tocar este fichero:
 * - TLS != E2E: el relay ve los metadatos (quién habla con quién, cuándo,
 *   tamaño) pero NUNCA el contenido: el plaintext solo existe en los dos
 *   extremos. El relay no tiene ninguna clave privada.
 * - La clave privada (`remote.device.priv`) NUNCA sale del equipo: no se
 *   envía al relay, no se expone por REST ni por WS, no se mete en logs.
 * - Replay-protection triple: (1) nonce de 24B visto → rechazar,
 *   (2) `exp` de 5 min sobre `ts`, (3) contador monotónico `seq` por peer
 *   (en memoria + persistido en settings para sobrevivir reinicios).
 */
import nacl from 'tweetnacl';

const NONCE_BYTES = 24;
const ENVELOPE_TTL_MS = 5 * 60 * 1000;

export interface E2EEnvelope {
  /** deviceId emisor (para seq/replay por peer). */
  from: string;
  /** deviceId destino. */
  to: string;
  /** b64: clave pública efímera... no — usamos claves estáticas de identidad. */
  nonce: string; // b64 24B
  ciphertext: string; // b64
  /** ms epoch del cifrado. */
  ts: number;
  /** Contador monotónico del emisor (anti-replay + anti-reorden). */
  seq: number;
  /** Versión del formato. */
  v: 1;
}

export interface PlainCommand {
  type: string;
  params?: Record<string, any>;
  ts?: number;
}

// --- key utils ---

export function generateKeyPair(): { publicKeyB64: string; secretKeyB64: string } {
  const kp = nacl.box.keyPair();
  return {
    publicKeyB64: Buffer.from(kp.publicKey).toString('base64'),
    secretKeyB64: Buffer.from(kp.secretKey).toString('base64'),
  };
}

export function fingerprint(pubKeyB64: string): string {
  const raw = Buffer.from(pubKeyB64, 'base64');
  // SHA-256 hex recortado en grupos legibles: `ab12:34cd:…` (8 grupos).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto');
  const hex = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return (hex.match(/.{1,4}/g) ?? []).join(':');
}

function b64ToU8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
function u8ToB64(u8: Uint8Array): string {
  return Buffer.from(u8).toString('base64');
}

// --- replay store (inyectable para tests; por defecto en memoria) ---

export interface ReplayStore {
  getSeq(peerId: string): number;
  setSeq(peerId: string, seq: number): void;
  hasNonce(nonceB64: string): boolean;
  addNonce(nonceB64: string): void;
}

const memSeq = new Map<string, number>();
const memNonces = new Set<string>();
let store: ReplayStore = {
  getSeq: (p) => memSeq.get(p) ?? -1,
  setSeq: (p, s) => { memSeq.set(p, s); },
  hasNonce: (n) => memNonces.has(n),
  addNonce: (n) => { memNonces.add(n); },
};

/** El daemon inyecta aquí la persistencia en settings (`remote.seq.<peer>`). */
export function configureReplayStore(s: ReplayStore): void {
  store = s;
}

/** Solo tests: limpia nonces/seq en memoria. */
export function resetReplay(): void {
  memSeq.clear();
  memNonces.clear();
}

// --- seq local (emisor) ---

let localSeq = -1;
export function resetLocalSeq(): void {
  localSeq = -1;
}
function nextSeq(persist?: (seq: number) => void): number {
  localSeq += 1;
  persist?.(localSeq);
  return localSeq;
}

// --- box ---

export function encryptTo(
  recipientPubKeyB64: string,
  senderSecretB64: string,
  senderDeviceId: string,
  recipientDeviceId: string,
  cmd: PlainCommand,
  opts?: { seq?: number; onSeq?: (seq: number) => void; ts?: number },
): E2EEnvelope {
  const nonce = nacl.randomBytes(NONCE_BYTES);
  const msg = Buffer.from(JSON.stringify({ ...cmd, ts: cmd.ts ?? opts?.ts ?? Date.now() }));
  const box = nacl.box(msg, nonce, b64ToU8(recipientPubKeyB64), b64ToU8(senderSecretB64));
  if (!box) throw new Error('E2E encrypt failed');
  const seq = opts?.seq ?? nextSeq(opts?.onSeq);
  return {
    from: senderDeviceId,
    to: recipientDeviceId,
    nonce: u8ToB64(nonce),
    ciphertext: u8ToB64(box),
    ts: cmd.ts ?? opts?.ts ?? Date.now(),
    seq,
    v: 1,
  };
}

export function decryptFrom(
  senderPubKeyB64: string,
  recipientSecretB64: string,
  env: E2EEnvelope,
  opts?: { now?: number },
): PlainCommand {
  const now = opts?.now ?? Date.now();
  if (!env || env.v !== 1 || !env.nonce || !env.ciphertext || !env.from) {
    throw new Error('E2E envelope malformado');
  }
  // 1) expiración (5 min de deriva permitida)
  if (!Number.isFinite(env.ts) || Math.abs(now - env.ts) > ENVELOPE_TTL_MS) {
    throw new Error('E2E envelope expirado (exp 5min)');
  }
  // 2) nonce visto → replay
  if (store.hasNonce(env.nonce)) throw new Error('E2E replay: nonce ya visto');
  // 3) contador monotónico por peer
  const last = store.getSeq(env.from);
  if (!Number.isFinite(env.seq) || env.seq <= last) {
    throw new Error(`E2E replay: seq ${env.seq} <= último ${last} de ${env.from}`);
  }
  const open = nacl.box.open(b64ToU8(env.ciphertext), b64ToU8(env.nonce), b64ToU8(senderPubKeyB64), b64ToU8(recipientSecretB64));
  if (!open) throw new Error('E2E open failed (clave o contenido inválido)');
  let cmd: PlainCommand;
  try {
    cmd = JSON.parse(Buffer.from(open).toString('utf8'));
  } catch {
    throw new Error('E2E plaintext no es JSON');
  }
  // Marca como consumido SOLO si todo abrió bien.
  store.addNonce(env.nonce);
  store.setSeq(env.from, env.seq);
  return cmd;
}
