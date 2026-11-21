import { describe, expect, test } from 'bun:test';
import { RateLimiter } from '../src/ratelimit';

describe('rate-limit (60/min por IP)', () => {
  test('permite 60 y bloquea el 61', () => {
    let t = 0;
    const rl = new RateLimiter(60, 60_000, () => t);
    for (let i = 0; i < 60; i++) expect(rl.allow('1.2.3.4')).toBe(true);
    expect(rl.allow('1.2.3.4')).toBe(false);
  });

  test('ventana deslizante: tras 60s vuelve a permitir', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect(rl.allow('ip')).toBe(true);
    expect(rl.allow('ip')).toBe(true);
    expect(rl.allow('ip')).toBe(false);
    t += 1001;
    expect(rl.allow('ip')).toBe(true);
  });

  test('claves independientes por IP', () => {
    let t = 0;
    const rl = new RateLimiter(1, 60_000, () => t);
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('b')).toBe(true);
    expect(rl.allow('a')).toBe(false);
  });
});
