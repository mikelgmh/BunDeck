/**
 * Historial/undo propio del servidor MCP.
 *
 * Cada mutación por MCP registra su inversa (p.ej. crear → borrar con el
 * mismo id, borrar → recrear el snapshot, actualizar → restaurar el
 * snapshot previo). `undo_last` aplica la inversa de la última entrada no
 * deshecha del mismo token (o global en llamadas internas sin auth).
 *
 * En memoria y acotado (últimas 200 entradas): es "propio" del MCP, no
 * toca la BD salvo al deshacer. Best-effort: si la inversa falla (p.ej.
 * el objeto ya no existe), se marca como deshecha con el error.
 */
import { randomUUID } from 'node:crypto';

export interface HistoryInverse {
  /** Tool a invocar para deshacer. */
  tool: string;
  arguments: any;
  /** Entradas extra para batch (aplicar en orden inverso). */
  batch?: HistoryInverse[];
}

export interface HistoryEntry {
  seq: number;
  id: string;
  ts: number;
  tokenId: string | null;
  tokenName: string | null;
  /** Tool original que mutó (p.ej. 'create_button', 'execute_batch'). */
  tool: string;
  label: string;
  inverse: HistoryInverse;
  undone: boolean;
  undoneAt?: number | null;
  undoError?: string | null;
}

const MAX_ENTRIES = 200;
let seq = 0;
const entries: HistoryEntry[] = [];

function owner(auth: { tokenId?: string; tokenName?: string } | null | undefined): { tokenId: string | null; tokenName: string | null } {
  if (!auth) return { tokenId: null, tokenName: 'internal' };
  return { tokenId: auth.tokenId ?? null, tokenName: auth.tokenName ?? null };
}

export function pushHistory(
  auth: { tokenId?: string; tokenName?: string } | null | undefined,
  tool: string,
  label: string,
  inverse: HistoryInverse
): HistoryEntry {
  const o = owner(auth);
  const entry: HistoryEntry = {
    seq: ++seq,
    id: randomUUID(),
    ts: Date.now(),
    tokenId: o.tokenId,
    tokenName: o.tokenName,
    tool,
    label,
    inverse,
    undone: false,
  };
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();
  return entry;
}

export function listHistory(auth: { tokenId?: string } | null | undefined, limit = 50): HistoryEntry[] {
  const n = Math.min(Math.max(Number(limit) || 50, 1), MAX_ENTRIES);
  const mine = !auth?.tokenId ? entries : entries.filter((e) => e.tokenId === auth.tokenId);
  return mine.slice(-n).reverse().map((e) => ({ ...e }));
}

/** Última entrada no deshecha del token (o global si no hay auth). */
export function peekUndo(auth: { tokenId?: string } | null | undefined): HistoryEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.undone) continue;
    if (!auth?.tokenId) {
      if (e.tokenId === null) return e;
      continue;
    }
    if (e.tokenId === auth.tokenId) return e;
  }
  // Los tokens admin (sin scope-list o con history.write + todo) también
  // pueden deshacer la última global si no tienen propia: se resuelve en
  // server.ts pasando auth=null solo para internas. Aquí: estricto por token.
  return null;
}

export function markUndone(entry: HistoryEntry, error?: string): void {
  entry.undone = true;
  entry.undoneAt = Date.now();
  entry.undoError = error ?? null;
}

export function clearHistory(auth: { tokenId?: string } | null | undefined): number {
  if (!auth?.tokenId) {
    const n = entries.length;
    entries.length = 0;
    return n;
  }
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].tokenId === auth.tokenId) { entries.splice(i, 1); n++; }
  }
  return n;
}

/** Solo tests: vacía todo el historial global. */
export function __resetHistoryForTests(): void {
  entries.length = 0;
  seq = 0;
}
