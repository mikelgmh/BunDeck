/**
 * Plantilla de plugin externo LibreDeck (Plugin API 2.1).
 *
 * - Este archivo corre en SU PROPIO Worker. No hay acceso directo a
 *   SQLite, al FS del daemon ni a la red salvo vía `api`.
 * - `register(api)` se llama una vez al arrancar. Registra acciones
 *   declaradas en manifest.json con `api.onAction`.
 * - Las acciones reciben (params, context). `context` trae buttonId,
 *   pageId, profileId y timestamp.
 */

export function register(api) {
  api.onAction('saludo', async (params = {}, _context = {}) => {
    const nombre = params.nombre ?? 'Mundo';
    await api.log('info', `Saludo para ${nombre}`);
    return { message: `Hola, ${nombre}!` };
  });
}
