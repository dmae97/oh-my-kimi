#!/usr/bin/env bash
# Build + roll the preloaded omp-kata runner image onto the self-hosted CI host,
# driven over SSH from this repo. The Dockerfile next to this script is the
# source of truth: it is copied to the host, built there, imported into k3s
# containerd, and the ARC runner scale set is pointed at the new tag and rolled.
#
# The host is intentionally NOT hardcoded (this repo is public). Set CI_HOST to
# your ssh target; the remaining knobs default to the reference deployment.
#
# Usage:
#   CI_HOST=my-ci-host ./infra/reload-runner.sh                # tag: omp-kata-runner:YYYY-MM-DD-HHMMSS
#   CI_HOST=my-ci-host ./infra/reload-runner.sh 2026-06-20     # tag: omp-kata-runner:2026-06-20
#   CI_HOST=my-ci-host ./infra/reload-runner.sh my/repo:tag    # explicit repo:tag
#
# Env knobs (defaults match the reference deployment):
#   CI_HOST            ssh target of the CI host                    (required)
#   REMOTE_CTX         remote build dir for the Dockerfile          [/root/omp-kata-runner-image]
#   ARC_VALUES         remote ARC scale-set helm values file        [/root/arc-omp-values.yaml]
#   ARC_RELEASE        helm release name of the runner scale set    [omp-kata]
#   ARC_NAMESPACE      namespace the runner scale set lives in       [arc-runners]
#   ARC_CHART_VERSION  gha-runner-scale-set chart version           [0.14.2]
#   KUBECONFIG_REMOTE  kubeconfig path on the host                  [/etc/rancher/k3s/k3s.yaml]
set -euo pipefail

: "${CI_HOST:?set CI_HOST to the ssh target of your CI host, e.g. CI_HOST=my-ci-host}"
REMOTE_CTX="${REMOTE_CTX:-/root/omp-kata-runner-image}"
ARC_VALUES="${ARC_VALUES:-/root/arc-omp-values.yaml}"
ARC_RELEASE="${ARC_RELEASE:-omp-kata}"
ARC_NAMESPACE="${ARC_NAMESPACE:-arc-runners}"
ARC_CHART_VERSION="${ARC_CHART_VERSION:-0.14.2}"
KUBECONFIG_REMOTE="${KUBECONFIG_REMOTE:-/etc/rancher/k3s/k3s.yaml}"

arg="${1:-$(date +%Y-%m-%d-%H%M%S)}"
case "$arg" in *:*) IMAGE="$arg";; *) IMAGE="omp-kata-runner:$arg";; esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/runner.Dockerfile" ] || { echo "no runner.Dockerfile next to $0" >&2; exit 1; }

echo "==> [0/5] copying Dockerfile to ${CI_HOST}:${REMOTE_CTX}"
ssh "$CI_HOST" "mkdir -p '$REMOTE_CTX'"
scp -q "$here/runner.Dockerfile" "${CI_HOST}:${REMOTE_CTX}/Dockerfile"

# All build/import/rollout steps run on the host. Config is passed as positional
# args (no secrets, no spaces) so it survives the ssh command-string re-parse
# regardless of the host's login shell.
ssh "$CI_HOST" bash -s -- \
   "$IMAGE" "$REMOTE_CTX" "$ARC_VALUES" "$ARC_RELEASE" "$ARC_NAMESPACE" "$ARC_CHART_VERSION" "$KUBECONFIG_REMOTE" <<'REMOTE'
set -euo pipefail
IMAGE="$1"; REMOTE_CTX="$2"; ARC_VALUES="$3"; ARC_RELEASE="$4"; ARC_NAMESPACE="$5"; ARC_CHART_VERSION="$6"
export KUBECONFIG="$7"
cd "$REMOTE_CTX"

echo "==> [1/5] building $IMAGE"
DOCKER_BUILDKIT=1 docker build -t "$IMAGE" -t omp-kata-runner:preloaded .

echo "==> [2/5] verifying baked tools"
docker run --rm --entrypoint bash "$IMAGE" -lc '
  set -e
  for b in gh fd rg magick bun cargo rustc pkg-config zstd; do
    command -v "$b" >/dev/null || { echo "MISSING: $b"; exit 1; }
  done
  echo "tools OK | $(bun --version) | $(rustc --version) | gh $(gh --version | head -1 | cut -d" " -f3)"
'

echo "==> [3/5] importing into k3s containerd (k8s.io namespace)"
docker save "$IMAGE" | k3s ctr -n k8s.io images import --platform linux/amd64 -

echo "==> [4/5] pointing ARC runner scale set at $IMAGE"
sed -i "s#image: omp-kata-runner:.*#image: $IMAGE#" "$ARC_VALUES"
helm upgrade "$ARC_RELEASE" --namespace "$ARC_NAMESPACE" --version "$ARC_CHART_VERSION" \
  -f "$ARC_VALUES" \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set >/dev/null

echo "==> [5/5] verifying rollout"
live="$(kubectl get autoscalingrunnerset "$ARC_RELEASE" -n "$ARC_NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].image}')"
echo "ARC runner image is now: $live"
[ "$live" = "$IMAGE" ] && echo "OK: reloaded $IMAGE" || { echo "MISMATCH: expected $IMAGE"; exit 1; }
REMOTE

echo "OK: $IMAGE built on ${CI_HOST}, imported into k3s, and rolled out to ARC."
