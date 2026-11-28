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
  CREATE TABLE IF NOT EXISTS tunnel_sessions (
    token TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    exp INTEGER NOT NULL,
    url_code TEXT NOT NULL DEFAULT '',
    turn TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tunnel_sessions_exp ON tunnel_sessions (exp);
  CREATE INDEX IF NOT EXISTS idx_tunnel_sessions_device ON tunnel_sessions (device_id);
`;

export type TunnelStorageMode = 'persistent' | 'fallback-tmp' | 'memory';

/**
 * Persistencia mínima (convención daemon/src/db.ts: bun:sqlite,
 * columnas JSON/TEXT, upsert explícito). Solo identidad pública:
 * id + pubKey + name + lastSeen. JAMÁS claves privadas.
 *
 * DECISIÓN DE PERSISTENCIA (documentada aquí porque es el punto que
 * decide si un redespliegue mata las sesiones):
 * - Carga: 1 writer (el propio relay), tráfico modesto (devices +
 *   sesiones tunnel con upsert/prune esporádicos, sin lecturas calientes).
 * - SQLite en volumen persistente (/data) BASTA y es lo correcto: cero
 *   dependencias, backup = copiar relay.db, ACID local, sin concurrencia
 *   multi-réplica (el relay es single-instance tras el proxy).
 * - Postgres/Mongo solo si algún día hay multi-réplica real con writers
 *   concurrentes o >10k sesiones/s: hoy sería sobrediseño (operación,
 *   latencia de red y secretos extra a cambio de nada).
 * - Lo que SÍ es crítico: que DATA_DIR apunte a almacenamiento persistente.
 *   Con base efímera (tmpdir/:memory:) cada redespliegue pierde devices y
 *   sesiones aunque el código de restore/rebind sea correcto.
 */
export class DeviceStore {
  private db: Database;
  /** Dónde vive realmente la BD (puede diferir de dataDir si hubo fallback). */
  readonly storageDir: string;
  /** `persistent` = DATA_DIR escribible; otros = EFÍMERO (ver alerta en arranque). */
  readonly storageMode: TunnelStorageMode;

  constructor(dataDir: string, filename = 'relay.db') {
    const opened = openDatabaseWithFallback(dataDir, filename);
    this.db = opened.db;
    this.storageDir = opened.dir;
    this.storageMode = opened.mode;
    this.db.exec(SCHEMA);
    try {
      const cols = this.db.prepare('PRAGMA table_info(tunnel_sessions)').all() as Array<{ name?: string }>;
      if (!cols.some((c) => c?.name === 'secret_hash')) {
        this.db.exec('ALTER TABLE tunnel_sessions ADD COLUMN secret_hash TEXT');
      }
    } catch {
      /* best-effort: memoria sigue mandando */
    }
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

  // ---- Sesiones del túnel UI (supervivencia a reinicios del relay) ----
  // Solo lo necesario para rehidratar `TunnelState.sessions`: token,
  // deviceId, exp, urlCode y TURN (JSON). Para `/s/*` además `secret_hash`
  // (sha256 del secreto; el secreto plano nunca se persiste).

  saveTunnelSession(row: { token: string; deviceId: string; exp: number; urlCode: string; turnJson: string | null; secretHash?: string | null }): void {
    let hasSecretCol = true;
    try {
      const cols = this.db.prepare('PRAGMA table_info(tunnel_sessions)').all() as Array<{ name?: string }>;
      hasSecretCol = cols.some((c) => c?.name === 'secret_hash');
    } catch {
      hasSecretCol = false;
    }
    if (hasSecretCol) {
      this.db
        .prepare(
          `INSERT INTO tunnel_sessions (token, device_id, exp, url_code, turn, secret_hash)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(token) DO UPDATE SET device_id = excluded.device_id,
             exp = excluded.exp, url_code = excluded.url_code, turn = excluded.turn, secret_hash = excluded.secret_hash`,
        )
        .run(row.token, row.deviceId, row.exp, row.urlCode, row.turnJson, row.secretHash ?? null);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO tunnel_sessions (token, device_id, exp, url_code, turn)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET device_id = excluded.device_id,
           exp = excluded.exp, url_code = excluded.url_code, turn = excluded.turn`,
      )
      .run(row.token, row.deviceId, row.exp, row.urlCode, row.turnJson);
  }

  deleteTunnelSession(token: string): void {
    this.db.prepare('DELETE FROM tunnel_sessions WHERE token = ?').run(token);
  }

  deleteTunnelSessionsByDevice(deviceId: string): void {
    this.db.prepare('DELETE FROM tunnel_sessions WHERE device_id = ?').run(deviceId);
  }

  listTunnelSessions(): Array<{ token: string; deviceId: string; exp: number; urlCode: string; turnJson: string | null; secretHash?: string | null }> {
    try {
      return this.db
        .prepare('SELECT token, device_id AS deviceId, exp, url_code AS urlCode, turn AS turnJson, secret_hash AS secretHash FROM tunnel_sessions')
        .all() as Array<{ token: string; deviceId: string; exp: number; urlCode: string; turnJson: string | null; secretHash?: string | null }>;
    } catch {
      return this.db
        .prepare('SELECT token, device_id AS deviceId, exp, url_code AS urlCode, turn AS turnJson FROM tunnel_sessions')
        .all() as Array<{ token: string; deviceId: string; exp: number; urlCode: string; turnJson: string | null }>;
    }
  }

  pruneTunnelSessions(now: number): number {
    // `exp = 0` = sesión perenne: nunca se poda por caducidad.
    const r = this.db.prepare('DELETE FROM tunnel_sessions WHERE exp != 0 AND exp <= ?').run(now);
    return Number(r?.changes ?? 0);
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
 *
 * El fallback es EFÍMERO por diseño (tmpdir/:memory: no sobreviven al
 * redespliegue): quien arranca DEBE gritarlo (ver index.ts) y el operador
 * DEBE montar un volumen persistente en DATA_DIR (ver README "Despliegue
 * a prueba de pérdida"). El modo se expone en `storageMode`/`storageDir`
 * para logs, /health y tests.
 */
export function openDatabaseWithFallback(
  dataDir: string,
  filename: string,
): { db: Database; dir: string; mode: TunnelStorageMode } {
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
  if (primary) return { db: primary, dir: dataDir, mode: 'persistent' };
  const fallbackDir = join(tmpdir(), 'libredeck-relay');
  const fallback = tryOpen(fallbackDir);
  if (fallback) {
    console.error(
      `[relay][FATAL almacenamiento] ${dataDir} no es escribible, usando almacenamiento EFÍMERO en ${fallbackDir}. ` +
        `Las sesiones/devices SE PERDERÁN en el próximo redespliegue. ` +
        `Monta un volumen persistente en DATA_DIR y revisa permisos (chown 65532 o fsGroup).`,
    );
    return { db: fallback, dir: fallbackDir, mode: 'fallback-tmp' };
  }
  // Último recurso: SQLite en memoria (sin persistencia entre reinicios).
  console.error(
    '[relay][FATAL almacenamiento] sin directorio escribible, usando SQLite EN MEMORIA (efímera). ' +
      'Todo se perderá al reiniciar. Monta un volumen persistente en DATA_DIR.',
  );
  return { db: new Database(':memory:'), dir: ':memory:', mode: 'memory' };
}
