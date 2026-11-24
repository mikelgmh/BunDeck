# BunDeck landing (static site, Openship-ready)
# Build context is the REPO ROOT (like relay/Dockerfile), so paths use the site/ prefix.
# Openship: rootDirectory=site, repo context -> same COPY paths work locally and remote.
FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS release
COPY site/package.json ./
RUN bun install --production
COPY site/server.ts ./
COPY site/index.html ./
COPY site/features.html ./
COPY site/styles.css ./
COPY site/app.js ./
COPY site/assets ./assets

ENV NODE_ENV=production
# Openship/openpanel inject $PORT; fallback 8080.
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER bun
CMD ["bun", "server.ts"]
