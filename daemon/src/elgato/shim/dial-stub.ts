/**
 * dial-stub.ts — Rechazo explícito de DialAction/encoder (shim v1).
 *
 * LibreDeck no tiene dial hardware: cualquier acción Elgato con
 * `Controllers: ['Encoder']` se excluye en el análisis (ver
 * `elgato/manifest.ts`) y el registro de una `DialAction` en el Worker se
 * rechaza con evento `elgato.dial-rejected` + log de error, SIN tumbar el
 * resto del plugin (las acciones Keypad siguen funcionando).
 */
import { DialAction } from './sdk';

export class DialNotSupportedError extends Error {
  readonly actionUuid: string;
  constructor(actionUuid: string) {
    super(
      `DialAction '${actionUuid}' rechazado: sin equivalente hardware para ` +
      `dials/encoders Elgato en LibreDeck (shim v1, solo Keypad)`
    );
    this.name = 'DialNotSupportedError';
    this.actionUuid = actionUuid;
  }
}

/** ¿La acción es solo-dial (sin Keypad)? */
export function isDialOnlyAction(action: any): boolean {
  const ctrls = Array.isArray(action?.Controllers) ? action.Controllers : [];
  if (ctrls.length === 0) return false;
  return !ctrls.includes('Keypad');
}

/** ¿El manifiesto es dial-only (ninguna acción Keypad)? */
export function isDialOnlyManifest(elgatoManifest: any): boolean {
  const actions = Array.isArray(elgatoManifest?.Actions) ? elgatoManifest.Actions : [];
  if (actions.length === 0) return false;
  return !actions.some((a: any) => {
    const ctrls = Array.isArray(a?.Controllers) ? a.Controllers : [];
    return ctrls.length === 0 || ctrls.includes('Keypad');
  });
}

export { DialAction };
