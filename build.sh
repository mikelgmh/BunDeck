#!/bin/bash

# BunDeck Build Script
# Builds all components for production

set -e

echo "🚀 Building BunDeck for production..."

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
bun run build
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
else
    echo "⚠️ cargo no encontrado: se omite el launcher (instala Rust o usa bun run dev:launcher)"
fi

echo "📦 Building Installer..."
ISCC_PATH="/c/Users/Mikel/AppData/Local/Programs/Inno Setup 6/ISCC.exe"
# Versión única desde package.json, vía version.iss (evita /DAppVersion en CLI,
# que ISCC bajo Git Bash interpreta como segundo fichero de script).
APP_VERSION=$(node -p "JSON.parse(require('fs').readFileSync('package.json')).version")
echo "📌 App version: $APP_VERSION"
# Override en tiempo de ejecución y respaldo para getVersion() en daemon/CLI
# (el JSON de root package.json ya va incrustado en el binario vía import).
export LIBREDECK_VERSION="$APP_VERSION"
echo "#define AppVersion \"$APP_VERSION\"" > version.iss
if [ -f "$ISCC_PATH" ]; then
    "$ISCC_PATH" installer.iss
    echo "✅ Installer created: installer/BunDeck-Setup.exe"
else
    echo "⚠️ Inno Setup not found at $ISCC_PATH"
    echo "   Install it from https://jrsoftware.org/isinfo.php"
    echo "   Then run: iscc installer.iss"
fi