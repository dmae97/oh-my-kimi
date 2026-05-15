# syntax=docker/dockerfile:1.7-labs
###############################################################################
# oh-my-pi — build-artifacts image
#
# Produces, in `/out/`, the cross-host build outputs that downstream consumers
# bake into their runtime images:
#
#   - pi_natives.linux-<arch>.node   — N-API addon compiled from `crates/pi-natives`
#   - omp_rpc-<version>-py3-none-any.whl — Python RPC wheel from `python/omp-rpc`
#
# This image deliberately has no entrypoint and no apt-installed extras: it is
# meant to be referenced as a `COPY --from=` stage by other Dockerfiles.
#
# Build:
#     docker build -t oh-my-pi/artifacts:dev .
#
# Consume from another Dockerfile:
#     ARG PI_ARTIFACTS_IMAGE=oh-my-pi/artifacts:dev
#     FROM ${PI_ARTIFACTS_IMAGE} AS pi-artifacts
#     COPY --from=pi-artifacts /out/pi_natives.linux-*.node /opt/bun/bin/
#     COPY --from=pi-artifacts /out/*.whl /tmp/wheels/
###############################################################################

############################
# 1) natives-builder — Rust + Bun → pi_natives.linux-<arch>.node
############################
FROM rust:1.86-slim-bookworm AS natives-builder

ARG BUN_VERSION=1.3.14
ENV BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    CARGO_TERM_COLOR=never

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates pkg-config libssl-dev unzip git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

WORKDIR /pi

# ─── Layer 1: workspace manifests + lockfiles only ───────────────────────────
# Editing source files (under `packages/<x>/src/…` or `crates/<x>/src/…`) won't
# bust the `bun install` layer below, because none of those globs match. Only
# touching a `package.json`, `Cargo.toml`, or a root lockfile invalidates this
# layer. `--parents` preserves the matched path under /pi/ (dockerfile 1.7-labs).
COPY --parents \
    package.json bun.lock bunfig.toml \
    tsconfig.base.json tsconfig.json \
    Cargo.toml Cargo.lock rust-toolchain.toml \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    crates/*/Cargo.toml \
    /pi/

# ─── Layer 2: hydrate node_modules from the manifests above ──────────────────
RUN bun install --frozen-lockfile --ignore-scripts

# ─── Layer 3: full source ────────────────────────────────────────────────────
# `.dockerignore` keeps `target/`, `node_modules/`, `dist/`, `runs/`, editor /
# OS noise (`.DS_Store`, `CPU.*`, `*.cpuprofile`, …), and pre-built host-only
# natives output out of the build context. node_modules from Layer 2 is
# preserved across this COPY because it's never in the context to begin with.
COPY . /pi/

# ─── Layer 4: compile pi-natives to a Linux N-API addon ──────────────────────
# Persistent caches make repeat builds incremental even when the source layer
# invalidates: cargo's package index + git-deps + the workspace's target dir.
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/pi/target \
    set -eux; \
    rustup show; \
    bun --cwd=packages/natives run build; \
    mkdir -p /out; \
    cp packages/natives/native/pi_natives.linux-*.node /out/

############################
# 2) python-builder — omp-rpc wheel
############################
FROM python:3.12-slim-bookworm AS python-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip build

WORKDIR /src
COPY python/omp-rpc /src
RUN python -m build --wheel --outdir /out

############################
# 3) artifacts — final image, nothing but the two outputs.
############################
FROM scratch AS artifacts
COPY --from=natives-builder /out/pi_natives.linux-*.node /out/
COPY --from=python-builder /out/*.whl /out/
