import { randomInt } from 'node:crypto';

export const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 min
export const PAIRING_CODE_DIGITS = 6;

export interface PairingCode {
  code: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Códigos de emparejamiento de un solo uso, TTL 5 min, solo en memoria.
 * El servidor NUNCA guarda claves privadas: solo el código efímero.
 * (Persistencia opcional en SQLite: no necesaria para el MVP; los códigos
 *  mueren con el proceso por diseño.)
 */
export class PairingStore {
  private codes = new Map<string, PairingCode>();

  constructor(
    private ttlMs: number = PAIRING_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  /** Genera un código de 6 dígitos (crypto-seguro) de un solo uso. */
  create(): PairingCode {
    let code: string;
    do {
      code = String(randomInt(0, 1_000_000)).padStart(PAIRING_CODE_DIGITS, '0');
    } while (this.codes.has(code));
    const t = this.now();
    const entry: PairingCode = { code, createdAt: t, expiresAt: t + this.ttlMs };
    this.codes.set(code, entry);
    return entry;
  }

  /**
   * Consume un código: lo elimina SIEMPRE (un solo uso) y devuelve la
   * entrada solo si existe y no ha expirado. Null en caso contrario.
   */
  consume(code: string): PairingCode | null {
    const entry = this.codes.get(String(code).trim());
    this.codes.delete(String(code).trim());
    if (!entry) return null;
    if (this.now() > entry.expiresAt) return null;
    return entry;
  }

  /** Limpieza periódica de expirados (best-effort). */
  prune(): number {
    const t = this.now();
    let n = 0;
    for (const [code, e] of this.codes) {
      if (t > e.expiresAt) {
        this.codes.delete(code);
        n++;
      }
    }
    return n;
  }

  size(): number {
    return this.codes.size;
  }
}
