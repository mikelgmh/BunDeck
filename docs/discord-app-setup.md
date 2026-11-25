# Discord: setup del maintainer (una sola vez)

El usuario final NO hace nada de esto: solo pulsa **Autorizar con Discord**
(1 clic). Todo lo de abajo lo hace el maintainer una vez por release.

## 1. Crear la app en Discord

1. Abre https://discord.com/developers/applications → **New Application**.
   Nombre sin la palabra "Discord" (p. ej. `LibreDeck`): Discord lo exige.
2. En **OAuth2 → General** copia el **Client ID**.
3. En **OAuth2 → Redirects** añade EXACTO el redirect baked-in
   (`DEFAULT_DISCORD_REDIRECT_URI`, por defecto `http://127.0.0.1:6463`).
4. En **OAuth2 → General → Reset Secret** genera el **Client Secret**
   (vive SOLO en el relay, nunca en el repo ni en el binario).
5. Scopes necesarios: `identify`, `rpc`, `rpc.voice.write`.

## 2. Pedir aprobación para distribución pública

Discord exige **aprobación** para que una app RPC funcione fuera del
owner/testers (cuota + verificación). Sin este paso, otros usuarios verán
error al autorizar. Se pide en el portal de la app
(**App Verification / Approval**): describe que LibreDeck solo controla voz
(mute/deafen, sin leer mensajes) y espera el OK antes de publicar.

## 3. Desplegar el endpoint relay

El daemon NUNCA lleva el `client_secret` embebido (se extraería del binario).
Despliega un endpoint que lo custodia en servidor:

- `POST {url-relay}  body { code, redirect_uri }`
  → intercambia en `https://discord.com/api/oauth2/token` con
  `grant_type=authorization_code` + `client_id` + **`client_secret`** y
  devuelve `{ access_token, refresh_token, expires_in, token_type }`.
- `POST {url-relay}  body { grant_type: "refresh_token", refresh_token }`
  → renueva con `grant_type=refresh_token` y devuelve lo mismo.
- Propaga los errores de Discord tal cual (`error` / `error_description`,
  mismo status) para que el daemon los muestre.

## 4. Rellenar los 3 valores baked-in

En `daemon/src/plugins/discord-rpc.ts`:

| Constante | Valor |
|---|---|
| `DEFAULT_DISCORD_CLIENT_ID` | Client ID real (quitar el placeholder `__BUNDECK_DISCORD_CLIENT_ID__`) |
| `DEFAULT_DISCORD_REDIRECT_URI` | El redirect registrado en el paso 1.3 |
| `DEFAULT_DISCORD_PROXY_URL` | URL del relay del paso 3 (o `BUNDECK_DISCORD_PROXY_URL` por env) |

Alternativa sin recompilar: variables de entorno
`BUNDECK_DISCORD_CLIENT_ID` / `BUNDECK_DISCORD_REDIRECT_URI` /
`BUNDECK_DISCORD_PROXY_URL` (tienen prioridad sobre los baked-in, por debajo
de los ajustes del usuario power-user).

## 5. Comprobar

1. Con los placeholders SIN rellenar, `discord.connect` devuelve
   `discord-not-configured` (código `not-configured` en needs-auth) e indica
   este doc; el usuario usa el fallback de atajos globales (modo hotkey).
2. Con los 3 valores: 1 clic en Autorizar → `connected`, token en local,
   renovación automática vía relay.
3. Power-user con app propia (ID + Secret en ajustes) sigue yendo directo
   contra `discord.com` sin pasar por el relay.

## Qué ve el usuario final

Nada de lo anterior: pulsa **Autorizar con Discord**, acepta el popup
"Authorize" UNA vez y controla la voz en background. Si el relay aún no está
configurado, el diálogo le dice que use atajos globales mientras tanto.
