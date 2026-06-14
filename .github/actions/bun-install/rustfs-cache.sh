#!/usr/bin/env bash
# Shared bun dependency cache backed by the in-cluster RustFS (S3) object store.
#
# Used by .github/actions/bun-install on the self-hosted omp-kata runners. There
# the stock `actions/cache` restore of ~/.bun/install/cache costs 130-186s per
# job because GitHub's cache backend is only reachable over the node's NAT
# egress, and ~9 jobs contend on it at once. RustFS lives in the same k3s node
# (svc :9000, already allowed by the runner egress NetworkPolicy), so the same
# payload moves at LAN speed.
#
# Credentials are the ones sccache already gets via the `sccache-s3` secret
# (envFrom on every runner pod): AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
# SCCACHE_ENDPOINT / SCCACHE_BUCKET / SCCACHE_REGION / SCCACHE_S3_USE_SSL.
#
# Two objects per lockfile, under the bun-cache/ key prefix of the sccache
# bucket:
#   store-<os>-<lockhash>   the bun global package store (~/.bun/install/cache)
#   nm-<os>-<lockhash>      the installed node_modules trees (root + workspaces)
# The store additionally publishes a rolling store-<os>-latest alias, so a
# changed lockfile still warm-starts from the previous store and `bun install`
# only fetches the delta. A node_modules hit short-circuits everything: the
# subsequent `bun install --frozen-lockfile` is a no-op, so the store is neither
# fetched nor saved.
set -euo pipefail

mode="${1:?usage: rustfs-cache.sh restore|save}"

: "${SCCACHE_BUCKET:?SCCACHE_BUCKET required}"
: "${SCCACHE_ENDPOINT:?SCCACHE_ENDPOINT required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY required}"

region="${SCCACHE_REGION:-us-east-1}"
if [ "${SCCACHE_S3_USE_SSL:-false}" = "true" ]; then scheme=https; else scheme=http; fi
base="${scheme}://${SCCACHE_ENDPOINT}/${SCCACHE_BUCKET}/bun-cache"
os="${RUNNER_OS:-$(uname -s)}"
store_dir="${BUN_INSTALL_CACHE_DIR:-${HOME}/.bun/install/cache}"
work="${RUNNER_TEMP:-/tmp}/bun-rustfs-cache"
mkdir -p "$work"

# Prefer multi-threaded zstd (baked into the omp-kata runner image); fall back to
# gzip so the action still works on an image that predates the zstd addition. The
# object suffix records the codec, and restore only inflates archives this host
# can actually decompress.
if command -v zstd >/dev/null 2>&1; then
   tar_c=(-I "zstd -3 -T0"); ext="tzst"; alt_ext="tgz"
else
   tar_c=(-I "gzip -6"); ext="tgz"; alt_ext="tzst"
fi

lock_hash="$(sha256sum bun.lock | cut -c1-32)"
store_key="store-${os}-${lock_hash}"
store_latest="store-${os}-latest"
nm_key="nm-${os}-${lock_hash}"

auth=(--aws-sigv4 "aws:amz:${region}:s3" --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}")
# 404 (-f) and connection errors are non-zero; transient errors retry, 4xx do not.
s3_get()    { curl -fsS --retry 3 --retry-connrefused "${auth[@]}" "${base}/$1" -o "$2"; }
s3_exists() { curl -fsS -I --retry 3 --retry-connrefused "${auth[@]}" "${base}/$1" -o /dev/null >/dev/null 2>&1; }
s3_put()    { curl -fsS --retry 3 --retry-connrefused "${auth[@]}" -T "$2" "${base}/$1" -o /dev/null; }

# Download <name>.<ext> (then the alternate codec) and extract into dir $2.
# tar auto-detects the codec from the archive; a present-but-uninflatable archive
# (codec mismatch with this host) is treated as a miss.
fetch_extract() { # name dest
   local name="$1" dest="$2" e f
   for e in "$ext" "$alt_ext"; do
      f="${work}/${name}.${e}"
      if s3_get "${name}.${e}" "$f" 2>/dev/null; then
         mkdir -p "$dest"
         if tar -xf "$f" -C "$dest" 2>/dev/null; then rm -f "$f"; return 0; fi
         rm -f "$f"
      fi
   done
   return 1
}

case "$mode" in
restore)
   if fetch_extract "$nm_key" "$PWD"; then
      echo "bun cache: node_modules HIT ($nm_key) — install becomes a no-op"
      : > "${work}/nm_hit"
      exit 0
   fi
   echo "bun cache: node_modules miss ($nm_key)"
   if fetch_extract "$store_key" "$store_dir"; then
      echo "bun cache: store HIT ($store_key)"
   elif fetch_extract "$store_latest" "$store_dir"; then
      echo "bun cache: store warm-start ($store_latest)"
   else
      echo "bun cache: store miss — cold install"
   fi
   ;;
save)
   if [ -f "${work}/nm_hit" ]; then
      echo "bun cache: node_modules was a hit — nothing to save"
      exit 0
   fi
   # Store (+ rolling latest): save when this exact lockfile has none yet.
   if [ -d "$store_dir" ] && ! s3_exists "${store_key}.${ext}"; then
      tar "${tar_c[@]}" -cf "${work}/store.${ext}" -C "$store_dir" .
      s3_put "${store_key}.${ext}" "${work}/store.${ext}"
      s3_put "${store_latest}.${ext}" "${work}/store.${ext}"
      rm -f "${work}/store.${ext}"
      echo "bun cache: saved store ($store_key + $store_latest)"
   fi
   # node_modules: save the installed trees for this exact lockfile.
   if ! s3_exists "${nm_key}.${ext}"; then
      shopt -s nullglob
      nm_paths=(node_modules packages/*/node_modules python/robomp/web/node_modules)
      if [ ${#nm_paths[@]} -gt 0 ]; then
         tar "${tar_c[@]}" -cf "${work}/nm.${ext}" "${nm_paths[@]}"
         s3_put "${nm_key}.${ext}" "${work}/nm.${ext}"
         rm -f "${work}/nm.${ext}"
         echo "bun cache: saved node_modules ($nm_key, ${#nm_paths[@]} trees)"
      fi
   fi
   ;;
*)
   echo "rustfs-cache.sh: unknown mode '$mode' (want restore|save)" >&2
   exit 2
   ;;
esac
