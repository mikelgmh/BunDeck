import { test, expect, type Browser, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { getRunnerProfile } from './helpers';

/**
 * relay-remote-press.spec.ts — flujo remoto REAL contra el relay PÚBLICO
 * (https://relay.bundeck.app). El daemon local ya está en marcha y conectado
 * al relay (verificado por preflight: relay.status=="connected" y
 * uiEnabled==true; si no, el run se aborta con HALLAZGO).
 *
 * Handshake por test (urlCode single-use):
 *   1. POST /api/v1/remote/ui-code → {urlCode}
 *   2. Visita https://relay.bundeck.app/ui/<urlCode> (la primera visita crea
 *      el ui-request pendiente en el daemon vía túnel)
 *   3. Poll local GET /ui-pending → approve POST .../allow → {sessionToken}
 *      (el token del allow es la fuente fiable: el /status del relay lo
 *      entrega solo en el primer poll y la waiting-room lo consume)
 *   4. Poll de verificación a /ui/<urlCode>/status hasta approved (60 s)
 *   5. GET https://relay.bundeck.app/t/<token>/ → app completa (tabs visibles)
 *
 * Test A: press remoto(s) de discord.toggle-mute flipean discordMuted en el
 *   daemon y el icono condicional se actualiza en la UI remota por WS.
 *   NOTA safe-mode: la suite Playwright corre con e2e.safe_mode='1' y el
 *   gate (daemon/src/action-runner.ts) neutraliza discord.toggle-mute como
 *   no-op SIN tocar la variable. Para que la pulsación sea real (la que
 *   presupuesta este spec: máx 2, separadas ≥3 s) se baja safe_mode a '0'
 *   solo alrededor de las pulsaciones, con restauración en afterEach.
 *   El resultado RPC es absoluto (mute:true/false según el micro real): si
 *   el micro estaba silenciado, la 1ª pulsación lo reactiva (sin flip) y se
 *   usa la 2ª (dentro del presupuesto). HALLAZGO RRP: runner y API usan
 *   instancias de VariableStore con cachés independientes; el GET unitario
 *   sirve rancio tras escrituras del runner, así que el flip se sondea por
 *   el LISTADO (lee BD) y la caché del runner se sincroniza con un
 *   local.set-var previo ejecutado por el propio runner.
 * Test B: 12 clics rápidos con `utility.delay` (ejecución REMOTA en el daemon,
 *   sin efectos visibles: 500 ms de espera) + look `e2eBurstVar` para la prueba
 *   de WS vivo. HALLAZGO RRP: `local.toggle-var` NO sirve para estresar el
 *   execute remoto — el frontend lo ejecuta EN EL CLIENTE (perform() de
 *   useKeyEngine: setVarValue/toggleVar locales) sin POST al daemon (12 taps
 *   silenciosos: 0 press-logs, 0 errores). `utility.delay` sí viaja por
 *   POST /actions/execute (architectura: execRemote), es SAFE en safe_mode
 *   (prefijo utility.*) y está en la allowlist remota.
 *   Cuenta toasts de error con 'daemon-timeout' y requests fallidas: FAIL si
 *   hay >3 timeouts o si el WS se cae; registra los conteos aunque pase.
 */

const API = 'http://localhost:3001/api/v1';
const RELAY = 'https://relay.bundeck.app';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

interface RemoteSession {
  ctx: BrowserContext;
  page: Page;
  urlCode: string;
  token: string;
  consoleErrors: string[];
  failedRequests: string[];
  /** Ruido conocido que no indica fallo funcional (chunks a raíz, launcher). */
  assetNoise: string[];
}

function isAssetNoise(m: string): boolean {
  return (
    m.includes('/_astro/') ||
    m.includes('127.0.0.1:3031') ||
    m.includes('__launcher/window-state') ||
    m.includes('injectBase') ||
    /hydration/i.test(m)
  );
}

async function apiJson(request: APIRequestContext, method: string, path: string, data?: any): Promise<any> {
  let lastErr: any = null;
  for (let i = 0; i < 4; i++) {
    try {
      const res =
        method === 'GET' ? await request.get(`${API}${path}`) :
        method === 'POST' ? await request.post(`${API}${path}`, data !== undefined ? { data } : undefined) :
        method === 'PUT' ? await request.put(`${API}${path}`, data !== undefined ? { data } : undefined) :
        await request.delete(`${API}${path}`);
      if (!res.ok()) {
        const body = await res.text().catch(() => '');
        throw new Error(`${method} ${path} -> ${res.status} :: ${body.slice(0, 300)}`);
      }
      const text = await res.text();
      try { return JSON.parse(text); } catch { return null; }
    } catch (e) {
      if (e instanceof Error && /-> \d{3} ::/.test(e.message)) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

async function dismissWelcome(page: Page) {
  try {
    await page.evaluate(() => {
      try { window.localStorage.setItem('bundeck:welcome-seen', '1'); } catch { /* noop */ }
      const d = document.querySelector('[data-cy=bd-welcome]') as any;
      try { if (d && d.open) d.close(); } catch { /* noop */ }
    });
  } catch { /* noop */ }
  try {
    const skip = page.locator('[data-cy=bd-welcome-skip]');
    await skip.waitFor({ state: 'visible', timeout: 1500 });
    await skip.click();
  } catch { /* noop */ }
}

/** Fija una variable bool (PUT; si no existe, POST). */
async function setBoolVar(request: APIRequestContext, name: string, value: boolean) {
  const put = await request.put(`${API}/variables/${encodeURIComponent(name)}`, {
    data: { value },
    failOnStatusCode: false,
  });
  if (put.status() === 404) {
    const post = await request.post(`${API}/variables`, { data: { name, type: 'bool', value } });
    expect(post.status(), `POST /variables ${name}`).toBe(201);
  } else {
    expect(put.ok(), `PUT /variables/${name}`).toBeTruthy();
  }
}

/**
 * Espera un valor leyendo el LISTADO (GET /api/v1/variables), no el GET
 * unitario: el runner y la API usan instancias de VariableStore con cachés
 * independientes y el unitario puede servir rancio tras escrituras del
 * runner (hallazgo RRP: press OK por RPC sin reflejo en GET /:name).
 * El listado lee de BD y refresca la caché.
 */
async function waitVarInList(
  request: APIRequestContext, name: string, value: unknown, timeoutMs = 30_000,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await request.get(`${API}/variables`, { failOnStatusCode: false });
      if (r.ok()) {
        const j: any = await r.json();
        const items: any[] = Array.isArray(j) ? j : (j?.items ?? j?.variables ?? []);
        const hit = items.find((it: any) => it?.name === name && (it?.scope ?? 'global') === 'global');
        if (hit && hit.value === value) return true;
      }
    } catch { /* reintentar dentro del presupuesto */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function openRemoteSession(browser: Browser, request: APIRequestContext, tag: string): Promise<RemoteSession> {
  // 0. Preflight: daemon conectado al relay público y UI habilitada.
  const stRes = await request.get(`${API}/remote/status`, { failOnStatusCode: false });
  if (!stRes.ok()) throw new Error(`HALLAZGO [${tag}]: GET /remote/status -> ${stRes.status()}: el daemon no responde; run abortado`);
  const st = await stRes.json();
  if (st?.relay?.status !== 'connected' || st?.uiEnabled !== true) {
    throw new Error(
      `HALLAZGO [${tag}]: relay no disponible (relay.status=${st?.relay?.status}, uiEnabled=${st?.uiEnabled}); ` +
      `se exige relay.status=="connected" y uiEnabled==true. Run abortado sin inventar nada.`,
    );
  }

  // 1-2. Código de enlace + visita a la sala de espera (crea el ui-request).
  // Con reintentos y ROTACIÓN de código: una visita puede no registrar el
  // ui-request en el daemon (hueco del túnel) y el reintento sobre el mismo
  // código no siempre lo re-emite; un código fresco sí.
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const assetNoise: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text().slice(0, 500);
    (isAssetNoise(t) ? assetNoise : consoleErrors).push(t);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 500)}`));
  const mask = (u: string) => (u.startsWith(RELAY) ? u.slice(RELAY.length) : u).replace(/^\/t\/[^/]+/, '/t/<tok>');
  page.on('requestfailed', (r) => failedRequests.push(`FAILED ${r.method()} ${mask(r.url()).slice(0, 160)} :: ${(r.failure()?.errorText ?? '').slice(0, 120)}`));
  page.on('response', (r) => {
    if (!r.ok()) {
      const line = `HTTP ${r.status()} ${r.request().method()} ${mask(r.url()).slice(0, 160)}`;
      // Los chunks perezosos con ruta absoluta escapan a la raíz del relay
      // (401): ruido conocido, la app arranca igual. Separa del reporte.
      if (r.status() === 401 && mask(r.url()).startsWith('/_astro/')) assetNoise.push(line);
      else failedRequests.push(line);
    }
  });
  await page.addInitScript(() => {
    (window as any).__e2eActionErrors = [];
    window.addEventListener('libredeck:action-error', (ev: any) => {
      try { (window as any).__e2eActionErrors.push(String(ev?.detail?.message ?? 'unknown')); } catch { /* noop */ }
    });
  });
  // Bucle código→visita→poll pendiente (máx 3 códigos, ~20 s de poll cada uno).
  let urlCode = '';
  let reqId = '';
  const visitStatuses: string[] = [];
  for (let h = 0; h < 3 && !reqId; h++) {
    if (urlCode) {
      await request.delete(`${API}/remote/ui-code`, { failOnStatusCode: false }).catch(() => {});
    }
    const codeRes = await request.post(`${API}/remote/ui-code`, { failOnStatusCode: false });
    if (!codeRes.ok()) {
      throw new Error(`HALLAZGO [${tag}]: POST /remote/ui-code -> ${codeRes.status()} :: ${(await codeRes.text()).slice(0, 300)}`);
    }
    urlCode = (await codeRes.json())?.urlCode ?? '';
    expect(urlCode, 'ui-code con urlCode').toBeTruthy();
    try {
      const resp = await page.goto(`${RELAY}/ui/${urlCode}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      visitStatuses.push(`${urlCode.slice(0, 6)}:HTTP ${resp?.status()}`);
    } catch (e) {
      visitStatuses.push(`${urlCode.slice(0, 6)}:GOTO-FALLO ${String(e).slice(0, 120)}`);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000 && !reqId) {
      const p = await request.get(`${API}/remote/ui-pending`, { failOnStatusCode: false });
      if (p.ok()) {
        const items = (((await p.json()) as any)?.pending ?? []) as any[];
        const hit = items.find((i) => i?.urlCode === urlCode) ?? items[0];
        if (hit?.reqId) { reqId = hit.reqId; break; }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!reqId) console.log(`[RRP-${tag}] sin pendiente tras visita ${h + 1}/3 (${urlCode.slice(0, 6)}…); rotando código…`);
  }
  console.log(`[RRP-${tag}] visitas sala de espera: ${visitStatuses.join(' | ')}`);
  if (!reqId) throw new Error(`HALLAZGO [${tag}]: la approval no llega (sin ui-pending en 3 códigos/60 s; visitas: ${visitStatuses.join(' | ')}); run abortado`);
  const allow = await request.post(`${API}/remote/ui-pending/${encodeURIComponent(reqId)}/allow`, { failOnStatusCode: false });
  if (!allow.ok()) throw new Error(`HALLAZGO [${tag}]: allow -> ${allow.status()} :: ${(await allow.text()).slice(0, 300)}`);
  const allowBody = await allow.json();
  const allowToken = allowBody?.sessionToken as string | undefined;
  if (!allowToken) throw new Error(`HALLAZGO [${tag}]: allow sin sessionToken`);

  // 4. Verificación relay-side: /status hasta approved (el token puede venir
  //    o no: la waiting-room lo consume en su propio poll).
  let statusToken: string | undefined;
  const s0 = Date.now();
  let approved = false;
  while (Date.now() - s0 < 60_000) {
    try {
      const s = await request.get(`${RELAY}/ui/${urlCode}/status`, {
        headers: { Accept: 'application/json' },
        failOnStatusCode: false,
        timeout: 15_000,
      });
      if (s.ok()) {
        const b = await s.json();
        if (b?.status === 'approved') {
          approved = true;
          if (typeof b?.sessionToken === 'string' && b.sessionToken) statusToken = b.sessionToken;
          break;
        }
        if (b?.status === 'denied' || b?.status === 'expired') {
          throw new Error(`HALLAZGO [${tag}]: /status -> ${b?.status}; run abortado`);
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('HALLAZGO')) throw e;
      // relay por internet: reintentar dentro del presupuesto
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!approved) throw new Error(`HALLAZGO [${tag}]: /status nunca llegó a approved en 60 s; run abortado`);

  // 5. Abrir la sesión remota y esperar la app (con reintentos: el túnel
  //    relay↔daemon tiene ventanas transitorias de daemon-offline → 502).
  const token = statusToken ?? allowToken;
  const remote: RemoteSession = { ctx, page, urlCode, token, consoleErrors, failedRequests, assetNoise };
  await loadSessionApp(page, remote.token, request, tag);
  return remote;
}

/**
 * Carga /t/<token>/ y espera las tabs (reintenta con reload: huecos del túnel).
 * Si agota los intentos, sondea el cuerpo del error del relay (distingue
 * daemon-offline / expired / invalid-token / 502 del daemon).
 */
async function loadSessionApp(page: Page, token: string, request: APIRequestContext, tag: string) {
  const maxAttempts = 3;
  for (let a = 1; a <= maxAttempts; a++) {
    try {
      await page.goto(`${RELAY}/t/${token}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await dismissWelcome(page);
      await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30_000 });
      if (a > 1) console.log(`[RRP-${tag}] app visible tras reintento ${a}/${maxAttempts}`);
      return;
    } catch {
      console.log(`[RRP-${tag}] intento ${a}/${maxAttempts} sin tabs; reintentando…`);
    }
  }
  // Diagnóstico: cuerpo exacto del error del relay para este token.
  try {
    const probe = await request.get(`${RELAY}/t/${token}/api/v1/profiles`, { failOnStatusCode: false, timeout: 20_000 });
    const body = (await probe.text()).slice(0, 300);
    console.log(`[RRP-${tag}] HALLAZGO probe /t/<tok>/api/v1/profiles -> ${probe.status()} :: ${body}`);
  } catch (e) {
    console.log(`[RRP-${tag}] HALLAZGO probe falló: ${String(e).slice(0, 300)}`);
  }
  await dumpRemoteState(page, `${tag}-final`);
  throw new Error(
    `HALLAZGO [${tag}]: la app remota no muestra tabs tras ${maxAttempts} cargas (ver probe anterior); run abortado`,
  );
}

async function getActionErrors(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() => (Array.isArray((window as any).__e2eActionErrors) ? (window as any).__e2eActionErrors : []) as string[]);
  } catch { return []; }
}

/** Pliega el drawer izquierdo con reintentos (si aún está montando, el botón
 *  de plegar no existe y el drawer abierto tapa [data-md=...] y las teclas). */
async function ensureDrawerCollapsed(page: Page) {
  for (let i = 0; i < 4; i++) {
    try {
      const expand = page.locator('[data-cy=bd-expand-left]').first();
      if ((await expand.count()) && (await expand.isVisible())) return;
    } catch { /* reintentar */ }
    try {
      const collapse = page.locator('[data-cy=bd-collapse-left]').first();
      if (await collapse.count()) await collapse.evaluate((el) => (el as HTMLElement).click());
    } catch { /* reintentar */ }
    await page.waitForTimeout(700);
  }
}

/** Clic en modo edición/uso robusto al drawer (click real + fallback JS). */
async function clickMode(page: Page, md: 'use' | 'edit') {
  await ensureDrawerCollapsed(page);
  const btn = page.locator(`[data-md="${md}"]`);
  try {
    await btn.click({ timeout: 15_000 });
  } catch {
    await btn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(btn).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
}

/** Diagnóstico del estado de la UI remota (qué ve la app tras cargar). */
async function dumpRemoteState(page: Page, tag: string) {
  try {
    const info = await page.evaluate(() => {
      const q = (s: string) => document.querySelectorAll(s).length;
      const chips = [...document.querySelectorAll('.bd-page .bd-chip')].map((e) => (e.textContent ?? '').trim().slice(0, 40));
      const usePressed = document.querySelector('[data-md="use"]')?.getAttribute('aria-pressed');
      const editPressed = document.querySelector('[data-md="edit"]')?.getAttribute('aria-pressed');
      return {
        url: location.href.replace(/\/t\/[^/]+/, '/t/<tok>'),
        bdPage: q('.bd-page'), chips: q('.bd-page .bd-chip'), chipTexts: chips.slice(0, 12),
        profileTabs: q('[data-cy=bd-profile-tab]'), keys: q('[data-cy=bd-key]'),
        usePressed, editPressed,
      };
    });
    console.log(`[RRP-${tag}] remote state:`, JSON.stringify(info));
  } catch (e) { console.log(`[RRP-${tag}] dumpRemoteState falló: ${String(e).slice(0, 200)}`); }
}

/** Navega a la página de test y espera su tecla (con recargas: huecos del túnel).
 *  keyText es el texto visible INICIAL (título del look que matchea, no el
 *  label interno: con looks el look manda en el render). */
async function gotoTestPage(
  page: Page, token: string, request: APIRequestContext, tag: string, pageName: string, keyText: string,
) {
  const maxAttempts = 3;
  for (let a = 1; a <= maxAttempts; a++) {
    try {
      await page.goto(`${RELAY}/t/${token}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await dismissWelcome(page);
      await expect(page.locator('[data-cy=bd-profile-tab]').first()).toBeVisible({ timeout: 30_000 });
      await ensureDrawerCollapsed(page);
      await page.locator('.bd-page .bd-chip', { hasText: pageName }).first().click({ timeout: 20_000 });
      const key = page.locator('[data-cy=bd-key]').filter({ hasText: keyText }).first();
      await expect(key).toBeVisible({ timeout: 30_000 });
      if (a > 1) console.log(`[RRP-${tag}] página+tecla visibles tras carga ${a}/${maxAttempts}`);
      return;
    } catch {
      console.log(`[RRP-${tag}] página/tecla sin ver (intento ${a}/${maxAttempts}); recargando…`);
      await dumpRemoteState(page, `${tag}-no-key-${a}`);
    }
  }
  throw new Error(`HALLAZGO [${tag}]: la tecla ${keyText} no aparece en la UI remota tras ${maxAttempts} cargas`);
}

/** Tecla de la posición 0 (nuestra tecla de test: página dedicada, sin filtro
 *  de texto — el texto visible cambia con el look que matchea). */
function slot0Key(page: Page) {
  return page.locator('[data-swapy-slot="slot-0"] [data-cy=bd-key]').first();
}

/** Selecciona la tecla 0 en modo edición y abre su pestaña Aspecto. */
async function openAppearance(page: Page, expectedCards = 2) {
  await clickMode(page, 'edit');
  const slotKey = slot0Key(page);
  await expect(slotKey).toBeVisible({ timeout: 30_000 });
  await slotKey.click({ timeout: 30_000 });
  await expect(page.locator('[data-cy=bd-key-title]')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-cy=bd-tab-appearance]').click({ timeout: 15_000 });
  const cards = page.locator('.bd-rl');
  await expect(cards).toHaveCount(expectedCards, { timeout: 15_000 });
  return cards;
}

test.describe('relay público: press remoto (relay-remote-press)', () => {
  let remote: RemoteSession | null = null;
  let testPageId = '';
  let restorePageId = '';
  let restoreProfileId = '';
  let lastUrlCode = '';

  test.afterEach(async ({ request }) => {
    if (remote) {
      const errs = remote.consoleErrors.slice(0, 20);
      if (errs.length) console.log(`[RRP] console errors remotos (${remote.urlCode}):`, JSON.stringify(errs, null, 1));
      const fr = remote.failedRequests.slice(0, 30);
      // Resumen por endpoint (enmascara query): cuenta repeticiones.
      const summary: Record<string, number> = {};
      for (const m of remote.failedRequests) {
        const k = m.replace(/[0-9a-f]{8,}-[0-9a-f-]{10,}/gi, '<id>').slice(0, 140);
        summary[k] = (summary[k] ?? 0) + 1;
      }
      console.log(`[RRP] failedRequests total=${remote.failedRequests.length} assetNoise=${remote.assetNoise.length} ::`, JSON.stringify(summary, null, 1));
      if (fr.length) console.log(`[RRP] failedRequests muestra:`, JSON.stringify(fr, null, 1));
      await remote.ctx.close().catch(() => {});
      remote = null;
    }
    if (testPageId) {
      await request.delete(`${API}/pages/${testPageId}`, { failOnStatusCode: false });
      testPageId = '';
    }
    if (lastUrlCode) {
      await request.delete(`${API}/remote/ui-code`, { failOnStatusCode: false });
      lastUrlCode = '';
    }
    await request.delete(`${API}/variables/e2eBurstVar`, { failOnStatusCode: false }).catch(() => {});
    if (restorePageId) {
      await request.post(`${API}/settings`, { data: { key: 'current.page_id', value: restorePageId } }).catch(() => {});
      restorePageId = '';
    }
    if (restoreProfileId) {
      await request.post(`${API}/settings`, { data: { key: 'current.profile_id', value: restoreProfileId } }).catch(() => {});
      restoreProfileId = '';
    }
    // Red de seguridad: la suite corre con safe_mode='1'.
    await request.post(`${API}/settings`, { data: { key: 'e2e.safe_mode', value: '1' } }).catch(() => {});
  });

  test('A: press remoto actualiza el icono (discordMuted)', async ({ browser, request }) => {
    remote = await openRemoteSession(browser, request, 'A');
    lastUrlCode = remote.urlCode;
    const { page } = remote;
    const tag = `RRP-A-${Date.now().toString(36)}`;
    const profile = await getRunnerProfile(request);
    const origPage: any = await apiJson(request, 'GET', '/settings?key=current.page_id');
    const origProfile: any = await apiJson(request, 'GET', '/settings?key=current.profile_id');
    restorePageId = origPage?.value ?? '';
    restoreProfileId = origProfile?.value ?? '';

    // Normalizar coherentemente: el runner y la API usan instancias de
    // VariableStore con cachés independientes (si la del runner está rancia,
    // el press no persiste ni emite WS). Escribir por el RUNNER sincroniza
    // su caché con la BD (la API crea la var si falta: require() la exige).
    await setBoolVar(request, 'discordMuted', false);
    await apiJson(request, 'POST', '/actions/execute', {
      action: { type: 'local.set-var', parameters: { name: 'discordMuted', value: false } },
    });
    expect(await waitVarInList(request, 'discordMuted', false), 'discordMuted=false en BD').toBe(true);
    const created = await apiJson(request, 'POST', '/pages', {
      profile_id: profile.id, name: `${tag}-page`, order_idx: 130, is_folder: 0, data: {},
    });
    testPageId = created.id;
    const discordAct = { type: 'discord.toggle-mute', parameters: {} };
    await apiJson(request, 'POST', '/buttons', {
      page_id: testPageId,
      position: 0,
      data: {
        label: `${tag}-key`,
        actions: [discordAct],
        pressActions: { click: [discordAct] },
        looks: [
          { cond: 'discordMuted', t: 'MUTEADO', i: 'MicOff', c: 4, bg: 1 },
          { cond: 'discordMuted == falso', t: 'En vivo', i: 'Mic', c: null, bg: 0 },
        ],
      },
    });
    await apiJson(request, 'POST', '/settings', { key: 'current.profile_id', value: profile.id });
    await apiJson(request, 'POST', '/settings', { key: 'current.page_id', value: testPageId });

    // La UI remota aterriza en la página de test (con recargas si hace falta).
    // Texto inicial: discordMuted=false → look 'En vivo'.
    await gotoTestPage(page, remote.token, request, 'A', `${tag}-page`, 'En vivo');

    // Estado inicial: discordMuted=false → matchea la SEGUNDA.
    let cards = await openAppearance(page);
    await expect(cards.nth(1)).toHaveClass(/is-matched/, { timeout: 15_000 });
    await expect(cards.nth(0)).not.toHaveClass(/is-matched/, { timeout: 15_000 });

    // PULSACIÓN REAL: modo uso + clic en la tecla remota (slot 0).
    await clickMode(page, 'use');
    const key = slot0Key(page);
    await expect(key).toBeVisible({ timeout: 30_000 });
    await apiJson(request, 'POST', '/settings', { key: 'e2e.safe_mode', value: '0' });
    // El execute viaja ~340 ms DESPUÉS del clic (debounce multi-tap) + RTT
    // del relay: no reactivar safe_mode hasta ver el flip en el daemon (si
    // se reactiva antes, el gate neutraliza la acción como no-op).
    // El resultado RPC es absoluto (mute:true/false según el micro): si el
    // micro estaba silenciado, la 1ª pulsación lo reactiva (sin flip) y hace
    // falta la 2ª (dentro del presupuesto de 2, separadas ≥3 s).
    await page.evaluate(() => { (window as any).__e2eActionErrors = []; });
    let pressesUsed = 0;
    let flipped = false;
    for (let p = 0; p < 2 && !flipped; p++) {
      if (p > 0) await page.waitForTimeout(3000);
      await key.click({ timeout: 30_000 });
      pressesUsed++;
      flipped = await waitVarInList(request, 'discordMuted', true, 30_000);
    }
    await request.post(`${API}/settings`, { data: { key: 'e2e.safe_mode', value: '1' } }).catch(() => {});
    const errsPress = await getActionErrors(page);
    console.log(`[RRP-A] flipped=${flipped} pressesUsed=${pressesUsed} actionErrors=${JSON.stringify(errsPress.slice(0, 5))}`);
    test.info().annotations.push({ type: 'rrp-a-press', description: `flipped=${flipped} presses=${pressesUsed} errors=${errsPress.length}` });
    expect(flipped, `el press remoto debió flipar discordMuted a true en ≤2 pulsaciones (errores UI: ${JSON.stringify(errsPress.slice(0, 3))})`).toBe(true);
    // Separación amplia (presupuesto: máx 2 pulsaciones, ≥3 s): deja que el
    // toggle viaje daemon → relay WS → UI remota.
    await page.waitForTimeout(4000);

    // Comprobar que la PRIMERA condición matchea en vivo (openAppearance
    // vuelve a edición).
    cards = await openAppearance(page);
    await expect(cards.nth(0)).toHaveClass(/is-matched/, { timeout: 15_000 });
    await expect(cards.nth(1)).not.toHaveClass(/is-matched/, { timeout: 15_000 });

    // Fijar false por API local → la SEGUNDA se activa en la UI remota.
    await setBoolVar(request, 'discordMuted', false);
    await expect(cards.nth(1)).toHaveClass(/is-matched/, { timeout: 15_000 });
    await expect(cards.nth(0)).not.toHaveClass(/is-matched/, { timeout: 15_000 });

    const errs = remote.consoleErrors;
    console.log(`[RRP-A] console errors: ${errs.length} :: ${JSON.stringify(errs.slice(0, 10))}`);
    test.info().annotations.push({ type: 'rrp-a', description: `press=1 discord.toggle-mute; consoleErrors=${errs.length}` });
  });

  test('B: ráfaga de 12 sin efectos reales (utility.delay remoto)', async ({ browser, request }) => {
    remote = await openRemoteSession(browser, request, 'B');
    lastUrlCode = remote.urlCode;
    const { page } = remote;
    const tag = `RRP-B-${Date.now().toString(36)}`;
    const profile = await getRunnerProfile(request);
    const origPage: any = await apiJson(request, 'GET', '/settings?key=current.page_id');
    const origProfile: any = await apiJson(request, 'GET', '/settings?key=current.profile_id');
    restorePageId = origPage?.value ?? '';
    restoreProfileId = origProfile?.value ?? '';

    await request.delete(`${API}/variables/e2eBurstVar`, { failOnStatusCode: false });
    await setBoolVar(request, 'e2eBurstVar', false);
    const created = await apiJson(request, 'POST', '/pages', {
      profile_id: profile.id, name: `${tag}-page`, order_idx: 131, is_folder: 0, data: {},
    });
    testPageId = created.id;
    // utility.delay: ejecución remota real sin efectos visibles (ver HALLAZGO
    // en el docblock: local.* se ejecuta en el cliente y no estresa el túnel).
    const burstAct = { type: 'utility.delay', parameters: { duration: 500 } };
    const btn = await apiJson(request, 'POST', '/buttons', {
      page_id: testPageId,
      position: 0,
      data: {
        label: `${tag}-key`,
        actions: [burstAct],
        pressActions: { click: [burstAct] },
        looks: [{ cond: 'e2eBurstVar', t: 'ON', i: 'Zap', c: 2, bg: 1 }],
      },
    });
    const buttonId = btn.id as string;
    await apiJson(request, 'POST', '/settings', { key: 'current.profile_id', value: profile.id });
    await apiJson(request, 'POST', '/settings', { key: 'current.page_id', value: testPageId });

    await gotoTestPage(page, remote.token, request, 'B', `${tag}-page`, `${tag}-key`);
    await clickMode(page, 'use');
    const key = slot0Key(page);
    await expect(key).toBeVisible({ timeout: 30_000 });

    // Vaciar el espía de errores justo antes de la ráfaga.
    await page.evaluate(() => { (window as any).__e2eActionErrors = []; });
    remote.failedRequests.length = 0;
    const burstStart = Date.now();
    for (let i = 0; i < 12; i++) {
      await key.click({ timeout: 30_000 });
      await page.waitForTimeout(350);
    }
    // Dejar que las ejecuciones/WS se asienten.
    await page.waitForTimeout(5000);

    const actionErrors = await getActionErrors(page);
    const timeoutToasts = actionErrors.filter((m) => /timeout/i.test(m));
    const otherToasts = actionErrors.filter((m) => !/timeout/i.test(m));
    const failedReqs = remote.failedRequests.slice();
    // 504 = 'daemon-timeout' del relay (sin respuesta del daemon en 30 s).
    // (Los ERR_ABORTED por navegación NO son timeouts: se listan aparte.)
    const timeoutReqs = failedReqs.filter((m) => /timeout|TIMEDOUT|HTTP 504/i.test(m));
    const timeoutCount = timeoutToasts.length + timeoutReqs.length;
    const stats = `burst: clicks=12 buttonId=${buttonId} actionErrors=${actionErrors.length} ` +
      `timeoutToasts=${timeoutToasts.length} otherToasts=${otherToasts.length} ` +
      `failedRequests=${failedReqs.length} timeoutReqs=${timeoutReqs.length}`;
    console.log(`[RRP-B] ${stats}`);
    if (otherToasts.length) console.log(`[RRP-B] other error toasts: ${JSON.stringify(otherToasts.slice(0, 8))}`);
    if (failedReqs.length) console.log(`[RRP-B] failed requests: ${JSON.stringify(failedReqs.slice(0, 8))}`);
    test.info().annotations.push({ type: 'rrp-burst-stats', description: stats });

    // Cuántas pulsaciones llegaron al daemon (press-logs del botón).
    let executed = -1;
    try {
      const logsRes = await request.get(`${API}/buttons/${buttonId}/logs?limit=50`, { failOnStatusCode: false });
      if (logsRes.ok()) {
        const lj: any = await logsRes.json();
        const items: any[] = Array.isArray(lj) ? lj : (lj?.items ?? lj?.logs ?? []);
        executed = items.filter((it: any) => (it?.ts ?? it?.created_at ?? 0) >= burstStart - 1000).length;
      }
    } catch { /* mejor esfuerzo */ }
    console.log(`[RRP-B] press-logs ejecutados desde burstStart: ${executed}`);
    test.info().annotations.push({ type: 'rrp-burst-executed', description: `executed=${executed}` });

    expect(timeoutCount, `timeouts en ráfaga (máx 3): ${stats}`).toBeLessThanOrEqual(3);
    expect(executed, `al menos 1 pulsación ejecutada en daemon: ${stats}`).toBeGreaterThanOrEqual(1);

    // WS vivo downstream: fijar la var por API y ver el look en la UI remota.
    // El broadcast variable.changed es best-effort y puede perderse en un
    // hueco del túnel: se reintenta el flanco una vez antes de declarar el
    // WS caído.
    const cards = await openAppearance(page, 1);
    let liveOk = false;
    for (let a = 0; a < 2 && !liveOk; a++) {
      if (a > 0) {
        await setBoolVar(request, 'e2eBurstVar', false);
        await page.waitForTimeout(2000);
        console.log('[RRP-B] reintentando flanco live (2/2)…');
      }
      await setBoolVar(request, 'e2eBurstVar', true);
      try {
        await expect(cards.nth(0)).toHaveClass(/is-matched/, { timeout: 12_000 });
        liveOk = true;
      } catch { /* flanco perdido: reintentar una vez */ }
    }
    expect(liveOk, 'el WS downstream no refleja variable.changed tras 2 flancos (WS caído)').toBe(true);

    const errs = remote.consoleErrors;
    console.log(`[RRP-B] console errors: ${errs.length} :: ${JSON.stringify(errs.slice(0, 10))}`);
  });
});
