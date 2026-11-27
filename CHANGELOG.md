# [1.24.0](https://github.com/mikelgmh/BunDeck/compare/v1.23.0...v1.24.0) (2026-11-27)


### Bug Fixes

* **relay:** separa rate-limit WS en buckets control/datos con fail-fast 429 ([303627b](https://github.com/mikelgmh/BunDeck/commit/303627b6cbf44ebea03577e32c554caa594208b5))
* **test:** elimina flake de hw-repaint-coalescing en CI ([433e3fc](https://github.com/mikelgmh/BunDeck/commit/433e3fcb1576799592b8ec5f20efd3ef25c15a59))


### Features

* **free:** volumen por gesto, persistencia solo gestual y 404/400 en PUT ([ae9db9d](https://github.com/mikelgmh/BunDeck/commit/ae9db9d145ae724c587e32b0a17f577cdeb77fc8))

# [1.23.0](https://github.com/mikelgmh/BunDeck/compare/v1.22.2...v1.23.0) (2026-11-27)


### Bug Fixes

* **ci:** instala deps del relay y ejecuta sus tests en el pipeline ([fd0b88b](https://github.com/mikelgmh/BunDeck/commit/fd0b88b47757fe46937acdeead7225d404192a40))


### Features

* **remote:** auth del relay por dispositivo con claim automatico ([bac5c50](https://github.com/mikelgmh/BunDeck/commit/bac5c5070f6da9e46eebe16ed90657d3b0ec8500))

## [1.22.2](https://github.com/mikelgmh/BunDeck/compare/v1.22.1...v1.22.2) (2026-11-27)


### Bug Fixes

* **launcher:** auto-apply updates, single-instance prompt, tray persistence, tests and CI ([b9e5018](https://github.com/mikelgmh/BunDeck/commit/b9e5018b99795b19e34759519d6f910a3878f5f6))

## [1.22.1](https://github.com/mikelgmh/BunDeck/compare/v1.22.0...v1.22.1) (2026-11-26)


### Bug Fixes

* dedupe dynamic polls and identify action errors ([b3c5168](https://github.com/mikelgmh/BunDeck/commit/b3c51687f2b8f0083bed69653df3e3a3afc963fd))

# [1.22.0](https://github.com/mikelgmh/BunDeck/compare/v1.21.0...v1.22.0) (2026-11-26)


### Features

* add interactive widgets and harden feedback ([dfcf1b8](https://github.com/mikelgmh/BunDeck/commit/dfcf1b899d3c191d52c875a8611c84091c5d3056))

# [1.21.0](https://github.com/mikelgmh/BunDeck/compare/v1.20.0...v1.21.0) (2026-11-26)


### Bug Fixes

* **lan:** modal sin hueco, probe via apiPort y puerto UI correcto en dev ([c44c165](https://github.com/mikelgmh/BunDeck/commit/c44c1657f952d5b7b4c652b2c87e5017eda7897b))
* **security:** handoff LAN post-aprobacion, sin invite pre-aprobacion ([16e6ec0](https://github.com/mikelgmh/BunDeck/commit/16e6ec06cfe05cc4636dc5c6743228541cd877bd))


### Features

* **relay:** boton manual Abrir version local en la waiting ([a53c518](https://github.com/mikelgmh/BunDeck/commit/a53c5187d2176f69f43acfe0b4da977a80c44efd))

# [1.20.0](https://github.com/mikelgmh/BunDeck/compare/v1.19.0...v1.20.0) (2026-11-26)


### Bug Fixes

* **relay:** puentes /s/ aceptados en onTunnelBridgeOpen + etiqueta honesta del pilotito ([8b4ad3b](https://github.com/mikelgmh/BunDeck/commit/8b4ad3b533aec38b5f9482c55bd6de9e6799a8d3))


### Features

* **kiosco:** dialogo de historial con UX de modales y IPs probadas visibles ([70c2a0d](https://github.com/mikelgmh/BunDeck/commit/70c2a0dc7c200d260ba9c8c8e6b17c27fa6d7418))
* **kiosco:** pilotito clicable con historial de conexion y waiting LAN visible ([52bf7fe](https://github.com/mikelgmh/BunDeck/commit/52bf7fe9da0e8d1a4a2fc39c48837dc907126c46))

# [1.19.0](https://github.com/mikelgmh/BunDeck/compare/v1.18.0...v1.19.0) (2026-11-26)


### Features

* **relay:** split-token sid en URL mas secreto en cookie HttpOnly ([ddbca68](https://github.com/mikelgmh/BunDeck/commit/ddbca68eca7accd82aa61c10c823308ece5e1d79))

# [1.18.0](https://github.com/mikelgmh/BunDeck/compare/v1.17.0...v1.18.0) (2026-11-26)


### Features

* **kiosco:** barra inferior flotante y dialogo de conexion redisenado ([703103d](https://github.com/mikelgmh/BunDeck/commit/703103da8b551aab5e52fa9940da82ff9a312204))
* **remote:** fast-path LAN con auto-redirect pre-aprobacion y paso de kiosco honesto ([09ffa8f](https://github.com/mikelgmh/BunDeck/commit/09ffa8ff66ba480c0b4276edb7c7e346f2a7596c))

# [1.17.0](https://github.com/mikelgmh/BunDeck/compare/v1.16.0...v1.17.0) (2026-11-26)


### Bug Fixes

* **daemon:** ActionRunner usa el VariableStore compartido (sin cachés divergentes) ([7e88b8e](https://github.com/mikelgmh/BunDeck/commit/7e88b8ea27047daa9e84e690cd9f458a4d005201))
* **db:** WAL + busy_timeout + synchronous NORMAL ([ebc4c52](https://github.com/mikelgmh/BunDeck/commit/ebc4c5252b080b9c2978befded74fe8714a60827))
* **discord:** AUTHENTICATE idempotente en conexion reutilizada ([d0d5760](https://github.com/mikelgmh/BunDeck/commit/d0d5760cb9ba19e7a5d5685d95abcfe43ca457f8))
* **discord:** mute determinista al primer intento + errores visibles ([ef1ab6b](https://github.com/mikelgmh/BunDeck/commit/ef1ab6bf177d75299231ce1e0d1f275d9400218e))
* **relay:** el watcher de web-dist vigilaba una ruta inexistente y la UI remota quedaba obsoleta ([f90257b](https://github.com/mikelgmh/BunDeck/commit/f90257bf5ff5c1784fa74d90923b419c8c51ef36))
* **tests:** aislar data-dir en plugin-loader/hw-coalesce/plugin-install con claimDataDir ([69d4ad1](https://github.com/mikelgmh/BunDeck/commit/69d4ad1c7c2926f1efeef1e4597bf38446ae79e6))


### Features

* **aspecto:** variables expuestas por acciones + condiciones simples ([0071bff](https://github.com/mikelgmh/BunDeck/commit/0071bff5343a8cf28785e9ff05417b7955e9ae97))
* **dev:** watcher de web/src reconstruye web-dist al guardar ([42e8eea](https://github.com/mikelgmh/BunDeck/commit/42e8eea74af35af9a3faa3e2b86f28e68ba72c03))
* variables en vivo con tipo, presets de aspecto y color libre por condición ([ba9b48b](https://github.com/mikelgmh/BunDeck/commit/ba9b48bf9f6d196bf56b8fdb3016ec7851c6d20d)), closes [#rrggbb](https://github.com/mikelgmh/BunDeck/issues/rrggbb)


### Performance Improvements

* **hw:** coalescing+backoff en repaints HID ([5de2454](https://github.com/mikelgmh/BunDeck/commit/5de2454c19aa05bb517e4f8a22a57da97a7aee96))
* **hw:** repaint diferencial por boton + cache de imagenes ([74730aa](https://github.com/mikelgmh/BunDeck/commit/74730aa71bb94ff2828b2f66acedd5c052bd840a))
* **hw:** status sin spawn si ya conectado + TTL 30s ([97ac459](https://github.com/mikelgmh/BunDeck/commit/97ac4596ca9b18a29c21fb5458ce757c97582361))
* **tunel:** sin trompicones por relay ([7df5e9f](https://github.com/mikelgmh/BunDeck/commit/7df5e9f76623bc790847c5ca6b3bf2e54cae5086))

# [1.16.0](https://github.com/mikelgmh/BunDeck/compare/v1.15.0...v1.16.0) (2026-11-25)


### Bug Fixes

* **discord:** callback y modal distinguen token de RPC ([254b3b2](https://github.com/mikelgmh/BunDeck/commit/254b3b2343aa40425c2d7d4f7012d5266fb44dde))
* **discord:** diagnostico auto-entrega y header Private-Network ([461c84d](https://github.com/mikelgmh/BunDeck/commit/461c84dad9074eff2ee8a393f56b7ead678b62a3))
* **discord:** redirect https por defecto y estado real en ajustes ([90128a2](https://github.com/mikelgmh/BunDeck/commit/90128a26267e06ab7c6d59733359c0c2c7f212fd))
* **discord:** waitReady no revienta si disconnect corre antes del timeout ([fb217d0](https://github.com/mikelgmh/BunDeck/commit/fb217d0e77f54d8bad23ba9bcac94f71a8b9036e))


### Features

* **discord:** RPC por pipe IPC como transporte primario ([da2a6dc](https://github.com/mikelgmh/BunDeck/commit/da2a6dc244a34ad2cdcd38574c348ba26a1f4256))
* **discord:** UX simple con spinner y desconectar ([9dfcdc2](https://github.com/mikelgmh/BunDeck/commit/9dfcdc2d1dd966f96870cf9f0480e82a9bb4e775))

# [1.15.0](https://github.com/mikelgmh/BunDeck/compare/v1.14.0...v1.15.0) (2026-11-25)


### Features

* **discord,remote,hw,kiosco:** Discord RPC zero-config, relay URL configurable, asignacion HW al arranque, dialog P2P en kiosco ([32c142c](https://github.com/mikelgmh/BunDeck/commit/32c142c22a8c292e5dd4ee5bf8d086b1a65a1c78))
* **discord:** app real zero-config y callback https en relay ([fcd7fff](https://github.com/mikelgmh/BunDeck/commit/fcd7ffffcb0856659023a178e3e9a003c45c520c))

# [1.14.0](https://github.com/mikelgmh/BunDeck/compare/v1.13.1...v1.14.0) (2026-11-25)


### Bug Fixes

* **kiosco:** banner y modal sin solapes en movil + modal siempre visible ([5f921e5](https://github.com/mikelgmh/BunDeck/commit/5f921e58f5a337e8b6b328bf4c0ed0fae5beff69))
* **profiles:** al cambiar de perfil cada dispositivo va a su pagina asignada ([52da0fc](https://github.com/mikelgmh/BunDeck/commit/52da0fc8959014f4eae7f58d10a274426c3675dd))
* **relay:** la pagina de sesion no valida enlaza al escaner de QR ([f7a5c4e](https://github.com/mikelgmh/BunDeck/commit/f7a5c4ee50d10e2f855c22d9dc534997ec3cb2b7))
* **remote:** modal aprobacion compacta + nombre en QR + pendiente se limpia ([4852ea6](https://github.com/mikelgmh/BunDeck/commit/4852ea6c642aee44c8674b8c296a9413fc0b2b01))
* **remote:** regenerar el QR tras denegar (y tras aprobar en QR) ([abca88a](https://github.com/mikelgmh/BunDeck/commit/abca88ac202bcda368b31724f4382d9226c4896e))
* **remote:** spinner P2P en vista de aprobado + dialogo sin hueco ([84386b8](https://github.com/mikelgmh/BunDeck/commit/84386b8ef1c13b7b3de2fbb2402d2fb53bc7b852))
* **security:** revocar corta de verdad la sesion remota ([d5df93b](https://github.com/mikelgmh/BunDeck/commit/d5df93b4c502c0fdeb38150c476a9ef9b27a1c8e))
* **tests:** aislar BUNDECK_DATA_DIR por fichero para CI determinista ([a15711b](https://github.com/mikelgmh/BunDeck/commit/a15711b7ce59d268fe297929569784a96544d776))
* **tests:** el test de window-action minimize ya no minimiza de verdad ([c35ced8](https://github.com/mikelgmh/BunDeck/commit/c35ced86e4c94e91fef1321cff43835f69d18db9))


### Features

* **logs:** registros por pulsacion (boton, accion, dispositivo) + higiene e2e ([16ee192](https://github.com/mikelgmh/BunDeck/commit/16ee192fa614cfc7ac4ac195f38b9de1ae0979bb))
* **remote:** nombre del dispositivo al aprobar (sugerido iPad Safari, editable) ([26b8701](https://github.com/mikelgmh/BunDeck/commit/26b8701b79f95a26817b217d639149169d33edd3))
* **remote:** renombrar dispositivo desde sesiones + revoke limpia la lista ([e39abc7](https://github.com/mikelgmh/BunDeck/commit/e39abc74f5134e4c05d9e4eeb11c9a9e3ce0be08))
* **remote:** sesiones perennes (sin caducidad) por defecto ([7583704](https://github.com/mikelgmh/BunDeck/commit/7583704bfe5caec24ebb499784e97d3e525f7d1d))
* **spotify:** login bajo demanda desde cualquier dispositivo + quitar Electrobun muerto ([322d46d](https://github.com/mikelgmh/BunDeck/commit/322d46d5617ae23cfd5f8a147cc7f85acd87a694))
* **ui:** modal de conexion en tunel + dot de transporte en kiosco ([0d5c81f](https://github.com/mikelgmh/BunDeck/commit/0d5c81fc5f3e2c5e051f23b2358c2d6c58b80923))
* **ui:** tabs de modo como select en movil (<=700px) ([2b8fb3c](https://github.com/mikelgmh/BunDeck/commit/2b8fb3ce9a2e58ff953d0395d9e7bbf6d6aa34e1))

## [1.13.1](https://github.com/mikelgmh/BunDeck/compare/v1.13.0...v1.13.1) (2026-11-25)


### Bug Fixes

* **relay:** pagina amable en /ui/ con codigo desconocido + e2e enlazar-dispositivo ([ed5b5bb](https://github.com/mikelgmh/BunDeck/commit/ed5b5bbb8e4a330f1fd19628006b0f2c2dfd7592))

# [1.13.0](https://github.com/mikelgmh/BunDeck/compare/v1.12.1...v1.13.0) (2026-11-25)


### Features

* devices, autostart, shortcuts, display e2e y pulido web ([96b8c3c](https://github.com/mikelgmh/BunDeck/commit/96b8c3cfe66ce778036fdf5b1417dc494d5ca75f))

## [1.12.1](https://github.com/mikelgmh/BunDeck/compare/v1.12.0...v1.12.1) (2026-11-25)


### Bug Fixes

* **cli:** bundeck-first daemon exe matching with libredeck fallback ([6a4716e](https://github.com/mikelgmh/BunDeck/commit/6a4716e2ba564983bc60c194ece557f640487783))
* **cli:** manifest URL and process names to bundeck, keep legacy fallbacks ([10a18c9](https://github.com/mikelgmh/BunDeck/commit/10a18c9b998eee49554149b197e2944a860a5268))

# [1.12.0](https://github.com/mikelgmh/BunDeck/compare/v1.11.1...v1.12.0) (2026-11-25)


### Features

* rename BunDeck canonico en binarios, envs y docs + trust bundle ([cca3be2](https://github.com/mikelgmh/BunDeck/commit/cca3be29d370682078e43bc75adba3ca0f98b3a3))

## [1.11.1](https://github.com/mikelgmh/BunDeck/compare/v1.11.0...v1.11.1) (2026-11-24)


### Bug Fixes

* **ci:** restore libredeck binary names in build jobs until rename lands whole ([bd97a9d](https://github.com/mikelgmh/BunDeck/commit/bd97a9d62ae5c91050a50327ae311278297cd820))

# [1.11.0](https://github.com/mikelgmh/BunDeck/compare/v1.10.6...v1.11.0) (2026-11-24)


### Bug Fixes

* **ci:** build web + system fonts in test job; installer tracks libredeck binaries ([b66209a](https://github.com/mikelgmh/BunDeck/commit/b66209a775ce4dab24e3f9e6735f0084bf9a64a8))
* **ci:** bump napi-rs canvas 1.0.9 to 1.2.0 for Linux font discovery ([8c1a5c6](https://github.com/mikelgmh/BunDeck/commit/8c1a5c627a37b1a762ea7ad093f217d49b9ce8b0))
* **devices:** asignacion de pantalla con cambio instantaneo por WS ([11b8aa8](https://github.com/mikelgmh/BunDeck/commit/11b8aa83bb1a908e157df55bd10f97d9d13ab3ec))
* **devices:** el desplegable vuelve a listar solo online ([dc23dfc](https://github.com/mikelgmh/BunDeck/commit/dc23dfc6a09a98bab5d5297b146dd87aa1c5b21c))
* **devices:** el HW sigue la asignacion explicita aunque su sesion este en otro perfil ([2b22ee1](https://github.com/mikelgmh/BunDeck/commit/2b22ee1689eee3116cca3df5aa264d9f07a59cdb))
* **hw:** navigatePageTo dirigido al HW fija su sesion (cubre MCP/flujos) ([906138d](https://github.com/mikelgmh/BunDeck/commit/906138d6ddae55f940f38af787d0931c9095c9cc))
* **kiosk:** click/doble/triple/hold funcionan tambien en kiosco tactil ([6423994](https://github.com/mikelgmh/BunDeck/commit/6423994b393fead605d66299a50e3fe56dcc2a27))
* **relay): rate-limit diferenciado por token + trust proxy + retry-after; feat(webrtc:** DataChannel P2P daemon-frontend con fallback relay ([10c90db](https://github.com/mikelgmh/BunDeck/commit/10c90dbe776f23cd047787dbc5950804e8a811cd))
* **relay:** auto-ir navegaba a /%5Ehttps:/ por regex con barras escapadas en el template ([2dda60a](https://github.com/mikelgmh/BunDeck/commit/2dda60acb925d53042c933e6bcaa1db7f6c61021))
* **relay:** escaner QR de la landing con fallback auto-hospedado (jsqr) para navegadores sin BarcodeDetector (Safari/iPad) ([a15ac80](https://github.com/mikelgmh/BunDeck/commit/a15ac804651a9369206f1850d9a6e96f854fbc9b))
* **remote:** auto-ir tras escanear QR de acceso; timeouts adaptativos en tunel; reintento de hello y aviso de ws-msg huerfano ([cbdf872](https://github.com/mikelgmh/BunDeck/commit/cbdf872813c792792ae67086496607f56cc99aea))
* **remote:** el tunel vuelve a servir el build (el proxy a Astro dev rompia el JS); auto-rebuild en DEV si src es mas nuevo ([ca81ce8](https://github.com/mikelgmh/BunDeck/commit/ca81ce866922ca7bc15179155bd343affb760bcc))
* **remote:** las sesiones del tunel sobreviven a reinicios del daemon y del relay ([3c26998](https://github.com/mikelgmh/BunDeck/commit/3c26998c6521e8412e92857f586f8e5a381f975c))
* **remote:** URL visible en pestana internet del QR; UI viva de Astro por el tunel en DEV y no-store en HTML (iOS) ([cc688e4](https://github.com/mikelgmh/BunDeck/commit/cc688e4286c4e55d115bb64c875ba79cac0f5a24))
* **remote:** web/dist va antes que la copia vieja daemon/web-dist en DEV (y corrige niveles http/) ([01379b9](https://github.com/mikelgmh/BunDeck/commit/01379b9b782caa1f1161f4df542b840c04a44a15))
* **site:** align hero copy with page content on desktop ([c43f782](https://github.com/mikelgmh/BunDeck/commit/c43f782fd5448c4fc5e31e31516a44fddae631fa))
* **site:** mobile hero buttons inline, hide mascot, icon-only github nav, bento features grid ([7bff24b](https://github.com/mikelgmh/BunDeck/commit/7bff24bf38c238354931f5ec5466d09bfa309d4b))
* **site:** restore home workflow section to original design ([78b84fc](https://github.com/mikelgmh/BunDeck/commit/78b84fc0dda972391ce743031db64327b07d7084))
* **ui:** los chips de pagina muestran un solo icono de dispositivo ([7cbd623](https://github.com/mikelgmh/BunDeck/commit/7cbd6235ef8f79025563d62dde11f5553eea3d7a))
* **web:** kiosco encaja el grid a lo ancho y alto sin deformar ([f313fc7](https://github.com/mikelgmh/BunDeck/commit/f313fc73dc7c408fe6f9cc74b42459d0f1f10470))


### Features

* **elgato:** shim en-Worker sin emulacion (sdk + raw) y matriz de 20 plugins ([b3005c5](https://github.com/mikelgmh/BunDeck/commit/b3005c5ca015a4fd65ce7b92257aaafcef47a980))
* gestion de dispositivos en Acceso remoto, nombres por navegador y popover solo en linea ([3c4e49c](https://github.com/mikelgmh/BunDeck/commit/3c4e49c23f8d30fb5a051cbb5ddd2deaf067998c))
* mejoras de dispositivos, pintado de teclas y compatibilidad ([6d33406](https://github.com/mikelgmh/BunDeck/commit/6d33406a6310d8041cf2ca2f158beb5936918ec7))
* press FX + acciones por pulsacion, kiosco, QR relay, LAN por invitacion, grid por pagina ([6fc9043](https://github.com/mikelgmh/BunDeck/commit/6fc904326fcb1d11b39e2ec6809de05b7929e647))
* **remote:** avisar transporte WebRTC vs relay en dialogo de aprobacion y sesiones ([69a28c0](https://github.com/mikelgmh/BunDeck/commit/69a28c0dc61410b6ed62aa0c7a7e71a074db6910))
* **remote:** transporte P2P/Relay visible en sala de espera, banner de sesion y dialogo de aprobacion ([3f9cb04](https://github.com/mikelgmh/BunDeck/commit/3f9cb041cbad7d01403545a20fa06c97ac15b489))
* **streamdeck:** importacion de perfiles (detect, import, bienvenida y ajustes) ([5ef0666](https://github.com/mikelgmh/BunDeck/commit/5ef066624d143714e9155ac0907608d2fe2c41cb))
* **web:** exportar e importar perfil desde el menu del tab ([02230c9](https://github.com/mikelgmh/BunDeck/commit/02230c93d04fa04742ec6d67e5669b91b4a3133f))

## [1.10.6](https://github.com/mikelgmh/libredeck/compare/v1.10.5...v1.10.6) (2026-11-23)


### Bug Fixes

* **qa-2:** snapshot de Deshacer desde la API + e2e de reglas load ([79892be](https://github.com/mikelgmh/libredeck/commit/79892bed5f9947c620ac806d7d4a949483ca373e))

## [1.10.5](https://github.com/mikelgmh/libredeck/compare/v1.10.4...v1.10.5) (2026-11-23)


### Bug Fixes

* **qa:** tormenta assignments, undo sin botones, duplicado forward, race resize, rename ES, icono autosave, resize acotado, búsqueda unificada ([11a6520](https://github.com/mikelgmh/libredeck/commit/11a6520f4b002f8534beef21ddece9627d88a4bb))

## [1.10.4](https://github.com/mikelgmh/libredeck/compare/v1.10.3...v1.10.4) (2026-11-23)


### Bug Fixes

* **free-mode:** toggle estable, filas acotadas, icono por defecto y e2e herméticos ([7329049](https://github.com/mikelgmh/libredeck/commit/7329049f8c199381b29d0a14efd0d8d01a7549bc))

## [1.10.3](https://github.com/mikelgmh/libredeck/compare/v1.10.2...v1.10.3) (2026-11-23)


### Bug Fixes

* **perf:** carga inicial en paralelo, plugins nativos completos y resync diferido de botones ([19653fc](https://github.com/mikelgmh/libredeck/commit/19653fc3f4734ee223ed3b9c671d174a7c062ed9))

## [1.10.2](https://github.com/mikelgmh/libredeck/compare/v1.10.1...v1.10.2) (2026-11-23)


### Bug Fixes

* **updater:** bake LIBREDECK_VERSION into daemon and CLI binaries ([d9ffabf](https://github.com/mikelgmh/libredeck/commit/d9ffabfc50ae59534f842b0cb2c5fc3973032e5c))

## [1.10.1](https://github.com/mikelgmh/libredeck/compare/v1.10.0...v1.10.1) (2026-11-23)


### Bug Fixes

* **daemon:** hide PowerShell/terminal windows and cache system metrics ([8181370](https://github.com/mikelgmh/libredeck/commit/818137041dc5d71c9d71fb96fa18e71b2cdd7185))

# [1.10.0](https://github.com/mikelgmh/libredeck/compare/v1.9.0...v1.10.0) (2026-11-23)


### Bug Fixes

* **launcher:** skip automatic updates in dev mode ([28e9cc3](https://github.com/mikelgmh/libredeck/commit/28e9cc34c2b612c212e3ef3405b6c2863a85ce52))


### Features

* **updater:** download updates automatically ([cab58d7](https://github.com/mikelgmh/libredeck/commit/cab58d7bee41c0ef9baae7689096a987f495fa44))

# [1.9.0](https://github.com/mikelgmh/libredeck/compare/v1.8.1...v1.9.0) (2026-11-23)


### Features

* improve action configuration and deck experience ([ee8ed32](https://github.com/mikelgmh/libredeck/commit/ee8ed32015b45e88cc34138d10063c65c2be607c))

## [1.8.1](https://github.com/mikelgmh/libredeck/compare/v1.8.0...v1.8.1) (2026-11-23)


### Bug Fixes

* **launcher:** update a TEMP con error accionable sin admin, ventana con scroll 440x860 y aviso sin host Electrobun ([802fd0d](https://github.com/mikelgmh/libredeck/commit/802fd0d9065ee25fbde8445e626f01e21b48b568))

# [1.8.0](https://github.com/mikelgmh/libredeck/compare/v1.7.2...v1.8.0) (2026-11-23)


### Features

* add flows, device sessions and mobile deck ([5e8c116](https://github.com/mikelgmh/libredeck/commit/5e8c11600f54774928d22a79d471805d05232d3e))


### Performance Improvements

* memoiza render de teclas, indexa botones, batch WS, code-splitting y batch backend ([fd984b3](https://github.com/mikelgmh/libredeck/commit/fd984b3bef524fe2e92d5198a12fe956e461c9a1))

## [1.7.2](https://github.com/mikelgmh/libredeck/compare/v1.7.1...v1.7.2) (2026-11-22)


### Bug Fixes

* **relay:** rewrite Astro island asset URLs through tunnel so approved phone loads CSS/JS ([da49cbd](https://github.com/mikelgmh/libredeck/commit/da49cbd7013b74abf5c5a63e2c512e5780a5eecf))
* **web:** init iconImage and content checks so cleared key images don't persist ([ef93458](https://github.com/mikelgmh/libredeck/commit/ef934582453dfc2b19f1e034da50320c6e1894f0))

## [1.7.1](https://github.com/mikelgmh/libredeck/compare/v1.7.0...v1.7.1) (2026-11-22)


### Bug Fixes

* prevent launcher stalls and version mismatches ([98b0b94](https://github.com/mikelgmh/libredeck/commit/98b0b94ca4d4f14eb67f827a49d86b7080647b72))

# [1.7.0](https://github.com/mikelgmh/libredeck/compare/v1.6.0...v1.7.0) (2026-11-21)


### Bug Fixes

* **ci:** restaurar fetch real en afterEach de system-e2e en vez de undefined ([3e7ad69](https://github.com/mikelgmh/libredeck/commit/3e7ad69faeff6425ba6bffc1439c8e4f7fac0d9e))
* **relay:** Dockerfile con contexto repo-root para openship ([45cb137](https://github.com/mikelgmh/libredeck/commit/45cb13768eb7d3b6057393fae074809b09dfbf26))
* **relay:** fallback a almacenamiento efimero si /data no es escribible ([b9e313a](https://github.com/mikelgmh/libredeck/commit/b9e313a22122008a50a5f5fe0fb0e9a387183cc2))
* **remote:** relay publico por defecto + protocolo E2E unificado ([bb2db46](https://github.com/mikelgmh/libredeck/commit/bb2db465d6bf39ed758f16920cef48ed73fd9da5))
* **remote:** relay publico por defecto, protocolo E2E unificado y diagnostico de tunel ([57b6c56](https://github.com/mikelgmh/libredeck/commit/57b6c56505a8c2634ea2fe55553742c4d0df8159))
* **web:** grid centrado en el escenario (min-height en asides, bd-stack con margin auto) ([8ad0946](https://github.com/mikelgmh/libredeck/commit/8ad0946211556cd5a2e8aab728865489341b572d))


### Features

* catalogo plugins + 25 plugins nuevos + relay E2E + remote pane ([bb3138d](https://github.com/mikelgmh/libredeck/commit/bb3138d482b6bc8b5c45d5c5156612a8c8a6f97a))
* **relay:** landing publica GET / con guia de conexion (ES/EN) ([b7c95b6](https://github.com/mikelgmh/libredeck/commit/b7c95b64ce2052e4e2ebaf91620c5836db6de4d8))
* **remote:** emparejamiento por QR - GET /remote/qr, mostrar/escanear con camara, deteccion movil ([c352693](https://github.com/mikelgmh/libredeck/commit/c352693bb42fd0735f20702f200b4843782c6afc))
* **remote:** UI remota por internet via relay (tunel inverso + aprobacion en host) ([a279d4a](https://github.com/mikelgmh/libredeck/commit/a279d4ac95ea9fb82d87f5a495c089c9cdda7f16))
* **web:** Entrar desde internet primero, fuera churro de estado, switch DaisyUI ([914711a](https://github.com/mikelgmh/libredeck/commit/914711acefe7e983cb48a0dce690a6113c2da5e7))
* **web:** separa Acceso remoto en Enlazar otro BunDeck vs Entrar desde internet ([4612bf9](https://github.com/mikelgmh/libredeck/commit/4612bf9859204d4a16bb7950c0d0ca8253dfa674))

# [1.6.0](https://github.com/mikelgmh/libredeck/compare/v1.5.0...v1.6.0) (2026-11-21)


### Bug Fixes

* **ci:** daemon build sin --windows-hide-console fuera de Windows; build:win solo en Windows ([7d0417e](https://github.com/mikelgmh/libredeck/commit/7d0417e4cac994f3e9fd6f284135bb6155c723b6))
* **ci:** qualify gpui::Window in non-Windows title_chrome stub ([7113a7e](https://github.com/mikelgmh/libredeck/commit/7113a7ed7147077ee7d75baf61cc230bfdcc4595))
* **ci:** quote step name with colon and install Linux GPUI system deps ([f180ed5](https://github.com/mikelgmh/libredeck/commit/f180ed5847b5e3e1c9f57b1043b165cdee23bc03))
* **ci:** shell bash en pasos con sintaxis bash para que el build de Windows no use pwsh ([d5af546](https://github.com/mikelgmh/libredeck/commit/d5af54643e097397582b689b339ca476ca6b7547))
* **ci:** vendor xattr 0.2.3 with Linux ENOATTR fix ([41e3d0a](https://github.com/mikelgmh/libredeck/commit/41e3d0a7217f58d0da6d660676f5fb4d1f6ec68f))


### Features

* managed auto-update with signed bundles, wider sidebar ([70ab955](https://github.com/mikelgmh/libredeck/commit/70ab955e4fea57aeaefc6628a5f6d46909a8cd2f))

# [1.5.0](https://github.com/mikelgmh/libredeck/compare/v1.4.0...v1.5.0) (2026-11-21)


### Bug Fixes

* **ci:** instalar dependencias raiz en el job test ([9656834](https://github.com/mikelgmh/libredeck/commit/9656834bb145a8d64a1359675e22fd14efb722d1))
* **ci:** version.iss en vez de /DAppVersion para ISCC ([5c391f8](https://github.com/mikelgmh/libredeck/commit/5c391f82cce51a01d41da6a63888fb67ef65312d))
* **ci:** web/.npmrc con legacy-peer-deps para que npm ci pase ([140548c](https://github.com/mikelgmh/libredeck/commit/140548c74654d8b506852bf7a7d34e0c47c00928))
* **test:** esperar setGlobalSettings en elgato-host antes de afirmar ([c1a7e37](https://github.com/mikelgmh/libredeck/commit/c1a7e37f9d60548b1681cc7bc0aa43009f08ab39))


### Features

* Add streamdeck connection ([bac06bf](https://github.com/mikelgmh/libredeck/commit/bac06bfaeb8b73ecbc81007bd33a7e1c6288f504))
* Default profile in prod ([cea9d12](https://github.com/mikelgmh/libredeck/commit/cea9d12e45736fff6b532e17f969e6db6edc3ee2))
* plugins OBS/Spotify/Elgato, launcher GPUI, host Electrobun y fixes de CI e instalador ([3d73931](https://github.com/mikelgmh/libredeck/commit/3d7393138b2e3933e990fc41dbcaa0634b132c9d))

# [1.5.0](https://github.com/mikelgmh/libredeck/compare/v1.4.0...v1.5.0) (2026-11-21)


### Bug Fixes

* **ci:** instalar dependencias raiz en el job test ([9656834](https://github.com/mikelgmh/libredeck/commit/9656834bb145a8d64a1359675e22fd14efb722d1))
* **ci:** version.iss en vez de /DAppVersion para ISCC ([5c391f8](https://github.com/mikelgmh/libredeck/commit/5c391f82cce51a01d41da6a63888fb67ef65312d))
* **ci:** web/.npmrc con legacy-peer-deps para que npm ci pase ([140548c](https://github.com/mikelgmh/libredeck/commit/140548c74654d8b506852bf7a7d34e0c47c00928))
* **test:** esperar setGlobalSettings en elgato-host antes de afirmar ([c1a7e37](https://github.com/mikelgmh/libredeck/commit/c1a7e37f9d60548b1681cc7bc0aa43009f08ab39))


### Features

* Add streamdeck connection ([bac06bf](https://github.com/mikelgmh/libredeck/commit/bac06bfaeb8b73ecbc81007bd33a7e1c6288f504))
* Default profile in prod ([cea9d12](https://github.com/mikelgmh/libredeck/commit/cea9d12e45736fff6b532e17f969e6db6edc3ee2))
* plugins OBS/Spotify/Elgato, launcher GPUI, host Electrobun y fixes de CI e instalador ([3d73931](https://github.com/mikelgmh/libredeck/commit/3d7393138b2e3933e990fc41dbcaa0634b132c9d))

# [1.5.0](https://github.com/mikelgmh/libredeck/compare/v1.4.0...v1.5.0) (2025-12-01)


### Features

* Add streamdeck connection ([bac06bf](https://github.com/mikelgmh/libredeck/commit/bac06bfaeb8b73ecbc81007bd33a7e1c6288f504))
* Default profile in prod ([cea9d12](https://github.com/mikelgmh/libredeck/commit/cea9d12e45736fff6b532e17f969e6db6edc3ee2))

# [1.5.0](https://github.com/mikelgmh/libredeck/compare/v1.4.0...v1.5.0) (2025-11-25)


### Features

* Add streamdeck connection ([bac06bf](https://github.com/mikelgmh/libredeck/commit/bac06bfaeb8b73ecbc81007bd33a7e1c6288f504))
* Default profile in prod ([cea9d12](https://github.com/mikelgmh/libredeck/commit/cea9d12e45736fff6b532e17f969e6db6edc3ee2))

# [1.5.0](https://github.com/mikelgmh/libredeck/compare/v1.4.0...v1.5.0) (2025-11-25)


### Features

* Default profile in prod ([cea9d12](https://github.com/mikelgmh/libredeck/commit/cea9d12e45736fff6b532e17f969e6db6edc3ee2))

# [1.4.0](https://github.com/mikelgmh/libredeck/compare/v1.3.2...v1.4.0) (2025-11-25)


### Features

* auto update change ([5108e8a](https://github.com/mikelgmh/libredeck/commit/5108e8a729514d14c45cccaaf560845c8b3aa111))

## [1.3.2](https://github.com/mikelgmh/libredeck/compare/v1.3.1...v1.3.2) (2025-11-21)


### Bug Fixes

* Semantic release fix ([89da449](https://github.com/mikelgmh/libredeck/commit/89da44972c121afaa765c0e06e2c3bcaf4167e0c))

## [1.3.1](https://github.com/mikelgmh/libredeck/compare/v1.3.0...v1.3.1) (2025-11-21)


### Bug Fixes

* Fix auto update feature ([0e6d4b6](https://github.com/mikelgmh/libredeck/commit/0e6d4b64c3785611daa9171d3bd7b226f47945ee))

# [1.3.0](https://github.com/mikelgmh/libredeck/compare/v1.2.0...v1.3.0) (2025-11-21)


### Features

* Fix pipeline ([e00479a](https://github.com/mikelgmh/libredeck/commit/e00479af2ce804cfacf28d866b10497db7d134a0))
* Inno setup ([020fe1e](https://github.com/mikelgmh/libredeck/commit/020fe1e235c9fcba5080a0215642de2d17064c5f))

# [1.2.0](https://github.com/mikelgmh/libredeck/compare/v1.1.0...v1.2.0) (2025-11-21)


### Bug Fixes

* **daemon:** fix web-dist file serving in compiled executable ([a4f5702](https://github.com/mikelgmh/libredeck/commit/a4f570214eb41074f6f2d3af4dc5bd8ee64704ca))


### Features

* New release ([0b40831](https://github.com/mikelgmh/libredeck/commit/0b40831d1cbe6962872031dfc8f8a7a3735207dd))

# [1.1.0](https://github.com/mikelgmh/libredeck/compare/v1.0.0...v1.1.0) (2025-11-19)


### Bug Fixes

* **ci:** create dedicated script for cross-platform file operations ([e717c00](https://github.com/mikelgmh/libredeck/commit/e717c00ed7d963be389591794c0887bebdb2bd7a))
* **ci:** fix mkdir command compatibility in Windows GitHub Actions ([1db10c5](https://github.com/mikelgmh/libredeck/commit/1db10c5effa9eead982bd9400ca4a0011b372f14))
* **ci:** use cross-platform commands for directory operations ([2a75cd6](https://github.com/mikelgmh/libredeck/commit/2a75cd6ef2e5fcd32503551b67409369c482fac7))
* **daemon:** make systray module optional for cross-platform compatibility ([ed40e29](https://github.com/mikelgmh/libredeck/commit/ed40e29896e0385c33ae26613f882f076c16dc70))
* move deprecated Dashboard.vue to avoid build errors ([67bd601](https://github.com/mikelgmh/libredeck/commit/67bd6011b4ddc0b9f30f0f6947314d4ac7f86339))


### Features

* Build and auto update ([2f2023e](https://github.com/mikelgmh/libredeck/commit/2f2023ef68e9412574053975066e752cc169995e))
* unify daemon and web bundles with Bun, add lightweight tray icon ([8ae2d18](https://github.com/mikelgmh/libredeck/commit/8ae2d18b428e0192d1bb2271e9e06734dfb2d2ef))

# 1.0.0 (2025-11-19)


### Bug Fixes

* add contents write permission to release job for semantic-release ([05bd53a](https://github.com/mikelgmh/libredeck/commit/05bd53aed38d618124215ce11bacae60c8318830))
* Fix package.json ([9880107](https://github.com/mikelgmh/libredeck/commit/98801070c6a8e9564ecf829266a3c97d386a15d3))
* update Node.js version to 22 for semantic-release compatibility ([a51ecdd](https://github.com/mikelgmh/libredeck/commit/a51ecddaea4c1152109e774eb89cf1a73f8a3e19))
* use bun install for web dependencies in CI to avoid rollup binary issues ([8a2fb9a](https://github.com/mikelgmh/libredeck/commit/8a2fb9a29d6485c6e75bce5911461f208da5e7b1))
* use bun instead of npm in GitHub Actions workflow ([7ef91f6](https://github.com/mikelgmh/libredeck/commit/7ef91f6e1dc5e5c050a6625a78410f4ac2606165))


### Features

* add comprehensive CI/CD pipeline with tests and badges ([6587eb4](https://github.com/mikelgmh/libredeck/commit/6587eb468d6e146d978f6ab814d425dac33d6eef))
* CI and semantic release ([6705955](https://github.com/mikelgmh/libredeck/commit/6705955d6680922a226a00da84fdf656eae242ca))
* setup automated releases with semantic-release ([246c9cb](https://github.com/mikelgmh/libredeck/commit/246c9cb56d567463924301b80c46419de15eddc5))
