#!/usr/bin/env bash
# Resolve PI_ROOT to a usable oh-my-pi checkout, then `exec "$@"` with it
# exported. Falls back to cloning the upstream repo into a local cache when
# neither the explicit PI_ROOT nor /work/pi contains a checkout.
#
# Resolution order (first hit wins):
#   1. $PI_ROOT (when set and points at a pi tree)
#   2. /work/pi (the legacy hardcoded location)
#   3. $ROBOMP_PI_CACHE_DIR (default: <repo>/.cache/oh-my-pi); cloned on demand
#
# Knobs (env):
#   PI_ROOT                 preferred checkout path
#   ROBOMP_PI_REPO_URL      upstream clone URL (default: github.com/can1357/oh-my-pi)
#   ROBOMP_PI_REF           git ref to clone   (default: main)
#   ROBOMP_PI_CACHE_DIR     clone destination  (default: <repo>/.cache/oh-my-pi)
#   ROBOMP_PI_AUTO_UPDATE   when 1, `git fetch && reset --hard` the cache on
#                           every invocation if it's already populated
#
# Usage:
#   scripts/with-pi-root.sh <cmd> [args…]
#   scripts/with-pi-root.sh bash -c 'docker build … "$PI_ROOT"'

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

explicit_pi_root="${PI_ROOT:-}"
default_pi_root="${ROBOMP_PI_DEFAULT_PATH:-/work/pi}"
cache_dir="${ROBOMP_PI_CACHE_DIR:-$repo_root/.cache/oh-my-pi}"
repo_url="${ROBOMP_PI_REPO_URL:-https://github.com/can1357/oh-my-pi.git}"
repo_ref="${ROBOMP_PI_REF:-main}"

is_pi_checkout() {
    [ -n "${1:-}" ] && [ -d "$1/packages/coding-agent" ]
}

if is_pi_checkout "$explicit_pi_root"; then
    resolved="$explicit_pi_root"
elif [ -n "$explicit_pi_root" ] && [ "$explicit_pi_root" != "$default_pi_root" ]; then
    echo "roboomp: PI_ROOT=$explicit_pi_root is not an oh-my-pi checkout; falling back" >&2
    resolved=""
else
    resolved=""
fi

if [ -z "$resolved" ]; then
    if is_pi_checkout "$default_pi_root"; then
        resolved="$default_pi_root"
    elif is_pi_checkout "$cache_dir"; then
        resolved="$cache_dir"
        if [ "${ROBOMP_PI_AUTO_UPDATE:-0}" = "1" ]; then
            echo "roboomp: updating $cache_dir (ROBOMP_PI_AUTO_UPDATE=1)" >&2
            git -C "$cache_dir" fetch --depth=1 origin "$repo_ref" >&2
            git -C "$cache_dir" reset --hard FETCH_HEAD >&2
        fi
    else
        echo "roboomp: cloning $repo_url@$repo_ref into $cache_dir (set PI_ROOT to skip)" >&2
        mkdir -p "$(dirname "$cache_dir")"
        rm -rf "$cache_dir"
        git clone --depth=1 --branch "$repo_ref" "$repo_url" "$cache_dir" >&2
        if ! is_pi_checkout "$cache_dir"; then
            echo "roboomp: clone of $repo_url produced no packages/coding-agent/ tree" >&2
            exit 1
        fi
        resolved="$cache_dir"
    fi
fi

export PI_ROOT="$resolved"
echo "roboomp: PI_ROOT=$PI_ROOT" >&2

exec "$@"
