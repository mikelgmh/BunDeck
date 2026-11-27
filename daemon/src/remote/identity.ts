/**
 * Identidad del equipo para el relay E2E.
 *
 * - `remote.device.id`: uuid persistido (estable entre reinicios).
 * - `remote.device.pub`: X25519 pública (se comparte con el relay y los
 *   peers para cifrar hacia nosotros).
 * - `remote.device.priv`: X25519 privada en b64.
 *
 * SEGURIDAD: la privada NUNCA sale del equipo. No hay ningún endpoint que
 * la devuelva, no se envía al relay, no se loguea. `rotateKeys()` genera
 * un par nuevo y deja los contadores de replay a cero para los peers
 * (sus `seq` antiguos ya no valen: deben re-emparejar si hace falta).
 */
import { v4 as uuidv4 } from 'uuid';
import nacl from 'tweetnacl';
import { DatabaseService } from '../db';
import { generateKeyPair, fingerprint, resetLocalSeq } from './crypto';

const K_ID = 'remote.device.id';
const K_PUB = 'remote.device.pub';
const K_PRIV = 'remote.device.priv';

/**
 * Claves de firma ed25519 DEDICADAS a la auth del relay (NO reutilizar las
 * X25519 de E2E: `crypto.ts`/`nacl.box` no puede firmar).
 *
 * - `remote.relay.signPub`: pública ed25519 (b64 raw 32B). Se envía como
 *   `pubKeyB64` en `device-claim` y el relay la usa para verificar el
 *   `tunnel-register` firmado.
 * - `remote.relay.signPriv`: privada ed25519 (b64 raw 64B). NUNCA sale del
 *   equipo (igual que `remote.device.priv`).
 * - Estables ante `rotateKeys()`: el vínculo con el relay es por
 *   `deviceId`+`signPub`, independiente de la identidad E2E.
 */
const K_SIGN_PUB = 'remote.relay.signPub';
const K_SIGN_PRIV = 'remote.relay.signPriv';

export interface DeviceIdentity {
  deviceId: string;
  publicKeyB64: string;
  /** Solo memoria del daemon: nunca serializar a respuestas. */
  secretKeyB64: string;
  fingerprint: string;
}

export function getIdentity(db?: DatabaseService): DeviceIdentity {
  const d = db ?? new DatabaseService();
  let id = d.getSetting(K_ID);
  let pub = d.getSetting(K_PUB);
  let priv = d.getSetting(K_PRIV);
  if (!id || !pub || !priv) {
    const kp = generateKeyPair();
    id = id || uuidv4();
    pub = pub || kp.publicKeyB64;
    priv = priv || kp.secretKeyB64;
    // Si faltaba algo, regenerar el par completo para no mezclar mitades.
    if (!d.getSetting(K_PUB) || !d.getSetting(K_PRIV)) {
      const fresh = generateKeyPair();
      pub = fresh.publicKeyB64;
      priv = fresh.secretKeyB64;
    }
    d.setSetting(K_ID, id);
    d.setSetting(K_PUB, pub);
    d.setSetting(K_PRIV, priv);
  }
  return { deviceId: id, publicKeyB64: pub, secretKeyB64: priv, fingerprint: fingerprint(pub) };
}

/** Rota el par de claves. Invalida sesiones remotas abiertas con la clave vieja. */
export function rotateKeys(db?: DatabaseService): DeviceIdentity {
  const d = db ?? new DatabaseService();
  const id = d.getSetting(K_ID) ?? uuidv4();
  const kp = generateKeyPair();
  d.setSetting(K_ID, id);
  d.setSetting(K_PUB, kp.publicKeyB64);
  d.setSetting(K_PRIV, kp.secretKeyB64);
  // Los seq de emisión empiezan de cero con la identidad nueva.
  resetLocalSeq();
  // Contadores de recepción persistidos: se purgan para que un atacante no
  // pueda reutilizar `seq` altos de la época anterior.
  try {
    for (const [k] of Object.entries(d.getAllSettings())) {
      if (k.startsWith('remote.seq.')) d.deleteSetting(k);
    }
  } catch { /* mejor esfuerzo */ }
  return { deviceId: id, publicKeyB64: kp.publicKeyB64, secretKeyB64: kp.secretKeyB64, fingerprint: fingerprint(kp.publicKeyB64) };
}

/** Vista pública (sin privada) para REST/WS. */
export function publicIdentity(db?: DatabaseService): { deviceId: string; publicKey: string; fingerprint: string } {
  const i = getIdentity(db);
  return { deviceId: i.deviceId, publicKey: i.publicKeyB64, fingerprint: i.fingerprint };
}

export interface RelaySigningKeys {
  /** Pública ed25519 en b64 (raw 32B). Se envía como `pubKeyB64` en device-claim. */
  publicKeyB64: string;
  /** Privada ed25519 en b64 (raw 64B). SOLO memoria del daemon: nunca serializar. */
  secretKeyB64: string;
}

function b64ByteLength(b64: string): number {
  try {
    return Buffer.from(String(b64 ?? ''), 'base64').length;
  } catch {
    return -1;
  }
}

/**
 * Par de firma del relay (ed25519 `nacl.sign`). Se genera UNA vez y persiste;
 * NO rota con `rotateKeys()` (el vínculo relay es deviceId+signPub).
 */
export function getRelaySigningKeys(db?: DatabaseService): RelaySigningKeys {
  const d = db ?? new DatabaseService();
  const pub = d.getSetting(K_SIGN_PUB);
  const priv = d.getSetting(K_SIGN_PRIV);
  if (pub && priv && b64ByteLength(pub) === 32 && b64ByteLength(priv) === 64) {
    return { publicKeyB64: pub, secretKeyB64: priv };
  }
  // Generar el par completo si falta algo (no mezclar mitades).
  const kp = nacl.sign.keyPair();
  const out: RelaySigningKeys = {
    publicKeyB64: Buffer.from(kp.publicKey).toString('base64'),
    secretKeyB64: Buffer.from(kp.secretKey).toString('base64'),
  };
  try { d.setSetting(K_SIGN_PUB, out.publicKeyB64); } catch { /* noop */ }
  try { d.setSetting(K_SIGN_PRIV, out.secretKeyB64); } catch { /* noop */ }
  return out;
}

/**
 * Firma `UTF-8(`${deviceId}|${ts}`)` con detached ed25519.
 * Devuelve `{ts, sig}` con `sig` en hex minúsculas (raw 64B) para el
 * `tunnel-register` en sockets vinculados a device-token.
 */
export function signTunnelRegister(db: DatabaseService | undefined, deviceId: string, ts: number): { ts: number; sig: string } {
  const keys = getRelaySigningKeys(db);
  const msg = Buffer.from(`${deviceId}|${ts}`, 'utf8');
  const sig = nacl.sign.detached(new Uint8Array(msg), new Uint8Array(Buffer.from(keys.secretKeyB64, 'base64')));
  return { ts, sig: Buffer.from(sig).toString('hex') };
}
