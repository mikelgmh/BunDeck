# BunDeck Testing

Esta guía explica cómo ejecutar los tests en BunDeck.

## 🧪 Tipos de Tests

### 1. **Unit Tests** (Bun Test Runner)
- **Daemon**: Tests unitarios para lógica del backend usando el test runner nativo de Bun
- **Frontend**: Tests unitarios para componentes Vue y utilidades con Vitest

### 2. **Integration Tests** (Bun Test Runner)
- Tests de integración entre módulos
- Tests de API endpoints

### 3. **E2E Tests** (Cypress)
- Tests end-to-end completos
- Simulación de usuario real

## 🚀 Ejecutar Tests

### Tests del Daemon
```bash
cd daemon
bun test              # Ejecutar todos los tests (test runner nativo de Bun)
bun test --watch      # Modo watch
bun test --coverage   # Con reporte de cobertura
```

### Tests del Frontend
```bash
cd web
npm run test          # Unit tests con Vitest
npm run test:watch    # Modo watch
npm run test:coverage # Con cobertura
npm run test:e2e      # E2E con Cypress
npm run test:e2e:open # Abrir Cypress GUI
npm run test:component # Component tests
```

### Tests Globales
```bash
# Desde la raíz del proyecto
bun run test          # daemon (bun:test) + web (vitest), lo que corre CI
bun run test:coverage # Cobertura completa
bun run test:e2e       # Solo E2E
```

## 📁 Estructura de Tests

```
daemon/
├── src/
│   ├── test/
│   │   ├── setup.ts
│   │   └── action-runner.test.ts
│   └── ...
└── package.json (con scripts bun test)

web/
├── src/
│   ├── test/
│   │   ├── setup.ts
│   │   └── ButtonEditor.test.ts
│   └── ...
├── cypress/
│   ├── e2e/
│   │   └── libredeck.cy.ts
│   └── support/
│       ├── commands.ts
│       └── e2e.ts
├── vite.config.ts
└── cypress.config.ts
```

## 🛠️ Configuración

### Bun Test Runner (Unit/Integration - Daemon)
- **Environment**: Node.js nativo con Bun
- **Globals**: Habilitados para simplificar imports
- **Coverage**: Reportes integrados con Bun
- **Setup**: Archivo `src/test/setup.ts` para configuración global

### Vitest (Unit/Integration - Frontend)
- **Environment**: jsdom para simulación del DOM
- **Globals**: Habilitados para simplificar imports
- **Coverage**: Reportes HTML, JSON y texto
- **Setup**: Archivos de configuración global

### Cypress (E2E)
- **Base URL**: `http://localhost:4321`
- **Video**: Deshabilitado por defecto
- **Screenshots**: Solo en fallos
- **Component testing**: Soportado con Vite
- **Estado**: Configurado, requiere agregar `data-cy` attributes gradualmente

### Playwright (E2E actual)
- **Config**: `web/playwright.config.ts` (baseURL `http://localhost:4321`, un worker).
- **Servidores**: NO los arranca solo — daemon (`:3001`) y web dev (`:4321`) deben estar en marcha.
- **Aislamiento**: `global-setup.ts` crea el perfil dedicado **"E2E Runner"** (+ página `E2E Home`) y apunta `current.profile_id/page_id` a él; `global-teardown.ts` lo borra todo y restaura la vista previa del usuario. Los tests NUNCA tocan perfiles/páginas del usuario: cada spec crea sus propias páginas y las borra en `afterEach`. Así se puede seguir usando la app mientras corre la suite.

## 📝 Escribir Tests

### Test Unitario (Bun Test Runner)
```typescript
import { describe, it, expect, mock } from 'bun:test'

describe('ActionRunner', () => {
  it('debería ejecutar acciones correctamente', () => {
    // Test implementation
  })
})
```

### Test Unitario (Vitest - Frontend)
```typescript
import { describe, it, expect } from 'vitest'

describe('MiComponente', () => {
  it('debería renderizar correctamente', () => {
    // Test implementation
  })
})
```

### Test E2E (Cypress)
```typescript
describe('LibreDeck App', () => {
  it('debería cargar la página principal', () => {
    cy.visit('/')
    cy.contains('BunDeck').should('be.visible')
  })
})
```

## 🔧 Comandos Útiles

### Desarrollo con Tests
```bash
# Ejecutar tests del daemon en modo watch
cd daemon && bun test --watch

# Ejecutar solo tests específicos del daemon
cd daemon && bun test action-runner.test.ts

# Ejecutar tests del frontend
cd web && npm run test:watch

# Ejecutar con coverage del daemon
cd daemon && bun test --coverage
```

### Cypress (Tests E2E)
```bash
# Ejecutar tests E2E en modo headless (inicia servidores automáticamente)
bun run test:e2e

# Abrir interfaz gráfica de Cypress (inicia servidores automáticamente)
bun run test:e2e:open

# Ejecutar tests de componentes con Cypress
cd web && npm run test:component:open
```

### Debugging
```bash
# Ejecutar tests del daemon con verbose
cd daemon && bun test --verbose

# Abrir Vitest UI para tests del frontend
cd web && npm run test:ui
```

## 📊 Cobertura

Los reportes de cobertura se generan en:
- `daemon/coverage/` - Cobertura del daemon
- `web/coverage/` - Cobertura del frontend

## 🚨 CI/CD

Para integración continua, usar:
```bash
bun run test:coverage  # Tests con cobertura
bun run test:e2e       # Tests E2E (inicia servidores automáticamente)
```

## 🐛 Troubleshooting

### Tests no pasan
1. Verificar que las dependencias estén instaladas
2. Para tests E2E, usar `bun run test:e2e` (inicia servidores automáticamente)
3. Si ejecutas manualmente, asegurar que el daemon esté ejecutándose en puerto 3001
4. Revisar logs de error en la consola

### Cypress no encuentra elementos
1. Agregar `data-cy` attributes a los elementos
2. Usar `cy.wait()` para operaciones asíncronas
3. Verificar que el daemon esté corriendo en puerto 3001

### Vitest errors
1. Verificar imports y tipos
2. Usar mocks para dependencias externas
3. Configurar jsdom correctamente para tests del frontend

### Bun test errors
1. Verificar que uses `import { ... } from 'bun:test'` en lugar de vitest
2. Usar `mock.module()` para mockear módulos completos
3. Asegurar que los mocks estén antes de cualquier import