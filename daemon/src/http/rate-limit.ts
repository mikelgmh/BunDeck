/**
 * RateLimiter de ventana deslizante (en memoria, por clave).
 *
 * Espejo del `RateLimiter` del relay (`relay/src/ratelimit.ts`): misma
 * semántica para que ambos lados limiten igual (defecto 60/min). Aquí se
 * usa para el canje de invitaciones LAN (`POST /remote/lan-redeem`) y los
 * intentos de acceso sin invitación: evita escaneos/brute-force del código.
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

  /** Para tests: olvida todas las claves. */
  clear(): void {
    this.hits.clear();
  }
}
