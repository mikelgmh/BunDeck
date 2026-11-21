// Genera todos los iconos de la app desde assets/bundeck.svg (asset canonico).
// Uso: cd web && node ../scripts/gen-icons.cjs   (sharp vive en web/node_modules)
const fs = require('fs');
const path = require('path');

(async () => {
  const root = path.join(__dirname, '..');
  const sharp = require(path.join(root, 'web', 'node_modules', 'sharp'));
  const pngToIco = require(path.join(root, 'node_modules', 'png-to-ico'));
  const svg = fs.readFileSync(path.join(root, 'assets/bundeck.svg'));
  const sizes = [16, 32, 48, 180, 256, 512];
  const pngs = {};
  for (const s of sizes) {
    pngs[s] = await sharp(svg, { density: 1024 })
      .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(root, `assets/bundeck-${s}.png`), pngs[s]);
  }
  // Tray (electrobun + web): 32px con fondo transparente
  fs.writeFileSync(path.join(root, 'assets/tray.png'), pngs[32]);

  // Web: Astro sirve web/public/* en la raiz
  const pub = path.join(root, 'web', 'public');
  fs.mkdirSync(pub, { recursive: true });
  fs.copyFileSync(path.join(root, 'assets/bundeck.svg'), path.join(pub, 'favicon.svg'));
  fs.copyFileSync(path.join(root, 'assets/bundeck.svg'), path.join(pub, 'bundeck.svg'));
  fs.writeFileSync(path.join(pub, 'tray.png'), pngs[32]);
  fs.writeFileSync(path.join(pub, 'apple-touch-icon.png'), pngs[180]);
  fs.writeFileSync(path.join(pub, 'favicon-32.png'), pngs[32]);

  // ICO multi-tamano para Windows (taskbar electrobun + daemon + instalador).
  // Solo 16/32/48: el entry de 256 se guarda como BMP sin comprimir (~260KB)
  // y no aporta nada en taskbar/tray/instalador.
  const ico = await pngToIco([pngs[16], pngs[32], pngs[48]]);
  fs.writeFileSync(path.join(root, 'icon.ico'), ico);
  fs.writeFileSync(path.join(root, 'assets/icon.ico'), ico);

  // Daemon systray: la API pide el icono como string base64 (.ico en Windows).
  // Se embebe en un modulo TS para que funcione tambien en el exe compilado.
  const b64 = ico.toString('base64');
  fs.writeFileSync(
    path.join(root, 'daemon', 'src', 'tray-icon.ts'),
    `// Generado por scripts/gen-icons.cjs — no editar a mano.\n` +
    `// Icono BunDeck en formato .ico (base64) para el systray de Windows.\n` +
    `export const TRAY_ICON_BASE64 = "${b64}";\n`
  );
  console.log('icons ok');
})().catch((e) => { console.error(e); process.exit(1); });
