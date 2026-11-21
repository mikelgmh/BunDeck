# DESIGN.md — LibreDeck

Fuente: `unslop` + `awwwards` + `impeccable.style` + `vercel web-design-guidelines`.
Crédito unslop: Damir Sokolovsky (@heydamir), CC BY 4.0.

## Concept Card

Idea: mesa de control para configurar teclas físicas durante horas, sin ruido.
Metáfora: cabina de mezclas nocturna, instrumentos, keycaps retroiluminadas.
Signature: keycap + mono tabular (`⌘N`, `5×3`). Solo ahí.
Emoción: calma instrumental, todo en su sitio en 3 segundos.
Motion verb: asentar, no rebotar. `cubic-bezier(0.2,0,0,1)`, 120ms feedback / 180ms entrada.
Screenshot: grid de teclas centrado, chrome quieto alrededor.

## Patrones

- Top bar 48px: [modo | perfil] ··· [QR] [pantalla] [ajustes]. Sin idioma ni device en barra.
- Stage bar 44px: [tamaño 5×3] | [tabs páginas +] | [contador]. Una sola fila.
- Perfiles = drawer derecha 400px con listbox + crear inline + steppers + danger con confirm.
- Ajustes = modal centrada 440px: dispositivo / idioma / updates / acerca de. `data-cy` estables.
- Menús: `role=menu/menuitem`, foco al abrir, flechas + Esc. Drawers/modales: Esc cierra, `overscroll: contain`, foco inicial.

## Tokens

Palette (dark only):
- ground `#0e1216`, surface `#151b21`, raised `#1b232b`, overlay `#222c35`
- line `rgb(226 232 240 / 0.09)`, line-strong `.../0.14`
- text: primary `#e8edf2`, secondary `#9aa7b4`, muted `#66727e`
- accent `#4f8cff` (ink `#0b1526`, soft `rgb(79 140 255 / 0.12)`)
- ok `#3fb27f`, warn `#c99a3f`, danger `#d16a6a` (apagados)

Type: Inter UI + ui-monospace para cifras/keycaps. 12/13/14/16/20. Pesos 400/500/600 máx.
Sentence case siempre. `tabular-nums` en cifras. `text-wrap: balance` en h1-h3.

Shape: control 8, card 12, panel 16, key 14. Anidado: interior = exterior - padding, mín 4.

## Reglas (impeccable + unslop + vercel)

- No nested cards: 1 nivel de superficie por bloque. Agrupar con espacio, no con cajas.
- No side-tab, no icon-tile-stack, no hero metric, no gradients/glows/emoji.
- Espaciado 4px. Dentro < entre. Sidebar rows 32-36, gap 2-4.
- Un acento, uso raro. Contadores en `ld-count` mono muted, no pills.
- Motion: solo `background-color,border-color,opacity,transform`. Nada de `transition-all`, ni `scale` en hover (solo press 0.97). `prefers-reduced-motion` apaga todo.
- A11y vercel: icon-only con `aria-label`, forms con `<label>`, focus-visible siempre, `role=menu` + teclado en menús, `aria-live=polite` en toasts, `overscroll-behavior: contain` en drawers/modales.
- Copy: voz activa, segunda persona, sin `...` salvo loading/placeholder con `…`, sin em-dash en UI visible.
