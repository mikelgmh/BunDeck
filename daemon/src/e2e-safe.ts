/**
 * Modo seguro E2E: convierte las acciones con efectos fuera de la app en
 * no-ops logueados mientras la suite Playwright corre contra el daemon de
 * dev (misma DB real que usa el usuario).
 *
 * Por qué existe: los specs e2e (`web/tests/e2e/*.spec.ts`) ejecutan teclas
 * de verdad — clic en modo uso, tap en kiosco, botón «Probar», reglas
 * `load`/`timer` al abrir la página — y cada pulsación no-local viaja por
 * `POST /actions/execute` (o `/buttons/press`) hasta el ActionRunner, que
 * ejecuta la acción de verdad: `window-manager.minimize` minimiza la
 * ventana activa del PC, `hotkey` inyecta teclas, `shell` lanza procesos,
 * `audio-mixer` cambia el volumen, etc. Las fixtures actuales usan
 * `local.toast` (se ejecuta en el cliente, inocuo), pero basta un clic en
 * una tecla del usuario con acción de sistema para molestar.
 *
 * Activación (solo bajo e2e, ver `web/tests/e2e/global-setup.ts`):
 *   - variable de entorno `E2E_NO_SIDE_EFFECTS=1` (o `LIBREDECK_E2E_SAFE=1`)
 *     para daemons arrancados ad-hoc, o
 *   - ajuste persistente `e2e.safe_mode='1'` en SQLite (el daemon de dev ya
 *     está corriendo: no se le puede inyectar env desde fuera, así que el
 *     global-setup lo activa por API y el global-teardown lo desactiva).
 *
 * Política (allowlist mínima): solo se ejecutan acciones internas de la
 * app; todo lo demás se omite con `success:true + skipped:'e2e-safe-mode'`
 * (éxito para no romper los flujos que encadenan acciones, pero sin tocar
 * el sistema). Los contenedores (`utility.macro`, `multiaction.*`) pasan
 * porque cada paso anidado vuelve a filtrarse en `executeAction`.
 */

export const E2E_SAFE_MODE_SETTING = 'e2e.safe_mode';

/** Prefijos de acción seguros: efectos solo dentro de la app. */
const SAFE_PREFIXES = [
  'local.', // set-var / toggle-var / toast (lógica interna)
  'page.', // navegación entre páginas
  'flow.', // primitivas del motor (vars, control)
  'profile-auto.', // cambio de perfil (navegación interna)
  'utility.', // delay / macro (la macro refiltra cada paso)
  'multiaction.', // contenedor (cada sub-acción se refiltra)
] as const;

/**
 * ¿Está activo el modo seguro? Env manda sobre el ajuste en BD.
 * `db` es opcional: sin BD accesible solo se mira el entorno.
 */
export function isSafeModeEnabled(
  db?: { getSetting?: (key: string) => string | null } | null,
): boolean {
  if (
    process.env.E2E_NO_SIDE_EFFECTS === '1' ||
    process.env.LIBREDECK_E2E_SAFE === '1'
  ) {
    return true;
  }
  try {
    return db?.getSetting?.(E2E_SAFE_MODE_SETTING) === '1';
  } catch {
    return false;
  }
}

/**
 * ¿Debe omitirse este tipo de acción en modo seguro? `true` = peligroso
 * (efectos fuera de la app: ventanas, teclas, shell, sonido, red, hogar…).
 */
export function isGatedActionType(type: unknown): boolean {
  if (typeof type !== 'string' || !type) return true;
  const t = type.toLowerCase();
  return !SAFE_PREFIXES.some((p) => t.startsWith(p));
}
