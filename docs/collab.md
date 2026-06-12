# Collab: Live Session Sharing

`/collab` shares your running session with other omp instances in real time. Guests render the **same session natively in their own TUI** — streaming assistant text, tool-call cards, footer state (cwd, model, context %, cost), ctrl+o expansion, `/dump` — no terminal mirroring. Guests can prompt and interrupt the agent; the host machine runs the agent and all tools.

## Quick start

Host:

```
/collab
```

prints a link like

```
Collab link: mgAYTZwEnpRQtca0CTgn-Q#gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30
```

Guest (any directory, any machine):

```
/join mgAYTZwEnpRQtca0CTgn-Q#gdJU…
```

The guest's previous session is restored on `/leave` (or when the host stops).

### Commands

| Command | Effect |
|---|---|
| `/collab` | Start sharing (or re-print the link when already hosting) |
| `/collab <relay>` | Start sharing through a specific relay (`relay.example.com`, `ws://localhost:7475`) |
| `/collab status` | Show link + participants |
| `/collab stop` | Stop sharing |
| `/join <link>` | Join a shared session as a guest |
| `/leave` | Leave (guest) or stop sharing (host) |

## Link format

```
<roomId>#<key>                      → default relay (relay.omp.sh)
host[:port]/r/<roomId>#<key>        → custom relay, wss:// inferred
ws://localhost:7475/r/<roomId>#<key> → plain ws, allowed for localhost only
```

The fragment (`#<key>`) is the 32-byte AES-256-GCM room key, base64url-encoded. Fragments never appear in HTTP requests, and the key is never sent to the relay.

## End-to-end encryption

Every session payload (entries, events, state, prompts) is sealed with AES-256-GCM before it touches the socket. The relay sees only:

- room ids and connection counts,
- opaque ciphertext frames and their sizes,
- a 4-byte routing prefix (which guest a frame targets).

Possession of the link is the trust boundary: anyone with the full link can read the session and prompt the agent. Share it like a secret.

## Guest permission model

Single trust level. Guests can:

- read the entire session (including the back-transcript at join time),
- prompt the agent (rendered with their name badge on every participant's transcript; the LLM sees the prompt text verbatim — names are display-only),
- interrupt the agent (Esc),
- use the Agent Hub against the host's subagents: live table and progress, chat (steers the host's subagent), kill, revive, and transcript viewing (fetched from the host on demand).

Everything that mutates the host session or machine is host-only: `/model`, `/compact`, `/resume`, `/branch`, bash (`!`), python (`$`), skills, etc. Guests keep a small local allowlist (`/dump`, `/export`, `/copy`, `/help`, `/hotkeys`, `/theme`, `/settings`, `/leave`, `/collab`, `/exit`).

Known v1 limit for guests: a turn already streaming when you join becomes visible from its next message boundary.

## Web client

`packages/collab-web` is a standalone browser client for the same links — no omp install needed on the guest side. It renders the live transcript (streaming text, thinking, tool cards), a subagent panel with on-demand transcripts, and a composer with the same guest powers (prompt, interrupt, hub actions). Run `bun run dev` in the package for a local instance, `bun run mock-host` for an offline scripted host to develop against, and `bun run build` to emit a static `dist/` deployable anywhere (HTTPS required for WebCrypto). The client never talks to anything but the relay, and the key stays in the URL fragment.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `collab.relayUrl` | `wss://relay.omp.sh` | Relay used by `/collab` when no relay is passed inline |
| `collab.displayName` | OS username | Name shown to other participants |

## Self-hosting the relay

The relay is a small content-blind Go service (`omp-collab-relay`, in the pi-www repo under `relay/`). It keeps no state beyond live connections and exposes:

- `GET /r/<roomId>?role=host|guest` — WebSocket upgrade,
- `GET /healthz` — liveness.

Run it:

```sh
go build -o omp-collab-relay .
RELAY_BIND=0.0.0.0:7475 ./omp-collab-relay
```

`RELAY_BIND` accepts `host:port`, a bare port (binds localhost), or a unix socket path (front it with a TLS-terminating reverse proxy — guests other than localhost require `wss://`). Then:

```
/collab my-relay.example.com
```

or set `collab.relayUrl` in `/settings`.

## Architecture notes

Hub topology — the host is authoritative, guests never peer:

1. `entry` frames — durable session entries, broadcast pre-blob-externalization so images stay inline (guests cannot resolve host blob refs). Guests append them verbatim (ids preserved) to a replica session file under `~/.omp/collab/<roomId>.jsonl` and into the agent's message array, which is why `/dump` and context estimates work.
2. `event` frames — live agent events, fed straight into the guest's normal event controller; rendering is events-only to prevent double-render.
3. `state` frames — debounced footer snapshots: streaming flag, the host's full model object and thinking level (applied to the guest's replica agent state, so model display and context-window math are native), host context numbers, and participants.
4. `bus` frames — mirrored task-subagent lifecycle/progress EventBus traffic, republished on the guest's local bus so the subagent HUD and status-line count work natively.
5. `agents` frames — agent-registry snapshots feeding a guest-local registry, so the Agent Hub table renders host subagents.

Guest→host: `hello`, `prompt`, `abort`, `agent-cmd` (hub chat/kill/revive), and `fetch-transcript` (incremental subagent-transcript reads answered by targeted `transcript` frames). The replica loads through the regular `/resume` machinery, so theming, ctrl+o, and transcript behavior are native by construction; the guest process never chdirs to host paths.
