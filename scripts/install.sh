#!/usr/bin/env sh
# ─── OMK Installer ──────────────────────────────────────────────────────────
# https://get.omk.dev/install.sh
#
# Usage:
#   curl -fsSL https://get.omk.dev | sh
#   curl -fsSL https://get.omk.dev | sh -s -- --channel stable
#   curl -fsSL https://get.omk.dev | sh -s -- --channel beta
#   curl -fsSL https://get.omk.dev | sh -s -- --no-telemetry
#
# Environment:
#   OMK_INSTALL_DIR  — installation directory (default: ~/.omk/bin)
#   OMK_CHANNEL      — release channel: stable|beta (default: stable)
#   OMK_BASE_URL     — base URL for downloads (default: https://get.omk.dev)
# ─────────────────────────────────────────────────────────────────────────────

set -eu

OMK_INSTALL_DIR="${OMK_INSTALL_DIR:-$HOME/.omk/bin}"
OMK_CHANNEL="${OMK_CHANNEL:-stable}"
OMK_BASE_URL="${OMK_BASE_URL:-https://get.omk.dev}"
OMK_NO_TELEMETRY="${OMK_NO_TELEMETRY:-}"

# ── Parse args ──────────────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --channel=*)  OMK_CHANNEL="${arg#*=}" ;;
    --channel)    shift ;; # next arg is value
    --no-telemetry) OMK_NO_TELEMETRY=1 ;;
    --help|-h)
      echo "OMK Installer"
      echo ""
      echo "Usage: install.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --channel=stable|beta   Release channel (default: stable)"
      echo "  --no-telemetry          Disable anonymous usage metrics"
      echo "  --help                  Show this help"
      echo ""
      echo "Environment:"
      echo "  OMK_INSTALL_DIR   Installation directory (default: ~/.omk/bin)"
      echo "  OMK_CHANNEL       Release channel (default: stable)"
      echo "  OMK_BASE_URL      Base URL (default: https://get.omk.dev)"
      exit 0
      ;;
  esac
done

# ── Helpers ─────────────────────────────────────────────────────────────────

info()  { printf "\033[1;36m→\033[0m %s\n" "$1"; }
ok()    { printf "\033[1;32m✓\033[0m %s\n" "$1"; }
warn()  { printf "\033[1;33m⚠\033[0m %s\n" "$1" >&2; }
err()   { printf "\033[1;31m✗\033[0m %s\n" "$1" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "Required command not found: $1"
}

# ── Detect platform ─────────────────────────────────────────────────────────

detect_platform() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$arch" in
    x86_64|amd64)  arch="x86_64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *) err "Unsupported architecture: $arch" ;;
  esac

  case "$os" in
    linux)  target="${arch}-unknown-linux-gnu" ;;
    darwin) target="${arch}-apple-darwin" ;;
    *)      err "Unsupported OS: $os. Windows: use 'irm https://get.omk.dev/install.ps1 | iex'" ;;
  esac

  echo "$target"
}

# ── Main ────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo "  ╭────────────────────────────────────────╮"
  echo "  │  OMK — Project-aware AI coding runtime  │"
  echo "  ╰────────────────────────────────────────╯"
  echo ""

  need_cmd curl
  need_cmd uname
  need_cmd tar
  need_cmd mkdir
  need_cmd install

  target="$(detect_platform)"
  info "Platform: $target"
  info "Channel:  $OMK_CHANNEL"
  info "Install:  $OMK_INSTALL_DIR"

  # Create install directory
  mkdir -p "$OMK_INSTALL_DIR"

  # Download archive
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  archive_url="$OMK_BASE_URL/releases/$OMK_CHANNEL/omk-$target.tar.gz"
  archive="$tmpdir/omk.tar.gz"

  info "Downloading $archive_url ..."
  if ! curl -fsSL "$archive_url" -o "$archive" 2>/dev/null; then
    # Fallback: try npm for global install
    warn "Direct download not available. Falling back to npm..."
    if command -v npm >/dev/null 2>&1; then
      info "Installing via npm..."
      npm install -g open-multi-agent-kit 2>/dev/null || err "npm install failed"
      ok "OMK installed via npm"
      echo ""
      echo "  Run: omk doctor"
      echo ""
      return 0
    fi
    err "Download failed and npm not available. See https://omk.dev/install"
  fi

  # Verify checksum (if checksums.txt available)
  checksums_url="$OMK_BASE_URL/releases/$OMK_CHANNEL/checksums.txt"
  if curl -fsSL "$checksums_url" -o "$tmpdir/checksums.txt" 2>/dev/null; then
    expected="$(grep "omk-$target.tar.gz" "$tmpdir/checksums.txt" 2>/dev/null | cut -d' ' -f1 || true)"
    if [ -n "$expected" ]; then
      actual="$(sha256sum "$archive" | cut -d' ' -f1)"
      if [ "$expected" = "$actual" ]; then
        ok "Checksum verified"
      else
        err "Checksum mismatch! Expected: $expected Got: $actual"
      fi
    else
      warn "No checksum entry for omk-$target.tar.gz — skipping verification"
    fi
  else
    warn "Checksums not available — skipping verification"
  fi

  # Extract and install
  info "Extracting..."
  tar -xzf "$archive" -C "$tmpdir"

  if [ ! -f "$tmpdir/omk" ]; then
    # Try nested directory
    nested="$(find "$tmpdir" -name "omk" -type f 2>/dev/null | head -1)"
    if [ -n "$nested" ]; then
      install -m 0755 "$nested" "$OMK_INSTALL_DIR/omk"
    else
      err "omk binary not found in archive"
    fi
  else
    install -m 0755 "$tmpdir/omk" "$OMK_INSTALL_DIR/omk"
  fi

  ok "OMK installed to $OMK_INSTALL_DIR/omk"

  # PATH guidance
  case ":$PATH:" in
    *":$OMK_INSTALL_DIR:"*) ;;
    *)
      echo ""
      warn "OMK is not in your PATH."
      echo ""
      echo "  Add this to your shell profile:"
      echo ""
      # Detect shell
      shell_name="$(basename "${SHELL:-/bin/sh}")"
      case "$shell_name" in
        zsh)  echo "    echo 'export PATH=\"$OMK_INSTALL_DIR:\$PATH\"' >> ~/.zshrc" ;;
        fish) echo "    fish_add_path $OMK_INSTALL_DIR" ;;
        *)    echo "    echo 'export PATH=\"$OMK_INSTALL_DIR:\$PATH\"' >> ~/.bashrc" ;;
      esac
      echo ""
      echo "  Or run directly:"
      echo "    $OMK_INSTALL_DIR/omk doctor"
      echo ""
      ;;
  esac

  # First-run doctor
  echo ""
  info "Running omk doctor..."
  if "$OMK_INSTALL_DIR/omk" doctor 2>/dev/null; then
    ok "OMK is ready"
  else
    warn "omk doctor had warnings — this is normal for first install"
  fi

  # Telemetry opt-out
  if [ -n "$OMK_NO_TELEMETRY" ]; then
    mkdir -p "$HOME/.omk"
    echo '{"telemetry":false}' > "$HOME/.omk/config.json"
    ok "Telemetry disabled"
  fi

  echo ""
  echo "  ╭────────────────────────────────────╮"
  echo "  │  Next steps:                        │"
  echo "  │                                     │"
  echo "  │  omk init      — set up project     │"
  echo "  │  omk           — start coding       │"
  echo "  │  omk consent   — privacy settings   │"
  echo "  ╰────────────────────────────────────╯"
  echo ""
}

main "$@"