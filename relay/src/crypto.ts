import nacl from 'tweetnacl';

/**
 * Cifrado E2E real: NaCl `box` = X25519 (ECDH) + XSalsa20-Poly1305.
 * NO es cripto propia: es la primitiva estándar de libsodium vía tweetnacl.
 *
 * Modelo: ECDH ESTÁTICO entre identidades de dispositivo.
 * - Cada dispositivo genera una identidad X25519 (generateIdentity) y
 *   publica su clave pública en `register { deviceId, pubKey }`.
 * - El emisor cifra con (su secreta + pública del receptor) y un nonce
 *   aleatorio de 24 B generado por mensaje.
 * - El receptor descifra con (su secreta + pública del emisor).
 *
 * Formato en el cable (`payloadEncrypted`, cadena opaca base64):
 *   base64( JSON({ nonce: b64(24B), box: b64(ciphertext), from: b64(pubkey emisor) }) )
 *
 * El relay solo reenvía esa cadena opaca por `to` (deviceId). Nunca la
 * descifra ni la necesita: no tiene ninguna clave privada.
 */

export interface Envelope {
  /** Nonce aleatorio de 24 bytes, base64. Uno por mensaje. */
  nonce: string;
  /** Ciphertext XSalsa20-Poly1305 (incluye MAC de 16 B), base64. */
  box: string;
  /** Clave pública X25519 del emisor (32 B), base64. El receptor la usa para el ECDH. */
  from: string;
}

export interface Identity {
  publicKey: string; // base64, 32 B — se publica en `register`
  secretKey: string; // base64, 32 B — NUNCA sale del dispositivo
}

const b64encode = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const b64decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

export function generateIdentity(): Identity {
  const kp = nacl.box.keyPair();
  return { publicKey: b64encode(kp.publicKey), secretKey: b64encode(kp.secretKey) };
}

export function publicKeyFromSecret(secretKeyB64: string): string {
  const kp = nacl.box.keyPair.fromSecretKey(b64decode(secretKeyB64));
  return b64encode(kp.publicKey);
}

/** Cifra `plaintext` para `receiverPublicKeyB64` usando `senderSecretKeyB64`. */
export function seal(
  plaintext: string | Uint8Array,
  receiverPublicKeyB64: string,
  senderSecretKeyB64: string,
): Envelope {
  const msg = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const nonce = nacl.randomBytes(nacl.box.nonceLength); // 24 B aleatorios
  const box = nacl.box(msg, nonce, b64decode(receiverPublicKeyB64), b64decode(senderSecretKeyB64));
  if (!box) throw new Error('seal failed');
  return {
    nonce: b64encode(nonce),
    box: b64encode(box),
    from: publicKeyFromSecret(senderSecretKeyB64),
  };
}

/** Descifra un envelope. Devuelve null si la clave es incorrecta o el MAC no valida. */
export function openEnvelope(
  env: Envelope,
  receiverSecretKeyB64: string,
  senderPublicKeyB64?: string,
): Uint8Array | null {
  const senderPub = senderPublicKeyB64 ?? env.from;
  if (!senderPub) return null;
  return nacl.box.open(
    b64decode(env.box),
    b64decode(env.nonce),
    b64decode(senderPub),
    b64decode(receiverSecretKeyB64),
  );
}

/** Envelope -> cadena opaca para `payloadEncrypted` (lo único que ve el relay). */
export function encodeOpaque(env: Envelope): string {
  return Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
}

/** Cadena opaca -> envelope. Lanza si el formato no es válido. */
export function decodeOpaque(opaque: string): Envelope {
  const env = JSON.parse(Buffer.from(opaque, 'base64').toString('utf8')) as Envelope;
  if (typeof env.nonce !== 'string' || typeof env.box !== 'string' || typeof env.from !== 'string') {
    throw new Error('invalid envelope');
  }
  return env;
}

/** Atajo: cifra y devuelve directamente la cadena opaca lista para `payloadEncrypted`. */
export function sealToOpaque(
  plaintext: string | Uint8Array,
  receiverPublicKeyB64: string,
  senderSecretKeyB64: string,
): string {
  return encodeOpaque(seal(plaintext, receiverPublicKeyB64, senderSecretKeyB64));
}

/** Atajo: abre una cadena opaca. Null si falla. */
export function openFromOpaque(
  opaque: string,
  receiverSecretKeyB64: string,
  senderPublicKeyB64?: string,
): Uint8Array | null {
  try {
    return openEnvelope(decodeOpaque(opaque), receiverSecretKeyB64, senderPublicKeyB64);
  } catch {
    return null;
  }
}
