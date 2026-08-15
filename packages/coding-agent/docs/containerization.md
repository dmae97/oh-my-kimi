# Containerization

AgentSession's built-in local bash tool is OS-sandboxed by default on supported hosts. Other built-in tools, extension code, custom tools, and the OMK process itself still run with the host user's permissions unless you isolate or delegate them.

## Built-in session bash sandbox

The default `enforce` profile wraps each local bash spawn with macOS `sandbox-exec` or Linux `bwrap`. It allows writes only in the session workspace and OS temp directory and disables network access. If the backend is unavailable, bash fails closed with `sandbox.backend_missing` rather than spawning without isolation.

- macOS requires `sandbox-exec`.
- Linux requires `bwrap` and unprivileged user namespaces.
- `OMK_BASH_SANDBOX=audit` explicitly selects the unwrapped, ledger-only compatibility mode.
- `OMK_BASH_SANDBOX=0` or `off` explicitly disables the preflight.

The workspace-write profile protects host paths from writes; it is not a read-confidentiality boundary. It also does not cover injected or remote `BashOperations`, custom `createBashTool()` calls without a `sandboxPolicy`, extension tools, or other OMK file tools. Use one of the whole-process or delegated patterns below when that broader boundary is required.

There are two general isolation options:

1. run the whole `omk` process inside an isolated environment, or
2. run `omk` on the host and route tool execution into an isolated environment.

## Choose a pattern

| Pattern | What is isolated | Best for | Notes |
| --- | --- | --- | --- |
| OpenShell | Whole `omk` process in a policy-controlled sandbox | Local or remote managed sandbox | Requires an OpenShell gateway |
| Gondolin extension | Built-in tools and `!` commands | Local micro-VM isolation while keeping auth on host | See [`examples/extensions/gondolin/`](../examples/extensions/gondolin/). |
| Plain Docker | Whole `omk` process in a local container | Simple local isolation | Provider API keys enter the container. |

Extensions run wherever the `omk` process runs. If you run host `omk` with a tool-routing extension, other custom extension tools still run on the host unless they also delegate their operations.

## OpenShell

Use [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) when you want a policy-controlled sandbox with filesystem, process, network, credential, and inference controls.
OpenShell can run sandboxes through a local gateway backed by Docker, Podman, or a VM runtime, or through a remote Kubernetes gateway.

Every sandbox requires an active gateway.
Register and select one before creating a sandbox:

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

Launch `omk` inside an OpenShell sandbox:

```bash
openshell sandbox create --name omk-sandbox --from omk -- omk
```

In this pattern, the whole `omk` process runs inside the sandbox.
Built-in tools, `!` commands, and extension tools execute inside the OpenShell boundary.

If the gateway is remote, project files are not bind-mounted from the host, meaning writes in the sandbox are not reflected on your machine.
Clone the repository inside the sandbox or use OpenShell file transfer commands:

```bash
openshell sandbox upload omk-sandbox ./repo /workspace
openshell sandbox download omk-sandbox /workspace/repo ./repo-out
```

OpenShell providers can keep raw model API keys outside the sandbox.
When inference routing is configured, code inside the sandbox can call `https://inference.local`, and the gateway injects the configured provider credentials upstream.
Configure OMK to use the corresponding OpenAI-compatible or Anthropic-compatible endpoint if you want model traffic to use this route.

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM.
Use the [example extension](../examples/extensions/gondolin) when you want `omk` on the host but all built-in tools routed into the VM.

Setup:

```bash
cp -R packages/coding-agent/examples/extensions/gondolin ~/.omk/agent/extensions/gondolin
cd ~/.omk/agent/extensions/gondolin
npm install --ignore-scripts
```

Run from the project you want mounted:

```bash
cd /path/to/project
omk -e ~/.omk/agent/extensions/gondolin
```

The extension mounts the host cwd at `/workspace` in the VM and overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`.
User `!` commands are routed into the VM, as well.
File changes under `/workspace` write through to the host.

Requirements: Node.js >= 23.6.0 for `@earendil-works/gondolin`, plus QEMU (requires installation through your package manager).

## Plain Docker

Run the whole `omk` process in Docker when you want the simplest local container boundary.

`Dockerfile.omk`:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts open-multi-agent-kit

WORKDIR /workspace
ENTRYPOINT ["omk"]
```

Build and run:

```bash
docker build -t omk-sandbox -f Dockerfile.omk .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v omk-agent-home:/root/.omk/agent \
  omk-sandbox
```

The `-v "$PWD:/workspace"` mounts your current directory into the container at /workspace such that reads and writes in `/workspace` inside Docker directly affect your host files, like in the Gondolin example.

Use a named volume for `/root/.omk/agent` if you want container-local settings and sessions. Mounting your host `~/.omk/agent` exposes host auth and session files to the container.
