/**
 * Política y ejecución de acciones remotas E2E.
 *
 * SEGURIDAD:
 * - ALLOWLIST estricta: solo lo listado en `REMOTE_ALLOWLIST`. Todo lo
 *   demás se deniega por defecto, EN ESPECIAL `shell.*` (RCE),
 *   `http.*` arbitrario (SSRF), `open-app.*` arbitrario, servicios y
 *   energía (`system.*`, `power.*`). TLS != E2E: aunque el relay vaya por
 *   TLS, el contenido sigue cifrado extremo a extremo con NaCl box.
 * - Cada acción remota exige: peer `trusted` + NO `revoked` + la acción
 *   está en `allowedActions` del peer (subconjunto de la allowlist).
 * - Todo se loguea (`logs`, level info/error) y se difunde por WS al
 *   topic `remote` (`remote.received` / `remote.executed`).
 */
import { DatabaseService } from '../db';
import { getTrusted } from './pairing';

/** Política por defecto: navegar + pulsar tecla + OBS/multimedia seguros. */
export const DEFAULT_POLICY: string[] = [
  'page.select',
  'profile.select',
  'button.press',
  'obs.scene',
  'obs.source',
  'obs.stream',
  'obs.record',
  'obs.replay',
  'multimedia.play',
  'multimedia.pause',
  'utility.delay',
  'local.set-var',
  'local.toggle-var',
  'local.toast',
];

export type RemotePolicy = string[];

/** Acciones que el motor remoto sabe ejecutar (superset de DEFAULT_POLICY). */
export const REMOTE_ALLOWLIST: string[] = [
  ...DEFAULT_POLICY,
  'multimedia.multimedia',
  'utility.macro-safe', // marcador: las macros solo con pasos allowlist (ver abajo)
];

/** Prefijos BLOQUEADOS por defecto aunque el peer los pida en su policy. */
export const REMOTE_BLOCKED_PREFIXES: string[] = [
  'shell.',
  'http.',
  'open-app.',
  'browser.',
  'hotkey.',
  'type-text.',
  'service.',
  'system.',
  'power.',
  'energy.',
  'plugin.',
  'admin.',
];

export function isBlockedAction(actionType: string): boolean {
  const t = String(actionType ?? '');
  if (REMOTE_BLOCKED_PREFIXES.some((p) => t === p.slice(0, -1) || t.startsWith(p))) return true;
  // `utility.macro` puede anidar shell/http: solo se permite si TODOS los
  // pasos están en allowlist (se valida en executeRemoteAction).
  return false;
}

/** ¿La acción está en la allowlist del motor? */
export function isAllowlisted(actionType: string): boolean {
  const t = String(actionType ?? '');
  if (isBlockedAction(t)) return false;
  if (REMOTE_ALLOWLIST.includes(t)) return true;
  // Alias OBS genéricos: obs.* ya listados explícitamente arriba.
  return false;
}

export interface RemoteCommand {
  type: string;
  params?: Record<string, any>;
}

export interface RemoteExecDeps {
  db: DatabaseService;
  actionRunner?: { executeAction: (a: any, c: any) => Promise<any> };
  wsManager?: { broadcast: (event: string, payload: any, topic?: string) => void };
}

export function checkRemotePermission(db: DatabaseService, fromDeviceId: string, actionType: string): { ok: boolean; reason?: string } {
  const t = getTrusted(db, fromDeviceId);
  if (!t) return { ok: false, reason: 'dispositivo no emparejado' };
  if (t.revoked || !t.pubKey) return { ok: false, reason: 'dispositivo revocado' };
  if (isBlockedAction(actionType)) return { ok: false, reason: `acción bloqueada por defecto: ${actionType}` };
  if (!isAllowlisted(actionType)) return { ok: false, reason: `acción no permitida: ${actionType}` };
  if (!t.allowedActions.includes(actionType)) return { ok: false, reason: 'fuera de la política del dispositivo' };
  return { ok: true };
}

/** Valida que una macro remota solo contenga pasos allowlist (anti-escalada). */
function assertSafeMacro(params: any): void {
  const steps = params?.steps;
  if (!Array.isArray(steps)) throw new Error('macro sin steps');
  for (const s of steps) {
    if (!s || typeof s.type !== 'string' || !isAllowlisted(s.type)) {
      throw new Error(`macro con paso no permitido: ${s?.type ?? '?'}`);
    }
    if (s.type === 'utility.macro' || s.type === 'utility.macro-safe') throw new Error('macros anidadas no permitidas');
  }
}

export async function executeRemoteAction(
  deps: RemoteExecDeps,
  fromDeviceId: string,
  cmd: RemoteCommand,
): Promise<{ ok: boolean; result?: any; error?: string }> {
  const { db } = deps;
  const type = String(cmd?.type ?? '');
  const params = cmd?.params ?? {};
  const log = (level: string, message: string, meta?: any) => {
    try { db.addLog({ level, message, meta: { ...meta, remote: true, from: fromDeviceId, type }, ts: Date.now() }); } catch { /* noop */ }
  };
  const emit = (event: string, payload: any) => {
    try { deps.wsManager?.broadcast(event, payload, 'remote'); } catch { /* noop */ }
  };

  emit('remote.received', { from: fromDeviceId, type, ts: Date.now() });

  const perm = checkRemotePermission(db, fromDeviceId, type);
  if (!perm.ok) {
    log('info', `[remote] denegado ${type} desde ${fromDeviceId}: ${perm.reason}`);
    emit('remote.executed', { from: fromDeviceId, type, ok: false, error: perm.reason, ts: Date.now() });
    return { ok: false, error: perm.reason };
  }

  try {
    let result: any = null;
    if (type === 'page.select') {
      const pageId = String(params.pageId ?? '');
      if (!pageId) throw new Error('falta pageId');
      if (!deps.db.getPage(pageId)) throw new Error('página inexistente');
      db.setCurrentPage(pageId);
      emit('page.navigate', { pageId });
      result = { pageId };
    } else if (type === 'profile.select') {
      const profileId = String(params.profileId ?? '');
      if (!profileId) throw new Error('falta profileId');
      if (!deps.db.getProfile(profileId)) throw new Error('perfil inexistente');
      db.setCurrentProfile(profileId);
      emit('profile.navigate', { profileId });
      result = { profileId };
    } else if (type === 'button.press') {
      const buttonId = String(params.buttonId ?? params.id ?? '');
      if (!buttonId) throw new Error('falta buttonId');
      const btn = deps.db.getButton(buttonId);
      if (!btn) throw new Error('botón inexistente (solo id existente)');
      const data = (btn as any).data ?? (btn as any);
      const actions = (data as any)?.actions ?? (data as any)?.data?.actions ?? [];
      if (!deps.actionRunner) throw new Error('sin actionRunner');
      const ctx = { buttonId, pageId: (btn as any).page_id, timestamp: Date.now(), remote: true, from: fromDeviceId };
      const results = [];
      for (const a of actions) {
        if (!a?.type || !isAllowlisted(a.type)) throw new Error(`acción del botón no permitida por remoto: ${a?.type ?? '?'}`);
        results.push(await deps.actionRunner.executeAction(a, ctx));
      }
      result = { buttonId, executed: results.length };
    } else if (type === 'utility.macro-safe' || type === 'utility.delay') {
      if (type === 'utility.macro-safe') assertSafeMacro(params);
      if (!deps.actionRunner) throw new Error('sin actionRunner');
      const mapped = type === 'utility.macro-safe' ? { ...params, type: 'utility.macro' } : params;
      const r = await deps.actionRunner.executeAction(
        { type: type === 'utility.macro-safe' ? 'utility.macro' : 'utility.delay', parameters: mapped },
        { timestamp: Date.now(), remote: true, from: fromDeviceId },
      );
      result = r;
    } else {
      // obs.*, multimedia.*, local.*: delegan al ActionRunner con el mismo
      // `type` (los plugins ya están registrados como `<plugin>.<acción>`).
      if (!deps.actionRunner) throw new Error('sin actionRunner');
      const r = await deps.actionRunner.executeAction(
        { type, parameters: params },
        { timestamp: Date.now(), remote: true, from: fromDeviceId },
      );
      result = r;
    }
    log('info', `[remote] ejecutado ${type} desde ${fromDeviceId}`);
    emit('remote.executed', { from: fromDeviceId, type, ok: true, result, ts: Date.now() });
    return { ok: true, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log('info', `[remote] error ${type} desde ${fromDeviceId}: ${error}`);
    emit('remote.executed', { from: fromDeviceId, type, ok: false, error, ts: Date.now() });
    return { ok: false, error };
  }
}
