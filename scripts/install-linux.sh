#!/bin/bash
# install-linux.sh — instalación gestionada de BunDeck en Linux (por usuario).
# Descarga el manifiesto, verifica el bundle y lo deja en:
#   ~/.local/share/bundeck/versions/<ver>/ + active.json
# Crea shims en ~/.local/bin (libredeck-launcher, libredeck-cli).
set -e
REPO="mikelgmh/libredeck"
ROOT="${BUNDECK_HOME:-$HOME/.local/share/bundeck}"
BIN="${HOME}/.local/bin"
TARGET="linux-x64"

echo "→ Manifiesto..."
MANIFEST="$(curl -fsSL "https://github.com/${REPO}/releases/latest/download/bundeck-update-manifest.json")"
VER="$(echo "$MANIFEST" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")"
URL="$(echo "$MANIFEST" | python3 -c "import json,sys; print(json.load(sys.stdin)['assets']['$TARGET']['url'])")"
SHA="$(echo "$MANIFEST" | python3 -c "import json,sys; print(json.load(sys.stdin)['assets']['$TARGET']['sha256'])")"
echo "  versión $VER"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "→ Descargando bundle..."
curl -fSL --progress-bar -o "$TMP/bundle.zip" "$URL"
echo "→ Verificando sha256..."
echo "$SHA  $TMP/bundle.zip" | sha256sum -c -
DEST="$ROOT/versions/$VER"
mkdir -p "$DEST"
echo "→ Extrayendo en $DEST..."
python3 -c "import zipfile; zipfile.ZipFile('$TMP/bundle.zip').extractall('$DEST')"
# Pela carpeta raíz única si la hay (bundeck-v.../).
if [ ! -f "$DEST/libredeck-daemon" ]; then
  SUB="$(find "$DEST" -maxdepth 1 -mindepth 1 -type d | head -1)"
  if [ -n "$SUB" ] && [ -f "$SUB/libredeck-daemon" ]; then
    cp -r "$SUB/." "$DEST/"
    rm -rf "$SUB"
  fi
fi
chmod +x "$DEST"/libredeck-* 2>/dev/null || true
echo "{\"version\":\"$VER\"}" > "$ROOT/active.json"

mkdir -p "$BIN"
for b in libredeck-launcher libredeck-cli libredeck-updater; do
  ln -sf "$DEST/$b" "$BIN/$b"
done

# .desktop
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/bundeck.desktop" <<EOF
[Desktop Entry]
Name=BunDeck
Comment=Open Source StreamDeck alternative
Exec=$DEST/libredeck-launcher
Icon=$DEST/web-dist/favicon-32.png
Terminal=false
Type=Application
Categories=Utility;
EOF

echo "✅ BunDeck $VER instalado en $ROOT"
echo "   Launcher: $BIN/libredeck-launcher (o menú de aplicaciones)"
echo "   Las actualizaciones se aplican desde el launcher (ACTUALIZACIÓN)."
