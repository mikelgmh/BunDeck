import { describe, expect, test } from 'bun:test';
import {
  decodeOpaque,
  encodeOpaque,
  generateIdentity,
  openEnvelope,
  openFromOpaque,
  publicKeyFromSecret,
  seal,
  sealToOpaque,
} from '../src/crypto';

describe('crypto E2E (tweetnacl box = X25519 + XSalsa20-Poly1305)', () => {
  test('A cifra -> B descifra (roundtrip)', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const env = seal('hola mundo', b.publicKey, a.secretKey);
    const pt = openEnvelope(env, b.secretKey, a.publicKey);
    expect(pt).not.toBeNull();
    expect(Buffer.from(pt!).toString('utf8')).toBe('hola mundo');
  });

  test('el receptor puede usar env.from como clave del emisor', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const opaque = sealToOpaque('comando:press:3', b.publicKey, a.secretKey);
    const pt = openFromOpaque(opaque, b.secretKey); // sin pasar pubkey de A
    expect(Buffer.from(pt!).toString('utf8')).toBe('comando:press:3');
  });

  test('el relay NO puede descifrar: con otra clave falla y el opaco no contiene el plaintext', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const attacker = generateIdentity();
    const secret = 'TOKEN_SUPER_SECRETO_123';
    const opaque = sealToOpaque(secret, b.publicKey, a.secretKey);

    // El atacante (o el relay) no abre el sobre con su propia clave.
    expect(openFromOpaque(opaque, attacker.secretKey, a.publicKey)).toBeNull();
    // Ni aunque conozca la pubkey del emisor pero no la secreta del receptor.
    expect(openFromOpaque(opaque, attacker.secretKey)).toBeNull();

    // El sobre opaco no filtra el plaintext en claro.
    const raw = Buffer.from(opaque, 'base64').toString('utf8');
    expect(raw).not.toContain(secret);
    // Pero el receptor legítimo sí abre.
    expect(Buffer.from(openFromOpaque(opaque, b.secretKey)!).toString('utf8')).toBe(secret);
  });

  test('nonce aleatorio por mensaje (mismo plaintext -> distinto box)', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const e1 = seal('x', b.publicKey, a.secretKey);
    const e2 = seal('x', b.publicKey, a.secretKey);
    expect(e1.nonce).not.toBe(e2.nonce);
    expect(e1.box).not.toBe(e2.box);
  });

  test('ciphertext manipulado no valida (MAC)', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const env = seal('datos', b.publicKey, a.secretKey);
    const tampered = { ...env, box: encodeOpaque(decodeOpaque(encodeOpaque(env))).slice(0, 0) || env.box };
    // Corrompe un byte del box.
    const bytes = Buffer.from(tampered.box, 'base64');
    bytes[0] ^= 0xff;
    tampered.box = bytes.toString('base64');
    expect(openEnvelope(tampered, b.secretKey, a.publicKey)).toBeNull();
  });

  test('publicKeyFromSecret deriva la pública publicada en register', () => {
    const id = generateIdentity();
    expect(publicKeyFromSecret(id.secretKey)).toBe(id.publicKey);
  });
});
