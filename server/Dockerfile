# Mempire API.
#
# Multi-stage so the shipped image carries production dependencies only — no
# lockfile-resolved dev tree, no build cache, no source control metadata.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
# Copied on their own so a source edit does not invalidate the dependency layer.
COPY package.json package-lock.json ./
# `npm ci` rather than `install`: it installs exactly the lockfile and fails if
# the two have drifted, which is the behaviour you want in a build that nobody
# is watching.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as a non-root user. The base image ships `node` (uid 1000) for exactly
# this; a container that does not need root should not have it.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node *.js ./
# The roster, the contract ABIs and the deployment addresses, vendored from the
# repo's `shared/` by `npm run sync-shared`. None of it is code, so none of it
# is caught by the *.js copy above — and the server refuses to start without
# it. A data directory beside the modules is the easy half of a change to
# forget, which is why it is named here on its own line.
COPY --chown=node:node shared ./shared

# `wget` is in busybox already, so the healthcheck costs no extra layer.
# Mongo may take a moment on cold start, hence the generous start period.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:${PORT:-8787}/api/health || exit 1

USER node
EXPOSE 8787

# `node` directly, not `npm start`: npm sits between the signal and the process,
# and this server has a SIGTERM handler that closes Mongo cleanly. Exec form so
# there is no shell in between either.
CMD ["node", "index.js"]
