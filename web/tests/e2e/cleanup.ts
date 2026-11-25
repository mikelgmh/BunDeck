import type { APIRequestContext } from '@playwright/test';

const API = 'http://localhost:3001/api/v1';

export const RUNNER_PROFILE = 'E2E Runner';
/** Página suelta que crea dragdrop.spec.ts (puede vivir en cualquier perfil). */
export const DRAG_PAGE_NAME = 'E2E Drag Page';

/** Prefijos de perfiles creados por la suite e2e (ver profiles.spec.ts `tag()`, profile-backup.spec.ts `tag()`). */
const PROFILE_PREFIXES = ['E2E ', 'MD-'];

function isTestProfile(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  if (name === RUNNER_PROFILE) return true;
  return PROFILE_PREFIXES.some((p) => name.startsWith(p));
}

function isTestPlugin(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('com.ld.');
}

async function jsonOrNull(ctx: APIRequestContext, url: string): Promise<any[] | null> {
  try {
    const res = await ctx.get(url);
    if (!res.ok()) return null;
    const body = await res.json();
    return Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** Borra un perfil con todo su árbol (botones→páginas→perfil). Mejor esfuerzo. */
export async function deleteProfileTree(ctx: APIRequestContext, profileId: string): Promise<void> {
  const pages = await jsonOrNull(ctx, `${API}/pages?profileId=${encodeURIComponent(profileId)}`);
  for (const p of pages ?? []) {
    if (!p?.id) continue;
    try {
      const btns = (await (await ctx.get(`${API}/buttons?pageId=${encodeURIComponent(p.id)}`)).json()) as any[];
      for (const b of btns ?? []) {
        if (b?.id) await ctx.delete(`${API}/buttons/${encodeURIComponent(b.id)}`);
      }
    } catch { /* mejor esfuerzo */ }
    await ctx.delete(`${API}/pages/${encodeURIComponent(p.id)}`);
  }
  await ctx.delete(`${API}/profiles/${encodeURIComponent(profileId)}`);
}

/**
 * Barrido compartido de residuos e2e (global-setup pre-limpieza,
 * global-teardown post-limpieza y rescate manual tras runs abortados):
 * - Perfiles de test ('E2E Runner', prefijos 'E2E ' y 'MD-') con su árbol completo.
 * - Páginas sueltas 'E2E Drag Page' en cualquier perfil (dragdrop.spec.ts).
 * - Plugins 'com.ld.*' (fixtures de elgato-shim.spec.ts).
 * Todo best-effort: nunca lanza.
 */
export async function sweepTestResidue(ctx: APIRequestContext): Promise<void> {
  try {
    const profiles = await jsonOrNull(ctx, `${API}/profiles`);
    for (const p of profiles ?? []) {
      if (p?.id && isTestProfile(p.name)) {
        await deleteProfileTree(ctx, p.id);
      }
    }
  } catch { /* mejor esfuerzo */ }

  // Páginas sueltas de drag&drop fuera de perfiles de test (p. ej. si el
  // beforeAll tocó un perfil del usuario en versiones antiguas del spec).
  try {
    const profiles = await jsonOrNull(ctx, `${API}/profiles`);
    for (const p of profiles ?? []) {
      if (!p?.id) continue;
      const pages = await jsonOrNull(ctx, `${API}/pages?profileId=${encodeURIComponent(p.id)}`);
      for (const pg of pages ?? []) {
        if (pg?.name === DRAG_PAGE_NAME && pg?.id) {
          try {
            const btns = (await (await ctx.get(`${API}/buttons?pageId=${encodeURIComponent(pg.id)}`)).json()) as any[];
            for (const b of btns ?? []) {
              if (b?.id) await ctx.delete(`${API}/buttons/${encodeURIComponent(b.id)}`);
            }
          } catch { /* mejor esfuerzo */ }
          await ctx.delete(`${API}/pages/${encodeURIComponent(pg.id)}`);
        }
      }
    }
  } catch { /* mejor esfuerzo */ }

  try {
    const plugins = await jsonOrNull(ctx, `${API}/plugins`);
    for (const pl of plugins ?? []) {
      if (pl?.id && isTestPlugin(pl.id)) {
        await ctx.delete(`${API}/plugins/${encodeURIComponent(pl.id)}`);
      }
    }
  } catch { /* mejor esfuerzo */ }
}
