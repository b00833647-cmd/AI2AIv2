# AI2AI — multi-agent negotiation experiment server.
# Single-stage build using node:24-alpine. We don't have a build step (tsx
# runs TypeScript directly) so the runtime image == the build image.
#
# At runtime the container expects:
#   - PORT     (set by your platform; we read AI2AI_PORT or fall back to 3737)
#   - ANTHROPIC_API_KEY  (or all three of BUYER/SELLER/ORCHESTRATOR_*)
#   - AI2AI_ADMIN_PASSWORD          (recommended)
#   - AI2AI_DAILY_BUDGET_USD        (recommended — daily LLM spend cap)
#   - A persistent volume mounted at /data (set AI2AI_DB_PATH=/data/sessions.db)
#
# Build:    docker build -t ai2ai .
# Run:      docker run -p 3737:3737 -v $(pwd)/data:/data \
#             -e ANTHROPIC_API_KEY=sk-ant-... \
#             -e AI2AI_ADMIN_PASSWORD=change-me \
#             -e AI2AI_DB_PATH=/data/sessions.db \
#             ai2ai

FROM node:24-alpine

# better-sqlite3 needs python3 + build tools to compile its native binding.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (better Docker layer caching).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm install tsx

# Copy the rest of the application code.
COPY src ./src
COPY web ./web
COPY scenarios ./scenarios
COPY multi-agent-core ./multi-agent-core
COPY tsconfig.json ./

# Default port + DB path (overridable at runtime).
ENV NODE_ENV=production
ENV AI2AI_PORT=3737
ENV AI2AI_DB_PATH=/data/sessions.db

# Rate-limiting OFF by default in containerized deploys so QA/researchers can
# test from their own IP without tripping the per-IP-per-24h limit. Re-enable
# for a Prolific launch by setting AI2AI_RATE_LIMIT=on in your platform's
# environment variables (Railway → Variables; Fly → fly secrets) — that
# overrides this Dockerfile default at container start.
ENV AI2AI_RATE_LIMIT=off

# Make sure the volume mount point exists (won't be persistent without -v).
RUN mkdir -p /data

EXPOSE 3737

# Container-native health check — same /health endpoint your platform polls.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O - http://localhost:${AI2AI_PORT:-3737}/health || exit 1

# tsx runs the TS source directly — no build step.
CMD ["npx", "tsx", "src/server/server.ts"]
