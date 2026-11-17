# Build from the repository root:
#   docker build -f deploy/docker/Dockerfile -t mxagent .

# Base image pinned by exact tag and digest so builds are reproducible. To update, pick the new
# tag and look up its digest, e.g. `docker buildx imagetools inspect node:<version>-bookworm-slim`
# (the digest of the multi-arch index, not of one platform), or let Dependabot/Renovate do it.
# Debian-based on purpose: it gets the glibc build of the native crypto library.
ARG NODE_IMAGE=node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Do not add --ignore-scripts: the postinstall script of @matrix-org/matrix-sdk-crypto-nodejs
# downloads the prebuilt native crypto library (.node) matching this image's platform and
# architecture. Without it the daemon cannot load end-to-end encryption at runtime. The
# download script does not fail the install on errors, so the library is loaded once here:
# a missing, truncated or wrong-architecture binary fails the build.
RUN npm ci --omit=dev \
 && node -e "require('@matrix-org/matrix-sdk-crypto-nodejs')"

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="mxagent" \
      org.opencontainers.image.description="Control AI agents from an end-to-end encrypted Matrix space" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
ENV NODE_ENV=production \
    MXA_STATE_DIR=/var/lib/mxagent \
    MXA_SOCKET_PATH=/run/mxagent/bridge.sock
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY LICENSE LICENSING.md ./
COPY src ./src
COPY cli ./cli
# The config dir exists in the image so that a named volume mounted there (compose.yml) is
# created owned by the node user (uid 1000) with mode 0700 and is writable.
RUN mkdir -p /var/lib/mxagent /run/mxagent /home/node/.config/mxagent \
 && chown node:node /var/lib/mxagent /run/mxagent /home/node/.config /home/node/.config/mxagent \
 && chmod 0700 /var/lib/mxagent /home/node/.config/mxagent
USER node
VOLUME ["/var/lib/mxagent"]
EXPOSE 8640
CMD ["node", "src/daemon/index.ts"]
