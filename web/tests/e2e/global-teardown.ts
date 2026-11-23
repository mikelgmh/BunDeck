import { request as baseRequest, type FullConfig } from '@playwright/test';
import * as fs from 'node:fs';
import { RUNNER_PROFILE, RUNNER_STATE_FILE } from './global-setup';

const API = 'http://localhost:3001/api/v1';

/** Borra un perfil con todas sus páginas y botones. */
async function deleteProfileTree(ctx: any, profileId: string) {
  const pagesRes = await ctx.get(`${API}/pages?profileId=${encodeURIComponent(profileId)}`);
  if (!pagesRes.ok()) return;
  const pages = await pagesRes.json();
  for (const p of pages ?? []) {
    try {
      const btns = await (await ctx.get(`${API}/buttons?pageId=${encodeURIComponent(p.id)}`)).json();
      for (const b of btns ?? []) {
        await ctx.delete(`${API}/buttons/${encodeURIComponent(b.id)}`);
      }
    } catch { /* mejor esfuerzo */ }
    await ctx.delete(`${API}/pages/${encodeURIComponent(p.id)}`);
  }
  await ctx.delete(`${API}/profiles/${encodeURIComponent(profileId)}`);
}

async function globalTeardown(_config: FullConfig) {
  const ctx = await baseRequest.newContext();
  try {
    let orig: { origProfile: string | null; origPage: string | null } = { origProfile: null, origPage: null };
    try {
      orig = JSON.parse(fs.readFileSync(RUNNER_STATE_FILE, 'utf8'));
    } catch { /* sin estado previo: mejor esfuerzo */ }

    const profiles = (await (await ctx.get(`${API}/profiles`)).json()) as any[];
    for (const p of profiles ?? []) {
      if (p?.name === RUNNER_PROFILE) await deleteProfileTree(ctx, p.id);
    }

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
