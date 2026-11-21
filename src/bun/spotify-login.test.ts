/**
 * spotify-login.test.ts — login de Spotify sin Client ID (host Electrobun).
 * Solo helpers puros + polling con fetch/BrowserWindow inyectados:
 * nunca se crea una ventana real en tests.
 */
import { describe, it, expect, beforeEach } from 'bun:test';

process.env.LIBREDECK_HOST_TEST = '1';

const {
    buildSpotifySnifferScript,
    fetchSpotifyLoginStatus,
    fetchSpotifySettingsBundle,
    fetchSpotifyDaemonSetting,
    setSpotifyDaemonSetting,
    clearSpotifyLoginRequest,
    readSpotifySessionCookies,
    hasSpotifySession,
    mintSpotifyTokenViaCookies,
    postSpotifyTokenCapture,
    shouldReapStaleWindow,
    openSpotifyLoginWindow,
    startSpotifyLoginPolling,
    decideSpotifyWindowAction,
    __resetSpotifyLoginStateForTests,
    daemonBase,
    SPOTIFY_WEB_PLAYER_URL,
} = await import('./spotify-login');

beforeEach(() => {
    __resetSpotifyLoginStateForTests();
});

describe('spotify-login helpers', () => {
    it('daemonBase apunta a loopback', () => {
        expect(daemonBase(3001)).toBe('http://127.0.0.1:3001');
    });

    it('el sniffer no menciona iframes y apunta al Web Player + capture', () => {
        const js = buildSpotifySnifferScript(3001);
        expect(js).not.toMatch(/iframe/i);
        expect(js).toContain('/get_access_token');
        expect(js).toContain('http://127.0.0.1:3001/api/v1/plugins/spotify/token-capture');
        expect(js).toContain('credentials');
        // Idempotente: doble inyección no duplica intervalos.
        expect(js).toContain('__ldSpotifySniff');
    });

    it('el sniffer renueva en bucle sin cerrar la ventana (sesión persistente)', () => {
        const js = buildSpotifySnifferScript(3001);
        // Sin window.close: la ventana debe seguir viva para reacuñar.
        expect(js).not.toContain('window.close');
        // Solo publica cuando el token cambia.
        expect(js).toContain('__ldSpotifyNow');
        expect(js).toContain('10000');
        // En la pantalla de login (accounts.*) no hace nada hasta el redirect.
        expect(js).toContain('open.spotify.com');
    });

    it('fetchSpotifyLoginStatus devuelve el pending del daemon', async () => {
        const fetchFn = (async () => ({
            ok: true,
            json: async () => ({ pluginId: 'spotify', pending: true, requestedAt: '123', configured: false, missing: ['token'] }),
        })) as any;
        const st = await fetchSpotifyLoginStatus(fetchFn, 3001);
        expect(st?.pending).toBe(true);
        expect(st?.missing).toEqual(['token']);
    });

    it('fetchSpotifyLoginStatus devuelve null si el daemon falla', async () => {
        const fetchFn = (async () => { throw new Error('down'); }) as any;
        expect(await fetchSpotifyLoginStatus(fetchFn, 3001)).toBeNull();
        const notOk = (async () => ({ ok: false })) as any;
        expect(await fetchSpotifyLoginStatus(notOk, 3001)).toBeNull();
    });

    it('clearSpotifyLoginRequest hace DELETE best-effort sin lanzar', async () => {
        const calls: any[] = [];
        await clearSpotifyLoginRequest((async (u: string, init: any) => {
            calls.push([u, init]);
            return { ok: true };
        }) as any, 3001);
        expect(calls[0][0]).toContain('/login-request');
        expect(calls[0][1].method).toBe('DELETE');
        // Aunque fetch falle, no lanza.
        await clearSpotifyLoginRequest((async () => { throw new Error('x'); }) as any, 3001);
    });

    it('openSpotifyLoginWindow devuelve null sin BrowserWindow (navegador/tests)', () => {
        expect(openSpotifyLoginWindow({ BrowserWindowCtor: undefined as any, apiPort: 3001 })).toBeNull();
    });

    it('openSpotifyLoginWindow abre el Web Player e inyecta el sniffer', () => {
        const injected: string[] = [];
        const events: string[] = [];
        const fakeWin = {
            webview: {
                executeJavascript: (js: string) => injected.push(js),
                on: (name: string) => events.push(name),
            },
        };
        class FakeBW {
            constructor(public opts: any) {
                expect(opts.url).toBe(SPOTIFY_WEB_PLAYER_URL);
            }
            get webview() { return fakeWin.webview; }
        }
        const win = openSpotifyLoginWindow({ BrowserWindowCtor: FakeBW as any, apiPort: 3001 });
        expect(win).not.toBeNull();
        expect(events).toContain('did-navigate');
        expect(events).toContain('dom-ready');
        // La inyección inicial es diferida; forzamos con timers reales cortos.
        return new Promise<void>((resolve) => setTimeout(() => {
            expect(injected.length).toBeGreaterThanOrEqual(1);
            expect(injected[0]).toContain('get_access_token');
            resolve();
        }, 2600));
    }, 10000);

    it('fetchSpotifySettingsBundle devuelve configured + values', async () => {
        const fetchFn = (async () => ({
            ok: true,
            json: async () => ({ configured: true, values: { tokenExpiresAt: '123' } }),
        })) as any;
        const b = await fetchSpotifySettingsBundle(fetchFn, 3001);
        expect(b?.configured).toBe(true);
        expect(b?.values?.tokenExpiresAt).toBe('123');
    });

    it('decide: sin token ni petición no hace nada', () => {
        const d = decideSpotifyWindowAction({
            configured: false, expiresAtMs: null, pending: false,
            winOpen: false, winHidden: false, winAgeMs: 0, nowMs: 1000,
        });
        expect(d.action).toBe('none');
    });

    it('decide: petición pendiente sin token abre VISIBLE de entrada', () => {
        const d = decideSpotifyWindowAction({
            configured: false, expiresAtMs: null, pending: true,
            winOpen: false, winHidden: false, winAgeMs: 0, nowMs: 1000,
        });
        expect(d.action).toBe('open-visible');
    });

    it('decide: oculta sin resultado tras la gracia → mostrar al usuario', () => {
        const d = decideSpotifyWindowAction({
            configured: false, expiresAtMs: null, pending: true,
            winOpen: true, winHidden: true, winAgeMs: 60_000, nowMs: 1000,
        });
        expect(d.action).toBe('show');
    });

    it('decide: token que caduca sin sesión legible NO abre nada (espera al usuario)', () => {
        const now = 1_700_000_000_000;
        const d = decideSpotifyWindowAction({
            configured: true, expiresAtMs: now + 60_000, pending: false,
            winOpen: false, winHidden: false, winAgeMs: 0, nowMs: now,
        });
        expect(d.action).toBe('none');
    });

    it('decide: token fresco cierra la webview', () => {
        const now = 1_700_000_000_000;
        const d = decideSpotifyWindowAction({
            configured: true, expiresAtMs: now + 3600_000, pending: false,
            winOpen: true, winHidden: true, winAgeMs: 5_000, nowMs: now,
        });
        expect(d.action).toBe('close');
    });

    it('decide: minter oculto obsoleto con token aún caducado → esperar (el reap lo cierra)', () => {
        const now = 1_700_000_000_000;
        const d = decideSpotifyWindowAction({
            configured: true, expiresAtMs: now - 1_000, pending: false,
            winOpen: true, winHidden: true, winAgeMs: 120_000, nowMs: now,
        });
        expect(d.action).toBe('none');
    });

    it('shouldReapStaleWindow: solo huérfanas viejas sin token', () => {
        expect(shouldReapStaleWindow(true, 11 * 60_000, false)).toBe(true);
        expect(shouldReapStaleWindow(true, 60_000, false)).toBe(false);
        expect(shouldReapStaleWindow(false, 999 * 60_000, false)).toBe(false);
        expect(shouldReapStaleWindow(true, 999 * 60_000, true)).toBe(false);
    });

    it('readSpotifySessionCookies filtra y hasSpotifySession detecta sp_dc', () => {
        const fake = {
            cookies: {
                get: () => [
                    { name: 'sp_dc', value: 'cookie-larga-de-sesion-123' },
                    { name: 'sp_key', value: 'k' },
                    { name: null, value: 'x' },
                ],
            },
        };
        const cookies = readSpotifySessionCookies(fake as any);
        expect(cookies).toHaveLength(2);
        expect(hasSpotifySession(cookies)).toBe(true);
        expect(hasSpotifySession([])).toBe(false);
        expect(hasSpotifySession([{ name: 'sp_dc', value: 'corto' }])).toBe(false);
        // Sin impl y sin runtime Electrobun → [] sin lanzar.
        expect(readSpotifySessionCookies()).toEqual([]);
    });

    it('mintSpotifyTokenViaCookies envía Cookie y parsea el token', async () => {
        const seen: any[] = [];
        const fetchFn = (async (url: string, init: any) => {
            seen.push([url, init]);
            return { ok: true, json: async () => ({ accessToken: 'tok-nuevo-1234567890', expiresIn: 3600, tokenType: 'Bearer' }) };
        }) as any;
        const token = await mintSpotifyTokenViaCookies(fetchFn, [
            { name: 'sp_dc', value: 'abc' },
            { name: 'sp_key', value: 'def' },
        ]);
        expect(token?.accessToken).toBe('tok-nuevo-1234567890');
        expect(seen[0][0]).toContain('open.spotify.com/get_access_token');
        expect(seen[0][1].headers.Cookie).toBe('sp_dc=abc; sp_key=def');
    });

    it('mintSpotifyTokenViaCookies falla sin lanzar (401 / red / sin cookies)', async () => {
        const fail401 = (async () => ({ ok: false })) as any;
        expect(await mintSpotifyTokenViaCookies(fail401, [{ name: 'sp_dc', value: 'abc123456789' }])).toBeNull();
        const failNet = (async () => { throw new Error('down'); }) as any;
        expect(await mintSpotifyTokenViaCookies(failNet, [{ name: 'sp_dc', value: 'abc123456789' }])).toBeNull();
        const okFetch = (async () => { throw new Error('no debería llamarse'); }) as any;
        expect(await mintSpotifyTokenViaCookies(okFetch, [])).toBeNull();
    });

    it('postSpotifyTokenCapture publica en token-capture', async () => {
        const seen: any[] = [];
        const fetchFn = (async (url: string, init: any) => {
            seen.push([url, init]);
            return { ok: true };
        }) as any;
        const ok = await postSpotifyTokenCapture(fetchFn, 3001, { accessToken: 't', expiresIn: 3600, tokenType: 'Bearer' });
        expect(ok).toBe(true);
        expect(seen[0][0]).toContain('/token-capture');
        expect(JSON.parse(seen[0][1].body).accessToken).toBe('t');
    });

    it('tick con sesión: acuña en silencio SIN abrir ventanas', async () => {
        const seenWins: any[] = [];
        const posts: string[] = [];
        const now = Date.now();
        let captured = false;
        const fetchFn = (async (url: string, init?: any) => {
            if (String(url).includes('open.spotify.com')) {
                return { ok: true, json: async () => ({ accessToken: 'tok-sesion-1234567890', expiresIn: 3600, tokenType: 'Bearer' }) };
            }
            if (String(url).includes('/token-capture')) {
                posts.push(String(url));
                captured = true;
                return { ok: true, json: async () => ({}) };
            }
            if (String(url).includes('/settings?key=')) {
                return { ok: true, json: async () => ({ key: 'k', value: null }) };
            }
            if (String(url).includes('/settings')) {
                return { ok: true, json: async () => ({ configured: captured, values: captured ? { tokenExpiresAt: String(now + 3600_000) } : {} }) };
            }
            return { ok: true, json: async () => ({ pending: true, requestedAt: String(now), configured: captured }) };
        }) as any;
        class FakeBW {
            webview = { executeJavascript() {}, on() {} };
            constructor(public opts: any) { seenWins.push(opts); }
        }
        const sessionImpl = { cookies: { get: () => [{ name: 'sp_dc', value: 'sesion-viva-1234567890' }] } };
        startSpotifyLoginPolling({ fetchFn, apiPort: 3001, BrowserWindowCtor: FakeBW as any, sessionImpl: sessionImpl as any, once: true });
        await new Promise((r) => setTimeout(r, 50));
        expect(posts).toHaveLength(1);
        expect(seenWins).toHaveLength(0);
    });

    it('tick con señal de fondo y SIN sesión: jamás abre ventana visible', async () => {
        const seenWins: any[] = [];
        const now = Date.now();
        const fetchFn = (async (url: string) => {
            if (String(url).includes('/settings?key=')) {
                // autoRefresh reciente, sin dismissed.
                const auto = String(url).includes('autoRefresh');
                return { ok: true, json: async () => ({ key: 'k', value: auto ? String(now) : null }) };
            }
            if (String(url).includes('/settings')) {
                return { ok: true, json: async () => ({ configured: true, values: { tokenExpiresAt: String(now - 1000) } }) };
            }
            return { ok: true, json: async () => ({ pending: false, configured: true }) };
        }) as any;
        class FakeBW {
            webview = { executeJavascript() {}, on() {} };
            constructor(public opts: any) { seenWins.push(opts); }
        }
        startSpotifyLoginPolling({ fetchFn, apiPort: 3001, BrowserWindowCtor: FakeBW as any, once: true });
        await new Promise((r) => setTimeout(r, 50));
        expect(seenWins).toHaveLength(0);
    });

    it('startSpotifyLoginPolling once: caducidad sin sesión NO abre ventanas', async () => {
        const now = Date.now();
        const seen: any[] = [];
        const fetchFn = (async (url: string) => {
            if (String(url).includes('/settings')) {
                return { ok: true, json: async () => ({ configured: true, values: { tokenExpiresAt: String(now + 60_000) } }) };
            }
            return { ok: true, json: async () => ({ pending: false }) };
        }) as any;
        class FakeBW {
            webview = { executeJavascript() {}, on() {} };
            constructor(public opts: any) { seen.push(opts); }
        }
        startSpotifyLoginPolling({
            fetchFn, apiPort: 3001, BrowserWindowCtor: FakeBW as any, once: true,
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(seen).toHaveLength(0);
    });

    it('startSpotifyLoginPolling once: sin pending no abre ventana', async () => {
        let opened = 0;
        const fetchFn = (async () => ({
            ok: true,
            json: async () => ({ pending: false, configured: true, missing: [] }),
        })) as any;
        startSpotifyLoginPolling({
            fetchFn, apiPort: 3001, BrowserWindowCtor: class { constructor() { opened++; } } as any, once: true,
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(opened).toBe(0);
    });

    it('startSpotifyLoginPolling once: con pending abre UNA ventana visible', async () => {
        const seen: any[] = [];
        const now = Date.now();
        const fetchFn = (async (url: string) => {
            if (String(url).includes('/settings?key=')) {
                return { ok: true, json: async () => ({ key: 'k', value: null }) };
            }
            if (String(url).includes('/settings')) {
                return { ok: true, json: async () => ({ configured: false, values: {} }) };
            }
            return { ok: true, json: async () => ({ pending: true, requestedAt: String(now), configured: false, missing: ['token'] }) };
        }) as any;
        class FakeBW {
            webview = { executeJavascript() {}, on() {} };
            on() {}
            constructor(public opts: any) { seen.push(opts); }
        }
        startSpotifyLoginPolling({
            fetchFn, apiPort: 3001, BrowserWindowCtor: FakeBW as any, once: true,
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(seen).toHaveLength(1);
        expect(seen[0].hidden).not.toBe(true);
    });

    it('cerrar la ventana la cierra definitivamente: limpia pending y marca dismissed', async () => {
        const seen: any[] = [];
        const calls: Array<{ url: string; init?: any }> = [];
        const closeHandlers: Array<() => void> = [];
        const now = Date.now();
        const fetchFn = (async (url: string, init?: any) => {
            calls.push({ url, init });
            if (String(url).includes('/settings?key=')) {
                return { ok: true, json: async () => ({ key: 'k', value: null }) };
            }
            if (String(url).includes('/settings') && !init) {
                return { ok: true, json: async () => ({ configured: false, values: {} }) };
            }
            if (String(url).includes('login-request') && init?.method !== 'POST' && init?.method !== 'DELETE') {
                return { ok: true, json: async () => ({ pending: true, requestedAt: String(now), configured: false }) };
            }
            return { ok: true, json: async () => ({}) };
        }) as any;
        class FakeBW {
            webview = { executeJavascript() {}, on() {} };
            on(name: string, h: () => void) { if (name === 'close') closeHandlers.push(h); }
            close() {}
            constructor(public opts: any) { seen.push(opts); }
        }
        // Tick 1: abre la ventana.
        startSpotifyLoginPolling({ fetchFn, apiPort: 3001, BrowserWindowCtor: FakeBW as any, once: true });
        await new Promise((r) => setTimeout(r, 50));
        expect(seen).toHaveLength(1);
        expect(closeHandlers).toHaveLength(1);
        // El usuario la cierra.
        closeHandlers[0]();
        await new Promise((r) => setTimeout(r, 20));
        // Tick 2: NO reabre.
        startSpotifyLoginPolling({ fetchFn, apiPort: 3001, BrowserWindowCtor: FakeBW as any, once: true });
        await new Promise((r) => setTimeout(r, 50));
        expect(seen).toHaveLength(1);
        // Y se limpió el pending + quedó dismissed persistido.
        expect(calls.some((c) => c.url.includes('login-request') && c.init?.method === 'DELETE')).toBe(true);
        const dismissed = calls.find((c) => (c.init?.body ?? '').includes('loginDismissedAt'));
        expect(dismissed).toBeDefined();
    });

    it('petición rancia (TTL) no abre ventana y se limpia', async () => {
        const seen: any[] = [];
        const calls: Array<{ url: string; init?: any }> = [];
        const old = Date.now() - 20 * 60_000;
        const fetchFn = (async (url: string, init?: any) => {
            calls.push({ url, init });
            if (String(url).includes('/settings?key=')) {
                return { ok: true, json: async () => ({ key: 'k', value: null }) };
            }
            if (String(url).includes('/settings')) {
                return { ok: true, json: async () => ({ configured: false, values: {} }) };
            }
            return { ok: true, json: async () => ({ pending: true, requestedAt: String(old), configured: false }) };
        }) as any;
        class FakeBW {
            webview = { executeJavascript() {}, on() {} };
            constructor(public opts: any) { seen.push(opts); }
        }
        startSpotifyLoginPolling({ fetchFn, apiPort: 3001, BrowserWindowCtor: FakeBW as any, once: true });
        await new Promise((r) => setTimeout(r, 50));
        expect(seen).toHaveLength(0);
        expect(calls.some((c) => c.url.includes('login-request') && c.init?.method === 'DELETE')).toBe(true);
    });

    it('dismissed persistido ignora la petición aunque el host haya reiniciado', async () => {
        const seen: any[] = [];
        const now = Date.now();
        const fetchFn = (async (url: string) => {
            if (String(url).includes('/settings?key=')) {
                return { ok: true, json: async () => ({ key: 'k', value: String(now) }) };
            }
            if (String(url).includes('/settings')) {
                return { ok: true, json: async () => ({ configured: false, values: {} }) };
            }
            return { ok: true, json: async () => ({ pending: true, requestedAt: String(now - 1000), configured: false }) };
        }) as any;
        class FakeBW {
            webview = { executeJavascript() {}, on() {} };
            constructor(public opts: any) { seen.push(opts); }
        }
        startSpotifyLoginPolling({ fetchFn, apiPort: 3001, BrowserWindowCtor: FakeBW as any, once: true });
        await new Promise((r) => setTimeout(r, 50));
        expect(seen).toHaveLength(0);
    });
});
