#!/usr/bin/env node
/**
 * gen-update-keys.mjs — genera el par ed25519 para firmar bundles.
 *
 * Uso: node scripts/gen-update-keys.mjs
 *   - Escribe la pública en launcher/UPDATE_PUBKEY (se commitea).
 *   - Imprime la semilla privada UNA VEZ: guárdala como secret de CI
 *     `LIBREDECK_UPDATE_PRIVKEY` (hex 64 chars). No la commitees.
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privJwk = privateKey.export({ format: 'jwk' });
const pubJwk = publicKey.export({ format: 'jwk' });
const seedHex = Buffer.from(privJwk.d, 'base64url').toString('hex');
const pubHex = Buffer.from(pubJwk.x, 'base64url').toString('hex');

writeFileSync(new URL('../launcher/UPDATE_PUBKEY', import.meta.url), pubHex + '\n');
console.log('Pública (commiteada en launcher/UPDATE_PUBKEY):');
console.log(pubHex);
console.log('');
console.log('PRIVADA — guarda como secret LIBREDECK_UPDATE_PRIVKEY (no commitear):');
console.log(seedHex);
