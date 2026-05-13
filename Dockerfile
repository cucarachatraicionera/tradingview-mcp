# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════════════════
#  Stage 1: Build dependencies (native modules)
# ═══════════════════════════════════════════════════════════════════════════
FROM node:22-slim AS builder

WORKDIR /build

# Build dependencies for native modules (better-sqlite3)
RUN apt-get update -qq && apt-get install -y -qq \
    python3 \
    make \
    g++ \
    git \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts 2>/dev/null; \
    npm install 2>&1 | tail -5

# ═══════════════════════════════════════════════════════════════════════════
#  Stage 2: Runtime image
# ═══════════════════════════════════════════════════════════════════════════
FROM node:22-slim

LABEL org.opencontainers.image.title="TradingView Signals Bot"
LABEL org.opencontainers.image.description="Multi-timeframe trading signal scanner with Telegram alerts and dashboard"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.licenses="MIT"

# Runtime dependencies (better-sqlite3 needs these)
RUN apt-get update -qq && apt-get install -y -qq \
    python3 \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PM2_HOME=/app/.pm2

WORKDIR /app

# Copy built node_modules from builder
COPY --from=builder /build/node_modules ./node_modules

# Copy application code
COPY package.json ./
COPY bot/ ./bot/
COPY strategies/ ./strategies/
COPY ecosystem.config.cjs ./

# Create data directory with proper permissions
RUN mkdir -p /app/data /app/.pm2 && \
    addgroup --system --gid 1001 app && \
    adduser --system --uid 1001 --ingroup app --no-create-home app && \
    chown -R app:app /app

USER app

EXPOSE 3456

# Healthcheck: dashboard API + bot process
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3456/api/stats').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# PM2 manages both signals-bot and dashboard
CMD ["npx", "pm2-runtime", "ecosystem.config.cjs"]
