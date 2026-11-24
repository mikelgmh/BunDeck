# BunDeck landing (static site, Openship-ready)
# Build context is the REPO ROOT (like relay/Dockerfile), so paths use the site/ prefix.
# Openship: rootDirectory=site, repo context -> same COPY paths work locally and remote.
FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS release
COPY site/package.json ./
RUN bun install --production
# Todo site/ (index, features, assets, _redirects/_headers de Pages...):
# copiar explícito por fichero ya nos dejó fuera features.html una vez.
COPY site/ ./

ENV NODE_ENV=production
# Openship/openpanel inject $PORT; fallback 8080.
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER bun
CMD ["bun", "server.ts"]
