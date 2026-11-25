# Discord: setup del maintainer (una sola vez)

El usuario final NO hace nada de esto: solo pulsa **Autorizar con Discord**
(1 clic). Todo lo de abajo lo hace el maintainer una vez por release.

App real: Client ID `1575201215791497256` (baked-in en
`daemon/src/plugins/discord-rpc.ts` como `DISCORD_MAINTAINER_CLIENT_ID`).

## 1. Redirects a registrar en el portal

En https://discord.com/developers/applications → tu app → **OAuth2 →
Redirects** añade EXACTAS estas 3 URLs (Discord solo acepta http/https;
NO admite esquemas personalizados como `bundeck://…`, por eso el flujo usa
el callback https del relay como intermediario):

1. `http://127.0.0.1:6463` (loopback principal; el redirect por defecto del daemon)
2. `http://localhost:6463` (variante loopback; algunos navegadores/SO la prefieren)
3. `https://relay.bundeck.app/api/discord/callback` (callback https del relay;
   si cambias de dominio, actualiza `DEFAULT_DISCORD_CALLBACK_URL` y
   `DEFAULT_DISCORD_PROXY_URL` en `daemon/src/plugins/discord-rpc.ts` y
   registra la nueva URL aquí)

Las 3 están declaradas en código como `DISCORD_VALID_REDIRECT_URIS`
(`daemon/src/plugins/discord-rpc.ts`).

## 2. Dónde va el secret (NUNCA en el repo)

1. En el portal: **OAuth2 → General → Reset Secret** genera el **Client Secret**.
2. El secret vive SOLO como variable de entorno del relay desplegado:
   `DISCORD_CLIENT_SECRET` (junto a `DISCORD_CLIENT_ID=1575201215791497256`).
3. NUNCA lo pegues en el repo, en el binario, en ajustes del plugin ni en
   la web: el daemon no lleva secret embebido (se extraería del binario) y
   el endpoint proxy jamás lo devuelve al cliente.
4. Endpoints del relay (`relay/src/discord.ts`):
   - `GET /api/discord/callback?code=…&state=…` (público, sin auth): sirve una
     página mínima que intenta `POST http://127.0.0.1:<apiPort>/api/v1/plugins/discord/token-capture`
     con `{ code }` (`apiPort` por defecto 3001, override con `?api_port=`).
     Si el daemon no responde, muestra el code grande con botón de copiar
     para pegado manual (token-capture también acepta `{code}`).
     NO necesita secreto: solo reenvía el code al daemon local; el canje
     sigue vía proxy con el secret del env.
   - `POST /api/discord/rpc-token` (público con rate-limit, sin RELAY_TOKEN:
     lo llaman los daemons de los usuarios): recibe `{ code, redirect_uri }`
     o `{ grant_type: "refresh_token", refresh_token }`, intercambia contra
     `https://discord.com/api/oauth2/token` con `client_id` + **`client_secret`**
     del env y devuelve `{ access_token, refresh_token, expires_in, token_type }`
     (propagando los errores de Discord tal cual).

## 3. Approval/testers para distribución

Discord exige **aprobación** para que una app RPC funcione fuera del
owner/testers (cuota + verificación). Sin este paso, otros usuarios verán
error al autorizar. Se pide en el portal de la app
(**App Verification / Approval**): describe que LibreDeck solo controla voz
(mute/deafen, sin leer mensajes) y espera el OK antes de publicar.

Mientras la aprobación está pendiente: en el portal añade a los testers
en **OAuth2 → Testers / App Testers** para que puedan autorizar.

## 4. Valores baked-in (ya rellenos)

En `daemon/src/plugins/discord-rpc.ts`:

| Constante | Valor |
|---|---|
| `DEFAULT_DISCORD_CLIENT_ID` | `1575201215791497256` (app real del maintainer) |
| `DEFAULT_DISCORD_REDIRECT_URI` | `http://127.0.0.1:6463` (redirect loopback) |
| `DEFAULT_DISCORD_CALLBACK_URL` | `https://relay.bundeck.app/api/discord/callback` |
| `DEFAULT_DISCORD_PROXY_URL` | `https://relay.bundeck.app/api/discord/rpc-token` |

Alternativa sin recompilar: variables de entorno del daemon
`BUNDECK_DISCORD_CLIENT_ID` / `BUNDECK_DISCORD_REDIRECT_URI` /
`BUNDECK_DISCORD_PROXY_URL` (tienen prioridad sobre los baked-in, por debajo
de los ajustes del usuario power-user).

## 5. Comprobar

1. Con el relay SIN `DISCORD_CLIENT_SECRET`, `discord.connect` con code
   devuelve `discord-not-configured` e indica este doc; el usuario usa el
   fallback de atajos globales (modo hotkey). El callback https sigue
   sirviendo la página (auto-captura si el daemon está abierto, si no,
   código para copiar).
2. Con relay desplegado (secret en env) + redirects 1–3 registrados:
   1 clic en Autorizar → Discord redirige al callback https → la página
   reenvía el code al daemon local → `connected`, token en local,
   renovación automática vía relay.
3. Power-user con app propia (ID + Secret en ajustes) sigue yendo directo
   contra `discord.com` sin pasar por el relay.

## Qué ve el usuario final

Nada de lo anterior: pulsa **Autorizar con Discord**, acepta el popup
"Authorize" UNA vez y el navegador pasa por el callback https, que entrega
el código a su LibreDeck local automáticamente (o se lo muestra grande
para copiar si el daemon no respondió). Después controla la voz en
background. Si el relay aún no está configurado, el diálogo le dice que
use atajos globales mientras tanto.
