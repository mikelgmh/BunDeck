#!/bin/bash
# install-macos.sh — instalación gestionada de BunDeck en macOS (por usuario).
#   ~/Applications/BunDeck/versions/<ver>/ + active.json
#   + enlace en ~/bin o /usr/local/bin si es posible (solo CLI).
set -e
REPO="mikelgmh/libredeck"
ROOT="${BUNDECK_HOME:-$HOME/Applications/BunDeck}"
TARGET="darwin-x64"

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
echo "$SHA  $TMP/bundle.zip" | shasum -a 256 -c -
DEST="$ROOT/versions/$VER"
mkdir -p "$DEST"
echo "→ Extrayendo en $DEST..."
python3 -c "import zipfile; zipfile.ZipFile('$TMP/bundle.zip').extractall('$DEST')"
if [ ! -f "$DEST/bundeck-daemon" ] && [ ! -f "$DEST/libredeck-daemon" ]; then
  SUB="$(find "$DEST" -maxdepth 1 -mindepth 1 -type d | head -1)"
  if [ -n "$SUB" ] && { [ -f "$SUB/bundeck-daemon" ] || [ -f "$SUB/libredeck-daemon" ]; }; then
    cp -R "$SUB/." "$DEST/"
    rm -rf "$SUB"
  fi
fi
chmod +x "$DEST"/bundeck-* "$DEST"/libredeck-* 2>/dev/null || true
echo "{\"version\":\"$VER\"}" > "$ROOT/active.json"

# Quita cuarentena de los binarios descargados (evita el diálogo de Gatekeeper).
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo "✅ BunDeck $VER instalado en $ROOT"
echo "   Abre: $DEST/bundeck-launcher"
echo "   (Mantenlo en una ruta estable: el updater usa versions/<ver>/ + active.json.)"
echo "   Las actualizaciones se aplican desde el launcher (ACTUALIZACIÓN)."
echo "   NOTA: para auto-update sin avisos de Gatekeeper, la release debe estar"
echo "   firmada y notarizada (ver docs). Sin notarizar, autoriza el binario una vez."
