# syntax=docker/dockerfile:1
#
# Sandbox image for the TypeScript execution harness.
#
# Security model, briefly (full version in README.md):
#   gVisor (runsc)    = the security boundary. Set at `docker run`, not here.
#   this image        = keep the inside of that boundary small: no package manager,
#                       no compiler, no node_modules, no writable app files, no root.
#   the sandbox itself = a single, wholly untrusted process. There is no privileged
#                       component inside it holding a secret -- per-test timeouts and
#                       memory limits are enforced by the HOST killing this whole
#                       process/container from outside (src/host/supervise.ts).
#
# Build from the repository root:
#   docker build -f docker/Dockerfile -t ts-sandbox-harness:latest .
#
# For production, pin both FROM lines to an immutable digest
# (node:24-bookworm-slim@sha256:...) so a rebuilt image cannot silently change what
# runs inside the boundary.

# ---------------------------------------------------------------------------
# Build stage: compile the harness. Nothing from this stage ships except the
# emitted JavaScript for the in-sandbox modules.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.json

# ---------------------------------------------------------------------------
# Runtime stage.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# The sandbox runs `node` and nothing else. Remove the package managers so an escape
# from the vm context finds no tooling to install or fetch anything with (there is
# no network either, but layers are cheap).
RUN rm -rf /usr/local/lib/node_modules \
           /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /opt/yarn-* \
 && groupadd --system --gid 10001 sandbox \
 && useradd --system --uid 10001 --gid sandbox \
            --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sandbox

WORKDIR /app

# Only the modules that execute inside the sandbox. The sandbox depends on Node
# built-ins and these files; the host-side orchestrator, import guard and the
# TypeScript compiler are deliberately absent. Transpilation happens on the host.
COPY --from=build /src/dist/src/sandbox/harness.js ./dist/src/sandbox/
COPY --from=build /src/dist/src/encoding.js /src/dist/src/channel.js /src/dist/src/protocol.js ./dist/src/

# Owned by root, not writable by the sandbox user. The container also runs with
# --read-only, so this matters mainly when someone runs the image without it.
RUN chown -R root:root /app && chmod -R a-w,a+rX /app

USER 10001:10001
ENV NODE_ENV=production

# Keep in sync with SANDBOX_NODE_FLAGS in src/host/runner.ts.
ENTRYPOINT ["node", "--disallow-code-generation-from-strings", "/app/dist/src/sandbox/harness.js"]
