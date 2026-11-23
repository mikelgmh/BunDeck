/**
 * variables-bus.test.ts — servicio daemon de variables + bus de eventos.
 *
 * Cubre: persistencia, scopes, tipos, plantillas con filtros,
 * concurrencia, eventos que disparan flujos, compat local.set-var/
 * local.toggle-var, REST /api/v1/variables y notificaciones WS.
 *
 * Funciona con la BD real (corrida aislada: initDatabase en tmp) y con el
 * mock compartido de action-runner.test.ts (suite completa).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseService, initDatabase } from '../db';
import { VariableStore, resetVariableStore, varToJSON } from '../variables/store';
import { EventBus, BUS_WS_FORWARD, busWsTopic } from '../events/bus';
import { FlowEngine } from '../automation/flows';
import { handleVariables } from '../api/variables';
import { ActionRunner } from '../action-runner';

const P = 'vb_';

function makeStore(bus?: EventBus): { db: DatabaseService; bus: EventBus; store: VariableStore } {
  const db = new DatabaseService();
  const b = bus ?? new EventBus();
  return { db, bus: b, store: new VariableStore(db, b) };
}

async function api(path: string, method: string, body?: any): Promise<{ status: number; json: any }> {
  const res = await handleVariables(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as any,
    { url: new URL(`http://localhost${path}`), method, path, db: new DatabaseService(), services: {} as any },
  );
  const json = await (res as Response).json().catch(() => null);
  return { status: (res as Response).status, json };
}

beforeAll(async () => {
  // Corrida aislada (sin el mock global): BD real en un directorio temporal.
  try {
    process.env.LIBREDECK_DATA_DIR = join(tmpdir(), `libredeck-test-vars-${process.pid}`);
    await initDatabase();
  } catch { /* suite completa: rige el mock compartido */ }
});

beforeEach(() => {
  resetVariableStore();
});

describe('variables: persistencia', () => {
  it('1. lo guardado se lee desde una instancia nueva (misma BD)', async () => {
    const a = makeStore();
    a.store.define({ name: `${P}persist`, type: 'numeric', value: 41 });
    await a.store.set(`${P}persist`, 42, { source: 'test' });

    const b = makeStore(); // caché vacía, misma BD (mock o real)
    const def = b.store.get(`${P}persist`);
    expect(def).not.toBeNull();
    expect(def!.value).toBe(42);
    expect(def!.type).toBe('numeric');
    await b.store.delete(`${P}persist`);
    expect(makeStore().store.get(`${P}persist`)).toBeNull();
  });

  it('2. define() duplicado lanza; nombres inválidos y reservados lanzan', () => {
    const { store } = makeStore();
    store.define({ name: `${P}dup` });
    expect(() => store.define({ name: `${P}dup` })).toThrow(/ya existe/);
    expect(() => store.define({ name: 'mala variable' })).toThrow(/inválido/);
    expect(() => store.define({ name: 'y' })).toThrow(/reservado/);
    expect(() => store.define({ name: '' })).toThrow(/vacío/);
  });
});

describe('variables: scopes', () => {
  it('3. global/widget/script/automation con fallback al global', async () => {
    const { store } = makeStore();
    store.define({ name: `${P}scope`, value: 'global' });
    store.define({ name: `${P}scope`, value: 'widget', scope: 'widget', scopeId: 'w1' });
    store.define({ name: `${P}scoped_only`, value: 7, scope: 'script', scopeId: 's1' });

    expect(store.get(`${P}scope`)!.value).toBe('global');
    expect(store.get(`${P}scope`, 'widget', 'w1')!.value).toBe('widget');
    // Otro widget sin valor propio hereda el global
    expect(store.get(`${P}scope`, 'widget', 'w2')!.value).toBe('global');
    // Automation sin valor propio hereda el global
    expect(store.get(`${P}scope`, 'automation', 'a9')!.value).toBe('global');
    // Sin global no hay fallback
    expect(store.get(`${P}scoped_only`)).toBeNull();
    expect(store.get(`${P}scoped_only`, 'script', 's1')!.value).toBe(7);

    const resolved = store.resolved('widget', 'w1').filter((d) => d.name.startsWith(P));
    const names = resolved.map((d) => d.name);
    expect(names).toContain(`${P}scope`);
    // La propia gana al global en resolved()
    expect(resolved.find((d) => d.name === `${P}scope`)!.value).toBe('widget');
  });

  it('4. scope inválido lanza', () => {
    const { store } = makeStore();
    expect(() => store.define({ name: `${P}x`, scope: 'galaxia' })).toThrow(/Scope inválido/);
  });
});

describe('variables: tipos', () => {
  it('5. coerciones text/numeric/bool/color', async () => {
    const { store } = makeStore();
    expect(store.define({ name: `${P}t`, type: 'text', value: 123 }).value).toBe('123');
    expect(store.define({ name: `${P}tinfer`, value: 123 }).value).toBe(123);
    expect(store.get(`${P}tinfer`)!.type).toBe('numeric');
    expect(store.define({ name: `${P}n`, type: 'numeric', value: '3.5' }).value).toBe(3.5);
    expect(store.define({ name: `${P}n2`, type: 'num', value: 'abc' }).value).toBe(0);
    expect(store.define({ name: `${P}b`, type: 'bool', value: 'sí' }).value).toBe(true);
    expect(store.define({ name: `${P}c`, type: 'color', value: '#ff00aa' }).value).toBe('#ff00aa');
    expect(() => store.define({ name: `${P}cbad`, type: 'color', value: 'rojo' })).toThrow(/Color inválido/);
    expect(() => store.define({ name: `${P}tbag`, type: 'texto' })).toThrow(/Tipo de variable inválido/);

    await store.set(`${P}n`, '9');
    expect(store.get(`${P}n`)!.value).toBe(9);
  });

  it('6. toggle por tipo + unavailable', async () => {
    const { store } = makeStore();
    store.define({ name: `${P}tb`, type: 'bool', value: false });
    store.define({ name: `${P}tn`, type: 'numeric', value: 0 });
    store.define({ name: `${P}tt`, value: '' });

    expect((await store.toggle(`${P}tb`)).value).toBe(true);
    expect((await store.toggle(`${P}tn`)).value).toBe(1);
    expect((await store.toggle(`${P}tt`)).value).toBe('sí');

    await store.setUnavailable(`${P}tb`, true);
    const def = store.require(`${P}tb`);
    expect(def.unavailable).toBe(true);
    expect(def.value).toBe(true); // conserva el último valor
    expect(store.render(`A[{{vars.${P}tb}}]B`)).toBe('A[]B');
    expect(store.render(`A[{{vars.${P}tb | default("?")}}]B`)).toBe('A[?]B');
  });
});

describe('variables: plantillas con filtros', () => {
  it('7. {{vars.x}}, nombre pelado y filtros básicos', async () => {
    const { store } = makeStore();
    store.define({ name: `${P}nombre`, value: 'mundo' });
    store.define({ name: `${P}precio`, type: 'numeric', value: 3.14159 });
    store.define({ name: `${P}on`, type: 'bool', value: true });

    expect(store.render('Hola {{vars.vb_nombre}}!')).toBe('Hola mundo!');
    expect(store.render('Hola {{vb_nombre}}!')).toBe('Hola mundo!');
    expect(store.render('{{vars.vb_nombre | upper}}')).toBe('MUNDO');
    expect(store.render('{{ vars.vb_nombre | lower }}')).toBe('mundo');
    expect(store.render('{{vars.vb_precio | fixed(2)}}')).toBe('3.14');
    expect(store.render('{{vars.vb_precio | round}}')).toBe('3');
    expect(store.render('{{vars.vb_on | yesno("ON","OFF")}}')).toBe('ON');
    expect(store.render('{{vars.vb_nombre | length}}')).toBe('5');
    expect(store.render('{{vars.vb_nombre | json}}')).toBe('"mundo"');
    expect(store.render('[{{vars.vb_falta | default("N/A")}}]')).toBe('[N/A]');
    expect(store.render('a{{vars.vb_falta}}b')).toBe('ab');
    expect(store.render('{{vb_precio + 1}}')).toBe('4.14159');
    expect(store.render('{{vars.vb_nombre | capitalize}}')).toBe('Mundo');
  });

  it('8. filtro desconocido → ⚠; Jinja ajena intacta en modo lenient', () => {
    const { store } = makeStore();
    expect(store.render('{{vars.vb_nombre | rot13}}')).toBe('⚠');
    expect(store.renderLenient('{{ states("light.salon") }}')).toBe('{{ states("light.salon") }}');
    expect(store.renderLenient('{{ vars.vb_falta }}')).toBe('{{ vars.vb_falta }}');
  });
});

describe('variables: concurrencia', () => {
  it('9. 50 increments atómicos no pierden escrituras', async () => {
    const { store } = makeStore();
    store.define({ name: `${P}conc`, type: 'numeric', value: 0 });
    await Promise.all(
      Array.from({ length: 50 }, () => store.update(`${P}conc`, (c) => Number(c) + 1)),
    );
    expect(store.get(`${P}conc`)!.value).toBe(50);
  });

  it('10. sets paralelos en claves distintas persisten todos', async () => {
    const { store } = makeStore();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.set(`${P}par${i}`, i)),
    );
    for (let i = 0; i < 20; i++) {
      expect(store.get(`${P}par${i}`)!.value).toBe(i);
    }
  });
});

describe('bus de eventos', () => {
  it('11. variable-changed lleva payload completo + onVarChange filtra', async () => {
    const { bus, store } = makeStore();
    store.define({ name: `${P}ev`, type: 'numeric', value: 0 });
    const seen: any[] = [];
    bus.on('variable-changed', (p) => { seen.push(p); });
    const mine: any[] = [];
    store.onVarChange(`${P}ev`, (p) => { mine.push(p); });

    await store.set(`${P}ev`, 5, { source: 'test' });
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ name: `${P}ev`, scope: 'global', value: 5, previous: 0, unavailable: false, source: 'test' });
    expect(typeof seen[0].ts).toBe('number');
    expect(mine.length).toBe(1);

    // Sin cambio de valor no re-emite
    await store.set(`${P}ev`, 5, { source: 'test' });
    expect(seen.length).toBe(1);
  });

  it('12. canales integration/timer/calendar/media/client-connected + waitFor', async () => {
    const bus = new EventBus();
    const got = bus.waitFor('integration', (p) => p.integration === 'spotify');
    bus.emit('integration', { integration: 'spotify', state: 'playing' });
    expect((await got).state).toBe('playing');

    bus.emit('timer', { tick: 1 });
    bus.emit('calendar', { kind: 'sync' });
    bus.emit('media', { kind: 'state' });
    bus.emit('client-connected', { clientId: 'c1' });
    expect(bus.recent('timer').length).toBe(1);
    expect(bus.recent('calendar').length).toBe(1);
    expect(bus.recent('media').length).toBe(1);
    expect(bus.recent('client-connected').length).toBe(1);

    await expect(bus.waitFor('media', undefined, 30)).rejects.toThrow(/Timeout/);
  });

  it('13. mapeo bus → WS topics', () => {
    expect(BUS_WS_FORWARD['variable-changed']).toBe('variable.changed');
    expect(BUS_WS_FORWARD['integration']).toBe('event.integration');
    expect(BUS_WS_FORWARD['calendar']).toBe('event.calendar');
    expect(BUS_WS_FORWARD['media']).toBe('event.media');
    expect(BUS_WS_FORWARD['timer']).toBe('event.timer');
    expect(busWsTopic('variable-changed')).toBe('variables');
    expect(busWsTopic('integration')).toBe('events');
  });

  it('14. cambios notifican por WS (topic variables, best-effort)', async () => {
    const sent: any[] = [];
    (globalThis as any).__libredeckWs = { broadcast: (e: string, p: any, t?: string) => sent.push([e, p, t]) };
    try {
      const { store } = makeStore();
      store.define({ name: `${P}ws`, value: 'a' });
      sent.length = 0;
      await store.set(`${P}ws`, 'b', { source: 'test' });
      expect(sent.length).toBe(1);
      expect(sent[0][0]).toBe('variable.changed');
      expect(sent[0][2]).toBe('variables');
      expect(sent[0][1]).toMatchObject({ name: `${P}ws`, value: 'b' });

      await store.delete(`${P}ws`);
      expect(sent.at(-1)[0]).toBe('variable.deleted');
    } finally {
      delete (globalThis as any).__libredeckWs;
    }
  });
});

describe('variables: bindings lectura/escritura', () => {
  it('15. syncFromIntegration alimenta bindings.read y el cambio propaga write', async () => {
    const { bus, store } = makeStore();
    store.define({
      name: `${P}bind`, type: 'text', value: '',
      bindings: { read: 'ha.light.salon', write: ['dash.label'] },
    });
    const changed: any[] = [];
    bus.on('variable-changed', (p) => { if (p.name === `${P}bind`) changed.push(p); });

    const updated = await store.syncFromIntegration('ha.light.salon', 'on', 'integration:ha');
    expect(updated.length).toBe(1);
    expect(updated[0].value).toBe('on');
    expect(changed.length).toBe(1);
    expect(changed[0].source).toBe('integration:ha');

    // Otra entidad no toca nada
    expect(await store.syncFromIntegration('ha.light.otro', 'on')).toEqual([]);
    expect(varToJSON(store.require(`${P}bind`)).bindings).toEqual({ read: 'ha.light.salon', write: ['dash.label'] });
  });
});

describe('eventos que disparan flujos', () => {
  it('16. flow en variable-changed ejecuta acciones; equals filtra', async () => {
    const { db, bus, store } = makeStore();
    const calls: any[] = [];
    const runner = { executeAction: async (a: any, c: any) => { calls.push([a, c]); return { success: true, duration: 1 }; } };
    const engine = new FlowEngine(bus, runner, db);
    engine.upsert({
      id: `${P}flow1`,
      on: { event: 'variable-changed', var: `${P}trig`, equals: 'go' },
      actions: [{ type: 'utility.delay', parameters: { duration: 1 } }],
    });
    engine.upsert({
      id: `${P}flow2`,
      on: { event: 'variable-changed', var: `${P}trig` },
      actions: [{ type: 'test.echo', parameters: {} }],
    });
    engine.start();

    // No coincide equals → solo flow2
    calls.length = 0;
    store.define({ name: `${P}trig`, value: '' });
    const p1 = bus.waitFor('flow.executed', (p) => p.flowId === `${P}flow2`);
    await store.set(`${P}trig`, 'stop');
    await p1;
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toMatchObject({ trigger: 'variable-changed', flowId: `${P}flow2` });

    // Coincide equals → ambos
    calls.length = 0;
    const p2 = bus.waitFor('flow.executed', (p) => p.flowId === `${P}flow1`);
    const p3 = bus.waitFor('flow.executed', (p) => p.flowId === `${P}flow2`);
    await store.set(`${P}trig`, 'go');
    await p2;
    await p3;
    expect(calls.length).toBe(2);

    // Deshabilitado no dispara
    engine.upsert({ id: `${P}flow2`, enabled: false, on: { event: 'variable-changed', var: `${P}trig` }, actions: [] });
    calls.length = 0;
    await store.set(`${P}trig`, 'otra');
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.length).toBe(0);
    engine.stop();
  });

  it('17. flows persisten en settings (automation.flows)', () => {
    const { db, bus } = makeStore();
    const e1 = new FlowEngine(bus, null, db);
    e1.upsert({ id: `${P}saved`, on: { event: 'timer' }, actions: [{ type: 'utility.delay', parameters: {} }] });
    const e2 = new FlowEngine(new EventBus(), null, db);
    const loaded = e2.load();
    expect(loaded.some((f) => f.id === `${P}saved`)).toBe(true);
    e2.remove(`${P}saved`);
    expect(new FlowEngine(new EventBus(), null, db).load().some((f) => f.id === `${P}saved`)).toBe(false);
  });
});

describe('compat local.set-var / local.toggle-var', () => {
  function makeRunner(): ActionRunner {
    return new ActionRunner({ setActionCallbacks: () => {} } as any);
  }

  it('18. set-var con expr y toggle-var sobre el scope global', async () => {
    const runner = makeRunner();
    const store = runner.getVariableStore();
    store.define({ name: `${P}contador`, type: 'numeric', value: 0 });
    store.define({ name: `${P}mute`, type: 'bool', value: false });
    store.define({ name: `${P}saludo`, value: 'hola' });

    const r1 = await runner.executeAction(
      { type: 'local.set-var', parameters: { name: `${P}contador`, expr: `${P}contador + 1` } },
      { timestamp: Date.now() },
    );
    expect(r1.success).toBe(true);
    expect(r1.result).toMatchObject({ name: `${P}contador`, value: 1 });

    const r2 = await runner.executeAction(
      { type: 'local.toggle-var', parameters: { name: `${P}mute` } },
      { timestamp: Date.now() },
    );
    expect(r2.success).toBe(true);
    expect(r2.result.value).toBe(true);

    // Variable desconocida → error (como el motor web)
    const r3 = await runner.executeAction(
      { type: 'local.set-var', parameters: { name: `${P}noexiste`, expr: '1' } },
      { timestamp: Date.now() },
    );
    expect(r3.success).toBe(false);
    expect(r3.error).toMatch(/desconocida/);
    runner.dispose();
  });

  it('19. interpola {{vars.x}} conocidas y respeta Jinja ajena', async () => {
    const runner = makeRunner();
    const store = runner.getVariableStore();
    store.define({ name: `${P}txt`, value: 'mundo' });
    let seen: any = null;
    runner.registerAction('test.echo', async (params: any) => { seen = params; return params; });

    const r = await runner.executeAction(
      {
        type: 'test.echo',
        parameters: { a: 'hola {{vars.vb_txt}}', b: '{{ states("light.x") }}', n: 5 },
      },
      { timestamp: Date.now() },
    );
    expect(r.success).toBe(true);
    expect(seen.a).toBe('hola mundo');
    expect(seen.b).toBe('{{ states("light.x") }}');
    expect(seen.n).toBe(5);
    runner.dispose();
  });
});

describe('REST /api/v1/variables', () => {
  it('20. CRUD completo + códigos de error', async () => {
    // define
    let r = await api('/api/v1/variables', 'POST', { name: `${P}rest`, type: 'numeric', value: 1 });
    expect(r.status).toBe(201);
    expect(r.json.variable).toMatchObject({ name: `${P}rest`, type: 'numeric', value: 1, scope: 'global' });

    // duplicado → 409
    r = await api('/api/v1/variables', 'POST', { name: `${P}rest` });
    expect(r.status).toBe(409);

    // nombre inválido → 400
    r = await api('/api/v1/variables', 'POST', { name: 'mal nombre' });
    expect(r.status).toBe(400);

    // get
    r = await api(`/api/v1/variables/${P}rest`, 'GET');
    expect(r.status).toBe(200);
    expect(r.json.variable.value).toBe(1);

    // inexistente → 404
    r = await api(`/api/v1/variables/${P}rest_missing`, 'GET');
    expect(r.status).toBe(404);

    // put valor
    r = await api(`/api/v1/variables/${P}rest`, 'PUT', { value: 7 });
    expect(r.status).toBe(200);
    expect(r.json.variable.value).toBe(7);

    // put retype a text
    r = await api(`/api/v1/variables/${P}rest`, 'PUT', { type: 'text' });
    expect(r.status).toBe(200);
    expect(r.json.variable.type).toBe('text');
    expect(r.json.variable.value).toBe('7');

    // lista contiene la variable
    r = await api('/api/v1/variables', 'GET');
    expect(r.status).toBe(200);
    expect(r.json.variables.some((v: any) => v.name === `${P}rest`)).toBe(true);

    // toggle numérico: '7' → truthy → 0
    r = await api(`/api/v1/variables/${P}rest`, 'PUT', { type: 'numeric', value: 5 });
    expect(r.json.variable.value).toBe(5);
    r = await api(`/api/v1/variables/${P}rest/toggle`, 'POST', {});
    expect(r.status).toBe(200);
    expect(r.json.variable.value).toBe(0);

    // render
    r = await api('/api/v1/variables/render', 'POST', { template: `v={{vars.${P}rest | fixed(1)}}` });
    expect(r.status).toBe(200);
    expect(r.json.result).toBe('v=0.0');

    // delete
    r = await api(`/api/v1/variables/${P}rest`, 'DELETE');
    expect(r.status).toBe(200);
    r = await api(`/api/v1/variables/${P}rest`, 'GET');
    expect(r.status).toBe(404);
  });

  it('21. unavailable y bindings por REST', async () => {
    await api('/api/v1/variables', 'POST', {
      name: `${P}restb`, type: 'text', value: 'x', bindings: { read: 'ha.s', write: 'dash' },
    });
    let r = await api(`/api/v1/variables/${P}restb`, 'PUT', { unavailable: true });
    expect(r.json.variable.unavailable).toBe(true);
    expect(r.json.variable.bindings).toEqual({ read: 'ha.s', write: 'dash' });
    r = await api(`/api/v1/variables/${P}restb`, 'PUT', { value: 'y', unavailable: false });
    expect(r.json.variable).toMatchObject({ value: 'y', unavailable: false });
    await api(`/api/v1/variables/${P}restb`, 'DELETE');
  });
});
