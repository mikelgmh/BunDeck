/**
 * plugin-i18n.test.ts — paridad de diccionarios i18n en acciones nativas.
 *
 * Toda acción nativa debe declarar `i18n: { es, en }` con name+description
 * (ver daemon/src/plugins/plugin-i18n.ts). Sin dict explícito, el loader
 * deriva el fallback en `ensureActionI18n`, pero los 42 ficheros
 * `*.plugin.ts` migran de forma mecánica con el dict explícito
 * (EN temporal = ES marcado con TODO donde falta traducir).
 */
import { describe, it, expect } from 'bun:test';
import { getNativeManifests } from '../plugins/index';
import {
  ensureActionI18n,
  localizeActionField,
  localizeActionName,
} from '../plugins/plugin-i18n';

describe('plugin i18n parity', () => {
  it('toda acción nativa trae i18n es+en con name y description', () => {
    const missing: string[] = [];
    for (const m of getNativeManifests() as any[]) {
      for (const a of m.actions ?? []) {
        const es = a?.i18n?.es;
        const en = a?.i18n?.en;
        if (
          typeof es?.name !== 'string' || !es.name ||
          typeof es?.description !== 'string' || !es.description ||
          typeof en?.name !== 'string' || !en.name ||
          typeof en?.description !== 'string' || !en.description
        ) {
          missing.push(`${m.id}.${a?.id}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('ensureActionI18n deriva el fallback sin mutar', () => {
    const action = { id: 'x', name: 'Haz algo', description: 'Hace algo' };
    const out = ensureActionI18n(action);
    expect((action as any).i18n).toBeUndefined();
    expect((out as any).i18n.es).toEqual({ name: 'Haz algo', description: 'Hace algo' });
    expect((out as any).i18n.en).toEqual({ name: 'Haz algo', description: 'Hace algo' });
  });

  it('localizeActionField: locale → en → valor actual', () => {
    const action = {
      name: 'Nombre ES',
      description: 'Desc ES',
      i18n: {
        es: { name: 'Nombre ES', description: 'Desc ES' },
        en: { name: 'EN name', description: 'EN desc' },
      },
    };
    expect(localizeActionName(action, 'es')).toBe('Nombre ES');
    expect(localizeActionName(action, 'en')).toBe('EN name');
    expect(localizeActionField(action, 'description', 'en')).toBe('EN desc');
    // Sin dict: cae al valor actual.
    expect(localizeActionName({ name: 'Solo' } as any, 'en')).toBe('Solo');
    expect(localizeActionName({ name: 'Solo' } as any, 'es', 'FB')).toBe('Solo');
    expect(localizeActionName(null, 'en', 'FB')).toBe('FB');
    // Sin entrada en locale: cae a en.
    const onlyEn = { name: 'Base', i18n: { en: { name: 'EN' } } };
    expect(localizeActionName(onlyEn as any, 'es')).toBe('EN');
  });
});
