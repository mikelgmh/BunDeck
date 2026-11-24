/**
 * detect.ts — Clasifica el estilo de un CodePath Elgato sin ejecutarlo.
 *
 * - `'sdk'`: importa el SDK (`@elgato/streamdeck` o `streamdeck.*`) → el
 *   bridge clásico lo auto-registra en el falso SDK (`sdk.ts`).
 * - `'raw'`: habla el protocolo WebSocket en crudo (estilo AUS-UV:
 *   `new WebSocket` + `registerEvent`/`registerPlugin` + envíos
 *   `setTitle`/`setImage`/`getSettings`/...) sin importar el SDK → necesita
 *   el adaptador raw en-Worker (`raw-transport.ts`).
 * - `'unknown'`: no hay marcadores claros (se trata como SDK por
 *   compatibilidad: el bridge clásico es el camino por defecto).
 *
 * Heurística sobre el texto fuente, sin dependencias.
 */

export type ElgatoCodeStyle = 'sdk' | 'raw' | 'unknown';

const SDK_FROM = /from\s+['"]@elgato\/streamdeck['"]/;
const SDK_IMPORT_CALL = /import\s*\(\s*['"]@elgato\/streamdeck['"]\s*\)/;
const SDK_REQUIRE = /require\s*\(\s*['"]@elgato\/streamdeck['"]\s*\)/;
const STREAMDECK_DOT = /streamdeck\s*\.\s*(?:action|actions|connect|settings|devices|system|profiles|logger)/i;
const WS_NEW = /new\s+WebSocket\s*\(/;
const REGISTER_EVENT = /register(?:Event|Plugin)/;
const RAW_VERB = /\b(?:setTitle|setImage|setState|showAlert|showOk|getSettings|setSettings|setGlobalSettings|getGlobalSettings|sendToPropertyInspector|sendToPlugin|logMessage|openUrl|switchToProfile)\b/;
const RAW_EVENT_LITERAL = /['"]\b(?:willAppear|keyDown|keyUp|didReceiveSettings|didReceiveGlobalSettings|willDisappear|propertyInspectorDidAppear)\b['"]/;

/** ¿El fuente importa el SDK Elgato? */
export function importsElgatoSdk(code: string): boolean {
  if (typeof code !== 'string') return false;
  return SDK_FROM.test(code) || SDK_IMPORT_CALL.test(code) || SDK_REQUIRE.test(code) || STREAMDECK_DOT.test(code);
}

/** ¿El fuente habla el protocolo crudo (WebSocket + register + verbos)? */
export function looksLikeRawProtocol(code: string): boolean {
  if (typeof code !== 'string') return false;
  if (!WS_NEW.test(code)) return false;
  if (!REGISTER_EVENT.test(code)) return false;
  return RAW_VERB.test(code) || RAW_EVENT_LITERAL.test(code);
}

/**
 * Clasifica el estilo del CodePath. El SDK manda: un plugin que importa el
 * SDK y además abre sockets se considera `'sdk'` (el falso SDK ya cubre
 * `streamDeck.connect()`).
 */
export function detectElgatoCodeStyle(code: string | null | undefined): ElgatoCodeStyle {
  if (typeof code !== 'string' || !code.trim()) return 'unknown';
  if (importsElgatoSdk(code)) return 'sdk';
  if (looksLikeRawProtocol(code)) return 'raw';
  return 'unknown';
}
