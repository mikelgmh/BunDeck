#!/bin/bash

# Script de desarrollo para LibreDeck
# Facilita el desarrollo y testing del proyecto

set -e

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🎛️  LibreDeck Development Script${NC}"
echo -e "${BLUE}=================================${NC}"

# Puertos por defecto (alineados con daemon/src/config.ts)
API_PORT="${API_PORT:-3001}"
WS_PORT="${WS_PORT:-3003}"

# Espera a que una URL responda 2xx. Uso: wait_for_health <url> [timeout_s] [interval_s]
wait_for_health() {
    local url="$1"
    local timeout="${2:-30}"
    local interval="${3:-1}"
    local elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        if curl -sf -o /dev/null "$url" 2>/dev/null; then
            return 0
        fi
        sleep "$interval"
        elapsed=$((elapsed + interval))
    done
    return 1
}

# Ayuda del script
show_help() {
    cat << 'EOF'
Uso: ./dev.sh <comando>

Comandos:
  setup    Instala dependencias, configura DB, crea perfil inicial y plugin de ejemplo
  dev      Inicia daemon (DEV_MODE) + frontend Astro con health-checks
  build    Build de producción (daemon + frontend + CLI)
  test     Prueba la conectividad del daemon
  clean    Limpia dist/ y base de datos local
  plugin   Crea el plugin de ejemplo
  help     Muestra esta ayuda

Variables de entorno:
  NO_BROWSER=1        No abrir el navegador automáticamente en `dev`
  NO_LAUNCHER=1       No abrir la ventana de estado GPUI en `dev`
  API_PORT / WS_PORT   Puertos esperados (por defecto 3001 / 3003)
  FRONTEND_PORT        Puerto esperado del frontend (autodetección si se omite)

Ejemplos:
  ./dev.sh setup
  ./dev.sh dev
  NO_BROWSER=1 ./dev.sh dev
EOF
}

# Verificar prerrequisitos
check_prereqs() {
    echo -e "${YELLOW}Verificando prerrequisitos...${NC}"
    
    if ! command -v bun &> /dev/null; then
        echo -e "${RED}❌ Bun no está instalado. Instálalo desde https://bun.sh/${NC}"
        exit 1
    fi
    
    if ! command -v node &> /dev/null; then
        echo -e "${RED}❌ Node.js no está instalado. Instálalo desde https://nodejs.org/${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✅ Prerrequisitos verificados${NC}"
}

# Instalar todas las dependencias
install_deps() {
    echo -e "${YELLOW}Instalando dependencias...${NC}"
    
    echo "📦 Instalando dependencias del daemon..."
    (cd daemon && bun install)
    
    echo "📦 Instalando dependencias del frontend..."
    (cd web && npm install)
    
    echo "📦 Instalando dependencias del CLI..."
    (cd cli && bun install)
    
    echo -e "${GREEN}✅ Todas las dependencias instaladas${NC}"
}

# Configurar base de datos
setup_db() {
    echo -e "${YELLOW}Configurando base de datos...${NC}"
    
    mkdir -p data
    
    echo -e "${GREEN}✅ Base de datos configurada${NC}"
}

# Crear perfil inicial
create_initial_profile() {
    echo -e "${YELLOW}Creando perfil inicial...${NC}"
    
    # Iniciar daemon temporalmente
    cd daemon && bun run start &
    DAEMON_PID=$!

    # Esperar a que el daemon esté listo (health-check con timeout, sin sleep fijo)
    echo "Esperando a que el daemon se inicialice..."
    if ! wait_for_health "http://localhost:${API_PORT}/health" 30 1; then
        echo "Daemon no responde tras 30s, no se pudo crear el perfil inicial"
    fi
    
    # Verificar que el daemon esté respondiendo
    if curl -sf http://localhost:${API_PORT}/health > /dev/null 2>&1; then
        echo "Daemon está respondiendo, creando perfil..."

        # Crear perfil inicial vía API
        RESPONSE=$(curl -s -X POST http://localhost:${API_PORT}/api/v1/profiles \
            -H "Content-Type: application/json" \
            -d '{"name":"Perfil Principal","data":{"isDefault":true}}')
        
        if echo "$RESPONSE" | grep -q "id"; then
            echo "Perfil creado exitosamente"
        else
            echo "Error creando perfil: $RESPONSE"
        fi
    else
        echo "Daemon no responde, no se pudo crear el perfil inicial"
    fi
    
    # Detener daemon
    kill $DAEMON_PID 2>/dev/null
    wait $DAEMON_PID 2>/dev/null
    
    cd ..
    
    echo -e "${GREEN}✅ Proceso de creación de perfil inicial completado${NC}"
}

# Crear plugin de ejemplo

# Iniciar desarrollo
start_dev() {
    echo -e "${YELLOW}Iniciando modo desarrollo...${NC}"
    
    # Trap para limpiar procesos al salir
    trap 'kill $(jobs -p) 2>/dev/null' EXIT
    
    echo -e "${BLUE}🔧 Iniciando daemon (modo dev - sin frontend embebido)...${NC}"
    export DEV_MODE=true
    cd daemon && bun run start &
    DAEMON_PID=$!
    
    echo -e "${BLUE}🌐 Iniciando frontend dev server...${NC}"
    cd web && npm run dev -- --host &
    WEB_PID=$!
    
    # Esperar a que los servicios estén listos (health-check con timeout)
    echo "Esperando a que el daemon responda..."
    if ! wait_for_health "http://localhost:${API_PORT}/health" 30 1; then
        echo -e "${YELLOW}⚠️  El daemon no respondió en 30s; continúa de todos modos${NC}"
    fi
    
    # Detectar puerto del frontend dev server
    FRONTEND_PORT=""
    for port in {3000..4000}; do
        if curl -s http://localhost:$port > /dev/null 2>&1; then
            response=$(curl -s http://localhost:$port)
            # Evitar detectar el puerto del daemon (que responde con "LibreDeck API Server")
            if echo "$response" | grep -q "astro\|vite\|<title>" && ! echo "$response" | grep -q "LibreDeck API Server"; then
                FRONTEND_PORT=$port
                break
            fi
        fi
    done
    
    # Fallback al puerto por defecto de Astro
    if [ -z "$FRONTEND_PORT" ]; then
        FRONTEND_PORT=4321
    fi
    
    # Obtener IP local (portable: hostname -I en Linux, `ip` como fallback;
    # en Windows/Git Bash puede no existir ninguno: se omite en silencio)
    LOCAL_IP=""
    if command -v hostname &> /dev/null; then
        LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi
    if [ -z "$LOCAL_IP" ] && command -v ip &> /dev/null; then
        LOCAL_IP=$(ip addr show 2>/dev/null | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | cut -d/ -f1 | head -n1)
    fi

    echo -e "${GREEN}🚀 LibreDeck está ejecutándose:${NC}"
    echo -e "   📡 API: ${BLUE}http://localhost:${API_PORT}${NC}"
    echo -e "   🌐 Panel Local: ${BLUE}http://localhost:$FRONTEND_PORT${NC}"
    if [ -n "$LOCAL_IP" ]; then
        echo -e "   🌐 Panel Red LAN: ${BLUE}http://${LOCAL_IP}:$FRONTEND_PORT${NC}"
    fi
    echo -e "   🔌 WebSocket: ${BLUE}ws://localhost:${WS_PORT}${NC}"
    echo ""
    echo -e "${YELLOW}Presiona Ctrl+C para detener${NC}"

    # Ventanita de estado GPUI: es la puerta de entrada en dev (con botón
    # "Abrir panel"). Si se lanza, ya no hace falta auto-abrir el navegador.
    LAUNCHER_OPENED=0
    if [ "${NO_LAUNCHER:-0}" != "1" ]; then
        for _exe in "launcher/target/release/libredeck-launcher" "launcher/target/release/libredeck-launcher.exe" "launcher/target/debug/libredeck-launcher" "launcher/target/debug/libredeck-launcher.exe"; do
            if [ -x "$_exe" ]; then
                echo -e "${BLUE}🪟 Abriendo ventana de estado (GPUI)...${NC}"
                # Job directo (sin subshell) para que el trap de EXIT lo cierre con Ctrl+C.
                "$_exe" &> /dev/null &
                LAUNCHER_OPENED=1
                break
            fi
        done
        if [ "$LAUNCHER_OPENED" = "0" ]; then
            echo -e "${YELLOW}Launcher GPUI sin compilar: 'cd launcher && cargo run' (luego ./dev.sh dev ya lo abre solo)${NC}"
        fi
    fi

    # Abrir navegador automáticamente salvo NO_BROWSER=1 (portable: xdg-open/open/start)
    # Si la ventanita GPUI ya abrió, ella ofrece "Abrir panel": no duplicar.
    if [ "${NO_BROWSER:-0}" = "1" ]; then
        echo -e "${YELLOW}NO_BROWSER=1: no se abre el navegador${NC}"
    elif [ "$LAUNCHER_OPENED" = "1" ]; then
        echo -e "${BLUE}Navegador no auto-abierto: usa «Abrir panel» en la ventana de estado${NC}"
    else
        echo -e "${YELLOW}Abriendo navegador...${NC}"
        if [ -n "$LOCAL_IP" ]; then
            BROWSER_URL="http://${LOCAL_IP}:$FRONTEND_PORT"
        else
            BROWSER_URL="http://localhost:$FRONTEND_PORT"
        fi
        if command -v xdg-open &> /dev/null; then
            xdg-open "$BROWSER_URL" &> /dev/null &
        elif command -v open &> /dev/null; then
            open "$BROWSER_URL" &> /dev/null &
        elif command -v start &> /dev/null; then
            start "$BROWSER_URL" &> /dev/null &
        elif command -v powershell.exe &> /dev/null; then
            powershell.exe -NoProfile -Command Start-Process "$BROWSER_URL" &> /dev/null &
        else
            echo -e "${YELLOW}No se encontró forma de abrir el navegador; visita $BROWSER_URL${NC}"
        fi
    fi
    
    # Esperar a que se detengan procesos
    wait
}

# Build de producción
build_prod() {
    echo -e "${YELLOW}Construyendo para producción...${NC}"
    
    echo "🔧 Building daemon..."
    cd daemon && bun run build && cd ..
    
    echo "🌐 Building frontend..."
    cd web && npm run build && cd ..
    
    echo "📁 Copiando frontend a daemon..."
    cp -r web/dist daemon/web-dist
    
    echo "⚙️ Building CLI..."
    cd cli && bun run build && cd ..
    
    echo -e "${GREEN}✅ Build completado${NC}"
    echo -e "Archivos en:"
    echo "   daemon/dist/"
    echo "   web/dist/"
    echo "   cli/dist/"
}

# Limpiar archivos temporales
clean() {
    echo -e "${YELLOW}Limpiando archivos temporales...${NC}"
    
    rm -rf daemon/dist/
    rm -rf web/dist/
    rm -rf cli/dist/
    rm -rf data/db.sqlite*
    rm -rf data/logs/*.log
    
    echo -e "${GREEN}✅ Archivos limpiados${NC}"
}

# Tests
run_tests() {
    echo -e "${YELLOW}Ejecutando tests...${NC}"
    
    echo "🧪 Testing daemon..."
    cd daemon && bun test && cd .. || true
    
    echo "🧪 Testing frontend..."
    cd web && npm run test && cd .. || true
    
    echo -e "${GREEN}✅ Tests completados${NC}"
}

# Crear plugin de ejemplo
create_example_plugin() {
    echo -e "${YELLOW}Creando plugin de ejemplo...${NC}"
    
    PLUGIN_DIR="data/plugins/ejemplo-plugin"
    mkdir -p "$PLUGIN_DIR"
    
    # Manifest
    cat > "$PLUGIN_DIR/manifest.json" << 'EOF'
{
  "id": "com.libredeck.ejemplo",
  "name": "Plugin de Ejemplo",
  "version": "1.0.0",
  "description": "Plugin de demostración para LibreDeck",
  "author": "LibreDeck Team",
  "permissions": ["emitEvent"],
  "actions": [
    {
      "id": "saludo",
      "name": "Decir Hola",
      "description": "Muestra un saludo personalizado",
      "schema": {
        "type": "object",
        "properties": {
          "nombre": {
            "type": "string",
            "title": "Nombre",
            "default": "Mundo"
          },
          "entusiasmo": {
            "type": "integer",
            "title": "Nivel de entusiasmo",
            "minimum": 1,
            "maximum": 10,
            "default": 5
          }
        }
      }
    }
  ]
}
EOF

    # Main.js
    cat > "$PLUGIN_DIR/main.js" << 'EOF'
// Plugin de Ejemplo para LibreDeck
export function register(api) {
  console.log('🎉 Plugin de Ejemplo cargado');
  
  // Registrar acción de saludo
  api.onAction('saludo', async ({ args }) => {
    const nombre = args.nombre || 'Mundo';
    const entusiasmo = args.entusiasmo || 5;
    const exclamaciones = '!'.repeat(Math.min(entusiasmo, 10));
    
    const mensaje = `¡Hola ${nombre}${exclamaciones}`;
    
    // Emitir evento para logging
    api.emitEvent('log', { 
      message: `Saludo enviado: ${mensaje}`,
      plugin: 'ejemplo-plugin' 
    });
    
    // Log en el plugin
    api.log('info', `Saludo generado para: ${nombre}`);
    
    return { 
      success: true, 
      message: mensaje,
      entusiasmo: entusiasmo
    };
  });
}

export function unload() {
  console.log('👋 Plugin de Ejemplo descargado');
}
EOF

    # README
    cat > "$PLUGIN_DIR/README.md" << 'EOF'
# Plugin de Ejemplo

Este es un plugin de demostración que muestra cómo crear plugins para LibreDeck.

## Funciones

- **saludo**: Genera un saludo personalizado con nivel de entusiasmo configurable

## Instalación

El plugin se instala automáticamente durante el desarrollo. Para instalarlo manualmente:

```bash
sdctl plugin install data/plugins/ejemplo-plugin
```

## Uso

1. Crear un botón en LibreDeck
2. Asignar la acción "Decir Hola"
3. Configurar el nombre y nivel de entusiasmo
4. ¡Presionar el botón y ver el saludo!
EOF

    echo -e "${GREEN}✅ Plugin de ejemplo creado en $PLUGIN_DIR${NC}"
}

# Test daemon connectivity
test_daemon() {
    echo -e "${YELLOW}Testing daemon connectivity...${NC}"
    
    # Test health endpoint
    if curl -sf http://localhost:${API_PORT}/api/v1/test > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Daemon is responding${NC}"
        echo -e "   🌐 API: ${BLUE}http://localhost:${API_PORT}${NC}"
        echo -e "   🧪 Test: ${BLUE}http://localhost:${API_PORT}/api/v1/test${NC}"

        # Test windows endpoint
        echo -e "${YELLOW}Testing windows API...${NC}"
        WINDOWS_RESPONSE=$(curl -s http://localhost:${API_PORT}/api/v1/windows/list)
        if echo "$WINDOWS_RESPONSE" | grep -q "hwnd"; then
            WINDOW_COUNT=$(echo "$WINDOWS_RESPONSE" | grep -o '"hwnd"' | wc -l)
            echo -e "${GREEN}✅ Windows API working - found ${WINDOW_COUNT} windows${NC}"
        else
            echo -e "${RED}❌ Windows API not working${NC}"
            echo -e "   Response: ${WINDOWS_RESPONSE}"
        fi
    else
        echo -e "${RED}❌ Daemon is not responding${NC}"
        echo -e "   Make sure the daemon is running with: ${BLUE}./dev.sh dev${NC}"
    fi
}

# Main
case "${1:-dev}" in
    "setup")
        check_prereqs
        install_deps
        setup_db
        create_initial_profile
        create_example_plugin
        echo -e "${GREEN}🎉 Setup completado. Ejecuta './dev.sh dev' para iniciar${NC}"
        ;;
    "dev")
        check_prereqs
        start_dev
        ;;
    "build")
        check_prereqs
        build_prod
        ;;
    "test")
        test_daemon
        ;;
    "clean")
        clean
        ;;
    "plugin")
        create_example_plugin
        ;;
    "help"|"-h"|"--help")
        show_help
        ;;
    *)
        echo -e "${RED}Comando desconocido: $1${NC}"
        show_help
        exit 1
        ;;
esac