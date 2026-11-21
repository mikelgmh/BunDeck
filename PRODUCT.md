# PRODUCT.md — BunDeck

## Audiencia
Makers, streamers y técnicos que configuran un Stream Deck open-source. Sesiones largas, necesitan densidad sin fatiga.

## Jobs
1. Elegir perfil y página en <3s.
2. Seleccionar tecla, poner icono/texto/color y 1-N acciones.
3. Probar y reorganizar (drag) sin perder el hilo.
4. Gestionar perfiles (crear, renombrar, grid, auto-switch, eliminar con confirmación).

## No-jobs
Landing marketing. Sin loader, sin WebGL, sin hero. El momento es el grid.

## Restricciones
- Stack existente: Astro + Vue + Tailwind v4 + DaisyUI. No cambiar framework.
- `data-cy` estables para Cypress. No renombrar sin actualizar tests.
- Daemon en 3001, WS 3003. Update UI solo bajo Electrobun.
- ES por defecto, EN completo. `translate="no"` en marcas/identificadores.
