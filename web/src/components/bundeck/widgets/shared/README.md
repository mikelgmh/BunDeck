# Infraestructura compartida de los widgets de control (modo libre)

Piezas que los 13 controles de `web/src/components/bundeck/widgets/` deben
reutilizar en su rediseño. Nada aquí rediseña ningún widget: son los
ladrillos comunes + las reglas que todos siguen.

Ficheros:

| Pieza | Fichero |
|---|---|
| `Marquee` | `shared/Marquee.vue` |
| `NeedsConfig` | `shared/NeedsConfig.vue` |
| `useOpenActionSettings` | `src/composables/useOpenActionSettings.ts` |
| `useAutoCarousel` + `resolveCarouselMs` | `src/composables/useAutoCarousel.ts` |
| `AutoCarousel` | `shared/AutoCarousel.vue` |

Referencias del patrón original: marquee del kiosco
(`BunDeckApp.vue:360-408`, `useKiosk.ts:marqueeOverflows`,
`bundeck.css:1329-1384`); superficie (`ControlSurface.vue`,
`useActionPresentation.ts:CONTROL_ACTION_COMPONENTS`); drawer
(`BunDeckApp.vue` `#bd-ins` + `KeyInspector.vue`).

---

## 1. `Marquee.vue` — texto largo en teclas pequeñas

```vue
<script setup>
import Marquee from './shared/Marquee.vue'
</script>

<template>
  <Marquee :text="trackTitle" :speed="22" />
</template>
```

- Props: `text: string` (requerido, una línea), `speed?: number`
  (segundos por vuelta completa; defecto `22`, igual que el kiosco).
- La velocidad vive en la CSS var `--bd-marquee-duration`; se puede
  sobreescribir por CSS sin tocar la prop.
- Solo anima si el texto **desborda de verdad**: mide con `ResizeObserver`
  `span.scrollWidth` vs ancho visible (`marqueeOverflows` de `useKiosk.ts`,
  +1px anti-subpíxel). Sin overflow: fijo, centrado, sin 2ª copia.
- Pausa en hover; sin animación con `prefers-reduced-motion: reduce`.
- `data-cy="bd-marquee"` / `data-cy="bd-marquee-text"`.
- Usar para títulos/textos secundarios largos. **No** para el dato principal
  numérico (ese va en grande con `cqi`, ver §4).

## 2. `NeedsConfig.vue` + `useOpenActionSettings` — patrón "sin configurar"

```vue
<script setup>
import NeedsConfig from './shared/NeedsConfig.vue'
const isConfigured = computed(() => !!entityId.value) // condición propia
</script>

<template>
  <section class="mi-widget">
    <NeedsConfig
      v-if="!isConfigured"
      :action-type="props.action.type"
      :position="props.position"
    />
    ...
```

- Props: `actionType?: string` (informativo), `position?: number | null`
  (**la prop `position` que reenvía `ControlSurface`**), `remoteUrl?: string`,
  `label?: string` (defecto i18n `bd.widgetNeedsConfig`).
- Pinta icono de ajustes + warning parpadeante arriba-derecha de la tecla
  (`position: absolute; top/right 4px; z-index 5`). **Requisito**: la raíz
  del widget debe tener `position: relative`.
- Emite `opened` con `'drawer' | 'remote' | 'unhandled'` (tests/telemetría).
- `data-cy="bd-needs-config"`.
- **Condición `isConfigured` la define cada widget** (p. ej. `entityId` vacío
  en HomeAssistant, sin `videoId` en YouTube, sin `host` en OBS…). Este
  componente solo pinta y abre ajustes.

### Mecanismo de apertura del drawer (no existía: creado aquí)

`ControlSurface.vue` hace `@click.stop`/`@pointerdown.stop`, así que ningún
clic interior llega a `StageBoard` → `button-click` → `selectButton`. Por
eso el drawer se abre por evento:

1. `useOpenActionSettings().openActionSettings({ actionType, position })`
   dispara `window.CustomEvent('bundeck:open-action-settings',
   { detail: { actionType, position }, cancelable: true })`.
2. `BunDeckApp` lo escucha (`onOpenActionSettings`): `selectButton(position)`
   + `bdSetPanels(izq, true)` y `preventDefault()` (= "gestionado").
3. `dispatchEvent` devuelve `false` si se canceló → resultado `'drawer'`.

Constante exportada: `OPEN_ACTION_SETTINGS_EVENT`. El listener vive en
`BunDeckApp.vue` (montado/desmontado con la app).

### En remoto

- "Remoto" = `!isHostClient()` (`useBunDeckUi.ts`: no-localhost y sin token
  de túnel) o vista sin inspector (`MobileDeck`, kiosco).
- Si el evento **no** fue gestionado y es remoto: `window.open(remoteUrl ??
  bundeckRootUrl(), '_blank', 'noopener')` → abre bundeck en la web para
  configurar allí. `bundeckRootUrl()` = `location.origin + '/'` (best-effort;
  en LAN sirve la app). **Hook preparado**: pasar `remoteUrl` explícito
  (p. ej. la URL del QR de conexión) cuando el origin no resuelva.
- No existía ningún mecanismo previo para esto: el fallback `window.open`
  es nuevo y queda documentado aquí.
- En kiosco no hay drawer y no se abre nada (`'unhandled'`; el badge sigue
  siendo informativo).

### Cableado de `position` (ya hecho, no tocar)

`StageBoard` → `:position="b.position"` → `ControlSurface` (prop opcional
`position`, defecto `null`, solo rama genérica; `VolumeRange` no la recibe)
→ cada widget la declara como prop opcional y se la pasa a `NeedsConfig`.
Los widgets que aún no la declaren la reciben como atributo HTML
inofensivo (`position="3"` en la raíz) hasta que adopten el contrato.

## 3. `useAutoCarousel` / `AutoCarousel.vue` — rotación en pequeño

Para datos múltiples en teclas pequeñas (eventos, sensores, escenas…):
rota un elemento cada N ms en vez de lista con scroll.

### Contrato del setting (drawer derecho)

- **Campo: `carouselMs`** en `action.parameters` (número, milisegundos).
  - `> 0` = intervalo (se satura al mínimo `1000` ms).
  - `<= 0` = desactivado (se muestra el primer elemento).
  - ausente/inválido = defecto `4000` ms.
- `resolveCarouselMs(params, fallback = 4000)` implementa esa semántica.
- Para que el campo salga editable en el drawer, el manifiesto del plugin
  (**daemon**) debe exponer `carouselMs` en su `settingsSchema`; la parte
  web lo lee igual aunque el schema aún no lo declare.

### `useAutoCarousel(count, { intervalMs, enabled })`

```ts
import { resolveCarouselMs, useAutoCarousel } from '../../../composables/useAutoCarousel'

const items = computed(() => [...])
const { index, next, prev, goTo, pause, resume, running } = useAutoCarousel(
  computed(() => items.value.length),
  { intervalMs: computed(() => resolveCarouselMs(props.action.parameters)) },
)
// pintar items[index]
```

- `count` / `intervalMs` / `enabled` aceptan valor, `Ref` o getter.
- Solo rota con `≥ 2` elementos; resetea `index` si la lista encoge.
- Pausa con pestaña oculta (`visibilitychange`); sin auto-arranque con
  `prefers-reduced-motion` (navegación manual sigue disponible).
- `pause()`/`resume()` para hover/focus del widget.
- **El `readonly` NO apaga el carrusel**: solo-lectura también rota
  (no ejecuta nada, solo muestra).

### `AutoCarousel.vue` (presentacional)

```vue
<AutoCarousel :count="items.length" :interval-ms="ms" :show-dots="hasRoom" v-slot="{ index }">
  <Datum :value="items[index]" />
</AutoCarousel>
```

- Props: `count`, `intervalMs` (defecto 4000), `showDots` (defecto `false`),
  `dotsLabel`. Slot por defecto `{ index, count, goTo }`.
- Pausa en hover/focus; dots con `role="tablist"` + `data-cy="bd-carousel-dot"`.
- **`showDots` solo con espacio**: el widget lo condiciona por container
  query (ver §4). En 1×1, sin dots.

## 4. Reglas base de container queries (todos los widgets)

Modelo: `VolumeRange.vue` (único control ya adaptativo).

### Contenedor

```css
.mi-widget {
  width: 100%; height: 100%; min-width: 0; min-height: 0;
  container-type: size;      /* 2D: las teclas libres tienen w×h fijos */
  container-name: mi-widget; /* nombre único por widget */
  position: relative;        /* ancla de NeedsConfig */
}
```

- `container-type: size` exige tamaño propio: la raíz **debe** ocupar el
  100% de la tecla (lo hace `.bd-control-surface`, que ya es `display: grid`
  + `overflow: hidden`).
- Nombres en uso (no repetir): `vol`, `spotify`, `workflow`. Nuevos:
  kebab del componente (`audio-mixer`, `media-transport`, `smart-home`,
  `voice-panel`, `soundboard`, `stream-studio`, `creative-tools`,
  `calendar-agenda`, `pomodoro`, `status-cards`).
- Tipografía fluida con `cqi`: `font-size: clamp(min, N cqi, max)`.

### Breakpoints recomendados (coherentes con los existentes)

Orientación primero (umbrales de `VolumeRange`, no inventar otros):

```css
@container mi-widget (min-aspect-ratio: 13/10) { /* ancha: layout horizontal */ }
@container mi-widget (max-aspect-ratio: 77/100) { /* alta: stack vertical */ }
/* defecto = cuadrada ≈1×1: dato hero centrado */
```

Ancho (bandas unificadas; en uso: spotify 165px, workflow 230px, creative 240px):

| Rango | Guía | Contenido |
|---|---|---|
| XS `< 200px` (≈1×1, `--bd-ks` 76–128 + kiosco 96) | `@container (max-width: 199px)` | **Solo dato relevante** + `Marquee`/`AutoCarousel`. Sin botones secundarios, sin refresh, sin dots. |
| M `200–339px` | `@container (min-width: 200px)` | Dato + 1 acción principal o dots. Refresh permitido solo si cabe (≥ ~260px). |
| L `≥ 340px` | `@container (min-width: 340px)` | Lista completa, acciones, refresh, textos largos. |

Alto (listas; workflow usa 135/150px):

```css
@container mi-widget (min-height: 140px) { /* mostrar lista/dots extra */ }
```

### Qué mostrar/ocultar por rango

- **XS**: un solo dato hero (número + unidad/icono). Título largo → `Marquee`.
  Varios datos → `AutoCarousel` sin dots. Nada de botón "actualizar"
  (el widget ya hace poll silencioso + reintento); nada de errores rojos con
  texto largo (ver punto siguiente).
- **M+**: añadir acción principal, dots del carrusel, metadatos (lugar,
  hora, estado) con ellipsis.
- **L**: todo + refresh manual, listas completas, mensajes largos.
- **Errores**: en XS solo icono con `role="alert"` + `title` y texto
  accesible corto (sr-only); el mensaje largo (`copy.failed…`) solo en M+.
  Nunca rojo sobre fondo sin contraste AA con el tema (`--bd-danger`).
- **Vacíos**: en XS icono + 2-3 palabras (`copy.empty`); la explicación
  larga solo en M+.
- `readonly`: no desactiva visualización (carrusel/marquee siguen); solo
  bloquea controles que ejecutan. Sin párrafos "solo lectura" en XS.

### A11y / movimiento

- `role="alert"` en errores, `aria-live="polite"` en datos que cambian
  solos (poll/carrusel: el contenedor, no cada rotación).
- `focus-visible` con `outline: 2px solid var(--bd-ac)` en todo control.
- `prefers-reduced-motion: reduce` → sin marquee, sin blink, sin carrusel
  auto (los tres ya lo implementan; no añadir animaciones nuevas sin su
  `@media` correspondiente).
- `data-cy="widget-<nombre>"` en la raíz (convención; StatusCards usa
  `widget-status-card`, SmartHome `smart-home`: unificar a `widget-*` al
  rediseñar).

## 5. Checklist de adopción por widget (para los subagentes)

1. Declarar props `action, apiBase, label, readonly, position?` (tipar como
   `SmartHomeControl.vue:166-183` + `position?: number | null`).
2. Raíz: `position: relative` + `container-type: size` + `container-name`
   propio + `width/height 100%`.
3. `NeedsConfig v-if="!isConfigured"` con `action-type` + `position`;
   definir y documentar la condición `isConfigured` de la acción.
4. Textos largos → `Marquee`; datos múltiples → `useAutoCarousel` (+
   `carouselMs` leído de `parameters`) o `AutoCarousel`.
5. Aplicar tabla XS/M/L + orientación 13/10–77/100; errores/vacíos según §4.
6. Test `web/src/test/WidgetsSharedInfra.test.ts` cubre la infra; cada
   widget añade su `isConfigured` + queries en su propio test.
