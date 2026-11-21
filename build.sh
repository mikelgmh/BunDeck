#!/bin/bash

# BunDeck Build Script
# Builds all components for production

set -e

echo "🚀 Building BunDeck for production..."

# Versión única desde package.json (temprano: la usan daemon/CLI/launcher/bundle).
APP_VERSION=$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")
echo "📌 App version: $APP_VERSION"
export LIBREDECK_VERSION="$APP_VERSION"

# Clean dist directory
echo "🧹 Cleaning dist directory..."
rm -rf dist/*

# Create dist directory
mkdir -p dist

# Build Web first (web usa npm, no bun — convención del repo)
echo "📦 Building Web..."
cd web
npm run build
cd ..

# Copy web dist to daemon
echo "📦 Copying Web dist to Daemon..."
mkdir -p daemon/web-dist
cp -r web/dist/* daemon/web-dist/

# Copy web dist to dist (for executable)
echo "📦 Copying Web dist to Dist..."
mkdir -p dist/web-dist
cp -r web/dist/* dist/web-dist/

# Build Unified Executable (includes daemon + web server)
echo "📦 Building Unified Executable..."
cd daemon
if [ "$(uname -s)" = "MINGW"* ] || [ "$(uname -s)" = "MSYS"* ] || [ -n "${WINDIR:-}" ]; then
  bun run build:win
else
  bun run build
fi
mv libredeck-daemon ../dist/
cd ..

# CLI as compiled executable
echo "📦 Building CLI..."
cd cli
bun run build
mv libredeck-cli ../dist/
cd ..

# Launcher GPUI (ventana de estado). Requiere Rust; si no está, se omite
# (el resto de flujos siguen funcionando con la ventana Electrobun).
echo "📦 Building Launcher (Rust)..."
if command -v cargo &> /dev/null; then
    (cd launcher && cargo build --release)
    cp launcher/target/release/libredeck-launcher dist/ 2>/dev/null || cp launcher/target/release/libredeck-launcher.exe dist/ 2>/dev/null || echo "⚠️ Launcher compilado pero no copiado a dist/"
    cp launcher/target/release/libredeck-updater dist/ 2>/dev/null || cp launcher/target/release/libredeck-updater.exe dist/ 2>/dev/null || echo "⚠️ Updater compilado pero no copiado a dist/"
else
    echo "⚠️ cargo no encontrado: se omite el launcher (instala Rust o usa bun run dev:launcher)"
fi

# active.json gestionado (el updater migra instalaciones planas a versions/).
if [ -f dist/libredeck-daemon ] || [ -f dist/libredeck-daemon.exe ]; then
    echo "{\"version\":\"$APP_VERSION\"}" > dist/active.json
fi

# Bundle gestionado (daemon+cli+launcher+updater+web) para auto-update.
if [ -f dist/libredeck-daemon ] || [ -f dist/libredeck-daemon.exe ]; then
    if [ "$(uname -s)" = "MINGW"* ] || [ "$(uname -s)" = "MSYS"* ] || [ -n "${WINDIR:-}" ]; then
        bash scripts/make-bundle.sh "$APP_VERSION" "windows-x64" || echo "⚠️ no se pudo crear el bundle"
    elif [ "$(uname)" = "Darwin" ]; then
        bash scripts/make-bundle.sh "$APP_VERSION" "darwin-x64" || echo "⚠️ no se pudo crear el bundle"
    else
        bash scripts/make-bundle.sh "$APP_VERSION" "linux-x64" || echo "⚠️ no se pudo crear el bundle"
    fi
fi

echo "📦 Building Installer..."
ISCC_PATH="/c/Users/Mikel/AppData/Local/Programs/Inno Setup 6/ISCC.exe"
# version.iss desde APP_VERSION (evita /DAppVersion en CLI, que ISCC bajo
# Git Bash interpreta como segundo fichero de script). LIBREDECK_VERSION ya
# se exportó arriba para daemon/CLI/launcher.
echo "#define AppVersion \"$APP_VERSION\"" > version.iss
if [ -f "$ISCC_PATH" ]; then
    "$ISCC_PATH" installer.iss
    echo "✅ Installer created: installer/BunDeck-Setup.exe"
else
    echo "⚠️ Inno Setup not found at $ISCC_PATH"
    echo "   Install it from https://jrsoftware.org/isinfo.php"
    echo "   Then run: iscc installer.iss"
fi