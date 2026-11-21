/**
 * Subida de imágenes de tecla (`POST /api/v1/assets`).
 *
 * - Límite 8 MB; tipos: PNG, JPEG, WebP, GIF, SVG.
 * - PNG/JPEG/WebP se normalizan con `Bun.Image` (Bun 1.3.14+): encaje
 *   dentro de 512 px sin ampliar y salida PNG — "siempre el formato correcto".
 * - GIF (animados incluidos) y SVG se guardan tal cual para no romper
 *   la animación ni la vectorialidad.
 * - El fichero vive en `<data>/assets/key-<uuid>.<ext>` y se sirve en
 *   `/assets/<fichero>` (ver `http/static.ts`); en BD solo metadatos.
 */
import path from 'path';
import { getDataDir } from '../paths';
import { jsonResponse } from '../api/http-helpers';

export const KEY_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const KEY_IMAGE_MAX_DIM = 512;

/** ext → mime aceptado (ext en minúsculas, sin punto). */
export const KEY_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

/** Aliases que ponen algunos navegadores/SO (p. ej. image/jpg en Windows). */
const MIME_ALIASES: Record<string, string[]> = {
  png: ['image/png', 'image/x-png'],
  jpg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  webp: ['image/webp'],
  gif: ['image/gif'],
  svg: ['image/svg+xml', 'image/svg'],
};

export type KeyImageKind = 'raster' | 'gif' | 'svg';

export interface ClassifiedUpload {
  kind: KeyImageKind;
  ext: string;
  mime: string;
}

/**
 * Valida nombre/mime/tamaño. Devuelve la clasificación o un mensaje de error.
 * Pura y unit-testeable (sin FS ni BD).
 */
export function classifyKeyImageUpload(
  filename: unknown,
  mime: unknown,
  size: unknown
): { ok: ClassifiedUpload } | { error: string } {
  const bytes = typeof size === 'number' ? size : NaN;
  if (!Number.isFinite(bytes) || bytes <= 0) return { error: 'Archivo vacío.' };
  if (bytes > KEY_IMAGE_MAX_BYTES) return { error: 'La imagen supera los 8 MB.' };

  const name = typeof filename === 'string' ? filename : '';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const expected = KEY_IMAGE_TYPES[ext];
  if (!expected) return { error: 'Formato no válido (PNG, JPG, WebP, GIF o SVG).' };

  // El mime del navegador debe acompañar a la extensión (evita .exe renombrados).
  // Se permite vacío (curl) y aliases conocidos (image/jpg en Windows, …).
  const mt = typeof mime === 'string' ? mime.toLowerCase().split(';')[0].trim() : '';
  if (mt && !(MIME_ALIASES[ext] ?? []).includes(mt)) {
    return { error: 'Formato no válido (PNG, JPG, WebP, GIF o SVG).' };
  }

  const kind: KeyImageKind = ext === 'gif' ? 'gif' : ext === 'svg' ? 'svg' : 'raster';
  return { ok: { kind, ext: ext === 'jpg' ? 'jpg' : ext, mime: expected } };
}

export interface NormalizedImage {
  bytes: Uint8Array;
  ext: string;
  mime: string;
  width: number;
  height: number;
}

/**
 * Normaliza un raster (PNG/JPEG/WebP) a PNG encajado en 512 px.
 * Lanza si `Bun.Image` no está disponible o el contenido no es imagen.
 */
export async function normalizeKeyImage(input: Uint8Array | ArrayBuffer): Promise<NormalizedImage> {
  const BImage = (Bun as any)?.Image;
  if (typeof BImage !== 'function') {
    throw new Error('Este daemon (Bun) no trae Bun.Image: actualiza Bun para subir imágenes.');
  }
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  let img: any;
  try {
    img = new BImage(buf, { maxPixels: 4096 * 4096, autoOrient: true });
    await img.metadata();
  } catch {
    throw new Error('El archivo no es una imagen válida.');
  }
  try {
    const out = await img
      .resize(KEY_IMAGE_MAX_DIM, KEY_IMAGE_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .png()
      .bytes();
    const meta = await img.metadata().catch(() => ({ width: 0, height: 0 }));
    const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
    return {
      bytes,
      ext: 'png',
      mime: 'image/png',
      width: typeof meta?.width === 'number' ? meta.width : 0,
      height: typeof meta?.height === 'number' ? meta.height : 0,
    };
  } catch {
    throw new Error('No se pudo procesar la imagen.');
  }
}

/** Nombre seguro dentro de assets: un solo segmento, sin `..` ni separadores. */
export function safeAssetName(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel) return null;
  const base = rel.trim();
  if (!base || base === '.' || base === '..') return null;
  if (base.includes('/') || base.includes('\\') || base.includes('..')) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(base)) return null;
  return base;
}

interface AssetsDb {
  createAsset(a: { id: string; path: string; hash: string; size: number; created_at: number }): void;
}

/**
 * `POST /api/v1/assets` con `multipart/form-data` (`file`).
 * Responde `{ ok, url, name, size, width, height, format, animated }`.
 */
export async function handleKeyImageUpload(
  req: Request,
  db: AssetsDb,
  dataDir?: string
): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ error: 'Falta el fichero (campo «file»).' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return jsonResponse({ error: 'Falta el fichero (campo «file»).' }, 400);
  }
  const fname = typeof (file as any).name === 'string' ? (file as any).name : 'upload.bin';
  const verdict = classifyKeyImageUpload(fname, (file as Blob).type, (file as Blob).size);
  if ('error' in verdict) return jsonResponse({ error: verdict.error }, 400);

  const { kind } = verdict.ok;
  const raw = new Uint8Array(await (file as Blob).arrayBuffer());

  let finalBytes: Uint8Array;
  let ext: string;
  let width = 0;
  let height = 0;
  if (kind === 'raster') {
    try {
      const norm = await normalizeKeyImage(raw);
      finalBytes = norm.bytes;
      ext = norm.ext;
      width = norm.width;
      height = norm.height;
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : 'No se pudo procesar la imagen.' }, 422);
    }
  } else {
    finalBytes = raw;
    ext = verdict.ok.ext;
    if (kind === 'gif' && typeof (Bun as any)?.Image === 'function') {
      try {
        const meta = await new (Bun as any).Image(raw).metadata();
        width = meta?.width ?? 0;
        height = meta?.height ?? 0;
      } catch {
        /* dimensiones opcionales */
      }
    }
  }

  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const name = `key-${id}.${ext}`;
  const dir = dataDir ?? path.join(getDataDir(), 'assets');
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await Bun.write(path.join(dir, name), finalBytes);
  } catch {
    return jsonResponse({ error: 'No se pudo guardar la imagen.' }, 500);
  }

  try {
    const hash = typeof (Bun as any)?.hash === 'function' ? String((Bun as any).hash(finalBytes)) : id;
    db.createAsset({ id, path: name, hash, size: finalBytes.byteLength, created_at: Date.now() });
  } catch {
    /* metadatos best-effort: el fichero ya está servido por /assets */
  }

  const headers: Record<string, string> = {};
  return jsonResponse(
    {
      ok: true,
      url: `/assets/${name}`,
      name,
      size: finalBytes.byteLength,
      width,
      height,
      format: ext,
      animated: kind === 'gif',
    },
    200
  );
}

/** `DELETE /api/v1/assets` con JSON `{ url }`. Best-effort, siempre 200 si el nombre es válido. */
export async function handleKeyImageDelete(
  req: Request,
  dataDir?: string
): Promise<Response> {
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Falta «url».' }, 400);
  }
  const raw = typeof body?.url === 'string' ? body.url : typeof body?.path === 'string' ? body.path : '';
  const name = safeAssetName(raw.split('?')[0].replace(/^\/assets\//, ''));
  if (!name) return jsonResponse({ error: 'Nombre no válido.' }, 400);
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(path.join(dataDir ?? path.join(getDataDir(), 'assets'), name));
  } catch {
    /* ya no existe: igualmente ok */
  }
  return jsonResponse({ ok: true }, 200);
}
