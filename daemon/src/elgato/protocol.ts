/**
 * protocol.ts — Tipos y helpers del protocolo Elgato Stream Deck (fase 2).
 *
 * Referencia: SDK @elgato/streamdeck para Node (p.ej. DeckCal
 * `com.ewels.deckcal`, proceso `node bin/plugin.js -port <p> -pluginUUID
 * <uuid> -registerEvent <event> -info <json>`), que se conecta por WebSocket
 * a `ws://localhost:<puerto>`.
 *
 * Direcciones:
 *  - plugin → host: `registerEvent` (o `registerPlugin` en SDK v1), más los
 *    comandos `setTitle`, `setImage`, `setState`, `showAlert`, `showOk`,
 *    `setSettings`, `getSettings`, `setGlobalSettings`, `getGlobalSettings`,
 *    `openUrl`, `logMessage`, `sendToPropertyInspector`, `switchToProfile`.
 *  - host → plugin: `keyDown`, `keyUp`, `willAppear`, `willDisappear`,
 *    `didReceiveSettings`, `didReceiveGlobalSettings`,
 *    `applicationDidLaunch`, `applicationDidTerminate`, `deviceDidConnect`,
 *    `deviceDidDisconnect`, `propertyInspectorDidAppear`,
 *    `propertyInspectorDidDisappear`, `sendToPlugin`, `titleParametersDidChange`.
 */

/** Primer mensaje que envía el plugin al conectarse (SDK moderno). */
export const REGISTER_EVENT = 'registerEvent';
/** Variante de registro del SDK clásico (v1). */
export const REGISTER_PLUGIN_EVENT = 'registerPlugin';

/** Eventos que el HOST puede enviar al plugin. */
export type HostToPluginEvent =
  | 'keyDown'
  | 'keyUp'
  | 'willAppear'
  | 'willDisappear'
  | 'titleParametersDidChange'
  | 'deviceDidConnect'
  | 'deviceDidDisconnect'
  | 'applicationDidLaunch'
  | 'applicationDidTerminate'
  | 'systemDidWakeUp'
  | 'didReceiveSettings'
  | 'didReceiveGlobalSettings'
  | 'propertyInspectorDidAppear'
  | 'propertyInspectorDidDisappear'
  | 'sendToPlugin';

/** Comandos/eventos que el PLUGIN puede enviar al host. */
export type PluginToHostEvent =
  | typeof REGISTER_EVENT
  | typeof REGISTER_PLUGIN_EVENT
  | 'setTitle'
  | 'setImage'
  | 'setState'
  | 'showAlert'
  | 'showOk'
  | 'setSettings'
  | 'getSettings'
  | 'setGlobalSettings'
  | 'getGlobalSettings'
  | 'openUrl'
  | 'logMessage'
  | 'sendToPropertyInspector'
  | 'switchToProfile';

/** Mensaje genérico del protocolo (ambas direcciones). */
export interface ElgatoMessage {
  event: string;
  action?: string;
  context?: string;
  device?: string;
  payload?: any;
  /** UUID del plugin en el mensaje de registro. */
  uuid?: string;
}

/** Mensaje host → plugin. */
export interface HostToPluginMessage extends ElgatoMessage {
  event: HostToPluginEvent;
}

/** Mensaje plugin → host. */
export interface PluginToHostMessage extends ElgatoMessage {
  event: PluginToHostEvent;
}

/** Argumentos de lanzamiento del proceso del plugin Elgato. */
export interface ElgatoRegisterArgs {
  /** Puerto WS donde escucha el host. */
  port: number;
  /** UUID del plugin (`-pluginUUID`). */
  pluginUUID: string;
  /** Nombre del evento de registro (`-registerEvent`, normalmente `registerEvent`). */
  registerEvent: string;
  /** Objeto `-info` ya parseado. */
  info: any;
}

/**
 * Parsea `process.argv.slice(2)` del plugin Elgato:
 * `-port <p> -pluginUUID <uuid> -registerEvent <event> -info <json>`.
 * Lanza si falta `-port` o `-pluginUUID`.
 */
export function parseRegisterArgs(argv: string[]): ElgatoRegisterArgs {
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    if (i < 0 || i + 1 >= argv.length) return null;
    return argv[i + 1];
  };
  const portRaw = flag('-port');
  const pluginUUID = flag('-pluginUUID');
  const registerEvent = flag('-registerEvent') ?? REGISTER_EVENT;
  const infoRaw = flag('-info');
  if (!portRaw) throw new Error('Falta argumento -port');
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Puerto inválido en -port: '${portRaw}'`);
  }
  if (!pluginUUID) throw new Error('Falta argumento -pluginUUID');
  let info: any = {};
  if (infoRaw) {
    try {
      info = JSON.parse(infoRaw);
    } catch {
      throw new Error('Argumento -info no es JSON válido');
    }
  }
  return { port, pluginUUID, registerEvent, info };
}

export interface ElgatoDeviceInfo {
  id: string;
  name: string;
  /** 0 = StreamDeck clásico. */
  type: number;
  size: { columns: number; rows: number };
}

export interface BuildInfoOptions {
  pluginUUID: string;
  pluginVersion?: string;
  appVersion?: string;
  deviceId?: string;
  deviceName?: string;
  columns?: number;
  rows?: number;
}

/**
 * Construye el objeto `-info` que el host pasa al plugin en el arranque.
 * Incluye `application`, `plugin`, `devicePixelRatio`, `colors`, `devices`
 * y `devicesInfo`, como el software real de Elgato.
 */
export function buildInfoObject(opts: BuildInfoOptions): any {
  const deviceId = opts.deviceId ?? 'LIBREDECK-VIRTUAL-1';
  return {
    application: {
      language: 'en',
      platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux',
      platformVersion: process.version,
      version: opts.appVersion ?? '6.4.0',
    },
    plugin: {
      uuid: opts.pluginUUID,
      version: opts.pluginVersion ?? '1.0.0',
    },
    devicePixelRatio: 2,
    colors: {
      systemColorDark: '#2d2d2d',
      systemColorDesaturatedDark: '#535353',
      systemColorLight: '#e1e1e1',
      systemColorDesaturatedLight: '#c9c9c9',
      systemColorMid: '#878787',
      systemColorDesaturatedMid: '#a0a0a0',
    },
    devices: [deviceId],
    devicesInfo: [
      {
        id: deviceId,
        name: opts.deviceName ?? 'LibreDeck Virtual',
        type: 0,
        size: { columns: opts.columns ?? 5, rows: opts.rows ?? 3 },
      } satisfies ElgatoDeviceInfo,
    ],
  };
}

/** Versión serializada de `buildInfoObject` (lo que va en `-info`). */
export function buildInfoJson(opts: BuildInfoOptions): string {
  return JSON.stringify(buildInfoObject(opts));
}

/** ID del dispositivo virtual que emula el host. */
export const VIRTUAL_DEVICE_ID = 'LIBREDECK-VIRTUAL-1';

/**
 * Construye un mensaje host → plugin (keyDown/keyUp/willAppear/...).
 */
export function buildHostMessage(
  event: HostToPluginEvent,
  opts: { action: string; context: string; device?: string; payload?: any }
): HostToPluginMessage {
  return {
    event,
    action: opts.action,
    context: opts.context,
    device: opts.device ?? VIRTUAL_DEVICE_ID,
    payload: opts.payload ?? {},
  };
}

/** ¿Es un mensaje de registro del plugin? */
export function isRegisterMessage(msg: any): boolean {
  return !!msg && (msg.event === REGISTER_EVENT || msg.event === REGISTER_PLUGIN_EVENT);
}

/** Extrae el payload de forma segura (el SDK a veces lo omite). */
export function payloadOf(msg: any): any {
  return msg?.payload ?? {};
}
