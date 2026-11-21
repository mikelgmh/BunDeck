# libredeck-relay — servidor RELAY E2E

Relay WebSocket para BunDeck cuando cliente y daemon no están en la misma LAN.
**El relay NUNCA descifra nada**: enruta mensajes opacos por `deviceId`.
Sin cola: si el destino está offline responde error (no guarda comandos).

- Transporte: `Bun.serve` + WebSocket nativo. En prod va tras reverse proxy
  con TLS (`wss://`); en local `ws://`.
- Auth: token compartido `RELAY_TOKEN` (query `?token=`, `Authorization: Bearer`,
  o header `x-relay-token`). Sin token solo se permite en dev local (avisa en logs).
- E2E real: NaCl `box` (X25519 + XSalsa20-Poly1305) vía `tweetnacl`
  (primitiva estándar, no cripto propia). Ver `src/crypto.ts`.
- Pairing: código de 6 dígitos, un solo uso, TTL 5 min, solo en memoria.
- Persistencia mínima: SQLite `relay.db` con `devices(id, pub_key, name, last_seen)`.
  JAMÁS claves privadas en el servidor.

## Estructura

```
relay/
  src/
    index.ts    # entrypoint: config + listen + prune + shutdown
    relay.ts    # RelayServer (Bun.serve, routing, validación, rate-limit)
    crypto.ts   # E2E: generateIdentity / seal / openEnvelope / opaque
    pairing.ts  # PairingStore: códigos 6 dígitos, un solo uso, TTL 5min
    store.ts    # DeviceStore (bun:sqlite) + resolveRelayDataDir
    ratelimit.ts# RateLimiter ventana deslizante
    config.ts   # env: RELAY_PORT, RELAY_TOKEN, RELAY_DOMAIN, DATA_DIR
  tests/        # bun:test (routing, offline, pairing TTL, rate-limit, E2E)
  Dockerfile    # multi-stage bun, openship-ready ($PORT + /health)
  docker-compose.example.yml
```

## Protocolo (todo JSON, `v: 1`)

Sobre WS (autenticado con el token). El relay valida: `v === 1`,
`type` no vacío, **presencia** de `nonce` (string) y `exp` (epoch ms),
y rechaza `exp` con más de **5 min** de antigüedad (skew).
El **nonce/counter anti-replay lo valida el CLIENTE** (el relay no lleva estado
por mensaje). Límite: **64 KB** por mensaje; **60 msg/min por IP**.

```ts
// Sobre común cliente -> relay
{ v: 1, type, from?: deviceId, to?: deviceId, nonce, exp, payload?, payloadEncrypted? }
```

| type | dirección | campos | notas |
|---|---|---|---|
| `register` | c→s | `payload: { deviceId, pubKey, name? }` (`from` debe coincidir si se envía) | Vincula socket⇄deviceId, upsert en SQLite. Responde `registered`. Emite `presence` a todos. |
| `request-pair` | c→s | `payload: { code }` | Consume el código (un solo uso). Ok → `paired`. Falla → `error invalid-code`. |
| `signal` | c→s→c | `to`, `payloadEncrypted: string` (opaco) | Reenviado **tal cual** a `to`. Offline → `error offline`. |
| `invite` / `pair-accept` | c→s→c | `to`, `payload?` | Reenviado a `to` si está online (mismo tratamiento que `signal` pero con `payload` en claro para el handshake). |
| `presence` | c→s→c | — | Responde `{ type:'presence', payload:{ online: [deviceIds…] } }`. Además el servidor difunde `{ deviceId, online }` al registrar/desconectar. |
| `ping` | c→s | — | Responde `pong` (eco del `nonce`). |
| `registered` / `paired` / `pong` | s→c | — | Confirmaciones. |
| `error` | s→c | `reason`, `to?`, `detail?` | `offline`, `invalid-code`, `expired`, `too-large`, `bad-json`, `bad-version`, `missing-nonce`, `missing-exp`, `missing-to`, `missing-payload`, `bad-register`, `unknown-type`, `rate-limited`. |

### Formato E2E (`payloadEncrypted`)

1. A genera identidad (`generateIdentity()`), publica la pública en `register`.
2. Para enviar a B: `opaque = sealToOpaque(plaintext, pubKeyB, secretKeyA)`.
   - Por mensaje: nonce aleatorio 24 B.
   - `box(plaintext, nonce, pubKeyB, secretKeyA)` (ECDH X25519 estático + XSalsa20-Poly1305).
   - `payloadEncrypted = base64(JSON({ nonce, box, from: pubKeyA }))`.
3. B: `openFromOpaque(opaque, secretKeyB)` → usa `from` del sobre como clave del emisor.
4. El relay reenvía la cadena sin mirarla (tests: con otra clave no abre; el opaco no contiene el plaintext).

## HTTP

| Método | Ruta | Auth | Respuesta |
|---|---|---|---|
| GET | `/health` | no | `{ ok, service, version, uptime }` |
| GET | `/stats` | no | `{ online, devices, pairingPending, uptime }` — solo conteos, sin datos sensibles |
| POST | `/pair` | **sí** (`RELAY_TOKEN`) | `{ code: "123456", expiresIn: 300 }` — código de un solo uso |
| * | resto | **sí** | upgrade a WebSocket (`401` sin token, `426` si no es WS) |

## Variables de entorno

| Var | Defecto | Descripción |
|---|---|---|
| `PORT` | — | Prioritario (lo inyectan openship/openpanel). Si no, `RELAY_PORT`. |
| `RELAY_PORT` | `8787` | Puerto de escucha. |
| `RELAY_TOKEN` | vacío (abierto, solo dev) | Secreto para WS y `POST /pair`. Generar: `openssl rand -hex 32`. |
| `RELAY_DOMAIN` | vacío | Solo logs (p.ej. `bundeck.mikelgranero.com`). |
| `DATA_DIR` / `RELAY_DATA_DIR` | `relay/data` | Directorio de `relay.db` (en docker: `/data`). |

## Cómo correr

```bash
cd relay
bun install
cp .env.example .env   # pon RELAY_TOKEN

bun run dev            # watch, puerto 8787
bun run start          # prod local

# Generar código de pairing (requiere token):
curl -X POST -H "Authorization: Bearer $RELAY_TOKEN" http://127.0.0.1:8787/pair

bun test               # tests (routing, offline, pairing TTL, rate-limit, E2E)
```

## Docker / despliegue

```bash
cd relay
docker build -t libredeck-relay:0.1.0 .
docker run --rm -p 8787:8787 \
  -e RELAY_TOKEN="$(openssl rand -hex 32)" \
  -e RELAY_DOMAIN=bundeck.mikelgranero.com \
  -v relay-data:/data \
  libredeck-relay:0.1.0

# o con compose (copia el example y pon el token en .env):
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

Openship-ready: respeta `$PORT`, expone `HEALTHCHECK /health`.
Dominio previsto: `bundeck.mikelgranero.com` → reverse proxy TLS → `wss://` a este servicio
(el relay no termina TLS por sí mismo; `wss` lo pone el proxy).

## Límites del MVP (decisiones conscientes)

- Sin cola persistente: destino offline ⇒ `error offline`, el mensaje se pierde.
- Sin forward secrecy (ECDH estático entre identidades; rotar identidad = re-registrar + re-emparejar).
- Pairing en memoria: los códigos mueren al reiniciar (por diseño; SQLite solo guarda dispositivos).
- Anti-replay (`nonce`/counter) lo valida el cliente, no el relay.
