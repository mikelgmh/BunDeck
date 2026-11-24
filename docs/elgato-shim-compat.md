# Matriz de compatibilidad — Shim Elgato en-Worker (v2)

Fecha: 2026-11-24. Modo: `elgato/shim/` (cero procesos `node`, cero `Bun.serve` por plugin).
Legacy por proceso (`host.ts`/`runtime.ts`): deprecated, solo con `LIBREDECK_ELGATO_SHIM=0`.

El shim distingue dos estilos de CodePath (`detectElgatoCodeStyle` en
`elgato/shim/detect.ts`, heurística sin ejecutar):
- `sdk`: importa `@elgato/streamdeck` → bridge clásico (auto-registro en el
  falso SDK).
- `raw`: protocolo WebSocket en crudo sin SDK (`new WebSocket` +
  `registerEvent`/`registerPlugin` + `setTitle`/`setImage`/`getSettings`/...)
  → bridge raw con transporte virtual en memoria (`raw-transport.ts`).
- `unknown`: sin marcadores → se trata como SDK (camino por defecto).

## Fixtures versionadas (propias, JS puro, Keypad)

Viven en `daemon/src/test/fixtures/elgato/<nombre>-v<N>/` y se ejercitan en
`daemon/src/test/elgato-shim.test.ts` (bun:test) y
`web/tests/e2e/elgato-shim.spec.ts` (Playwright, requiere daemon en :3001).

| Fixture | Versión | Cubre | Resultado bun:test |
|---|---|---|---|
| `counter-v1` | 1.0.0 | keyDown/Up, willAppear, settings persistidas, setTitle/setState, hold corto+largo, contexto único por botón, import→key→state, arranque <2s | ✅ |
| `clock-settings-v1` | 1.2.0 | settingsSchema desde `SettingsDefaults`, params→settings, didReceiveSettings, sendToPropertyInspector→evento | ✅ |
| `image-v1` | 1.0.0 | setImage relativo resuelto contra `elgato/` | ✅ |
| `alert-v1` | 2.0.0 | showAlert/showOk alternados | ✅ |
| `openurl-v1` | 1.0.0 | system.openUrl → evento `system.open-url` (sin abrir nada en servidor/tests) | ✅ |
| `multi-v1` | 1.1.0 | 2 acciones Keypad, 1 acción LibreDeck por acción Elgato, contextos independientes | ✅ |
| `mixed-v1` | 1.0.0 | Keypad funciona + DialAction rechazado explícitamente (`elgato.dial-rejected`, sin tumbar) | ✅ |
| `sdk-v1` | 1.0.0 | Fixture SDK mínima (register + willAppear/keyDown/Up vía `@elgato/streamdeck`) | ✅ |
| `raw-v1` | 1.0.0 | Fixture raw mínima estilo AUS-UV (`new WebSocket` + `registerPlugin` + `setTitle` al `keyDown`, eco de settings) | ✅ |
| `dialonly-v1` | 1.0.0 | dial-only → import `needs-manual` apagado con motivo | ✅ (análisis) |

## Matriz por estilo de plugin (bridge v2)

| Tipo (UUID) | Estilo | Estado esperado | Notas |
|---|---|---|---|
| DeckCal (`com.ewels.deckcal`) | SDK | ✅ esperado | Caso de referencia de la auditoría; requiere `bin/plugin.js` compilado o build desde fuentes (automático si hay `package.json`+`scripts.build`) |
| SEMS (`dev.neave.sems.solar.monitoring`, SDK `@elgato/streamdeck ^2.0.0` + rollup) | SDK | ✅ esperado | `tryBuildElgatoFromSource` ejecuta `rollup -c` vía `scripts.build`; bridge clásico sin cambios |
| AUS-UV (`com.peterneave.streamdeck-plugin-au-uv`, raw `ws@8` + `fast-xml-parser`, bundle esbuild) | raw | ✅ esperado | `tryBuild` prueba `scripts.build` y cae a `scripts.bundle` (esbuild, reintento con npm); el bridge prefiere la fuente raw (`plugin.js`) al bundle opaco y reescribe `from "ws"` al socket virtual |
| Cualquier plugin JS + solo Keypad (SDK) | sdk | ✅ esperado | Si solo trae `CodePathMac`/`CodePathWin` sin genérico, `isElgatoManifest` ya lo acepta |
| Cualquier plugin JS + solo Keypad (raw, sin SDK) | raw | ✅ esperado | Transporte virtual: `willAppear/keyDown/keyUp/didReceiveSettings/didReceiveGlobalSettings` + `setTitle/setImage/setState/showAlert/showOk/setSettings/getSettings/setGlobalSettings/getGlobalSettings/openUrl/logMessage/sendToPropertyInspector`; mismo contexto único por botón (`ld:<plugin>:<acción>:<buttonId>`) y hold real |
| Plugin con `.exe`/`.dll`/`.so` o `bin/` nativo | nativo | ⛔ `needs-manual` | Sin ejecutables en el Worker; motivo en `last_error` |
| Plugin solo dial/encoder | dial-only | ⛔ `needs-manual` | Sin equivalente hardware; motivo en `last_error` |

## Plugins reales de marketplace.elgato.com (validación manual)

No se descargan automáticamente: las licencias de cada plugin lo permiten para
uso propio, pero no redistribuimos binarios. Procedimiento: descargar el
`.streamDeckPlugin` desde la tienda, `POST /api/v1/plugins/import-elgato`
con `{ "url": "file:///..." }` o `{ "dir": "<carpeta>" }`, y registrar aquí.

> Nota: los plugins raw usan `fetch` global (red directa) en vez de
> `http.fetch` mediado: necesitan el permiso `network` igualmente, pero el
> tráfico no pasa por el puente del padre (límite 30s/5MB no aplicable).

| Plugin (UUID) | Tipo | Estado esperado | Notas |
|---|---|---|---|
| Plugin con Property Inspector web | JS/Node | ⚠️ parcial | La PI no tiene UI en LibreDeck: `sendToPropertyInspector` → log + evento `elgato.pi-send`; los ajustes se editan vía `settingsSchema` generado |
| Plugin con `switchToProfile` | JS/Node | ⚠️ emulado | No-op avisado + evento `profile.switch` (mapeo a page/select pendiente) |

## Qué queda fuera de v2 (explícito)

- Diales/encoders (`DialAction`, `onDialRotate/...`): rechazo explícito, sin render.
- Property Inspector HTML: sin WebView; ajustes vía schema generado + `didReceiveSettings` en cada pulso.
- `switchToProfile` real (navegación entre páginas por nombre Elgato): emulado como no-op avisado.
- `setImage` binario en la UI: la ruta se resuelve contra el paquete y viaja en `elgato.state`, pero el render depende del frontend.
- `titleParameters`/`deviceDidConnect`/`appLaunch` con valores reales: emitidos con valores básicos documentados como emulados (coordenadas `{0,0}`, `userDesiredState {}`).
- Dependencias nativas (`node-gyp`, `node-hid`, `serialport`, `sqlite3`, ...): no se instalan; el plugin queda `needs-manual` con el motivo.
- Nodos `bin/` sin compilar y sin `scripts.build`/`scripts.bundle`: `needs-manual` (CodePath ausente).
- Bundles opacos sin fuentes raw (bundle con `ws` dentro y sin `plugin.js` fuente en el paquete): el bridge cae al camino SDK/`unknown`; sin adaptador posible hasta que el autor publique fuentes.
- `sendToPlugin`/`didReceiveGlobalSettings` push en caliente (SDK): los settings globales se leen/escriben, pero el push al Worker ocurre en el próximo pulso/willAppear.

## Detalles de implementación del camino raw (v2)

- Bun trae un `ws` incorporado con prioridad sobre `node_modules` (ni `paths`
  de tsconfig ni `Bun.plugin(onResolve)` lo ven): el stub `node_modules/ws`
  es solo fallback para otros runtimes. El bridge genera
  `elgato/shim-raw-entry.js` (copia del entry con `from "ws"`/`import("ws")`/
  `require("ws")` reescritos a `elgato-raw-transport.js`); las fuentes
  originales no se tocan y los imports relativos se preservan (la copia vive
  en el mismo directorio).
- Si el CodePath es un bundle opaco (esbuild/rollup con `ws` dentro),
  `findRawSourceEntry` prefiere la fuente raw del paquete que mencione el
  UUID (caso AUS-UV: `plugin.js` sobre `bin/plugin.js`); el entry efectivo
  queda en `x-elgato.bridgeEntry` del manifest convertido.
- `installRawGlobals` fija `globalThis.WebSocket` al socket virtual y
  `process.argv` (`-port/-pluginUUID/-registerEvent`) antes del import
  dinámico del entry; el import es dinámico a propósito (un static import se
  izaría antes que los globales).
- `WebSocket.Server` lanza (cero `Bun.serve` por plugin); `process.argv` real
  del Worker no se usa para nada más.
