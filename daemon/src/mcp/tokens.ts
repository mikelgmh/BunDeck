/**
 * Tokens de acceso para el servidor MCP de LibreDeck.
 *
 * Se guardan en settings (`mcp.tokens`) como JSON: solo el hash SHA-256
 * del secreto, nunca el secreto. El secreto (`ldmcp_...`) se muestra UNA
 * vez al crearlo.
 *
 * Cada token lleva `scopes` (permisos marcables en Ajustes → MCP).
 * Vacío/ausente = acceso total (admin, también para tokens legacy).
 */
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseService } from '../db';
import { normalizeScopes } from './scopes';

const SETTINGS_KEY = 'mcp.tokens';
const TOKEN_PREFIX = 'ldmcp_';

export interface McpTokenRecord {
  id: string;
  name: string;
  prefix: string; // primeros chars del secreto, para identificarlo
  hash: string; // sha256(hex) del secreto completo
  scopes: string[]; // permisos concedidos ([] = legacy → admin)
  createdAt: number;
  lastUsedAt: number | null;
}

function readAll(db: DatabaseService): McpTokenRecord[] {
  try {
    const raw = db.getSetting(SETTINGS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(db: DatabaseService, tokens: McpTokenRecord[]): void {
  db.setSetting(SETTINGS_KEY, JSON.stringify(tokens));
}

export function listMcpTokens(db: DatabaseService): Omit<McpTokenRecord, 'hash'>[] {
  return readAll(db).map(({ hash, ...pub }) => pub);
}

/** Crea un token y devuelve el registro público + el secreto (una sola vez). */
export function createMcpToken(
  db: DatabaseService,
  name: string,
  scopes?: unknown
): { record: Omit<McpTokenRecord, 'hash'>; secret: string } {
  const clean = (name ?? '').trim().slice(0, 80) || 'sin-nombre';
  const secret = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const record: McpTokenRecord = {
    id: `mcp_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
    name: clean,
    prefix: secret.slice(0, 12) + '…',
    hash: createHash('sha256').update(secret).digest('hex'),
    scopes: normalizeScopes(scopes),
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  const all = readAll(db);
  all.push(record);
  writeAll(db, all);
  const { hash, ...pub } = record;
  return { record: pub, secret };
}

/** Edita nombre y/o scopes de un token. Devuelve el registro o null. */
export function updateMcpToken(
  db: DatabaseService,
  id: string,
  patch: { name?: unknown; scopes?: unknown }
): Omit<McpTokenRecord, 'hash'> | null {
  const all = readAll(db);
  const found = all.find((t) => t.id === id);
  if (!found) return null;
  if (patch.name !== undefined) {
    const clean = String(patch.name ?? '').trim().slice(0, 80);
    if (clean) found.name = clean;
  }
  if (patch.scopes !== undefined) {
    found.scopes = normalizeScopes(patch.scopes);
  }
  writeAll(db, all);
  const { hash, ...pub } = found;
  return pub;
}

export function revokeMcpToken(db: DatabaseService, id: string): boolean {
  const all = readAll(db);
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return false;
  writeAll(db, next);
  return true;
}

/** Verifica un secreto Bearer. Devuelve el token si es válido. */
export function verifyMcpToken(db: DatabaseService, secret: string | null | undefined): McpTokenRecord | null {
  if (!secret || !secret.startsWith(TOKEN_PREFIX)) return null;
  const hash = createHash('sha256').update(secret).digest('hex');
  const all = readAll(db);
  const found = all.find((t) => t.hash === hash) ?? null;
  if (found) {
    found.lastUsedAt = Date.now();
    writeAll(db, all);
  }
  return found;
}

/** Extrae el Bearer de la cabecera Authorization. */
export function bearerFromHeaders(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}
