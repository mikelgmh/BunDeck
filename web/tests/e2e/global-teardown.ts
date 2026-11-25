import { request as baseRequest, type FullConfig } from '@playwright/test';
import * as fs from 'node:fs';
import { RUNNER_STATE_FILE } from './global-setup';
import { sweepTestResidue } from './cleanup';

const API = 'http://localhost:3001/api/v1';

async function globalTeardown(_config: FullConfig) {
  const ctx = await baseRequest.newContext();
  try {
    let orig: { origProfile: string | null; origPage: string | null } = { origProfile: null, origPage: null };
    try {
      orig = JSON.parse(fs.readFileSync(RUNNER_STATE_FILE, 'utf8'));
    } catch { /* sin estado previo: mejor esfuerzo */ }

    // Post-limpieza: barrido compartido (perfiles E2E/MD-*, 'E2E Drag Page',
    // plugins com.ld.*). Mantiene la restauración de la vista del usuario.
    await sweepTestResidue(ctx);

    // Desactivar el modo seguro e2e (lo activó el global-setup): el daemon
    // de dev vuelve a ejecutar acciones con normalidad. Best-effort y
    // antes de restaurar la vista, para no dejar el dev capado si algo falla.
    await ctx.post(`${API}/settings`, { data: { key: 'e2e.safe_mode', value: '0' } }).catch(() => {});

    if (orig.origProfile) {
      await ctx.post(`${API}/settings`, { data: { key: 'current.profile_id', value: orig.origProfile } });
    }
    if (orig.origPage) {
      await ctx.post(`${API}/settings`, { data: { key: 'current.page_id', value: orig.origPage } });
    }
    try { fs.rmSync(RUNNER_STATE_FILE, { force: true }); } catch { /* noop */ }
    // eslint-disable-next-line no-console
    console.log('[e2e] perfil dedicado eliminado y vista original restaurada');
  } finally {
    await ctx.dispose();
  }
}

export default globalTeardown;
