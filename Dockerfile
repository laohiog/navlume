# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage
#
# `better-sqlite3` ships prebuilt binaries only for some Node/ABI combinations.
# A Node 24 Bookworm (glibc) base plus python3/make/g++ lets npm build it from
# source when no prebuild matches, keeping the image reproducible rather than
# depending on a distant prebuild.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install with the lockfile only, so the image resolves exactly the committed
# dependency graph. `npm ci` is used instead of `npm install`.
COPY package.json package-lock.json ./
RUN npm ci

# Build the React client and compile the server.
#
# Every repository-level file that `npm run build` reads must be present before it
# runs. That chain is:
#
#   npm run build
#     → tsc -p tsconfig.json            (tsconfig.json, vite.config.ts)
#     → vite build                      (index.html, src/client)
#     → tsc -p tsconfig.server-build.json
#     → node scripts/copy-migrations.mjs
#
# `tsconfig.server-build.json` is easy to miss because it is not referenced by
# any other TypeScript config, but omitting it fails the build with TS5058.
COPY tsconfig.json tsconfig.server.json tsconfig.server-build.json vite.config.ts index.html ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage
#
# Only production dependencies and the built artifacts are carried over, so the
# runtime image contains no TypeScript toolchain (`tsx`) and no dev dependencies.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/nav.sqlite \
    UPLOADS_DIR=/data/uploads

WORKDIR /app

# Production dependencies only. The native module is built during this stage
# because the build stage's toolchain is not carried over; the resulting binary
# is ABI-compatible because both stages use the same Node major version.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Built client, compiled server, and the migration files the runtime CLI needs.
COPY --from=build /app/dist ./dist
COPY LICENSE ./LICENSE

# The single persistent mount point. Owned by the unprivileged runtime user so
# the SQLite database and uploads tree can be created on a fresh volume.
RUN mkdir -p /data \
    && chown -R node:node /data /app

USER node

EXPOSE 3000

# Uses Node's built-in fetch, so no curl/wget is installed just for the probe.
# Queries the container-local port rather than the public BETTER_AUTH_URL.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# The entrypoint applies pending migrations before the server starts listening.
CMD ["node", "dist/server/server/index.js"]
