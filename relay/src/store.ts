import { Database } from 'bun:sqlite';
import { mkdirSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface DeviceRow {
  id: string;
  pubKey: string;
  name: string | null;
  lastSeen: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    pub_key TEXT NOT NULL,
    name TEXT,
    last_seen INTEGER NOT NULL
  );
`;

/**
 * Persistencia mínima (convención daemon/src/db.ts: bun:sqlite,
 * columnas JSON/TEXT, upsert explícito). Solo identidad pública:
 * id + pubKey + name + lastSeen. JAMÁS claves privadas.
 */
export class DeviceStore {
  private db: Database;

  constructor(dataDir: string, filename = 'relay.db') {
    this.db = openDatabaseWithFallback(dataDir, filename);
    this.db.exec(SCHEMA);
  }

  upsert(id: string, pubKey: string, name?: string): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, pub_key, name, last_seen)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET pub_key = excluded.pub_key,
           name = COALESCE(excluded.name, devices.name),
           last_seen = excluded.last_seen`,
      )
      .run(id, pubKey, name ?? null, Date.now());
  }

  touch(id: string): void {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), id);
  }

  get(id: string): DeviceRow | null {
    const row = this.db
      .prepare('SELECT id, pub_key AS pubKey, name, last_seen AS lastSeen FROM devices WHERE id = ?')
      .get(id) as DeviceRow | undefined;
    return row ?? null;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Abre la SQLite en dataDir; si el volumen no es escribible por el usuario
 * del contenedor (p.ej. /data montado como root con USER bun), cae a un
 * directorio temporal escribible en vez de tumbar el relay. El registro de
 * dispositivos es mínimo y se re-puebla con cada `register`, así que la
 * degradación es preferible al crash-loop. Nunca lanza.
 */
function openDatabaseWithFallback(dataDir: string, filename: string): Database {
  const tryOpen = (dir: string): Database | null => {
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
      return new Database(join(dir, filename));
    } catch {
      return null;
    }
  };
  const primary = tryOpen(dataDir);
  if (primary) return primary;
  const fallbackDir = join(tmpdir(), 'libredeck-relay');
  const fallback = tryOpen(fallbackDir);
  if (fallback) {
    console.warn(
      `[relay] ${dataDir} no es escribible, usando almacenamiento efímero en ${fallbackDir}. ` +
        `Revisa los permisos del volumen.`,
    );
    return fallback;
  }
  // Último recurso: SQLite en memoria (sin persistencia entre reinicios).
  console.warn('[relay] sin directorio escribible, usando SQLite en memoria.');
  return new Database(':memory:');
}
