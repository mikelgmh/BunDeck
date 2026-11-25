/**
 * cleanup-e2e.ts — RESCATE MANUAL tras runs e2e abortados.
 *
 * El flujo normal ya limpia solo: global-setup (pre) y global-teardown
 * (post) ejecutan el barrido compartido de web/tests/e2e/cleanup.ts
 * (sweepTestResidue), y cada spec borra lo suyo (afterAll/afterEach).
 * Este script es solo para cuando un run se aborta a mitad (Ctrl+C,
 * caída del daemon) y el teardown no llegó a correr: barre los mismos
 * residuos contra la DB real de dev (http://localhost:3001, data/db.sqlite):
 * - Perfiles de test: 'E2E Runner' exacto y prefijos 'E2E ' / 'MD-',
 *   con su árbol completo (botones→páginas→perfil).
 * - Páginas sueltas 'E2E Drag Page' en cualquier perfil.
 * - Plugins 'com.ld.*' (fixtures de elgato-shim.spec.ts).
 * Al final restaura la vista a default/default-page-deck e informa.
 *
 * Uso: `bun cleanup-e2e.ts` (raíz) o `bun run test:e2e:cleanup` (raíz/web).
 * Requiere el daemon levantado en :3001. Best-effort: no lanza.
 */
const API = 'http://localhost:3001/api/v1';

const PROFILE_PREFIXES = ['E2E ', 'MD-'];
const RUNNER_PROFILE = 'E2E Runner';
const DRAG_PAGE_NAME = 'E2E Drag Page';

function isTestProfile(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  if (name === RUNNER_PROFILE) return true;
  return PROFILE_PREFIXES.some((p) => name.startsWith(p));
}

async function waitDaemon() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://localhost:3001/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('sin daemon');
}

async function jsonList(url: string): Promise<any[]> {
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const b = await r.json();
    return Array.isArray(b) ? b : [];
  } catch { return []; }
}

async function bestEffortDelete(url: string): Promise<void> {
  try { await fetch(url, { method: 'DELETE' }); } catch {}
}

await waitDaemon();

// 1) Perfiles de test con todo su árbol (la cascada del daemon en
// deleteProfile ya borra páginas/botones/asignaciones, pero se barre
// explícito por si el daemon es antiguo).
const profiles = await jsonList(`${API}/profiles`);
for (const p of profiles ?? []) {
  if (!p?.id || !isTestProfile(p?.name)) continue;
  const pages = await jsonList(`${API}/pages?profileId=${encodeURIComponent(p.id)}`);
  for (const pg of pages ?? []) {
    if (!pg?.id) continue;
    try {
      const btns = await jsonList(`${API}/buttons?pageId=${encodeURIComponent(pg.id)}`);
      for (const b of btns ?? []) {
        if (b?.id) await bestEffortDelete(`${API}/buttons/${encodeURIComponent(b.id)}`);
      }
    } catch {}
    await bestEffortDelete(`${API}/pages/${encodeURIComponent(pg.id)}`);
  }
  await bestEffortDelete(`${API}/profiles/${encodeURIComponent(p.id)}`);
  console.log('perfil de test eliminado:', p?.name, p.id);
}

// 2) Páginas sueltas 'E2E Drag Page' en cualquier perfil restante.
const remaining = await jsonList(`${API}/profiles`);
for (const p of remaining ?? []) {
  if (!p?.id) continue;
  const pages = await jsonList(`${API}/pages?profileId=${encodeURIComponent(p.id)}`);
  for (const pg of pages ?? []) {
    if (pg?.name !== DRAG_PAGE_NAME || !pg?.id) continue;
    try {
      const btns = await jsonList(`${API}/buttons?pageId=${encodeURIComponent(pg.id)}`);
      for (const b of btns ?? []) {
        if (b?.id) await bestEffortDelete(`${API}/buttons/${encodeURIComponent(b.id)}`);
      }
    } catch {}
    await bestEffortDelete(`${API}/pages/${encodeURIComponent(pg.id)}`);
    console.log('página suelta eliminada:', DRAG_PAGE_NAME, 'en perfil', p?.name);
  }
}

// 3) Desinstalar plugins com.ld.* (fixtures del spec elgato-shim).
const plugs = await jsonList(`${API}/plugins`);
for (const pl of plugs ?? []) {
  if (typeof pl?.id === 'string' && pl.id.startsWith('com.ld.')) {
    const r = await fetch(`${API}/plugins/${encodeURIComponent(pl.id)}`, { method: 'DELETE' });
    console.log('plugin fuera:', pl.id, r.status);
  }
}

// 4) Vista del usuario + estado final.
await fetch(`${API}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'current.profile_id', value: 'default' }) });
await fetch(`${API}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'current.page_id', value: 'default-page-deck' }) });
const left = await jsonList(`${API}/profiles`);
console.log('perfiles restantes:', left.map((p) => p.name).join(', '));
