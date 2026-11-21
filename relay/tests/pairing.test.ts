import { describe, expect, test } from 'bun:test';
import { PairingStore } from '../src/pairing';

describe('pairing (código 6 dígitos, un solo uso, TTL)', () => {
  test('create -> consume ok, segundo consume falla (un solo uso)', () => {
    const store = new PairingStore();
    const { code } = store.create();
    expect(code).toMatch(/^\d{6}$/);
    expect(store.consume(code)).not.toBeNull();
    expect(store.consume(code)).toBeNull(); // ya consumido
  });

  test('código inexistente se rechaza', () => {
    const store = new PairingStore();
    expect(store.consume('000000')).toBeNull();
  });

  test('código expirado se rechaza (TTL)', () => {
    let t = 1_000_000;
    const store = new PairingStore(5 * 60 * 1000, () => t);
    const { code } = store.create();
    t += 5 * 60 * 1000 + 1; // pasado el TTL
    expect(store.consume(code)).toBeNull();
  });

  test('código dentro del TTL vale y prune limpia expirados', () => {
    let t = 1_000_000;
    const store = new PairingStore(1000, () => t);
    store.create();
    t += 2000;
    expect(store.prune()).toBe(1);
    expect(store.size()).toBe(0);
  });
});
