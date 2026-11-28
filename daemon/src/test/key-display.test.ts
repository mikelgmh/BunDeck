/**
 * key-display.test.ts — apariencia efectiva de tecla para el HW.
 * Sin DB real: se usa env construido a mano (baseEnv) para looks/vars.
 */
import { describe, it, expect } from 'bun:test';
import { baseEnv } from '../variables/expressions';
import {
  DEFAULT_KEY_BG,
  DEFAULT_KEY_FG,
  displayNeedsLiveUpdate,
  resolvedSignature,
  resolveKeyDisplay,
} from '../hw-driver/key-display';

const env = (vars: Array<{ n: string; v: any }> = [], perfil = 'P', pagina = 'G') =>
  baseEnv(vars, perfil, pagina);

describe('resolveKeyDisplay (base)', () => {
  it('devuelve valores tal cual con defaults', () => {
    const eff = resolveKeyDisplay({ label: 'Holi', icon: 'Mic', backgroundColor: '#111111', textColor: '#222222' }, env());
    expect(eff.label).toBe('Holi');
    expect(eff.icon).toBe('Mic');
    expect(eff.backgroundColor).toBe('#111111');
    expect(eff.textColor).toBe('#222222');
    expect(eff.showTitle).toBe(true);
    expect(eff.fontSize).toBe(14);
  });

  it('defaults: icono Zap, fg claro, fondo vacío (= default web en renderer)', () => {
    const eff = resolveKeyDisplay({}, env());
    expect(eff.icon).toBe('Zap');
    expect(eff.textColor).toBe(DEFAULT_KEY_FG);
    expect(eff.backgroundColor).toBe('');
    expect(DEFAULT_KEY_BG).toBe('#2d3036');
  });

  it('icono explícitamente vacío se respeta (slot vacío, como la web)', () => {
    expect(resolveKeyDisplay({ icon: '' }, env()).icon).toBe('');
  });

  it('respeta showTitle=false y fontSize', () => {
    const eff = resolveKeyDisplay({ showTitle: false, fontSize: 20 }, env());
    expect(eff.showTitle).toBe(false);
    expect(eff.fontSize).toBe(20);
  });
});

describe('resolveKeyDisplay (looks)', () => {
  it('el primer look con cond cierta manda (t/i/c/bg)', () => {
    const eff = resolveKeyDisplay(
      {
        label: 'Base', icon: 'Zap', textColor: '#ffffff', backgroundColor: '#111111',
        looks: [{ cond: 'modo == "x"', t: 'Otro', i: 'Mic', c: 1, bg: 2 }],
      },
      env([{ n: 'modo', v: 'x' }]),
    );
    expect(eff.label).toBe('Otro');
    expect(eff.icon).toBe('Mic');
    expect(eff.textColor).toBe('#e8b04e'); // COLORS[1]
    expect(eff.backgroundColor).toBe('#2b5a3a'); // BGS[2]
  });

  it('sin match usa base', () => {
    const eff = resolveKeyDisplay(
      { label: 'Base', looks: [{ cond: 'modo == "x"', t: 'Otro' }] },
      env([{ n: 'modo', v: 'y' }]),
    );
    expect(eff.label).toBe('Base');
  });

  it('acepta color libre #rrggbb en c/bg (además de índices)', () => {
    const eff = resolveKeyDisplay(
      {
        label: 'Base', icon: 'Zap', textColor: '#ffffff', backgroundColor: '#111111',
        looks: [{ cond: 'modo == "x"', t: 'Otro', c: '#123abc', bg: '#abcdef' }],
      },
      env([{ n: 'modo', v: 'x' }]),
    );
    expect(eff.textColor).toBe('#123abc');
    expect(eff.backgroundColor).toBe('#abcdef');
  });
});

describe('resolveKeyDisplay ({{vars}})', () => {
  it('interpola label/textTop/textBottom con vars y vars.x', () => {
    const eff = resolveKeyDisplay(
      { label: 'Hola {{nombre}}', textTop: '{{hora}}h', textBottom: '{{vars.nombre}}!' },
      env([{ n: 'nombre', v: 'Ana' }]),
    );
    expect(eff.label).toBe('Hola Ana');
    expect(eff.textBottom).toBe('Ana!');
    expect(eff.textTop).toMatch(/^\d{1,2}h$/);
  });
});

describe('resolveKeyDisplay (badge)', () => {
  it('ausente o vacío → ""', () => {
    expect(resolveKeyDisplay({}, env()).badge).toBe('');
    expect(resolveKeyDisplay({ badge: '   ' }, env()).badge).toBe('');
  });

  it('literal y número (incluido 0)', () => {
    expect(resolveKeyDisplay({ badge: '5' }, env()).badge).toBe('5');
    expect(resolveKeyDisplay({ badge: 12 }, env()).badge).toBe('12');
    expect(resolveKeyDisplay({ badge: 0 }, env()).badge).toBe('0');
  });

  it('interpola {{vars}} igual que el resto de textos', () => {
    const eff = resolveKeyDisplay({ badge: '{{sinleer}}' }, env([{ n: 'sinleer', v: 7 }]));
    expect(eff.badge).toBe('7');
  });

  it('la firma cambia con el badge (evita repintados rancios)', () => {
    const a = resolveKeyDisplay({ badge: '1' }, env());
    const b = resolveKeyDisplay({ badge: '2' }, env());
    expect(resolvedSignature(a)).not.toBe(resolvedSignature(b));
    expect(resolvedSignature(a)).toBe(resolvedSignature(resolveKeyDisplay({ badge: '1' }, env())));
  });
});

describe('displayNeedsLiveUpdate', () => {
  it('true con {{hora}} o looks con cond', () => {
    expect(displayNeedsLiveUpdate({ label: '{{hora}}:{{minuto}}' })).toBe(true);
    expect(displayNeedsLiveUpdate({ label: 'X', looks: [{ cond: 'a == 1', t: 'Y' }] })).toBe(true);
    expect(displayNeedsLiveUpdate({ label: 'X', badge: '{{hora}}' })).toBe(true);
  });
  it('false en estático', () => {
    expect(displayNeedsLiveUpdate({ label: 'Fija', icon: 'Mic' })).toBe(false);
    expect(displayNeedsLiveUpdate({ badge: '5' })).toBe(false);
    expect(displayNeedsLiveUpdate({})).toBe(false);
  });
});

describe('resolvedSignature', () => {
  it('cambia si cambia la apariencia', () => {
    const a = resolveKeyDisplay({ label: 'A' }, env());
    const b = resolveKeyDisplay({ label: 'B' }, env());
    expect(resolvedSignature(a)).not.toBe(resolvedSignature(b));
    expect(resolvedSignature(a)).toBe(resolvedSignature(resolveKeyDisplay({ label: 'A' }, env())));
  });
});
