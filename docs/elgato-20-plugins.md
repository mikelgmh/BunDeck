# 32 plugins reales de Stream Deck contra el shim (matriz, no sintética)

Fecha: 2026-11-24. Objetivo: matriz real de 20+ plugins gratuitos de la tienda
Elgato (priorizando GitHub) evaluados contra el shim en-Worker, con el código
real del repo (`daemon/src/elgato/manifest.ts` → `analyzeElgatoManifest`,
`daemon/src/elgato/shim/loader-shim.ts` → `isShimCapable`/`needsManualReason`).
No existe `detectElgatoCodeStyle` en el repo: el estilo de código es heurística
manual (sdk = importa `@elgato/streamdeck`; raw = `connectElgatoStreamDeckSocket`
/ `registerEvent` / `new WebSocket` / global `$SD`; unknown = resto).

Relacionado: `docs/elgato-shim-compat.md` (fixtures propias y reglas v1).

## Método

1. Tienda en `marketplace.elgato.com/stream-deck/plugins` (filtro Free) + fichas
   de producto (autor, UUID si visible, tamaño, dial/Keypad, enlace "Get help").
   Verificados con ficha: DeckForge Commander, BambuLink, BambuLab Printer
   Monitor, HasteClip, Windows Utils (vilture), Music Deck Bridge, TL;DR,
   NewBlue Captivate, Glucose & Clock Lite, RiTA, GitHub Utilities.
2. Clonado `--depth 1` en `C:\Users\mikel\AppData\Local\Temp\opencode\elgato-real\`
   (26 repos). Nada instalado en el daemon, nada en `data/plugins`.
3. Análisis con bun (script en Temp, fuera del repo): todos los `manifest.json`
   con `Actions[]` (prof. ≤5, sin `node_modules/.git`), incluidos SDK2 antiguos
   sin `UUID` top-level (el propio `analyzeElgatoManifest` los marca).
4. Build: solo se intentó donde era rápido (ver §5). Sin fixtures nuevas en el repo.

## ⚠️ Hallazgos sobre el propio shim (leer antes que la tabla)

La columna `shimCapable` es el valor literal de `isShimCapable(report)`. El
análisis realista añade tres matices que el código actual NO distingue:

1. **Falso positivo HTML (3 casos).** `analyzeElgatoManifest` deja `runtime:
   'unknown'` + warning para `CodePath: *.html` y, si hay acciones Keypad, el
   plugin sale `compatible=true` → `isShimCapable=true`. Pero un entry HTML
   (Vue/DOM en cgiesche, `plugin.html` clásico en ampdeck, `index.html` en
   homebridge) **no puede ejecutarse dentro de un Worker**. El shim debería
   rechazar `CodePath *.html/*.htm` (o resolver el `<script src>` y evaluar
   solo-JS, fuera de v1).
2. **Estilo raw con entry JS (1 caso: aus-uv).** `bin/plugin.js` moderno
   (SDK3, Node 20) pero usa `ws` + `connectElgatoStreamDeckSocket` directamente,
   sin importar `@elgato/streamdeck`. El stub `node_modules/@elgato/streamdeck`
   del shim no le sirve: necesitaría un **adaptador WS crudo** (servidor
   `-port/-pluginUUID/-registerEvent` emulado en el Worker) o reescritura.
   `isShimCapable` dice true; ejecutarlo hoy falla.
3. **UUID ausente en clásicos (8 casos).** `compatible=false` solo por `Falta
   UUID del plugin` (clipper, countdown, gstrub-HA, webhook-HA, pomodoro,
   sonos, tomato, darth-bankai). Derivable del nombre de carpeta
   `*.sdPlugin` si se quiere rescatarlos (todos son además HTML salvo
   darth-bankai, que sí es `bin/plugin.js` moderno y quedaría a un paso del shim).

Cobertura realista hoy: **14/32 ejecutables directos** (sdk + `.js` + Keypad),
no 18/32.

## Tabla (32 manifests / 26 repos)

Leyenda — Estilo: `sdk` importa `@elgato/streamdeck`; `raw` WebSocket clásico
(`connectElgato…`/`registerEvent`/`new WebSocket`/`$SD-global`); Keypad `n/m` =
acciones ok Keypad sobre totales; Ctrl = `Controllers` distintos vistos;
shim = `isShimCapable` literal; Tienda `sí` = verificado (ficha o README), `s/d` = sin dato.

| # | Plugin (repo) | Autor | UUID | Runtime | Estilo | Keypad | Ctrl | Entry / build | bin | shim | Motivo / nota | Licencia | Tienda |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Australian UV (`streamdeck-plugin-aus-uv`) | peterneave | `com.peterneave.streamdeck-plugin-au-uv` | node | raw (`ws`+`connectElgato…`, SDK3/Node20) | 1/1 | — | `bin/plugin.js` / esbuild (`bundle`) | ✅ tras compilar | true | ⚠️ raw: necesita adaptador WS, el stub SDK no basta | s/d (sin LICENSE) | sí |
| 2 | SEMS Solar (`streamdeck-plugin-sems`) | peterneave | `dev.neave.sems.solar.monitoring` | node | sdk (`@elgato/streamdeck` ^2) | 1/1 | Keypad | `bin/plugin.js` / rollup | ✅ (`rollup -c` verificado) | true | ✅ directo | MIT | sí |
| 3 | DeckForge Commander (`deckforge-commander`) | Renaud Cerrato | `git.renaudcerrato.deckforge` | node | sdk (`@elgato/streamdeck` ^3) | 3/3 | Keypad | rollup + go-task + `sharp` | ❌ | true | ✅ directo (build pesado: go-task+sharp) | Apache-2.0 | sí (ficha Free) |
| 4 | Next Meeting Countdown (`stream-deck-plugin-timer`) | 6-Love-Tennis | `app.6love.next-meeting` | node | sdk | 2/2 | Keypad,Encoder | rollup | ❌ | true | ✅ directo (keypad; dial extra) | MIT (package.json) | sí (README tienda) |
| 5 | Shutdown (`Streamdeck-Plugin`) | LukasRahn | `com.lukas.shutdown` | node | sdk | 2/2 | Keypad | rollup | ❌ | true | ✅ directo | MIT | s/d |
| 6 | Essentials for Spotify (`essentials-for-spotify`) | ntanis-dev | `com.ntanis.essentials-for-spotify` | node | sdk | 24/28 | Keypad,Encoder | rollup (pnpm) | ❌ | true | ✅ directo (4 acciones solo-Encoder se omiten) | ISC | s/d (probable tienda) |
| 7 | Spotify Plus (`stream-deck-spotify-plus`) | xmow49 | `fr.dbenech.spotify-plus` | node | sdk | 8/9 | Encoder* | rollup | ❌ | true | ✅ parcial (1 acción solo-Encoder; *8 sin `Controllers`→Keypad) | s/d | s/d |
| 8 | Spotify Darth Bankai (`spotify-darth-bankai`) | Cognosis LLC | — (sin UUID) | node | sdk | 4/4 | Keypad | `bin/plugin.js` / rollup | ❌ | false | Falta UUID del plugin (rescatable: entry JS moderno) | s/d | s/d |
| 9 | GitHub Utilities (`stream-deck-github-utilities`) | Pedro Fuentes | `com.pedrofuentes.github-utilities` | node | sdk | 12/14 | Keypad,Encoder | rollup | ❌ | true | ✅ directo (2 solo-Encoder se omiten; dial support en tienda) | MIT | sí (ficha tienda) |
| 10 | Ampdeck (`ampdeck`) | rackemrack | — (sin UUID, SDK2) | unknown | raw (clásico) | 8/9 | Encoder* | `plugin.html` / sin build | n/a | true | ⛔ FALSO POSITIVO: entry HTML no corre en Worker | MIT | s/d |
| 11 | Home Assistant (`streamdeck-homeassistant-cgiesche`) | cgiesche | `de.perdoctus.streamdeck.homeassistant` | unknown | raw (Vue3 + `connectElgato…` propio) | 2/2 | Keypad,Encoder | `plugin.html` / vite | n/a | true | ⛔ FALSO POSITIVO: entry HTML+DOM (Vue monta `#app`) | MIT | sí (README tienda) |
| 12 | Homebridge (`streamdeck-homebridge`) | Sergey Tihon | `com.sergeytihon.homebridge` | unknown | raw (clásico) | 3/4 | Encoder* | `index.html` / webpack | n/a | true | ⛔ FALSO POSITIVO: entry HTML | MIT | sí (README App Store) |
| 13 | On Air Clock (`streamdeck-onairclock`) | Marc Herrmann | `fail.marc.onairclock` | node | sdk (v2.0 reescrito SDK3) | 4/4 | Keypad,Encoder | `bin/plugin.js` / rollup | ❌ | true | ✅ directo; ejemplo de migración clásico→SDK3 | MIT | no (README: aún no publicado) |
| 14 | Sonos (`streamdeck-sonos`) | GenericMale | — (sin UUID, SDK2) | unknown | raw (clásico `plugin/index.html`) | 12/12 | — | `plugin/index.html` / sin build | n/a | false | Falta UUID + entry HTML (doble bloqueo) | MIT | s/d |
| 15 | Tomato Timer (`streamdeck-tomato-timer`) | gallowaylabs | — (sin UUID) | unknown | raw (`index.html`) | 1/1 | — | `index.html` / sin build | n/a | false | Falta UUID + entry HTML | MIT | sí (README tienda) |
| 16 | Countdown (`streamdeck-countdown`) | Baptiewright | — (sin UUID, v0.3) | unknown | raw (clásico) | 1/1 | — | `index.html` / sin build | n/a | false | Falta UUID + versión `0.3` no X.Y.Z.0 + HTML | s/d | s/d |
| 17 | Pomodoro (`streamdeck-pomodoro`) | nightillusions | — (sin UUID) | unknown | raw (`plugin.html`, clásico TS) | 1/1 | — | `plugin.html` / npm scripts | n/a | false | Falta UUID + entry HTML | MIT | s/d |
| 18 | HA Webhook (`streamdeck-homeassistant-webhook`) | hendricksond | — (sin UUID, v1.0) | unknown | raw (`plugin/main.html`) | 1/1 | — | `plugin/main.html` / sin build | n/a | false | Falta UUID + versión + HTML | s/d | no (GitHub-only) |
| 19 | HA simple (`streamdeck-homeassistant` gstrub) | gstrub | — (sin UUID) | unknown | raw (`index.html`, basado en sample Philips Hue) | 4/4 | — | `index.html` / sin build | n/a | false | Falta UUID + entry HTML | MIT | no (GitHub-only) |
| 20 | Twitch Clipper (`clipper-streamdeck`) | BigChiefRick | — (sin UUID, SDK2) | unknown | raw (`index.html`+`app.html`) | 1/1 | — | `index.html` / sin build | n/a | false | Falta UUID + entry HTML | MIT | s/d |
| 21 | Clockify (`streamdeck-clockify`) | eXpl0it3r | `dev.duerrenberger.clockify` | native | raw (C#, `.exe`) | 1/1 | — | `Windows/….exe` / .NET | n/a | false | CodePath nativo + versión `1.18` no X.Y.Z.0 | MIT | sí (README marketplace) |
| 22 | SoundDeck (`SoundDeck`) | GeekyEggo | — (sin UUID) | native | raw (C#, `SoundDeck.exe`) | 11/11 | Keypad,Encoder | `.exe` / webpack (solo PI) | n/a | false | CodePath nativo + Falta UUID | GPL-3.0 | sí (README tienda) |
| 23 | Elite Dangerous (`streamdeck-elite`) | mhwlng | — (sin UUID) | unknown | raw (C#, binario sin extensión) | 10/12 | Encoder* | `com.mhwlng.elite` / .NET | n/a | false | Falta UUID (+ binario nativo sin ext) | MIT | s/d |
| 24 | Delayed Text (`streamdeck-delayedtext`) | BarRaider | — (sin UUID, v1.4) | unknown | raw (C#, binario sin extensión) | 1/1 | — | `com.barraider.delayedtext` / .NET | n/a | false | Falta UUID + versión + binario nativo | MIT | s/d |
| 25 | Text File Tools (`streamdeck-textfiletools`) | BarRaider | — (sin UUID, v1.5) | unknown | unknown (C#, binario sin extensión) | 5/5 | — | `com.barraider.textfiletools` / .NET | n/a | false | Falta UUID + versión + binario nativo | s/d | sí (docs barraider→tienda) |
| 26–32 | Samples oficiales Elgato (`streamdeck-plugin-samples`: cat-keys, counter, product-viewer/data-sources, hello-world, image-resizer, lightsout, layouts) | Elgato | `com.elgato.*` (7) | node | sdk | 12/15† | Keypad (6), Encoder (layouts) | `bin/plugin.js` prebuilt en `.streamDeckPlugin` / sin build | ✅ (en releases) | true (6), false (layouts) | ✅ directos salvo `layouts` (dial-only → needs-manual correcto) | MIT | no (ejemplos) |

† layouts: 0/3 Keypad → `Sin acciones Keypad (dial-only)` (único needs-manual estructuralmente correcto entre los JS).

## No-descargables de la tienda (registrados, no saltados)

| Plugin | Autor | Precio | Motivo no-descargable |
|---|---|---|---|
| BambuLink | neverweep | Free | Soporte = solo Discord (`discord.gg/DG2UcfMFPD`); sin GitHub ni descarga directa. 794 KB, dial+Keypad. |
| BambuLab Printer Monitor | Dadolyner | Free | Soporte = "Contact the Maker"; sin GitHub visible. 160 KB, Keypad. |
| Windows Utils | vilture | Free | Soporte = "Contact the Maker"; sin GitHub visible. 148 KB, Keypad. |
| HasteClip | HasteClip | Free | "Get help" genérico sin URL/GitHub; `Additional links: Related Download` (web del vendor). 130 KB, dial+Keypad. |
| Music Deck Bridge | minjungw00 | Free | Vista en listado Free; sin GitHub localizado en esta pasada. |
| TL;DR | TLDR | Free | Vista en listado Free; sin GitHub localizado en esta pasada. |
| NewBlue Captivate | NewBlue | Free | Vista en listado Free; sin GitHub localizado en esta pasada. |
| Glucose & Clock Lite | DiaHub | Free | Vista en listado Free; sin GitHub localizado en esta pasada. |
| RiTA | Global Audio Solutions | Free | Vista en listado Free; sin GitHub localizado en esta pasada. |

## Resumen

- 26 repos / **32 manifests con código**: `shimCapable=true` según código en
  **18**, `false` en **14**.
- Descontando falsos positivos HTML (nº 10–12) y el raw-JS (nº 1): **14/32
  (≈44 %) ejecutables directos hoy** (sdk + `.js` + Keypad, licencias
  abiertas). Los 14: nº 2–7, 9, 13 y 6 samples Elgato.
- **Necesitan adaptador raw** (protocolo WS `-port/-pluginUUID/-registerEvent`
  emulado): nº 1 (aus-uv, moderno), y opcionalmente nº 14–20 si antes se
  resuelven UUID+HTML.
- **Imposibles hoy** (nativos/diales): nº 21–25 (`.exe`/binarios C# — ojo:
  `delayedtext/elite/textfiletools` ni siquiera declaran UUID ni versión
  X.Y.Z.0) y `layouts` (dial-only, needs-manual correcto).
- **Rescate barato**: nº 8 (darth-bankai) es JS moderno con `bin/plugin.js`;
  solo le falta el UUID top-level (derivable de la carpeta o pedírselo al
  importador).
- Licencias: 20 MIT, 1 ISC (essentials), 1 Apache-2.0 (deckforge), 1 GPL-3.0
  (SoundDeck), 5 sin declarar (aus-uv, spotify-plus, darth-bankai, countdown,
  webhook-HA). Respetadas: sin redistribución de binarios, sin fixtures nuevas
  en el repo.

## Build (§4, solo rápido)

- ✅ `streamdeck-plugin-aus-uv`: `bun install` (86 pkgs, 8 s) + `bun run bundle`
  (esbuild) → `com.peterneave.streamdeck-plugin-au-uv.sdPlugin/bin/plugin.js`
  (277 KB). Estilo confirmado raw (`connectElgatoStreamDeckSocket` + `ws`).
- ⏳→✅ `streamdeck-plugin-sems`: `bun install` (120 pkgs, 11 s) + `bun run build`
  (`rollup -c`, 3 s) → `dev.neave.sems.solar.monitoring.sdPlugin/bin/plugin.js`.
  Compila limpio.
- No intentados (pesados o con toolchain extra): deckforge (go-task+sharp),
  essentials (pnpm), cgiesche (vite+vue), homebridge (webpack+Fable/.NET),
  onairclock/next-meeting/shutdown/github-utils/spotify-plus (rollup+ts;
  deps publicadas, compilables por el usuario con `npm install && npm run build`).

## Recomendaciones para el shim (backlog, no implementado aquí)

1. Rechazar `CodePath *.html/*.htm` en `analyzeElgatoManifest` (motivo claro)
   en vez de dejarlo pasar como `unknown`+warning → elimina 3 falsos positivos.
2. Aceptar UUID ausente derivándolo de la carpeta `*.sdPlugin` (warning en vez
   de error) → rescata 8 clásicos + darth-bankai (solo este último ejecutable).
3. Exigir versión X.Y.Z.0 solo como warning (clockify/delayedtext traen `1.18`,
   `1.4`…) o mantener como está si se quiere estricto: documentarlo.
4. Adaptador raw-WS v2: emular `-port/-pluginUUID/-registerEvent` + `global
   connectElgatoStreamDeckSocket` en el Worker → cubriría aus-uv y, con (2),
   los clásicos HTML-embebidos si además se resuelve su `<script>`.
5. `isShimCapable` debería exigir `style==sdk && ext==.js`, no solo
   `runtime!=native`.
