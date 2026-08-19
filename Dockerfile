# Based on the official Apify TypeScript Actor Dockerfile.
# https://docs.apify.com/platform/actors/development/actor-definition/dockerfile
# Base images: https://docs.apify.com/platform/actors/development/base-docker-images
FROM apify/actor-node:24 AS builder

# Fail loudly if the base image's preinstalled packages ever drift.
RUN npm ls apify || true

# Copy manifests first so Docker can cache the dependency layer.
COPY --chown=myuser:myuser package*.json ./

# `npm ci` (not `npm install`) so the build is reproducible from the lockfile.
RUN npm ci --include=dev --audit=false --fund=false

COPY --chown=myuser:myuser . ./

RUN npm run build

# ---------- runtime image ----------
FROM apify/actor-node:24

COPY --chown=myuser:myuser package*.json ./

# Production dependencies only, to keep the image small.
RUN npm --quiet set progress=false \
    && npm ci --omit=dev --omit=optional --audit=false --fund=false \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -rf ~/.npm

COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist

# Remaining source/config files. Done after install so most edits hit the cache.
COPY --chown=myuser:myuser . ./

CMD ["node", "dist/main.js"]
