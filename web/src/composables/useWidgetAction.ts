import { normalizeApiBase } from './useKeyShare'

/**
 * Execute a plugin action from a first-party widget surface.
 * Widgets only pass action identifiers and parameters; the daemon still
 * validates and executes every action through the normal ActionRunner path.
 * Unwrap the API envelope here so widgets consume the action result itself
 * and receive unsuccessful ActionRunner responses as errors.
 */
export async function executeWidgetAction(
  apiBase: string,
  type: string,
  parameters: Record<string, unknown> = {},
): Promise<any> {
  const base = normalizeApiBase(apiBase) || ''
  const response = await fetch(`${base}/api/v1/actions/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: { type, parameters },
      context: { quiet: true, source: 'widget-control' },
    }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail || `No se pudo ejecutar ${type} (${response.status})`)
  }
  const payload = await response.json()
  if (payload?.success === false) {
    throw new Error(payload.error || `No se pudo ejecutar ${type}`)
  }
  return payload?.result ?? payload?.data ?? payload
}
