const API = 'http://localhost:3001/api/v1';
async function waitDaemon() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://localhost:3001/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('sin daemon');
}
await waitDaemon();
// 1) Borrar perfil "E2E Runner" con todo su árbol (el teardown no llegó a correr).
const profiles = await (await fetch(`${API}/profiles`)).json();
for (const p of profiles ?? []) {
  if (p?.name !== 'E2E Runner') continue;
  const pages = await (await fetch(`${API}/pages?profileId=${encodeURIComponent(p.id)}`)).json();
  for (const pg of pages ?? []) {
    try {
      const btns = await (await fetch(`${API}/buttons?pageId=${encodeURIComponent(pg.id)}`)).json();
      for (const b of btns ?? []) await fetch(`${API}/buttons/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
    } catch {}
    await fetch(`${API}/pages/${encodeURIComponent(pg.id)}`, { method: 'DELETE' });
  }
  await fetch(`${API}/profiles/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
  console.log('E2E Runner eliminado:', p.id);
}
// 2) Desinstalar plugins com.ld.* (fixtures del spec elgato-shim).
const plugs = await (await fetch(`${API}/plugins`)).json();
for (const pl of plugs ?? []) {
  if (typeof pl?.id === 'string' && pl.id.startsWith('com.ld.')) {
    const r = await fetch(`${API}/plugins/${encodeURIComponent(pl.id)}`, { method: 'DELETE' });
    console.log('plugin fuera:', pl.id, r.status);
  }
}
// 3) Vista del usuario + estado final.
await fetch(`${API}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'current.profile_id', value: 'default' }) });
await fetch(`${API}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'current.page_id', value: 'default-page-deck' }) });
const left = await (await fetch(`${API}/profiles`)).json();
console.log('perfiles restantes:', left.map((p) => p.name).join(', '));
