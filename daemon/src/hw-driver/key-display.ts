/**
 * key-display.ts — Apariencia efectiva de una tecla para el hardware.
 *
 * Réplica en el daemon de `resolveDisplay()` (web: `useKeyEngine.ts`):
 * la primera apariencia condicional (`looks`) cuya condición se cumple
 * manda; si no, valores base. Los textos con `{{…}}` se interpolan con
 * el mismo motor del daemon (`variables/templates.ts`, superconjunto
 * del `intp` web: admite `{{nombre}}`, `{{vars.nombre}}` y filtros).
 *
 * El entorno incluye variables globales + incorporadas
 * (hora/minuto/segundo/dia/perfil/pagina) vía `VariableStore.envFor`.
 */

import { baseEnv, evb, type Env } from '../variables/expressions';
import { renderTemplate } from '../variables/templates';
import { getVariableStore } from '../variables/store';

/** Paleta de color de icono/texto (misma que la web: useKeyEngine.COLORS). */
export const KEY_COLORS = ['#e8e9eb', '#e8b04e', '#86cba5', '#82b4ea', '#ec8e7f', '#c7a6e0'];
/** Fondos condicionales (misma que la web: BGS; índice 0 = sin cambio). */
export const KEY_BGS: Array<string | undefined> = [undefined, '#5a2b2b', '#2b5a3a', '#2b3f5a', '#5a4a24', '#4b315e'];

export const DEFAULT_KEY_BG = '#2d3036';
export const DEFAULT_KEY_FG = '#e8e9eb';
export const DEFAULT_KEY_ICON = 'Zap';

export interface KeyLookLike {
  cond?: string;
  t?: string;
  i?: string;
  c?: number | null;
  bg?: number;
}

export interface KeyDisplayInput {
  label?: string;
  textTop?: string;
  textBottom?: string;
  title?: string;
  icon?: string;
  iconImage?: string;
  backgroundImage?: string;
  emoji?: string;
  textColor?: string;
  backgroundColor?: string;
  fontSize?: number;
  showTitle?: boolean;
  dynamicValue?: string | number | null;
  looks?: KeyLookLike[];
}

export interface ResolvedKeyDisplay {
  label: string;
  textTop: string;
  textBottom: string;
  icon: string;
  iconImage: string;
  backgroundImage: string;
  emoji: string;
  textColor: string;
  backgroundColor: string;
  fontSize: number;
  showTitle: boolean;
  dynamicValue: string;
}

/** Incorporadas que cambian con el tiempo: obligan a re-render periódico. */
const TIME_RE = /(^|[^\p{L}\p{N}_])(hora|minuto|segundo|dia)(?![\p{L}\p{N}_])/u;
/** perfil/pagina también van al env: si cambian, la caché debe invalidar. */
const SCOPE_RE = /(^|[^\p{L}\p{N}_])(perfil|pagina)(?![\p{L}\p{N}_])/u;

/**
 * Entorno de evaluación para el HW: variables globales del daemon +
 * incorporadas. `perfil`/`pagina` son los nombres visibles (sesión HW).
 */
export function getDaemonDisplayEnv(perfil = '', pagina = ''): Env {
  try {
    return getVariableStore().envFor('global', '', perfil, pagina);
  } catch {
    return baseEnv([], perfil, pagina);
  }
}

function interp(raw: unknown, env: Env): string {
  const s = String(raw ?? '');
  if (!s || !s.includes('{{')) return s;
  try {
    return renderTemplate(s, (name) => (env as any)[name], env);
  } catch {
    return s;
  }
}

/**
 * Resuelve la apariencia efectiva (looks + {{vars}}). No toca
 * `dynamicValue` (lo pone el driver con las métricas ya obtenidas).
 */
export function resolveKeyDisplay(raw: KeyDisplayInput, env: Env): ResolvedKeyDisplay {
  const looks = Array.isArray(raw?.looks) ? raw.looks : [];
  const hit = looks.find((l) => l?.cond && evb(l.cond, env));

  // La web distingue icono explícitamente vacío ('') de ausente: solo este
  // último recibe el Zap por defecto (ensureDefaultIcon al crear).
  const rawIcon = (raw as any)?.icon;
  const icon = (hit?.i || (typeof rawIcon === 'string' ? rawIcon : DEFAULT_KEY_ICON)) as string;
  const colorIdx = hit && hit.c != null ? hit.c : null;
  const bgIdx = hit?.bg ?? null;
  const textColor =
    colorIdx != null && KEY_COLORS[colorIdx] ? KEY_COLORS[colorIdx] : (raw.textColor || DEFAULT_KEY_FG);
  const bgFromLook = bgIdx ? KEY_BGS[bgIdx] : undefined;
  const backgroundColor = bgFromLook ?? raw.backgroundColor ?? '';

  // En la web el título visible es label || textTop || textBottom; aquí se
  // interpolan los tres (la web solo interpola label: esto es superconjunto).
  const label = interp(hit?.t || raw.label || '', env);
  const textTop = interp(raw.textTop || '', env);
  const textBottom = interp(raw.textBottom || '', env);

  return {
    label,
    textTop,
    textBottom,
    icon: typeof icon === 'string' ? icon : DEFAULT_KEY_ICON,
    iconImage: typeof raw.iconImage === 'string' ? raw.iconImage : '',
    backgroundImage: typeof raw.backgroundImage === 'string' ? raw.backgroundImage : '',
    emoji: typeof raw.emoji === 'string' ? raw.emoji : '',
    textColor,
    backgroundColor,
    fontSize: Number.isFinite(Number(raw.fontSize)) && Number(raw.fontSize) > 0 ? Number(raw.fontSize) : 14,
    showTitle: raw.showTitle !== false,
    dynamicValue: raw.dynamicValue == null ? '' : String(raw.dynamicValue),
  };
}

/** Firma compacta para detectar cambios y evitar repintados inútiles. */
export function resolvedSignature(eff: ResolvedKeyDisplay): string {
  return JSON.stringify([
    eff.label, eff.textTop, eff.textBottom, eff.icon, eff.iconImage,
    eff.backgroundImage, eff.emoji, eff.textColor, eff.backgroundColor,
    eff.fontSize, eff.showTitle, eff.dynamicValue,
  ]);
}

function displayTextOf(raw: KeyDisplayInput): string {
  const parts: string[] = [];
  for (const l of raw?.looks ?? []) parts.push(String(l?.cond ?? ''), String(l?.t ?? ''));
  parts.push(String(raw?.label ?? ''), String(raw?.textTop ?? ''), String(raw?.textBottom ?? ''));
  return parts.join('\n');
}

/**
 * ¿La tecla necesita re-render periódico (1 s)? Condiciones o textos con
 * incorporadas de tiempo/perfil/pagina. pc-vitals va por su propio polling
 * de métricas (no entra aquí).
 */
export function displayNeedsLiveUpdate(raw: KeyDisplayInput): boolean {
  try {
    const text = displayTextOf(raw);
    if (TIME_RE.test(text) || SCOPE_RE.test(text)) return true;
    // Un look con condición (aunque sea estática) puede cambiar por vars.
    return (raw?.looks ?? []).some((l) => !!l?.cond);
  } catch {
    return false;
  }
}
