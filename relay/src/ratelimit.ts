/**
 * Rate-limit por IP con ventana deslizante (en memoria).
 * Defecto: 60 mensajes/min (ver relay.ts). El cliente valida nonce/counter;
 * el relay solo exige presencia de nonce+exp y rechaza expirados.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private limit: number = 60,
    private windowMs: number = 60_000,
    private now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((ts) => t - ts < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    return true;
  }

  /** Para tests: olvida una clave. */
  reset(key: string): void {
    this.hits.delete(key);
  }
}
