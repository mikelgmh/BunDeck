/**
 * plugin-contracts.test.ts — Contrato público de plugins v2.2.
 *
 * Cubre sin DB ni red (salvo fetch stubbed):
 *  (a) tipos: secretos, redactado, estados de botón, helpers de contrato.
 *  (b) validator: states/optionsFrom/widgets/category/os/apiVersion.
 *  (c) permissions: localhost, metadatos cloud, denylist de shell.
 *  (d) catálogo: instalación versionada (pickBestTag) + campos de contrato.
 *  (e) plugins: weather/email puros, today-count, summary, viewer states.
 *  Sin `eval` en el daemon: el sandbox solo transporta eventos validados.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  isSecretField,
  secretFieldsOf,
  redactSettings,
  normalizeButtonState,
  PLUGIN_API_VERSION,
} from '../plugin-system/types';
import { thresholdState, optionsFromStrings, normalizeOptionsResult } from '../plugins/contract';
import { validateManifest } from '../plugin-system/validator';
import { isLocalhostUrl, checkUrlPermission, checkShellPermission } from '../plugin-system/permissions';
import {
  isVersionRangeRef,
  tagToVersion,
  pickBestTag,
  toCatalogEntry,
} from '../catalog';
import { weatherLabel, weatherState, WeatherPlugin } from '../plugins/weather.plugin';
import { emailProviderOf, buildMailto, EmailPlugin } from '../plugins/email.plugin';
import { CalendarPlugin } from '../plugins/calendar.plugin';
import { PCVitalsPlugin } from '../plugins/pc-vitals.plugin';
import { TwitchPlugin } from '../plugins/twitch.plugin';
import { YoutubePlugin } from '../plugins/youtube.plugin';
import { ObsPlugin } from '../plugins/obs.plugin';
import { SpotifyPlugin } from '../plugins/spotify.plugin';
import { HomeAssistantPlugin } from '../plugins/homeassistant.plugin';

const noopCtx = { log: () => {} } as any;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('contrato v2.2: secretos y config flows seguros', () => {
  it('detecta campos secretos por nombre, formato y flag', () => {
    expect(isSecretField('token', { type: 'string' })).toBe(true);
    expect(isSecretField('apiKey', { type: 'string' })).toBe(true);
    expect(isSecretField('password', { type: 'string' })).toBe(true);
    expect(isSecretField('clave', { type: 'string', secret: true })).toBe(true);
    expect(isSecretField('clave', { type: 'string', ui: { type: 'password' } })).toBe(true);
    expect(isSecretField('host', { type: 'string' })).toBe(false);
    expect(secretFieldsOf({ properties: { token: { type: 'string' }, host: { type: 'string' } } })).toEqual(['token']);
  });

  it('redacta secretos sin mutar el original', () => {
    const schema = { properties: { token: { type: 'string' }, host: { type: 'string' } } };
    const out = redactSettings(schema, { token: 'abc123', host: 'h' });
    expect(out).toEqual({ token: '****', host: 'h' });
  });

  it('normalizeButtonState solo acepta valores del catálogo states', () => {
    const states = [{ value: 'live', label: 'En directo' }, { value: 'offline', label: 'Off' }];
    expect(normalizeButtonState(states, 'live')).toBe('live');
    expect(normalizeButtonState(states, 'otro')).toBeNull();
    expect(normalizeButtonState([], 'live')).toBeNull();
  });

  it('helpers de contrato: umbrales y opciones', () => {
    expect(thresholdState(95, [{ max: 75, state: 'ok' }, { max: 90, state: 'warn' }])).toBe('warn');
    expect(thresholdState(99, [{ max: 75, state: 'ok' }, { max: 90, state: 'warn' }])).toBe('warn');
    expect(optionsFromStrings(['a'])).toEqual([{ value: 'a', label: 'a' }]);
    expect(normalizeOptionsResult({ options: [{ value: 'x' }, { nope: 1 }] })).toEqual([{ value: 'x', label: 'x' }]);
    expect(normalizeOptionsResult({})).toEqual([]);
  });
});

describe('contrato v2.2: validator', () => {
  const base = { id: 'x-plug', name: 'X Plug', version: '1.0.0', permissions: ['network'], actions: [{ id: 'a', name: 'A' }] };

  it('acepta el contrato completo (states/optionsFrom/widgets/category/os/apiVersion)', () => {
    const r = validateManifest({
      ...base,
      apiVersion: PLUGIN_API_VERSION,
      engine: '^1.5.0',
      category: 'integrations',
      os: ['win32', 'linux', 'darwin'],
      actions: [{
        id: 'scene', name: 'Escena',
        schema: { type: 'object', properties: { scene: { type: 'string' } }, required: ['scene'] },
        states: [{ value: 'live', label: 'En directo', icon: 'Radio' }],
        optionsFrom: { field: 'scene', sourceAction: 'scene-list', cacheMs: 5000 },
        pollMs: 5000,
      }, { id: 'scene-list', name: 'Lista' }],
      widgets: [{ id: 'viewers', kind: 'text', sourceAction: 'scene-list', refreshMs: 1000 }],
    });
    expect(r.errors).toEqual([]);
  });

  it('rechaza states/optionsFrom/widgets/pollMs mal formados', () => {
    const dup = validateManifest({ ...base, actions: [{ id: 'a', name: 'A', states: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Y' }] }] });
    expect(dup.valid).toBe(false);
    expect(dup.errors.join(' ')).toMatch(/duplicado/);

    const noLabel = validateManifest({ ...base, actions: [{ id: 'a', name: 'A', states: [{ value: 'x' }] }] });
    expect(noLabel.valid).toBe(false);

    const badOpt = validateManifest({
      ...base,
      actions: [{ id: 'a', name: 'A', schema: { type: 'object', properties: { s: { type: 'string' } } }, optionsFrom: { field: 'nope', sourceAction: 'a' } }],
    });
    expect(badOpt.valid).toBe(false);
    expect(badOpt.errors.join(' ')).toMatch(/no está en schema/);

    const badWidget = validateManifest({ ...base, actions: [{ id: 'a', name: 'A' }], widgets: [{ id: 'w', kind: 'video' }] });
    expect(badWidget.valid).toBe(false);

    const badPoll = validateManifest({ ...base, actions: [{ id: 'a', name: 'A', pollMs: 10 }] });
    expect(badPoll.valid).toBe(false);

    const badOs = validateManifest({ ...base, os: 'win32' as any });
    expect(badOs.valid).toBe(false);
  });

  it('apiVersion mayor que el daemon avisa (no rompe)', () => {
    const r = validateManifest({ ...base, apiVersion: '99.0.0' });
    expect(r.valid).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/actualiza LibreDeck/);
  });

  it('todos los nativos siguen pasando el validator sin errores', async () => {
    const { getNativeManifests } = await import('../plugins/index');
    for (const m of getNativeManifests()) {
      const r = validateManifest(m);
      expect({ id: (m as any).id, errors: r.errors }).toEqual({ id: (m as any).id, errors: [] });
    }
  });
});

describe('contrato v2.2: permisos validados', () => {
  it('isLocalhostUrl distingue local de público', () => {
    expect(isLocalhostUrl('http://localhost:3001/x')).toBe(true);
    expect(isLocalhostUrl('http://127.0.0.1/x')).toBe(true);
    expect(isLocalhostUrl('https://api.example.com/x')).toBe(false);
  });

  it('bloquea localhost sin permiso system y metadatos cloud siempre', () => {
    const noSys = { id: 'p', permissions: ['http'] } as any;
    expect(() => checkUrlPermission(noSys, 'http://localhost:3001/x')).toThrow(/system/);
    expect(() => checkUrlPermission(noSys, 'http://169.254.169.254/latest')).toThrow(/metadatos/);
    const withSys = { id: 'p', permissions: ['http', 'system'] } as any;
    expect(() => checkUrlPermission(withSys, 'http://localhost:3001/x')).not.toThrow();
    expect(() => checkUrlPermission({ id: 'p', permissions: [] } as any, 'https://x.com')).toThrow(/http/);
    expect(() => checkUrlPermission(noSys, 'ftp://x.com')).toThrow(/Protocolo/);
  });

  it('shell bloquea patrones peligrosos conocidos', () => {
    const m = { id: 'p', permissions: ['shell'] } as any;
    expect(() => checkShellPermission(m, 'rm -rf / --no-preserve-root')).toThrow(/bloqueado/);
    expect(() => checkShellPermission(m, 'powershell -enc aGVsbG8=')).toThrow(/bloqueado/);
    expect(() => checkShellPermission(m, 'echo hola')).not.toThrow();
    expect(() => checkShellPermission({ id: 'p', permissions: [] } as any, 'echo hola')).toThrow(/permiso/);
  });
});

describe('contrato v2.2: catálogo e instalación versionada', () => {
  it('isVersionRangeRef distingue rangos de ramas/tags', () => {
    expect(isVersionRangeRef('^1.0.0')).toBe(true);
    expect(isVersionRangeRef('>=2.0.0')).toBe(true);
    expect(isVersionRangeRef('*')).toBe(true);
    expect(isVersionRangeRef('latest')).toBe(true);
    expect(isVersionRangeRef('main')).toBe(false);
    expect(isVersionRangeRef('v1.2.3')).toBe(false);
  });

  it('tagToVersion normaliza v-prefijos e ignora basura', () => {
    expect(tagToVersion('v1.2.3')).toBe('1.2.3');
    expect(tagToVersion('1.2.3')).toBe('1.2.3');
    expect(tagToVersion('release')).toBeNull();
  });

  it('pickBestTag elige el mayor tag del rango', () => {
    const tags = ['v1.0.0', 'v1.2.0', 'v2.0.0', 'release'];
    expect(pickBestTag(tags, '^1.0.0')).toBe('v1.2.0');
    expect(pickBestTag(tags, '>=1.0.0')).toBe('v2.0.0');
    expect(pickBestTag(tags, '^2.0.0')).toBe('v2.0.0');
    expect(pickBestTag(tags, '^3.0.0')).toBeNull();
    expect(pickBestTag([], '*')).toBeNull();
  });

  it('toCatalogEntry expone apiVersion/engine/widgets sin romper el índice', () => {
    const e = toCatalogEntry({
      id: 'obs', name: 'OBS', version: '1.2.0', permissions: ['network'], actions: [],
      apiVersion: '2.2', engine: '^1.5.0', widgets: [{ id: 'w', kind: 'text' }],
    });
    expect(e.apiVersion).toBe('2.2');
    expect(e.engine).toBe('^1.5.0');
    expect(e.widgets).toEqual(['w']);
  });
});

describe('contrato v2.2: integraciones robustecidas', () => {
  it('weather: labels y estados puros', () => {
    expect(weatherLabel(0)).toBe('Despejado');
    expect(weatherLabel(95)).toBe('Tormenta');
    expect(weatherState(20, 0)).toBe('clear');
    expect(weatherState(10, 63)).toBe('rain');
    expect(weatherState(-2, 73)).toBe('snow');
    expect(weatherState(5, 45)).toBe('fog');
    const m = new WeatherPlugin(noopCtx).getManifest();
    expect(m.id).toBe('weather');
    expect(m.permissions).toContain('network');
    expect(m.actions.map((a: any) => a.id).sort()).toEqual(['forecast', 'now', 'search-place']);
    const now = m.actions.find((a: any) => a.id === 'now');
    expect(now.dynamic).toBe(true);
    expect(now.states.length).toBeGreaterThan(0);
  });

  it('email: proveedor, mailto y manifest', () => {
    expect(emailProviderOf('outlook')).toBe('outlook');
    expect(emailProviderOf('hotmail')).toBe('outlook');
    expect(emailProviderOf('gmail')).toBe('gmail');
    expect(emailProviderOf('')).toBe('gmail');
    expect(buildMailto('a@x.com', 'Hola', 'Cuerpo')).toBe('mailto:a%40x.com?subject=Hola&body=Cuerpo');
    const m = new EmailPlugin(noopCtx).getManifest();
    expect(m.actions.map((a: any) => a.id).sort()).toEqual(['compose', 'open-inbox', 'unread']);
    expect(m.settingsSchema.properties.token.secret).toBe(true);
  });

  it('obs expone status con options para opciones dinámicas', () => {
    const m = new ObsPlugin(noopCtx).getManifest();
    const status = m.actions.find((a: any) => a.id === 'status');
    expect(status).toBeDefined();
    expect(status.dynamic).toBe(true);
    expect(status.states.map((s: any) => s.value).sort()).toEqual(['live', 'offline']);
    const scene = m.actions.find((a: any) => a.id === 'scene');
    expect(scene.optionsFrom).toMatchObject({ field: 'scene', sourceAction: 'scene-list' });
  });

  it('spotify now-playing y homeassistant get-state en manifiestos', () => {
    const sp = new SpotifyPlugin(noopCtx).getManifest();
    expect(sp.actions.some((a: any) => a.id === 'now-playing')).toBe(true);
    const ha = new HomeAssistantPlugin(noopCtx).getManifest();
    expect(ha.actions.some((a: any) => a.id === 'get-state')).toBe(true);
    expect(ha.actions.find((a: any) => a.id === 'light').states.length).toBeGreaterThan(0);
  });

  it('calendar today-count cuenta eventos de hoy (ICS temporal)', async () => {
    // Anclado al mediodía LOCAL de hoy: un offset fijo (+1h) caería en mañana
    // si el run es 23:00-00:00 UTC y el test fallaría una hora al día.
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const stamp = noon.toISOString().replace(/[-:]/g, '').split('.')[0];
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:Hoy mismo',
      `DTSTART:${stamp}Z`,
      'END:VEVENT',
      'BEGIN:VEVENT',
      'SUMMARY:Pasado',
      'DTSTART:20000101T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n');
    const path = `${process.env.TMPDIR ?? '/tmp'}/ld-cal-${Date.now()}.ics`;
    await Bun.write(path, ics);
    try {
      const plugin = new CalendarPlugin(noopCtx);
      const res = await plugin.getActionHandlers().get('today-count')!({ icsPath: path }, {});
      expect(res.count).toBe(1);
      expect(res.widget.kind).toBe('text');
    } finally {
      try { await Bun.file(path).exists() && (await import('node:fs/promises')).unlink(path); } catch {}
    }
  });

  it('pc-vitals summary devuelve state discreto por umbrales', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ cpu: { usage: 95 }, ram: { usage: 10 } }))) as typeof fetch;
    const plugin = new PCVitalsPlugin(noopCtx);
    const res = await plugin.getActionHandlers().get('summary')!({}, {});
    expect(res.state).toBe('crit');
    expect(res.widget.kind).toBe('gauge');
  });

  it('twitch viewer-count devuelve state live/offline (fetch simulado)', async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/users')) return new Response(JSON.stringify({ data: [{ id: '123' }] }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ viewer_count: 7, title: 'D', game_name: 'J' }] }), { status: 200 });
    }) as typeof fetch;
    const plugin = new TwitchPlugin(noopCtx);
    const res = await plugin.getActionHandlers().get('viewer-count')!({ clientId: 'c', token: 't', broadcaster: 'canal' }, {});
    expect(res.state).toBe('live');
    expect(res.widget.kind).toBe('text');
  });

  it('youtube viewer-count devuelve state + widget (fetch simulado)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      items: [{ snippet: { title: 'T' }, liveStreamingDetails: { concurrentViewers: '3', activeLiveChatId: 'c' }, statistics: {} }],
    }), { status: 200 })) as typeof fetch;
    const plugin = new YoutubePlugin(noopCtx);
    const res = await plugin.getActionHandlers().get('viewer-count')!({ apiKey: 'k', videoId: 'v' }, {});
    expect(res.state).toBe('live');
    expect(res.viewerCount).toBe(3);
  });
});
