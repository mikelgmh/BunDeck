// Static server for the BunDeck landing (Openship-ready: respects $PORT, exposes /health).
const DIR = import.meta.dir + '/';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  return TYPES[ext] ?? 'application/octet-stream';
}

async function serveFile(path: string): Promise<Response | null> {
  const file = Bun.file(DIR + path);
  if (!(await file.exists())) return null;
  return new Response(file, {
    headers: {
      'content-type': contentType(path),
      'cache-control': path.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=300',
    },
  });
}

const port = Number(process.env.PORT ?? 8080);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    if (path === '/health') {
      return Response.json({ ok: true, service: 'bundeck-site' });
    }
    if (path === '/' || path === '/index.html') {
      const res = await serveFile('index.html');
      if (res) return res;
    }
    const clean = path.replace(/^\/+/, '').replace(/\.\./g, '');
    // Clean URLs: /features -> features.html (same design, no framework router).
    if (clean === 'features') {
      const res = await serveFile('features.html');
      if (res) return res;
    }
    if (clean === '' || clean.endsWith('/')) {
      const res = await serveFile('index.html');
      if (res) return res;
    }
    const direct = await serveFile(clean);
    if (direct) return direct;
    // SPA-ish fallback for unknown routes -> landing.
    const index = await serveFile('index.html');
    if (index) return index;
    return new Response('not found', { status: 404 });
  },
});

console.log(`bundeck-site listening on :${port}`);
