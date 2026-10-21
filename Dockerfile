# Coolify Dockerfile build. Replaces the Nixpacks build, whose Node package (22.11.0) could not
# be pinned to a patched release. Mirrors the former Coolify commands: install with dev
# dependencies, download and validate the bus-stop index, build, then start with `next start`.
# The official Node image manifest is pinned (22.23.4, Alpine 3.24).
ARG NODE_BASE=node:22-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc

FROM ${NODE_BASE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
# Cache-busted pages come from TfL's origin and take 10-15 s each (33 pages), past the script's
# 10 s per-page default, so allow 60 s per page and 25 min for the whole run.
RUN TFL_STOPS_TIMEOUT_MS=60000 TFL_STOPS_TOTAL_MS=1500000 node scripts/download-bus-stops.mjs \
 && node scripts/validate-bus-stops.mjs lib/bus-stops.json --require-generated \
 && npm run build \
 && npm prune --omit=dev

FROM ${NODE_BASE}
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
CMD ["npm", "start"]
