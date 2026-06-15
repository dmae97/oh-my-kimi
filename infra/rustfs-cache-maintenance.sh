#!/usr/bin/env bash
# Report/prune Bun cache objects in the shared RustFS bucket and alert on PVC
# pressure. The script runs on the CI host over SSH because the RustFS endpoint
# and the S3 credentials live there (inside k8s secrets).
#
# Modes:
#   report   list usage + object summary, exit 1/2 on warn/critical thresholds
#   prune    delete stale exact-lockfile Bun cache objects, then report/alert
#
# Usage:
#   CI_HOST=my-ci-host ./infra/rustfs-cache-maintenance.sh report
#   CI_HOST=my-ci-host ./infra/rustfs-cache-maintenance.sh prune
#
# Env knobs:
#   CI_HOST                  ssh target of the CI host                    (required)
#   KUBECONFIG_REMOTE        kubeconfig path on the host                  [/etc/rancher/k3s/k3s.yaml]
#   SECRET_NAMESPACE         namespace of sccache-s3 secret               [arc-runners]
#   SECRET_NAME              secret with RustFS client creds              [sccache-s3]
#   RUSTFS_NAMESPACE         namespace of the RustFS deployment           [sccache]
#   RUSTFS_DEPLOYMENT        deployment name of RustFS                    [rustfs]
#   CACHE_PREFIX             Bun cache prefix inside the bucket           [bun-cache/]
#   MAX_AGE_DAYS             keep exact-lock objects newer than this      [30]
#   KEEP_EXACT_PER_OS        always keep this many exact objects per OS   [3]
#   PRUNE_TRIGGER_PERCENT    if PVC >= this %, prune oldest extra caches  [80]
#   TARGET_PERCENT           when above trigger, prune toward this %      [70]
#   WARN_PERCENT             report warning exit code at/above this %     [80]
#   CRITICAL_PERCENT         report critical exit code at/above this %    [90]
#   DRY_RUN                  true = print deletes but do not delete       [false]
set -euo pipefail

: "${CI_HOST:?set CI_HOST to the ssh target of your CI host, e.g. CI_HOST=my-ci-host}"
mode="${1:-report}"
case "$mode" in report|prune) ;; *) echo "usage: $0 report|prune" >&2; exit 2 ;; esac

KUBECONFIG_REMOTE="${KUBECONFIG_REMOTE:-/etc/rancher/k3s/k3s.yaml}"
SECRET_NAMESPACE="${SECRET_NAMESPACE:-arc-runners}"
SECRET_NAME="${SECRET_NAME:-sccache-s3}"
RUSTFS_NAMESPACE="${RUSTFS_NAMESPACE:-sccache}"
RUSTFS_DEPLOYMENT="${RUSTFS_DEPLOYMENT:-rustfs}"
CACHE_PREFIX="${CACHE_PREFIX:-bun-cache/}"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-30}"
KEEP_EXACT_PER_OS="${KEEP_EXACT_PER_OS:-3}"
PRUNE_TRIGGER_PERCENT="${PRUNE_TRIGGER_PERCENT:-80}"
TARGET_PERCENT="${TARGET_PERCENT:-70}"
WARN_PERCENT="${WARN_PERCENT:-80}"
CRITICAL_PERCENT="${CRITICAL_PERCENT:-90}"
DRY_RUN="${DRY_RUN:-false}"

ssh "$CI_HOST" bash -s -- \
  "$mode" "$KUBECONFIG_REMOTE" "$SECRET_NAMESPACE" "$SECRET_NAME" "$RUSTFS_NAMESPACE" "$RUSTFS_DEPLOYMENT" \
  "$CACHE_PREFIX" "$MAX_AGE_DAYS" "$KEEP_EXACT_PER_OS" "$PRUNE_TRIGGER_PERCENT" "$TARGET_PERCENT" \
  "$WARN_PERCENT" "$CRITICAL_PERCENT" "$DRY_RUN" <<'REMOTE'
set -euo pipefail
MODE="$1"
export KUBECONFIG="$2"
SECRET_NAMESPACE="$3"
SECRET_NAME="$4"
RUSTFS_NAMESPACE="$5"
RUSTFS_DEPLOYMENT="$6"
CACHE_PREFIX="$7"
MAX_AGE_DAYS="$8"
KEEP_EXACT_PER_OS="$9"
PRUNE_TRIGGER_PERCENT="${10}"
TARGET_PERCENT="${11}"
WARN_PERCENT="${12}"
CRITICAL_PERCENT="${13}"
DRY_RUN="${14}"

ACCESS_KEY="$(kubectl get secret "$SECRET_NAME" -n "$SECRET_NAMESPACE" -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d)"
SECRET_KEY="$(kubectl get secret "$SECRET_NAME" -n "$SECRET_NAMESPACE" -o jsonpath='{.data.AWS_SECRET_ACCESS_KEY}' | base64 -d)"
BUCKET="$(kubectl get secret "$SECRET_NAME" -n "$SECRET_NAMESPACE" -o jsonpath='{.data.SCCACHE_BUCKET}' | base64 -d)"
ENDPOINT="$(kubectl get secret "$SECRET_NAME" -n "$SECRET_NAMESPACE" -o jsonpath='{.data.SCCACHE_ENDPOINT}' | base64 -d)"
REGION="$(kubectl get secret "$SECRET_NAME" -n "$SECRET_NAMESPACE" -o jsonpath='{.data.SCCACHE_REGION}' | base64 -d)"
USE_SSL="$(kubectl get secret "$SECRET_NAME" -n "$SECRET_NAMESPACE" -o jsonpath='{.data.SCCACHE_S3_USE_SSL}' | base64 -d)"
if [ "$USE_SSL" = "true" ]; then SCHEME=https; else SCHEME=http; fi

# The secret intentionally stores the in-cluster Service DNS because runner pods
# consume it. This host-side maintenance script runs outside cluster DNS, so talk
# to the same Service by ClusterIP instead when the endpoint points at `.svc`.
if [[ "$ENDPOINT" == *.svc.*:* || "$ENDPOINT" == *.svc:* ]]; then
  svc_ip="$(kubectl get svc "$RUSTFS_DEPLOYMENT" -n "$RUSTFS_NAMESPACE" -o jsonpath='{.spec.clusterIP}')"
  svc_port="${ENDPOINT##*:}"
  ENDPOINT="${svc_ip}:${svc_port}"
fi

usage_line() {
  kubectl exec -n "$RUSTFS_NAMESPACE" deploy/"$RUSTFS_DEPLOYMENT" -- df -P /data | tail -1
}

before="$(usage_line)"
TOTAL_KIB="$(awk '{print $2}' <<<"$before")"
USED_KIB="$(awk '{print $3}' <<<"$before")"
AVAIL_KIB="$(awk '{print $4}' <<<"$before")"
USED_PCT_RAW="$(awk '{print $5}' <<<"$before")"
USED_PCT="${USED_PCT_RAW%%%}"

echo "==> RustFS PVC before"
echo "$before"

summary="$(python3 - "$MODE" "$SCHEME" "$ENDPOINT" "$BUCKET" "$REGION" "$ACCESS_KEY" "$SECRET_KEY" "$CACHE_PREFIX" "$MAX_AGE_DAYS" "$KEEP_EXACT_PER_OS" "$PRUNE_TRIGGER_PERCENT" "$TARGET_PERCENT" "$DRY_RUN" "$TOTAL_KIB" "$USED_KIB" "$USED_PCT" <<'PY'
from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import json
import re
import subprocess
import sys
import urllib.parse
import xml.etree.ElementTree as ET

mode, scheme, endpoint, bucket, region, access, secret, prefix, max_age_days, keep_per_os, prune_trigger, target_pct, dry_run, total_kib, used_kib, used_pct = sys.argv[1:]
max_age_days = int(max_age_days)
keep_per_os = int(keep_per_os)
prune_trigger = int(prune_trigger)
target_pct = int(target_pct)
dry_run = dry_run.lower() == "true"
total_kib = int(total_kib)
used_kib = int(used_kib)
used_pct = int(used_pct)

prefix = prefix.rstrip("/") + "/"
base = f"{scheme}://{endpoint}/{bucket}"
now = datetime.now(timezone.utc)
cutoff = now - timedelta(days=max_age_days)


def curl(method: str, url: str, extra: list[str] | None = None) -> str:
    cmd = [
        "curl", "-fsS",
        "--aws-sigv4", f"aws:amz:{region}:s3",
        "--user", f"{access}:{secret}",
        "-X", method,
    ]
    if extra:
        cmd.extend(extra)
    cmd.append(url)
    return subprocess.check_output(cmd, text=True)


def list_objects() -> list[dict]:
    objs: list[dict] = []
    token = None
    while True:
        q = {"list-type": "2", "prefix": prefix}
        if token:
            q["continuation-token"] = token
        url = f"{base}/?{urllib.parse.urlencode(q)}"
        root = ET.fromstring(curl("GET", url))
        for node in root.findall(".//{*}Contents"):
            objs.append({
                "key": node.findtext("{*}Key", default=""),
                "size": int(node.findtext("{*}Size", default="0")),
                "etag": node.findtext("{*}ETag", default="").strip('"'),
                "last_modified": datetime.fromisoformat(node.findtext("{*}LastModified", default="1970-01-01T00:00:00+00:00")),
            })
        token = root.findtext(".//{*}NextContinuationToken")
        if not token:
            return objs


def human(n: int) -> str:
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    value = float(n)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.1f}{unit}"
        value /= 1024
    return f"{n}B"

objs = list_objects()
exact_re = re.compile(rf"^{re.escape(prefix)}(store|nm)-([^-]+)-([0-9a-f]{{32}})\.(tzst|tgz)$")
latest_re = re.compile(rf"^{re.escape(prefix)}store-([^-]+)-latest\.(tzst|tgz)$")

exacts: list[dict] = []
latest_aliases: list[dict] = []
other_prefix: list[dict] = []
for obj in objs:
    if m := exact_re.match(obj["key"]):
        obj = obj | {"kind": m.group(1), "os": m.group(2), "lock": m.group(3), "codec": m.group(4)}
        exacts.append(obj)
    elif m := latest_re.match(obj["key"]):
        obj = obj | {"kind": "store", "os": m.group(1), "lock": "latest", "codec": m.group(2)}
        latest_aliases.append(obj)
    else:
        other_prefix.append(obj)

protected = {obj["key"] for obj in latest_aliases}
by_group: dict[tuple[str, str], list[dict]] = defaultdict(list)
by_store_etag: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
for obj in exacts:
    by_group[(obj["kind"], obj["os"])] .append(obj)
    if obj["kind"] == "store":
        by_store_etag[(obj["os"], obj["codec"], obj["etag"])] .append(obj)

for alias in latest_aliases:
    matches = by_store_etag.get((alias["os"], alias["codec"], alias["etag"]), [])
    if matches:
        newest = max(matches, key=lambda o: o["last_modified"])
        protected.add(newest["key"])

for group, items in by_group.items():
    items.sort(key=lambda o: o["last_modified"], reverse=True)
    for obj in items[:keep_per_os]:
        protected.add(obj["key"])
    for obj in items:
        if obj["last_modified"] >= cutoff:
            protected.add(obj["key"])

eligible = [obj for obj in exacts if obj["key"] not in protected]
eligible.sort(key=lambda o: o["last_modified"])
aged = [obj for obj in eligible if obj["last_modified"] < cutoff]

selected: list[dict] = list(aged)
selected_keys = {obj["key"] for obj in selected}
need_reclaim_kib = max(0, used_kib - (total_kib * target_pct // 100)) if used_pct >= prune_trigger else 0
reclaimed_kib = sum(obj["size"] // 1024 for obj in selected)
if need_reclaim_kib > reclaimed_kib:
    for obj in eligible:
        if obj["key"] in selected_keys:
            continue
        selected.append(obj)
        selected_keys.add(obj["key"])
        reclaimed_kib += obj["size"] // 1024
        if reclaimed_kib >= need_reclaim_kib:
            break

selected.sort(key=lambda o: (o["kind"], o["os"], o["last_modified"], o["key"]))
delete_total = sum(obj["size"] for obj in selected)

print(f"bun-cache objects: exact={len(exacts)} latest={len(latest_aliases)} other-prefix={len(other_prefix)} total={human(sum(o['size'] for o in objs))}")
print(f"policy: max_age_days={max_age_days} keep_exact_per_os={keep_per_os} prune_trigger={prune_trigger}% target={target_pct}%")
print(f"eligible exact objects: {len(eligible)} | selected for deletion: {len(selected)} | reclaimable: {human(delete_total)}")
for obj in selected[:20]:
    age_days = int((now - obj['last_modified']).total_seconds() // 86400)
    print(f"  delete {obj['key']}  age={age_days}d size={human(obj['size'])}")
if len(selected) > 20:
    print(f"  ... {len(selected) - 20} more")

if mode == "prune":
    for obj in selected:
        if dry_run:
            continue
        curl("DELETE", f"{base}/{obj['key']}")

print("JSON_SUMMARY=" + json.dumps({
    "exact": len(exacts),
    "latest": len(latest_aliases),
    "other": len(other_prefix),
    "eligible": len(eligible),
    "selected": len(selected),
    "delete_bytes": delete_total,
    "dry_run": dry_run,
}))
PY
)"

echo "$summary"

after="$(usage_line)"
AFTER_USED_PCT_RAW="$(awk '{print $5}' <<<"$after")"
AFTER_USED_PCT="${AFTER_USED_PCT_RAW%%%}"

echo "==> RustFS PVC after"
echo "$after"

if [ "$AFTER_USED_PCT" -ge "$CRITICAL_PERCENT" ]; then
  echo "CRITICAL: rustfs-data usage ${AFTER_USED_PCT}% >= ${CRITICAL_PERCENT}%" >&2
  exit 2
fi
if [ "$AFTER_USED_PCT" -ge "$WARN_PERCENT" ]; then
  echo "WARNING: rustfs-data usage ${AFTER_USED_PCT}% >= ${WARN_PERCENT}%" >&2
  exit 1
fi

echo "OK: rustfs-data usage ${AFTER_USED_PCT}%"
REMOTE
