#!/bin/bash
# make-bundle.sh — empaqueta dist/ en bundeck-v<ver>-<target>.zip
# Uso: ./scripts/make-bundle.sh <version> <target>
#   target: windows-x64 | linux-x64 | darwin-x64
# Requiere que dist/ contenga: bundeck-daemon*, bundeck-cli*,
# bundeck-launcher*, bundeck-updater* y web-dist/.
set -e
VER="${1:?falta version}"
TARGET="${2:?falta target}"
OUT="bundeck-v${VER}-${TARGET}.zip"

if [ ! -d dist ]; then
  echo "Error: no existe dist/ (ejecuta el build primero)" >&2
  exit 1
fi

# Normaliza nombres dentro de dist/ a los canónicos con ext de la plataforma.
# (CI ya los deja así; build.sh local también.)
ls dist/ >&2

if command -v zip >/dev/null 2>&1; then
  rm -f "$OUT"
  # active.json es del instalador (raíz de {app}); el stage la genera apply.
  (cd dist && zip -qr "../$OUT" . -x active.json)
elif command -v python3 >/dev/null 2>&1; then
  rm -f "$OUT"
  python3 -c "
import zipfile, pathlib
out = pathlib.Path('$OUT')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for p in sorted(pathlib.Path('dist').rglob('*')):
        if p.is_file() and p.name != 'active.json':
            z.write(p, p.relative_to('dist'))
"
else
  echo "Error: ni 'zip' ni 'python3' disponibles para empaquetar" >&2
  exit 1
fi

# sha256 alongside (formato coreutils: "<hash>  <file>")
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUT" > "$OUT.sha256"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$OUT" > "$OUT.sha256"
else
  python3 -c "import hashlib;print(hashlib.sha256(open('$OUT','rb').read()).hexdigest()+'  $OUT')" > "$OUT.sha256"
fi
echo "Bundle: $OUT ($(cat "$OUT.sha256"))"
