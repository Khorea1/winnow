# Dockerfile — multi-stage production build for winnow
# Uses slim Node image for native addon compatibility.

# ── Stage 1: Build ──────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install build deps (better-sqlite3 needs node-gyp)
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy manifests first for layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Build the app
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── Stage 2: Runtime ────────────────────────────────────────
FROM node:22-bookworm-slim

# Add non-root user
RUN groupadd -g 1001 rotator && \
    useradd -u 1001 -g rotator -d /srv -s /sbin/nologin rotator

ENV WINNOW_DATA_DIR=/srv/data \
    WINNOW_CONFIG=/srv/data/config.json \
    NODE_ENV=production

# Copy built artifacts + node_modules (includes native better-sqlite3)
COPY --from=builder /app/dist        dist/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/package.json ./

# Copy static dashboard assets
COPY public/ public/

# Create writable data dir
RUN mkdir -p /srv/data && chown -R rotator:rotator /srv

USER rotator
EXPOSE 8080

# Volume for persistent state (health DB, config, proxy file)
VOLUME ["/srv/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/__stats',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(d.includes('total')?0:1))}).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
