/**
 * exposed.ts — Variables expuestas por las acciones (contrato + runtime).
 *
 * Modelo (decisión mínima consistente con la infra existente):
 * - El MANIFIESTO de cada plugin declara, por acción, las variables que
 *   expone (`variables: [{ name, type }]` en PluginActionV2). Es solo
 *   declarativo: la UI lo usa para listar "variables disponibles".
 * - El RUNTIME vive aquí: tras cada ejecución EXITOSA de una acción con
 *   estado, `applyExposedResult` actualiza esas variables en el
 *   VariableStore global (scope `global`, tipo `bool`). Cada escritura
 *   emite `variable.changed` por WS (topic `variables`), así el frontend
 *   recibe los valores en vivo sin recargar.
 *
 * Criterio de selección (solo toggles/estados con sentido para el icono):
 * acciones cuyo resultado real es un estado booleano conocido, o un toggle
 * cuyo estado no se puede leer (fallback a atajos) y se aproxima por
 * inversión del valor almacenado (optimista, documentado por variable).
 *
 * Variables expuestas (todas `bool`, scope global):
 * - discordMuted     ← discord.toggle-mute   (RPC: `mute` real; hotkey: toggle optimista)
 * - discordDeafened  ← discord.toggle-deafen (RPC: `deaf` real; hotkey: toggle optimista)
 * - obsMuted         ← obs.mute              (`muted` real; null → toggle optimista)
 * - obsStreaming     ← obs.stream            (`outputActive` real; null → según `requested`)
 * - obsRecording     ← obs.record            (`outputActive` real; null → según `requested`)
 * - audioMicMuted    ← audio-mixer.mic-mute  (`muted` real en linux/mac; 'toggle' en win → toggle optimista)
 * - multimediaMuted  ← multimedia.multimedia (solo `mute`: sin lectura real → toggle optimista)
 * - multimediaPlaying← multimedia.multimedia (`play`→true, `pause`/`stop`→false, `playpause`→toggle optimista)
 *
 * Nombres sin puntos: el validador (daemon `validateVarName` y web `IDRE`)
 * solo admite letras/números/`_` (sin empezar por número).
 */

export interface ExposedVarDecl {
  /** Nombre global de la variable (válido para validateVarName/IDRE). */
  name: string;
  type: 'bool';
  /** Acción que la expone (id completo, p. ej. `discord.toggle-mute`). */
  action: string;
}

export const EXPOSED_ACTION_VARS: Record<string, ExposedVarDecl[]> = {
  'discord.toggle-mute': [{ name: 'discordMuted', type: 'bool', action: 'discord.toggle-mute' }],
  'discord.toggle-deafen': [{ name: 'discordDeafened', type: 'bool', action: 'discord.toggle-deafen' }],
  'obs.mute': [{ name: 'obsMuted', type: 'bool', action: 'obs.mute' }],
  'obs.stream': [{ name: 'obsStreaming', type: 'bool', action: 'obs.stream' }],
  'obs.record': [{ name: 'obsRecording', type: 'bool', action: 'obs.record' }],
  'audio-mixer.mic-mute': [{ name: 'audioMicMuted', type: 'bool', action: 'audio-mixer.mic-mute' }],
  'multimedia.multimedia': [
    { name: 'multimediaMuted', type: 'bool', action: 'multimedia.multimedia' },
    { name: 'multimediaPlaying', type: 'bool', action: 'multimedia.multimedia' },
  ],
};

/** Decl listada para una acción (vacío si no expone nada). */
export function exposedDeclsFor(actionType: string): ExposedVarDecl[] {
  return EXPOSED_ACTION_VARS[String(actionType ?? '')] ?? [];
}

/**
 * Extrae los valores a publicar desde el resultado REAL de la acción.
 * Devuelve null si no hay nada que publicar (acción sin mapeo, o resultado
 * sin estado interpretable). `prev` lee el valor almacenado (para los
 * toggles optimistas cuando el resultado no trae el estado real).
 */
export function extractExposedValues(
  actionType: string,
  result: any,
  params: any,
  prev: (name: string) => unknown,
): Record<string, boolean> | null {
  const r = result ?? {};
  const p = params ?? {};
  switch (String(actionType ?? '')) {
    case 'discord.toggle-mute': {
      // RPC trae `mute` real; el fallback hotkey no sabe el estado → invierte.
      if (typeof r.mute === 'boolean') return { discordMuted: r.mute };
      return { discordMuted: !asBool(prev('discordMuted')) };
    }
    case 'discord.toggle-deafen': {
      if (typeof r.deaf === 'boolean') return { discordDeafened: r.deaf };
      return { discordDeafened: !asBool(prev('discordDeafened')) };
    }
    case 'obs.mute': {
      // `muted` real (Set) o leído tras Toggle; null si OBS no lo devolvió.
      if (typeof r.muted === 'boolean') return { obsMuted: r.muted };
      return { obsMuted: !asBool(prev('obsMuted')) };
    }
    case 'obs.stream': {
      // ToggleStream devuelve `outputActive`; si falta, se deduce del pedido.
      if (typeof r.outputActive === 'boolean') return { obsStreaming: r.outputActive };
      if (r.requested === 'start') return { obsStreaming: true };
      if (r.requested === 'stop') return { obsStreaming: false };
      return { obsStreaming: !asBool(prev('obsStreaming')) };
    }
    case 'obs.record': {
      if (typeof r.outputActive === 'boolean') return { obsRecording: r.outputActive };
      if (r.requested === 'start') return { obsRecording: true };
      if (r.requested === 'stop') return { obsRecording: false };
      return { obsRecording: !asBool(prev('obsRecording')) };
    }
    case 'audio-mixer.mic-mute': {
      // linux/mac devuelven `muted` real; win/nircmd devuelve 'toggle'.
      if (typeof r.muted === 'boolean') return { audioMicMuted: r.muted };
      if (typeof p.muted === 'boolean') return { audioMicMuted: p.muted };
      return { audioMicMuted: !asBool(prev('audioMicMuted')) };
    }
    case 'multimedia.multimedia': {
      // Sin lectura real del sistema: solo el pedido. `mute` y `playpause`
      // son toggles optimistas; play/pause/stop fijan el estado.
      const a = String(r.action ?? p.action ?? '').toLowerCase();
      if (a === 'mute' || a === 'volumemute') return { multimediaMuted: !asBool(prev('multimediaMuted')) };
      if (a === 'play') return { multimediaPlaying: true };
      if (a === 'pause' || a === 'stop') return { multimediaPlaying: false };
      if (a === 'playpause') return { multimediaPlaying: !asBool(prev('multimediaPlaying')) };
      return null;
    }
    default:
      return null;
  }
}

function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Publica en el store las variables expuestas por una ejecución exitosa.
 * Best-effort: nunca lanza (un fallo aquí no debe romper la acción).
 * `storeLike` es el subconjunto usado ({ get, set }) para poder testear
 * sin BD real.
 */
export async function applyExposedResult(
  storeLike: {
    get: (name: string, scope?: string, scopeId?: string) => { value?: unknown } | null;
    set: (name: string, value: unknown, opts?: { type?: string; source?: string }) => unknown | Promise<unknown>;
  },
  actionType: string,
  result: unknown,
  params: unknown,
): Promise<void> {
  try {
    if (!EXPOSED_ACTION_VARS[String(actionType ?? '')]) return;
    const values = extractExposedValues(
      actionType,
      result,
      params,
      (name) => {
        try {
          return storeLike.get(name, 'global', '')?.value;
        } catch {
          return undefined;
        }
      },
    );
    if (!values) return;
    for (const [name, value] of Object.entries(values)) {
      await storeLike.set(name, value, { type: 'bool', source: `action:${actionType}` });
    }
  } catch {
    /* mejor esfuerzo: la acción ya tuvo éxito */
  }
}
