# syntax=docker/dockerfile:1.7
# Multi-target build for the monorepo services.
#   docker build -f infra/docker/Dockerfile --target api .
#   docker build -f infra/docker/Dockerfile --target media-worker .

ARG NODE_IMAGE=node:22.23.4-bookworm-slim

# Building behind a TLS-intercepting proxy: pass its CA as an optional secret
#   docker build --secret id=extra_ca,src=/path/ca.pem ...
# It is only mounted during the RUN steps below and never stored in a layer.

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=true
COPY --chmod=755 infra/docker/with-extra-ca.sh /usr/local/bin/with-extra-ca
RUN --mount=type=secret,id=extra_ca,required=false \
    corepack enable && with-extra-ca corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo
# Manifests first so dependency layers are cached independently of sources.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/media-worker/package.json apps/media-worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/media-core/package.json packages/media-core/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=extra_ca,required=false \
    with-extra-ca pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN pnpm -r build
# Self-contained production bundles (prod deps only, workspace deps copied with dist/).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store --mount=type=secret,id=extra_ca,required=false \
    with-extra-ca pnpm --filter @streaming/api deploy --prod --legacy /out/api && \
    with-extra-ca pnpm --filter @streaming/media-worker deploy --prod --legacy /out/media-worker

# ---------------------------------------------------------------- api
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------- media-worker
# Ubuntu 24.04 ships ffmpeg 6.1, the version the media pipeline invariants were
# validated against (docs/feasibility/M0-pipeline-spike.md). Node comes from the
# official image so both services run the identical runtime.
FROM ${NODE_IMAGE} AS node-runtime
FROM ubuntu:24.04 AS media-worker
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then \
      echo 'Acquire::https::CAInfo "/run/secrets/extra_ca";' > /etc/apt/apt.conf.d/99extra-ca; fi && \
    apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -f /etc/apt/apt.conf.d/99extra-ca && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 10001 media && \
    useradd --system --uid 10001 --gid media --home-dir /app media && \
    mkdir -p /data /catalog && chown media:media /data
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 MEDIA_WORK_DIR=/data CATALOG_DIR=/catalog
WORKDIR /app
COPY --from=build --chown=media:media /out/media-worker ./
USER media
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
