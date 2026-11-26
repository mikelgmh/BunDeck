/**
 * kioskTransport — mapeo honesto pilotito → clave i18n de la barra del kiosco.
 *
 * El pilotito rojo (`disconnected`) mostraba el texto "P2P" porque la etiqueta
 * solo distinguía relay del resto. Cada estado muestra ahora su texto:
 * P2P solo en verde, Relay en ámbar, y el resto (probando/conectando/
 * desconectado) su propio texto.
 */

export type KioskTransport = 'p2p' | 'relay' | 'disconnected' | 'probing' | 'connecting';

/** Clave i18n de la etiqueta junto al pilotito (el componente aplica `t()`). */
export function kioskTransportLabelKey(transport: KioskTransport): string {
  switch (transport) {
    case 'relay':
      return 'bd.remoteUiTransportRelay';
    case 'disconnected':
      return 'bd.tunnelTransportDisconnected';
    case 'probing':
      return 'bd.tunnelTransportProbing';
    case 'connecting':
      return 'bd.tunnelTransportConnecting';
    case 'p2p':
    default:
      return 'bd.remoteUiTransportP2p';
  }
}
