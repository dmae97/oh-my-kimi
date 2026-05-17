# syntax=docker/dockerfile:1.7-labs
###############################################################################
# roboomp — orchestrator image
#
# Build is split across three stages:
#
#   1) pi-artifacts — pull a pre-built `oh-my-pi/artifacts:dev` image (built
#      separately from /work/pi/Dockerfile, see `bun run robomp:pi-artifacts`):
#        - pi_natives.linux-<arch>.node → /opt/bun/bin/  (the pi loader probes here)
#        - omp_rpc-*.whl                → pip install
#   2) web-builder    — Bun + Vite compile the SolidJS dashboard bundle from
#      the `web/` workspace into `web/dist/`.
#   3) runtime        — slim Python 3.12 image that copies in (1) the natives
#      + wheel, (2) the dashboard bundle, and (3) the roboomp source.
#
# At runtime the full pi checkout is mounted read-only at /work/pi so `omp`
# (the Bun shim below) executes the coding-agent source directly. The image
# itself stays slim: no rust compile, no pi source tree, no node_modules.
###############################################################################

ARG PI_ARTIFACTS_IMAGE=oh-my-pi/artifacts:dev

############################
# 1) pi-artifacts — pull the pre-built natives + omp-rpc wheel.
############################
FROM ${PI_ARTIFACTS_IMAGE} AS pi-artifacts

############################
# 2) web-builder — Bun + Vite, builds the SolidJS dashboard bundle.
############################
FROM oven/bun:1.3.14-slim AS web-builder
WORKDIR /work
# Build context is the pi monorepo root, so the web-builder stage installs
# from pi's bun.lock — that's how `web/package.json` resolves its `catalog:`
# references against the workspace-wide catalog declared at pi root.
COPY package.json bun.lock ./
COPY python/robomp/web/package.json ./python/robomp/web/package.json
RUN bun install --filter robomp-web
COPY --exclude=node_modules --exclude=dist python/robomp/web/ ./python/robomp/web/
RUN bun --cwd=python/robomp/web run build

############################
# 3) runtime — slim image with everything roboomp needs at boot.
############################
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BUN_INSTALL=/opt/bun \
    PI_ROOT=/work/pi \
    # Persistent build caches under the /data volume so cargo target and
    # rustup toolchains are shared across every per-issue worktree and
    # survive container restarts. Bun's install cache is deliberately
    # workspace-private at runtime; bun chmod/chown behavior makes a shared
    # cross-slot cache unreliable.
    CARGO_HOME=/data/cache/cargo \
    CARGO_TARGET_DIR=/data/cache/cargo-target \
    RUSTUP_HOME=/data/cache/rustup \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl ca-certificates unzip openssh-client tini sqlite3 \
        build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

ARG BUN_VERSION=1.3.14
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

# Rustup launcher. Install the cargo/rustc/rustup proxies into a fixed
# image path; the real toolchain is *not* baked in — it's installed
# lazily into RUSTUP_HOME (=/data/cache/rustup) on the first `cargo`
# invocation inside a worktree, driven by pi's rust-toolchain.toml.
# That keeps the image small while sharing the toolchain across reboots.
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup-bootstrap \
       sh /tmp/rustup-init.sh -y --no-modify-path --default-toolchain none --profile minimal \
    && rm -f /tmp/rustup-init.sh \
    && rm -rf /usr/local/rustup-bootstrap \
    && /usr/local/cargo/bin/rustup --version

# pi-natives addon: pi's loader probes /opt/bun/bin as a fallback path.
COPY --from=pi-artifacts /out/pi_natives.linux-*.node /opt/bun/bin/

# omp-rpc Python wheel.
COPY --from=pi-artifacts /out/*.whl /tmp/wheels/
RUN pip install /tmp/wheels/omp_rpc-*.whl && rm -rf /tmp/wheels

WORKDIR /app

# `omp` shim — calls into the mounted pi checkout via Bun.
RUN printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    ': "${PI_ROOT:=/work/pi}"' \
    'if [ ! -d "$PI_ROOT/packages/coding-agent" ]; then' \
    '  echo "roboomp: PI_ROOT=$PI_ROOT does not look like a pi checkout" >&2' \
    '  exit 127' \
    'fi' \
    'exec bun "$PI_ROOT/packages/coding-agent/src/cli.ts" "$@"' \
    > /usr/local/bin/omp \
    && chmod +x /usr/local/bin/omp

# roboomp itself. Drop the Vite-built dashboard into the package tree before
# `pip install` so it lands in the installed wheel (`static/**/*` is declared
# as package-data in pyproject.toml).
COPY python/robomp/pyproject.toml ./
COPY python/robomp/src/ ./src/
COPY --from=web-builder /work/python/robomp/web/dist/ ./src/static/
RUN pip install --upgrade pip \
    && pip install \
        "fastapi>=0.112" "uvicorn[standard]>=0.30" "httpx>=0.27" \
        "pydantic>=2.6" "pydantic-settings>=2.2" "python-dotenv>=1.0" \
        "click>=8.1" \
    && pip install --no-deps .

RUN mkdir -p /srv/agent-home/.agent /srv/agent-home/.omp/agent \
    && mkdir -p /srv/agent-home-stage/.agent /srv/agent-home-stage/.omp/agent \
    && printf '[install]\nbackend = "copyfile"\n' > /srv/agent-home/.bunfig.toml

COPY python/robomp/entrypoint.sh /usr/local/bin/robomp-entrypoint
RUN chmod +x /usr/local/bin/robomp-entrypoint

VOLUME ["/data"]
EXPOSE 8080
EXPOSE 8081

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/robomp-entrypoint"]
CMD ["python", "-m", "robomp", "serve"]
