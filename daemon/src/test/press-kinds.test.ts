/**
 * pressActions por tipo de pulsación (Fase B): buttonDataToNodes ejecuta la
 * lista de cada pressType + sus reglas `when`, con `actions[]` como espejo
 * legacy de click y `alt` solo en short.
 */
import { describe, it, expect } from 'bun:test';
import { buttonDataToNodes, buttonHasTrigger } from '../flow/migrate';
import { legacyTriggerToPress } from '../flow/types';

const a = (type: string) => ({ id: `x-${type}`, type, parameters: {} });

describe('pressActions por tipo de pulsación', () => {
  it('legacy: actions[] solo van al short', () => {
    const data = { actions: [a('shell')], mode: 'seq', rules: [] };
    expect(buttonDataToNodes(data, 'short').nodes.length).toBe(1);
    expect(buttonDataToNodes(data, 'double').hasContent).toBe(false);
    expect(buttonDataToNodes(data, 'long').hasContent).toBe(false);
  });

  it('cada tipo ejecuta su lista (click/double/triple/long)', () => {
    const data = {
      actions: [a('shell')],
      pressActions: { double: [a('web')], triple: [a('key')], long: [a('txt')] },
      mode: 'seq',
      rules: [],
    };
    const firstType = (press: any) => (buttonDataToNodes(data, press).nodes[0] as any)?.type;
    expect(firstType('short')).toBe('shell');
    expect(firstType('double')).toBe('web');
    expect(firstType('triple')).toBe('key');
    expect(firstType('long')).toBe('txt');
  });

  it('pressActions.click manda sobre actions[] (espejo legacy)', () => {
    const data = {
      actions: [a('shell')],
      pressActions: { click: [a('web')] },
      mode: 'seq',
      rules: [],
    };
    const { nodes } = buttonDataToNodes(data, 'short');
    expect(nodes.length).toBe(1);
    expect((nodes[0] as any).type).toBe('web');
  });

  it('reglas when double/triple/long corren en su pressType tras la lista', () => {
    const data = {
      actions: [],
      pressActions: { double: [a('shell')] },
      mode: 'seq',
      rules: [
        { on: true, when: 'double', then: [a('web')], else: [] },
        { on: true, when: 'triple', then: [a('key')], else: [] },
        { on: true, when: 'long', then: [a('txt')], else: [] },
      ],
    };
    // lista (1) + regla if/sequence (1) = 2 nodos en double
    expect(buttonDataToNodes(data, 'double').nodes.length).toBeGreaterThanOrEqual(2);
    expect(buttonDataToNodes(data, 'triple').hasContent).toBe(true);
    expect(buttonDataToNodes(data, 'long').hasContent).toBe(true);
    expect(buttonDataToNodes(data, 'short').hasContent).toBe(false);
  });

  it('buttonHasTrigger distingue por tipo (lo usa el driver HW)', () => {
    const data = {
      actions: [a('shell')],
      pressActions: { double: [a('web')] },
      mode: 'seq',
      rules: [],
    };
    expect(buttonHasTrigger(data, 'short')).toBe(true);
    expect(buttonHasTrigger(data, 'double')).toBe(true);
    expect(buttonHasTrigger(data, 'triple')).toBe(false);
    expect(buttonHasTrigger(data, 'touch-start')).toBe(false);
  });

  it('legacyTriggerToPress mapea press/click/double/triple/long', () => {
    expect(legacyTriggerToPress('press')).toBe('short');
    expect(legacyTriggerToPress('click')).toBe('short');
    expect(legacyTriggerToPress('long')).toBe('long');
    expect(legacyTriggerToPress('double')).toBe('double');
    expect(legacyTriggerToPress('triple')).toBe('triple');
    expect(legacyTriggerToPress('load')).toBeNull();
  });
});
