/** Respuestas JSON y detección de errores UNIQUE — uso común de api/*.ts. */

export function isUniqueConstraintError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? `${error.message} ${String((error as any)?.code ?? '')}`
      : String(error);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT/i.test(msg);
}

export function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

/** Límite anti-corrupción para los JSON de páginas/perfiles.
 *  Un `data` sano son decenas-centenas de bytes (grid + modo layout).
 *  El incidente de 2026-11 (una página con 118 MB por `{...string}`)
 *  bloqueó el event loop de Bun ~16 s y el parse del frontend ~22 s.
 *  Todo lo que supere el límite se rechaza con 413 antes de tocar la BD. */
export const MAX_PAGE_PROFILE_DATA_BYTES = 256 * 1024;

export function dataTooLarge(data: unknown, limit: number = MAX_PAGE_PROFILE_DATA_BYTES): boolean {
  if (data === undefined || data === null) return false;
  try {
    return JSON.stringify(data)?.length > limit;
  } catch {
    return true;
  }
}

export function errorResponse(message: string, error?: any, status: number = 500): Response {
  const details = error
    ? {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        type: error?.constructor?.name || 'Unknown',
      }
    : undefined;

  return jsonResponse(
    {
      error: message,
      details,
    },
    status
  );
}
