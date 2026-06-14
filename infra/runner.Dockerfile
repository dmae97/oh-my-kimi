# syntax=docker/dockerfile:1
# Preloaded omp-kata runner image.
#
# Stock GitHub Actions runner (Ubuntu 24.04) with the dependencies CI installs
# on every job baked in, so each ephemeral Kata microVM boots with them already
# present instead of re-fetching them per job:
#   - APT system deps (canvas/cairo stack + fd/ripgrep/imagemagick) + fd/magick shims
#   - GitHub CLI (gh) — present on GitHub-hosted runners; the coding-agent github
#     tool and release workflows expect it
#   - C/build toolchain the native + canvas builds need
#   - bun (system-wide, on PATH)
#   - rust nightly toolchain (pinned) + clippy/rustfmt + linux-arm64/windows-msvc targets
#
# Rebuild + reimport (see /root/omp-kata-runner.md) after bumping the ARGs below
# or the apt set. Keep the apt set in sync with .github/actions/setup-system-deps.
FROM ghcr.io/actions/actions-runner:latest

ARG RUST_NIGHTLY=nightly-2026-04-29
ARG BUN_VERSION=1.3.14

USER root
ENV DEBIAN_FRONTEND=noninteractive

# Mirrors the "Install system deps" block in .github/workflows/ci.yml plus the
# C/build toolchain (native + canvas builds) and the GitHub CLI. The gh apt repo
# is added first so `gh` installs in the same apt transaction.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y \
      build-essential pkg-config curl ca-certificates git unzip xz-utils zstd gh \
      libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
      fd-find ripgrep imagemagick \
 && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
 && ln -sf /usr/bin/convert /usr/local/bin/magick \
 && rm -rf /var/lib/apt/lists/*

# bun, system-wide (BUN_INSTALL/bin == /usr/local/bin, already on PATH).
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && bun --version

# rust toolchain for the runner user; rustup default == pinned nightly so
# dtolnay/rust-toolchain@nightly and target/component adds are no-ops in CI.
USER runner
ENV RUSTUP_HOME=/home/runner/.rustup \
    CARGO_HOME=/home/runner/.cargo \
    PATH=/home/runner/.cargo/bin:/usr/local/bin:${PATH}
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain "${RUST_NIGHTLY}" --profile minimal \
 && rustup component add clippy rustfmt \
 && rustup target add aarch64-unknown-linux-gnu x86_64-pc-windows-msvc \
 && cargo --version && rustc --version
