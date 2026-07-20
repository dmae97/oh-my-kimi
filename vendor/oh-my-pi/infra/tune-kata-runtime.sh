#!/usr/bin/env bash
# Patch the live Kata QEMU config on the CI host to match the runner pod's
# guaranteed boot shape and a larger virtiofsd worker pool, then smoke-test that
# a new kata-qemu pod still boots. Driven over SSH from this repo so the desired
# values stay version-controlled.
#
# Usage:
#   CI_HOST=my-ci-host ./infra/tune-kata-runtime.sh
#
# Env knobs:
#   CI_HOST                ssh target of the CI host                     (required)
#   KATA_CONFIG_REMOTE     remote Kata config file                       [/opt/kata/share/defaults/kata-containers/configuration-qemu.toml]
#   KUBECONFIG_REMOTE      kubeconfig path on the host                   [/etc/rancher/k3s/k3s.yaml]
#   ARC_RELEASE            runner scale set name                         [omp-kata]
#   ARC_NAMESPACE          runner namespace                              [arc-runners]
#   BOOT_VCPUS             Kata default_vcpus                            [2]
#   BOOT_MEMORY_MIB        Kata default_memory (MiB)                     [4096]
#   VIRTIOFSD_THREAD_POOL  virtiofsd --thread-pool-size                  [4]
set -euo pipefail

: "${CI_HOST:?set CI_HOST to the ssh target of your CI host, e.g. CI_HOST=my-ci-host}"
KATA_CONFIG_REMOTE="${KATA_CONFIG_REMOTE:-/opt/kata/share/defaults/kata-containers/configuration-qemu.toml}"
KUBECONFIG_REMOTE="${KUBECONFIG_REMOTE:-/etc/rancher/k3s/k3s.yaml}"
ARC_RELEASE="${ARC_RELEASE:-omp-kata}"
ARC_NAMESPACE="${ARC_NAMESPACE:-arc-runners}"
BOOT_VCPUS="${BOOT_VCPUS:-2}"
BOOT_MEMORY_MIB="${BOOT_MEMORY_MIB:-4096}"
VIRTIOFSD_THREAD_POOL="${VIRTIOFSD_THREAD_POOL:-4}"

ssh "$CI_HOST" bash -s -- \
  "$KATA_CONFIG_REMOTE" "$KUBECONFIG_REMOTE" "$ARC_RELEASE" "$ARC_NAMESPACE" \
  "$BOOT_VCPUS" "$BOOT_MEMORY_MIB" "$VIRTIOFSD_THREAD_POOL" <<'REMOTE'
set -euo pipefail
KATA_CONFIG="$1"
export KUBECONFIG="$2"
ARC_RELEASE="$3"
ARC_NAMESPACE="$4"
BOOT_VCPUS="$5"
BOOT_MEMORY_MIB="$6"
THREAD_POOL="$7"

backup="${KATA_CONFIG}.bak.$(date +%Y%m%d-%H%M%S)"
cp "$KATA_CONFIG" "$backup"
echo "==> backup: $backup"

python3 - "$KATA_CONFIG" "$BOOT_VCPUS" "$BOOT_MEMORY_MIB" "$THREAD_POOL" <<'PY'
from pathlib import Path
import re
import sys
path = Path(sys.argv[1])
boot_vcpus = sys.argv[2]
boot_mem = sys.argv[3]
thread_pool = sys.argv[4]
text = path.read_text()
replacements = [
    (r'(^\s*default_vcpus\s*=\s*)\d+', rf'\g<1>{boot_vcpus}'),
    (r'(^\s*default_memory\s*=\s*)\d+', rf'\g<1>{boot_mem}'),
    (r'(^\s*virtio_fs_extra_args\s*=\s*)\[[^\]]*\]', rf'\g<1>["--thread-pool-size={thread_pool}", "--announce-submounts"]'),
]
for pattern, replacement in replacements:
    text, n = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if n != 1:
        raise SystemExit(f"failed to patch {pattern}")
path.write_text(text)
PY

echo "==> active Kata knobs"
grep -nE 'default_vcpus|default_memory|virtio_fs_extra_args' "$KATA_CONFIG"

image="$(kubectl get autoscalingrunnerset "$ARC_RELEASE" -n "$ARC_NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}')"
pod="kata-runtime-smoke-$(date +%H%M%S)"
trap 'kubectl delete pod "$pod" -n "$ARC_NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true' EXIT

echo "==> smoke boot via kata-qemu using $image"
kubectl run "$pod" -n "$ARC_NAMESPACE" --restart=Never --image="$image" \
  --overrides='{"spec":{"runtimeClassName":"kata-qemu"}}' \
  --command -- bash -lc 'sleep 120' >/dev/null
kubectl wait --for=condition=Ready "pod/$pod" -n "$ARC_NAMESPACE" --timeout=120s >/dev/null
kubectl exec -n "$ARC_NAMESPACE" "$pod" -- bash -lc 'bun --version; rustc --version | head -1'
echo "OK: kata-qemu still boots after tuning"
REMOTE
