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
