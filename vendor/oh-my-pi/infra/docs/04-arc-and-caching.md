# 04 - ARC runners, shared caches, and egress policy

This is the last setup step. By now the node runs k3s with the `kata-qemu`
RuntimeClass ([02-kata-runtime.md](02-kata-runtime.md)) and the preloaded runner
image has been imported into the cluster containerd ([03-runner-image.md](03-runner-image.md)).
Here we install **actions-runner-controller (ARC)**, register an ephemeral
**scale set** whose pods each boot inside their own Kata microVM, stand up the
in-cluster **RustFS (S3)** `sccache` backend and the runner cache PVC, and lock
down runner egress with a NetworkPolicy. See [README.md](README.md) for the
architecture overview.

Everything below is read against the live cluster; set the kubeconfig once:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

ARC's `gha-runner-scale-set` flavour has three moving parts:

- **Controller** (`arc` release, ns `arc-systems`) - watches `AutoscalingRunnerSet`
  custom resources and reconciles them.
- **Listener** (one pod per scale set, ns `arc-systems`) - long-polls the GitHub
  Actions service for jobs targeting the scale set's `runs-on` label.
- **Scale set** (`omp-kata` release, ns `arc-runners`) - the `AutoscalingRunnerSet`
  plus the pod template; the controller turns assigned jobs into ephemeral runner
  pods here.

---

## 1. GitHub App and the `arc-github` secret

The listener authenticates to GitHub. The durable option is a **GitHub App**
(no expiring user token, scoped to exactly the repos you install it on).

1. Create the App at **GitHub - Settings - Developer settings - GitHub Apps - New GitHub App**.
   - **Repository permissions**: `Administration: Read and write` (register/remove
     self-hosted runners) and `Metadata: Read-only` (granted automatically).
   - No webhook is needed for the scale-set flavour; uncheck **Active** under Webhook.
   - Generate and download a **private key** (`.pem`).
2. **Install** the App on the target repo or org (App page - **Install App** -
   pick `<OWNER>/<REPO>` or "All repositories"). Note the **App ID** and the
   **Installation ID** (the trailing number in the install settings URL,
   `.../installations/<id>`).
3. Create the secret in the runners namespace. The three key names below are
   exactly what the chart reads:

   ```bash
   kubectl create namespace arc-runners

   kubectl -n arc-runners create secret generic arc-github \
     --from-literal=github_app_id=<GITHUB_APP_ID> \
     --from-literal=github_app_installation_id=<GITHUB_APP_INSTALLATION_ID> \
     --from-literal=github_app_private_key=<GITHUB_APP_PRIVATE_KEY>
   ```

   `<GITHUB_APP_PRIVATE_KEY>` is the full PEM body (use `--from-file=github_app_private_key=key.pem`
   to avoid shell-quoting the multi-line value).

Verify the live secret carries those three keys (names only - never print values):

```bash
kubectl -n arc-runners get secret arc-github \
  -o go-template='{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}'
# github_app_id
# github_app_installation_id
# github_app_private_key
```

**Token alternative.** ARC also accepts a single-key secret with a classic PAT
(scope `repo`) or a fine-grained PAT (`Administration: RW` + `Metadata: R`):

```bash
kubectl -n arc-runners create secret generic arc-github \
  --from-literal=github_token=<GITHUB_PAT>
```

The App is preferred: it does not expire, it is scoped per-installation, and one
installation covers every repo you grant it (useful for [adding another repo](#7-operate)).
Whichever you choose, the `githubConfigSecret` value in step 3's chart points at
this secret by name.

---

## 2. Install ARC (controller + scale set)

ARC ships as OCI Helm charts; no `helm repo add` is required. Both the controller
and the scale set are pinned to the same chart version, **0.14.2** (matches the
live `helm list -A`).

**Controller** (installed with chart defaults - `helm get values arc` is empty):

```bash
helm install arc \
  --namespace arc-systems --create-namespace \
  --version 0.14.2 \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller
```

**Scale set** (`omp-kata`), using the runner cache PVC and values file from step 3:
```bash
helm install omp-kata \
  --namespace arc-runners --create-namespace \
  --version 0.14.2 \
  -f arc-omp-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

Confirm both releases and the running controller image:

```bash
helm list -A
# arc       arc-systems   deployed  gha-runner-scale-set-controller-0.14.2  0.14.2
# omp-kata  arc-runners   deployed  gha-runner-scale-set-0.14.2             0.14.2

kubectl -n arc-systems get deploy arc-gha-rs-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
# ghcr.io/actions/gha-runner-scale-set-controller:0.14.2
```

Within a few seconds the controller spawns the listener in `arc-systems`:

```bash
kubectl -n arc-systems get pods
# arc-gha-rs-controller-xxxxxxxxxx-xxxxx   1/1   Running
# omp-kata-<hash>-listener                 1/1   Running
```

---

## 3. Scale-set values (`arc-omp-values.yaml`)

Create the namespace-local PVC before installing or upgrading the scale set. This
is the shared mutable filesystem cache for data whose tools already validate
against the lockfile: Bun's global package store and Cargo's registry cache.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: runner-cache
  namespace: arc-runners
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 100Gi
```

Apply it once:

```bash
kubectl apply -f runner-cache-pvc.yaml
```

This is the live `arc-omp-values.yaml` verbatim, with only the repo owner/name in
`githubConfigUrl` redacted:

```yaml
githubConfigUrl: "https://github.com/<OWNER>/<REPO>"
githubConfigSecret: arc-github
runnerScaleSetName: omp-kata
minRunners: 0
maxRunners: 10
# none: each job runs inside the runner container, which itself lives in a Kata microVM
containerMode:
  type: ""
template:
  spec:
    runtimeClassName: kata-qemu      # <-- every runner pod boots its own KVM microVM
    securityContext:
      # ghcr.io/actions/actions-runner runs jobs as uid/gid 1001 ("runner").
      # Let kubelet make the PVC writable by that user without changing image-owned
      # ~/.cargo/bin or ~/.rustup.
      fsGroup: 1001
      fsGroupChangePolicy: OnRootMismatch
    initContainers:
      - name: prepare-runner-cache
        image: omp-kata-runner:2026-06-15-002621
        imagePullPolicy: IfNotPresent
        command:
          - bash
          - -lc
          - install -d -o 1001 -g 1001 -m 2775 /cache/bun-store /cache/cargo-registry
        securityContext:
          runAsUser: 0
        volumeMounts:
          - name: runner-cache
            mountPath: /cache
    containers:
      - name: runner
        # Preloaded image: stock ghcr.io/actions/actions-runner + CI deps baked in
        # (apt cairo/pango/jpeg/gif/rsvg stack, fd/ripgrep/imagemagick, bun, rust
        # nightly + clippy/rustfmt + arm64/msvc targets). Built + imported locally;
        # see /root/omp-kata-runner-image/. IfNotPresent uses the local image.
        image: omp-kata-runner:2026-06-15-002621
        imagePullPolicy: IfNotPresent
        command: ["/home/runner/run.sh"]
        # Shared sccache backend (in-cluster RustFS S3). Exposes SCCACHE_BUCKET/
        # ENDPOINT/REGION/USE_SSL + AWS creds to every job; CI flips RUSTC_WRAPPER
        # on for rust builds only. GitHub-hosted runners lack this env and keep the
        # GHA cache backend. See /root/sccache-rustfs/.
        envFrom:
          - secretRef:
              name: sccache-s3
        volumeMounts:
          # Shared stores only. Keep node_modules, Cargo target/, and Cargo git
          # checkouts per-job to avoid mutable build-output or checkout poisoning.
          - name: runner-cache
            mountPath: /home/runner/.bun/install/cache
            subPath: bun-store
          - name: runner-cache
            mountPath: /home/runner/.cargo/registry
            subPath: cargo-registry
        resources:
          requests:
            cpu: "2"
            memory: "4Gi"
          limits:
            cpu: "16"
            memory: "12Gi"
    volumes:
      - name: runner-cache
        persistentVolumeClaim:
          claimName: runner-cache
```

Field by field:

- **`githubConfigUrl`** - the repo (or org) the scale set serves. Jobs reach it
  with `runs-on: omp-kata`.
- **`githubConfigSecret: arc-github`** - the auth secret from [step 1](#1-github-app-and-the-arc-github-secret).
- **`runnerScaleSetName: omp-kata`** - the runner label. This is the string that
  goes in a workflow's `runs-on:`.
- **`minRunners: 0` / `maxRunners: 10`** - **scale-to-zero**. With no queued jobs
  there are zero runner pods (and zero microVMs) consuming the node; the listener
  scales up to ten concurrent runners on demand. (The older ops notes capped this
  at 3; the live value is 10.)
- **`containerMode.type: ""`** - **none**. The default chart offers `dind`
  (Docker-in-Docker sidecar) or `kubernetes` mode for job-container isolation;
  both are unnecessary here because the *whole runner pod* is already isolated in
  a microVM. The job runs directly in the runner container - no privileged dind
  sidecar, no extra attack surface.
- **`template.spec.runtimeClassName: kata-qemu`** - the critical line. It binds
  the pod to the Kata QEMU runtime ([02-kata-runtime.md](02-kata-runtime.md)), so
  every runner boots its own KVM microVM with a guest kernel distinct from the host.
- **`image` / `imagePullPolicy: IfNotPresent`** - the locally built, dependency-baked
  runner image ([03-runner-image.md](03-runner-image.md)). `IfNotPresent` uses the
  copy already imported into cluster containerd; there is no registry. Bump the tag
  here when you rebuild the image (see [Operate](#7-operate)).
- **`command: ["/home/runner/run.sh"]`** - the stock actions-runner entrypoint;
  overridden explicitly because the custom image keeps the upstream layout.
- **`envFrom.secretRef.name: sccache-s3`** - injects only the S3 configuration that
  `sccache` needs ([step 5](#5-shared-caches-rustfs-s3--runner-pvc)). Bun and
  Cargo no longer use RustFS.
- **`securityContext.fsGroup: 1001`** - makes the mounted PVC writable by the
  image's `runner` user without replacing image-owned `~/.cargo/bin` or `~/.rustup`.
- **`initContainers.prepare-runner-cache`** - uses the same locally imported image
  to create the PVC subdirectories as root before the runner starts. This avoids
  relying on kubelet's subPath auto-create permissions and does not pull another
  image.
- **`volumeMounts`** - mounts the shared PVC only at `~/.bun/install/cache` and
  `~/.cargo/registry`. `node_modules`, Cargo `target/`, and Cargo git checkouts
  stay inside the throwaway VM filesystem.
- **`volumes[].persistentVolumeClaim.claimName: runner-cache`** - binds those
  mounts to the `arc-runners/runner-cache` PVC. `ReadWriteOnce` is enough on this
  single-node k3s host; use a RWX-capable storage class before spreading runners
  across nodes.
- **`resources`** - requests `2` CPU / `4Gi`, limits `16` CPU / `12Gi`. Kata reads
  these and sizes the guest accordingly: the VM now boots at the same
  guaranteed floor (`default_vcpus: 2`, `default_memory: 4096`) and only
  hotplugs beyond that toward the limits, with `default_maxvcpus: 0` allowing up
  to all host CPUs. Effectively the **requests are the boot-time VM size** and
  the **limits are the hotplug ceiling**. See [02-kata-runtime.md](02-kata-runtime.md)
  for the runtime knobs and [`infra/tune-kata-runtime.sh`](../tune-kata-runtime.sh)
  for the SSH-driven patch helper.

---

## 4. Job lifecycle and the no-permission ServiceAccount

One job runs in one fresh microVM that is destroyed afterward:

1. The **listener** (ns `arc-systems`) long-polls the GitHub Actions service for
   jobs whose `runs-on` matches `omp-kata`.
2. When jobs are assigned, the controller reconciles the `AutoscalingRunnerSet`
   and creates an **`EphemeralRunnerSet`** sized to the demand (bounded by
   `minRunners`/`maxRunners`).
3. Each replica becomes an **ephemeral runner pod** registered **just-in-time
   (JIT)** with GitHub - a per-runner registration secret is minted, not a
   long-lived token.
4. Because the pod's `runtimeClassName` is `kata-qemu`, it **boots a microVM**,
   pulls the one assigned job, runs it, and exits.
5. ARC **deletes the pod** (and its microVM); a clean VM is created for the next
   job. There is no VM templating - state never leaks between jobs.

Observe the chain live:

```bash
kubectl -n arc-runners get autoscalingrunnerset omp-kata
kubectl -n arc-runners get ephemeralrunnerset
kubectl -n arc-runners get pods -o wide      # one pod per in-flight job; empty when idle
```

**No-permission ServiceAccount.** The scale-set chart runs every runner pod under
a ServiceAccount with no RBAC bindings:

```bash
kubectl -n arc-runners get sa
# default
# omp-kata-gha-rs-no-permission
```

Job code therefore has no Kubernetes API rights - it cannot read secrets, list
pods, or touch the cluster, even though it executes inside the cluster. Combined
with microVM isolation and the egress policy ([step 6](#6-runner-egress-lockdown)),
a compromised job is boxed into a throwaway VM with no cluster reach.

---

## 5. Shared caches (RustFS S3 + runner PVC)

GitHub's hosted cache backend is only reachable over the node's NAT egress, so on
a busy matrix (many concurrent jobs) it becomes the bottleneck. This setup keeps
the hot paths inside the cluster:

- **RustFS S3** backs `sccache` for Rust compiler outputs.
- **`runner-cache` PVC** is mounted into every runner for Bun's global package
  store and Cargo's crates.io registry cache.

### 5a. Deploy RustFS

The store lives in its own `sccache` namespace: a `local-path` PVC for durability,
a single-replica Deployment, and a ClusterIP Service. This is `rustfs.yaml`
verbatim (no secrets inline - credentials come from a separate secret):

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: sccache
  labels:
    kubernetes.io/metadata.name: sccache
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: rustfs-data
  namespace: sccache
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources:
    requests:
      storage: 100Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rustfs
  namespace: sccache
  labels: { app: rustfs }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector:
    matchLabels: { app: rustfs }
  template:
    metadata:
      labels: { app: rustfs }
    spec:
      containers:
        - name: rustfs
          image: rustfs/rustfs:latest
          imagePullPolicy: IfNotPresent
          env:
            - name: RUSTFS_ACCESS_KEY
              valueFrom: { secretKeyRef: { name: rustfs-creds, key: RUSTFS_ACCESS_KEY } }
            - name: RUSTFS_SECRET_KEY
              valueFrom: { secretKeyRef: { name: rustfs-creds, key: RUSTFS_SECRET_KEY } }
            - name: RUSTFS_VOLUMES
              value: "/data"
            - name: RUSTFS_ADDRESS
              value: ":9000"
            - name: RUSTFS_CONSOLE_ENABLE
              value: "false"
            - name: RUSTFS_OBS_LOG_DIRECTORY
              value: "/logs"
          ports:
            - { name: s3, containerPort: 9000 }
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: logs, mountPath: /logs }
          readinessProbe:
            tcpSocket: { port: 9000 }
            initialDelaySeconds: 5
            periodSeconds: 5
          livenessProbe:
            tcpSocket: { port: 9000 }
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            requests: { cpu: "200m", memory: "256Mi" }
            limits: { cpu: "2", memory: "2Gi" }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: rustfs-data }
        - name: logs
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: rustfs
  namespace: sccache
spec:
  selector: { app: rustfs }
  ports:
    - { name: s3, port: 9000, targetPort: 9000, protocol: TCP }
```

Notes:

- **`strategy: Recreate`** with a single replica and an RWO `local-path` PVC: the
  data is node-local and only one pod ever mounts it.
- **`RUSTFS_CONSOLE_ENABLE: "false"`** - only the S3 API on `:9000` is exposed;
  no admin console.
- The `kubernetes.io/metadata.name: sccache` namespace label is what the egress
  NetworkPolicy's `namespaceSelector` matches ([step 6](#6-runner-egress-lockdown)).

The RustFS pod credentials come from a two-key secret in the `sccache` namespace
(values are the object-store root credentials - use placeholders):

```bash
kubectl -n sccache create secret generic rustfs-creds \
  --from-literal=RUSTFS_ACCESS_KEY=<S3_ACCESS_KEY> \
  --from-literal=RUSTFS_SECRET_KEY=<S3_SECRET_KEY>
```

Apply and verify:

```bash
kubectl apply -f rustfs.yaml
kubectl -n sccache get deploy,svc,pvc
# deployment.apps/rustfs   1/1
# service/rustfs           ClusterIP   10.43.x.x   9000/TCP
# persistentvolumeclaim/rustfs-data   Bound   100Gi   local-path
```

Create the `sccache` bucket once (any S3 client - e.g. the `aws` CLI or `mc`
pointed at the endpoint with the root creds): `mb s3://sccache`.

### 5b. The `sccache-s3` secret (injected into every runner)

Every runner pod gets the `sccache` S3 configuration via `envFrom` ([step 3](#3-scale-set-values-arc-omp-valuesyaml)).
The secret lives in `arc-runners` (the runners' namespace) and has six keys:

```bash
kubectl -n arc-runners get secret sccache-s3 \
  -o go-template='{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}'
# AWS_ACCESS_KEY_ID
# AWS_SECRET_ACCESS_KEY
# SCCACHE_BUCKET
# SCCACHE_ENDPOINT
# SCCACHE_REGION
# SCCACHE_S3_USE_SSL
```

Recreate it (the two credential values must equal the `rustfs-creds` above; the
rest are non-sensitive cluster-local config):

```bash
kubectl -n arc-runners create secret generic sccache-s3 \
  --from-literal=AWS_ACCESS_KEY_ID=<S3_ACCESS_KEY> \
  --from-literal=AWS_SECRET_ACCESS_KEY=<S3_SECRET_KEY> \
  --from-literal=SCCACHE_BUCKET=sccache \
  --from-literal=SCCACHE_ENDPOINT=rustfs.sccache.svc.cluster.local:9000 \
  --from-literal=SCCACHE_REGION=us-east-1 \
  --from-literal=SCCACHE_S3_USE_SSL=false
```

- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` - the **only sensitive entries**;
  RustFS's root credentials (S3 SigV4 auth).
- `SCCACHE_BUCKET: sccache` - bucket name.
- `SCCACHE_ENDPOINT` - the in-cluster Service DNS + port.
- `SCCACHE_REGION: us-east-1` - arbitrary region label SigV4 requires.
- `SCCACHE_S3_USE_SSL: false` - the endpoint is plain HTTP on the cluster network.

### 5c. The cache consumers

The presence of `$SCCACHE_BUCKET` in the environment is the repo's single signal
for "am I on the self-hosted infra?". Cache behavior branches on it and falls
back to GitHub-hosted cache backends off-infra. Off-infra covers GitHub-hosted
macOS/arm runners (which never get the secret and cannot reach the private
RustFS) and **every pull request**: `ci.yml` pins PR jobs to GitHub-hosted
`ubuntu-22.04`, so omp-kata only runs trusted `push`/main + release builds (see
[5d](#5d-poisoning-boundary-and-pressure)).

**(a) sccache for Rust compiler outputs** -
[`.github/actions/build-native`](../../.github/actions/build-native/action.yml).
One action serves both environments: a "Detect runner environment" step reads
`$SCCACHE_BUCKET` and branches each toolchain/cache step on it. It sets
`RUSTC_WRAPPER=sccache` and `CARGO_INCREMENTAL=0` (sccache silently no-ops with
incremental enabled). The sccache backend is conditional:

- `$SCCACHE_BUCKET` set (omp-kata) - sccache reads `SCCACHE_BUCKET/ENDPOINT/REGION`
  and the AWS creds straight from the inherited pod env and uses the **shared S3
  (RustFS)**; toolchains come from the baked image via the `ensure-*` actions.
- otherwise (GitHub-hosted) - it installs the toolchains, exports
  `SCCACHE_GHA_ENABLED=true`, and uses the **GitHub Actions cache**.

`Swatinem/rust-cache` runs only on GitHub-hosted runners (it caches Cargo
`target/`). On omp-kata the mounted Cargo registry handles crate downloads and
sccache fills the compile-output gap when `target/` is cold.

**(b) Cargo registry cache** - the scale-set pod template mounts
`runner-cache:/cargo-registry` at `/home/runner/.cargo/registry`. Cargo uses it
automatically because the image keeps `CARGO_HOME=/home/runner/.cargo`.

Only the registry cache is shared. Cargo `target/` stays per-job, and
`/home/runner/.cargo/git` stays per-job too; this repo has no git dependencies,
and git checkouts are a worse shared mutable-cache boundary than crates.io
archives with lockfile checksums.

**(c) Bun package store** -
[`.github/actions/bun-install`](../../.github/actions/bun-install/action.yml)
wraps `bun install --frozen-lockfile`. On omp-kata, the pod template mounts
`runner-cache:/bun-store` at Bun's default store path
(`/home/runner/.bun/install/cache`), so the action only ensures the directory
exists before running Bun. Off-infra it still uses stock `actions/cache@v4` for
the same store path.

`node_modules` is deliberately not shared. It is lockfile-, platform-, script-,
and workspace-state-sensitive, and concurrent jobs would write through the same
tree. The clean VM still runs `bun install --frozen-lockfile`; it just reuses the
package tarball/extract store.

### 5d. Poisoning boundary and pressure

The shared writable PVC and the sccache S3 bucket are both poisonable by any job
that runs on `omp-kata`, and a poisoned entry could be consumed by a later
trusted build (a supply-chain risk). The primary defense is to **keep untrusted
code off the self-hosted runner entirely**:

- `ci.yml` routes every pull-request job to GitHub-hosted `ubuntu-22.04`
  (`runs-on` resolves to `omp-kata` only for `push`/main, manual dispatch, and
  release). That expression lives in the base workflow, which GitHub uses
  verbatim for `pull_request` events, so a fork cannot override it. Fork/PR code
  therefore never sees the PVC, the `sccache-s3` creds, or RustFS - it runs
  sandboxed on GitHub-hosted runners with the off-infra cache backends.
- As defense in depth, set the repo's **Settings -> Actions -> Fork pull request
  workflows** policy to *Require approval for all outside collaborators* (or all
  forks). GitHub's public-repo default only gates first-time contributors, which
  would otherwise let a returning contributor's workflow start without review.

omp-kata thus only ever serves trusted `push`/main + release builds. The
mounted-cache design also narrows the blast radius of those trusted runs:

- no shared `node_modules`;
- no shared Cargo `target/`;
- no shared Cargo git checkouts;
- Bun still installs from `bun.lock`;
- Cargo registry entries are checked against Cargo's lockfile/source checksums;
- Rust compiler outputs stay in sccache's content-addressed backend.

Pressure now has two places to watch:

- `sccache/rustfs-data` for Rust compiler objects;
- `arc-runners/runner-cache` for Bun store + Cargo registry files.

For the runner PVC, the safe cleanup is simple and coarse: scale `omp-kata` to
zero, delete either `bun-store/` or `cargo-registry/` from the bound local-path
volume, then let the next jobs repopulate it. There are no RustFS Bun objects and
no `node_modules` archives to prune anymore.

RustFS remains inside the egress allow-list on `tcp/9000` because sccache still
uses it ([step 6](#6-runner-egress-lockdown)).

---

## 6. Runner egress lockdown

Runner pods reach the public internet (GitHub, package registries, crates.io,
npm) but must **not** reach the host's own services, the LAN, the tailnet, or
arbitrary cluster workloads. A single NetworkPolicy in `arc-runners` enforces
this. Because the pod template sets no special labels, the policy uses
`podSelector: {}` to cover **every** pod in the namespace.

> k3s ships a built-in NetworkPolicy controller (kube-router based) that enforces
> policies even though the CNI is Flannel - so this policy actually takes effect.
> Do not start k3s with `--disable-network-policy` ([01-host-and-cluster.md](01-host-and-cluster.md)),
> or the lockdown silently becomes a no-op.

Live spec (captured with `kubectl get networkpolicy -n arc-runners runner-egress-lockdown -o yaml`;
server-managed metadata omitted, host public IP redacted):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: runner-egress-lockdown
  namespace: arc-runners
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  egress:
    # 1. Cluster DNS only (CoreDNS + kube-system).
    - to:
        - ipBlock:
            cidr: 10.43.0.10/32
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # 2. Public internet, MINUS all private/infra ranges and the host's own public IP.
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
              - 169.254.0.0/16
              - 100.64.0.0/10
              - <PUBLIC_IP>/32
    # 3. RustFS shared cache (S3) over the cluster network.
    - to:
        - ipBlock:
            cidr: 10.43.0.0/16
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: sccache
      ports:
        - port: 9000
          protocol: TCP
```

The allow-list, rule by rule:

- **Rule 1 - DNS.** UDP/TCP 53 to CoreDNS (`10.43.0.10/32`) and the `kube-system`
  namespace. Without this, name resolution breaks and rule 2 is useless.
- **Rule 2 - public internet only.** `0.0.0.0/0` with an `except` list that
  carves out every range a job has no business reaching: RFC1918 private space
  (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`), the CGNAT range
  used by the **tailnet** (`100.64.0.0/10`), and the **host's own public IP**
  (`<PUBLIC_IP>/32`). Note `10.0.0.0/8` covers the pod CIDR (`10.42.0.0/16`) and
  service CIDR (`10.43.0.0/16`), so this rule alone gives a job **zero** in-cluster
  reach - rules 1 and 3 punch the only two holes the job legitimately needs.
- **Rule 3 - RustFS cache.** TCP 9000 to the service CIDR (`10.43.0.0/16`) and the
  `sccache` namespace - the sccache backend from [step 5](#5-shared-caches-rustfs-s3--runner-pvc).
- **Ingress.** `policyTypes` lists `Ingress` but no ingress rule is defined, which
  is a **default-deny**: nothing can open a connection *into* a runner pod.

Egress that survives rule 2 leaves the node via the host's firewalld masquerade
(SNAT to the public IP) over the default interface - see
[01-host-and-cluster.md](01-host-and-cluster.md) for the host firewall side.

### Security model

- **Kernel isolation.** Each job runs in a Kata microVM with its own guest kernel
  (6.x), separate from the host kernel (7.0.x) - a kernel exploit hits a throwaway
  VM, not the host. See [02-kata-runtime.md](02-kata-runtime.md).
- **No cluster rights.** Jobs run under `omp-kata-gha-rs-no-permission` with no
  RBAC ([step 4](#4-job-lifecycle-and-the-no-permission-serviceaccount)).
- **Constrained network.** The policy above blocks the host, LAN, tailnet, and
  arbitrary cluster pods; only DNS, the public internet, and RustFS are reachable.
- **Ephemeral.** One job per VM, destroyed afterward - no state, secret, or
  artifact survives into the next job.
- **Public-repo recommendation.** For a public repo, require approval for fork
  PRs so untrusted code cannot auto-run on the infra: **repo - Settings - Actions
  - General - Fork pull request workflows from outside collaborators - Require
  approval for all outside collaborators**.

---

## 7. Operate

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

**Status / scale**

```bash
kubectl -n arc-runners get autoscalingrunnerset omp-kata   # min/max/current runners
kubectl -n arc-runners get ephemeralrunnerset              # desired vs current replicas
kubectl -n arc-runners get pods -o wide                    # live runner VMs (empty when idle)
```

**Logs**

```bash
# Listener (job dispatch / scaling decisions)
kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener -f
# Controller (reconciliation)
kubectl -n arc-systems logs deploy/arc-gha-rs-controller -f
# A specific runner / its job
kubectl -n arc-runners logs <runner-pod>
```

**Verify the caches are being used.** A warm job logs
`bun cache backend: mounted PVC (...)` and
`sccache backend: shared S3 (sccache @ rustfs.sccache.svc.cluster.local:9000)` in
its step output. To inspect the mounted cache, scale to zero and check the
`runner-cache` local-path volume on the host; to inspect sccache objects, point
an S3 client at RustFS and list `s3://sccache/`.

**Resize a job's VM** - edit the `resources` block in `arc-omp-values.yaml`
([step 3](#3-scale-set-values-arc-omp-valuesyaml); requests = guaranteed VM size,
limits = hotplug ceiling) and roll out:

```bash
helm upgrade omp-kata \
  --namespace arc-runners --version 0.14.2 \
  -f arc-omp-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

**Change scale-to-zero bounds** - edit `minRunners` / `maxRunners` in the same
file and `helm upgrade` as above. (Keep `maxRunners` within the node's CPU/RAM
budget: each runner can hotplug up to its `limits`.)

**Update the runner image** - bump `template.spec.containers[0].image` to the new
tag, then `helm upgrade` as above; confirm with:

```bash
kubectl -n arc-runners get autoscalingrunnerset omp-kata \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

See [03-runner-image.md](03-runner-image.md) for building and importing the image.

**Add another repo.** Because the GitHub App installation can cover multiple repos,
reuse the same `arc-github` secret and install a second scale set with its own
`githubConfigUrl`, `runnerScaleSetName` (the new `runs-on:` label), and release
name:

```bash
helm install <release> \
  --namespace arc-runners --version 0.14.2 \
  --set githubConfigUrl=https://github.com/<OWNER>/<OTHER_REPO> \
  --set githubConfigSecret=arc-github \
  --set runnerScaleSetName=<other-repo>-kata \
  -f arc-omp-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

Jobs in the other repo then target `runs-on: <other-repo>-kata`. (On this host a
convenience wrapper, `omp-add-repo-runner <OWNER>/<REPO> [label]`, performs exactly
this install.)

**Uninstall** (leaves k3s/Kata in place):

```bash
helm uninstall omp-kata -n arc-runners
helm uninstall arc -n arc-systems
```

---

**Previous:** [03-runner-image.md](03-runner-image.md) - the preloaded runner image.
**Overview:** [README.md](README.md) - architecture and the full doc set.
