#!/usr/bin/env node
/**
 * build-update-manifest.mjs — genera el manifiesto de auto-actualización.
 *
 * Uso (job `release` de CI, tras descargar los bundles de cada OS):
 *   node scripts/build-update-manifest.mjs \
 *     --version 1.6.0 \
 *     --assets ./artifacts \
 *     --out ./bundeck-update-manifest.json
 *
 * Busca `bundeck-v<version>-<target>.zip` (+ `.sha256` opcional, si no lo
 * calcula), y emite:
 *   { version, channel, publishedAt, minUpdaterVersion, notesUrl, assets }
 *
 * Firma: si existe `BUNDECK_UPDATE_PRIVKEY` (o `LIBREDECK_UPDATE_PRIVKEY` deprecated)
 * PEM) firma cada asset sobre el mensaje "<version>|<target>|<sha256>" y
 * añade `signature` + `pubkeyHint` (primeros 8 hex de la pubkey). Si no hay
 * clave, `signature: null` y `signed: false` (solo dev / releases sin firma).
 *
 * Sin dependencias: solo node:crypto + node:fs.
 */
import { createHash, sign as cryptoSign, createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) {
      const k = cur.slice(2);
      const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true';
      acc.push([k, v]);
    }
    return acc;
  }, []),
);

const isMain = process.argv[1] && /build-update-manifest\.mjs$/.test(process.argv[1]);

const version = (args.version || process.env.BUNDECK_VERSION || process.env.LIBREDECK_VERSION || '').replace(/^v/, '');
const assetsDir = args.assets || './artifacts';
const out = args.out || './bundeck-update-manifest.json';
const channel = args.channel || 'stable';

if (isMain && !version) {
  console.error('Falta --version (o BUNDECK_VERSION)');
  process.exit(1);
}

const TARGETS = ['windows-x64', 'linux-x64', 'darwin-x64'];

function sha256File(path) {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

/** Devuelve { signHex(msg) -> sigHex } o null si no hay clave. */
function loadSigner() {
  const raw = (process.env.BUNDECK_UPDATE_PRIVKEY || process.env.LIBREDECK_UPDATE_PRIVKEY || '').trim();
  if (!raw) return null;
  try {
    let keyObj;
    if (raw.includes('BEGIN')) {
      keyObj = createPrivateKey(raw);
    } else {
      // hex seed de 32 bytes -> PKCS8 der ed25519
      const seed = Buffer.from(raw.replace(/^0x/, ''), 'hex');
      if (seed.length !== 32) throw new Error('seed ed25519 debe ser 32 bytes hex');
      // Prefijo PKCS#8 Ed25519 OneAsymmetricKey
      const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
      keyObj = createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' });
    }
    return {
      signHex(msg) {
        const sig = cryptoSign(null, Buffer.from(msg), keyObj);
        return sig.toString('hex');
      },
    };
  } catch (e) {
    console.error(`Aviso: BUNDECK_UPDATE_PRIVKEY inválida (${e.message}); manifiesto sin firma.`);
    return null;
  }
}

export function buildManifest({ version, assetsDir, channel = 'stable' }) {
  const signer = loadSigner();
  const assets = {};
  let signedCount = 0;

  for (const target of TARGETS) {
    const name = `bundeck-v${version}-${target}.zip`;
    const bundlePath = join(assetsDir, name);
    if (!existsSync(bundlePath)) {
      console.error(`Aviso: no se encontró ${name} en ${assetsDir} (se omite ${target})`);
      continue;
    }
    let sha256 = '';
    const shaFile = bundlePath + '.sha256';
    if (existsSync(shaFile)) {
      sha256 = readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0];
    } else {
      sha256 = sha256File(bundlePath);
    }
    const size = statSync(bundlePath).size;
    const msg = `${version}|${target}|${sha256}`;
    let signature = null;
    if (signer) {
      signature = signer.signHex(msg);
      signedCount++;
    }
    assets[target] = {
      bundle: name,
      url: `https://github.com/mikelgmh/BunDeck/releases/download/v${version}/${name}`,
      sha256,
      size,
      signature,
    };
  }

  if (Object.keys(assets).length === 0) {
    throw new Error('ningún bundle encontrado; no se genera manifiesto.');
  }

  return {
    format: 1,
    version,
    channel,
    publishedAt: new Date().toISOString(),
    minUpdaterVersion: '1.6.0',
    notesUrl: `https://github.com/mikelgmh/BunDeck/releases/tag/v${version}`,
    signed: signedCount > 0,
    assets,
  };
}

const manifest = isMain ? buildManifest({ version, assetsDir, channel }) : null;

if (isMain) {
  if (!version) {
    console.error('Falta --version (o BUNDECK_VERSION)');
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  const signedCount = Object.values(manifest.assets).filter((a) => a.signature).length;
  console.log(`Manifiesto ${signedCount > 0 ? 'firmado' : 'SIN FIRMA'}: ${out} (${Object.keys(manifest.assets).join(', ')})`);
}

// Exportado para tests (bun/node import).
export default manifest;
