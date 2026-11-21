# ---- base ----
FROM oven/bun:1 AS base
WORKDIR /app

# ---- deps (capa cacheable) ----
# Contexto: openship usa el repo como contexto con rootDirectory=relay,
# así que se copia con prefijo relay/ para que funcione igual en local y en remote.
FROM base AS install
COPY relay/package.json relay/bun.lock ./
RUN bun install --production

# ---- runtime ----
FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY relay/package.json ./
COPY relay/src ./src

ENV NODE_ENV=production
# Openship/openpanel inyectan $PORT; RELAY_PORT es el fallback.
ENV PORT=8787
ENV RELAY_PORT=8787
ENV DATA_DIR=/data

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const p=process.env.PORT||process.env.RELAY_PORT||8787;fetch('http://127.0.0.1:'+p+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER bun
CMD ["bun", "src/index.ts"]
