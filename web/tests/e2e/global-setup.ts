import { request as baseRequest, type FullConfig } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RUNNER_PROFILE, sweepTestResidue } from './cleanup';

export { RUNNER_PROFILE };
export const RUNNER_STATE_FILE = path.join(os.tmpdir(), 'libredeck-e2e-runner.json');

const API = 'http://localhost:3001/api/v1';

async function api() {
  const ctx = await baseRequest.newContext();
  return ctx;
}

async function globalSetup(_config: FullConfig) {
  const ctx = await api();
  try {
    // Daemon arriba o nada tiene sentido.
    const health = await ctx.get('http://localhost:3001/health');
    if (!health.ok()) {
      throw new Error('El daemon no responde en http://localhost:3001 (arráncalo antes del e2e)');
    }

    // Recordar la vista del usuario para restaurarla al terminar.
    let origProfile: string | null = null;
    let origPage: string | null = null;
    try {
      origProfile = ((await (await ctx.get(`${API}/settings?key=current.profile_id`)).json()) as any)?.value ?? null;
      origPage = ((await (await ctx.get(`${API}/settings?key=current.page_id`)).json()) as any)?.value ?? null;
    } catch { /* sin settings: se queda en null */ }
    fs.writeFileSync(RUNNER_STATE_FILE, JSON.stringify({ origProfile, origPage }));

    // Limpieza de restos de runs anteriores (p. ej. crash a mitad):
    // barrido compartido (ver cleanup.ts): perfiles 'E2E Runner'/'E2E *'/'MD-*',
    // páginas sueltas 'E2E Drag Page' y plugins 'com.ld.*'.
    await sweepTestResidue(ctx);

    // Perfil dedicado para toda la suite: los tests no tocan los perfiles
    // del usuario y este puede seguir usando la app mientras corren.
    const created = await ctx.post(`${API}/profiles`, { data: { name: RUNNER_PROFILE, data: {} } });
    if (created.status() !== 201) throw new Error(`No se pudo crear ${RUNNER_PROFILE}: ${created.status()}`);
    const profile = await created.json();
    const pageRes = await ctx.post(`${API}/pages`, {
      data: { profile_id: profile.id, name: 'E2E Home', order_idx: 0, data: {} },
    });
    if (![200, 201].includes(pageRes.status())) throw new Error(`No se pudo crear la página E2E: ${pageRes.status()}`);
    const home = await pageRes.json();

    await ctx.post(`${API}/settings`, { data: { key: 'current.profile_id', value: profile.id } });
    await ctx.post(`${API}/settings`, { data: { key: 'current.page_id', value: home.id } });
    // Modo seguro e2e (ver daemon/src/e2e-safe.ts): mientras la suite corre
    // contra este daemon compartido, las acciones con efectos fuera de la
    // app (minimizar ventanas, hotkeys, shell, volumen…) son no-ops
    // logueados. El teardown lo desactiva (`e2e.safe_mode='0'`).
    await ctx.post(`${API}/settings`, { data: { key: 'e2e.safe_mode', value: '1' } });
    // eslint-disable-next-line no-console
    console.log(`[e2e] perfil dedicado "${RUNNER_PROFILE}" (${profile.id}), vista original guardada`);
  } finally {
    await ctx.dispose();
  }
}

export default globalSetup;
