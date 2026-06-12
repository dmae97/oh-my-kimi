# Collab: Live Session Sharing

`/collab` shares your running session with other omp instances in real time. Guests render the **same session natively in their own TUI** — streaming assistant text, tool-call cards, footer state (cwd, model, context %, cost), ctrl+o expansion, `/dump` — no terminal mirroring. Guests can prompt and interrupt the agent; the host machine runs the agent and all tools.

## Quick start

Host:

```
/collab
```

prints

```
Collab session started!
 • Join from another terminal: omp join "mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
 • or any web browser: my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30
```

The browser line is click-to-join (an OSC 8 hyperlink to the full `https://` deep link): the relay serves the web guest client at `/`, and the room id + key ride in the URL fragment. From another omp (any directory, any machine), either form works:

```
/join my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

The guest's previous session is restored on `/leave` (or when the host stops).

### Commands

| Command | Effect |
|---|---|
| `/collab` | Start sharing (or re-print the link when already hosting) |
| `/collab <relay>` | Start sharing through a specific relay (`relay.example.com`, `ws://localhost:7475`) |
| `/collab view` | Print a read-only (view-only) link (starts sharing first if needed) |
| `/collab status` | Show link + participants |
| `/collab stop` | Stop sharing |
| `/join <link>` | Join a shared session as a guest |
| `/leave` | Leave (guest) or stop sharing (host) |

## Link format

```
https://host[:port]/#<link>          → browser deep link (printed by /collab; /join accepts it too)
<roomId>.<key>                       → default relay (my.omp.sh)
host[:port]/r/<roomId>.<key>         → custom relay, wss:// inferred
ws://localhost:7475/r/<roomId>.<key> → plain ws, allowed for localhost only
```

The trailing `.<key>` part is the room secret, base64url-encoded, in one of two strengths:

- **Full link** — 48 bytes: the 32-byte AES-256-GCM room key followed by a 16-byte write token. Grants prompting, interrupting, and subagent control.
- **View-only link** — the bare 32-byte key, no write token. Grants live read access only. Pre-token links parse as view-only.

The room secret is dot-joined rather than `#`-joined: RFC 3986 forbids a raw `#` inside a URL fragment, so strict URL stacks (macOS Foundation behind terminal click-to-open) percent-encode a second `#` to `%23` and break the link. Parsers leniently accept the legacy `#` form and the mangled `%23` form. In the browser deep link, everything after the `#` — room id and key — is a URL fragment: it never appears in any HTTP request, and neither secret is ever sent to the relay.

## End-to-end encryption

Every session payload (entries, events, state, prompts) is sealed with AES-256-GCM before it touches the socket. The relay sees only:

- room ids and connection counts,
- opaque ciphertext frames and their sizes,
- a 4-byte routing prefix (which guest a frame targets).

Possession of the link is the trust boundary: a full link reads and steers the session, a view-only link reads it. Share both like secrets.

## Guest permission model

Two trust levels, enforced by the link itself — the host verifies the 16-byte write token at join and rejects writes from peers without it (they appear as read-only in the participants list, and the join notice says so).

Guests with a full link can:

- read the entire session (including the back-transcript at join time),
- prompt the agent (rendered with their name badge on every participant's transcript; the LLM sees the prompt text verbatim — names are display-only),
- interrupt the agent (Esc),
- use the Agent Hub against the host's subagents: live table and progress, chat (steers the host's subagent), kill, revive, and transcript viewing (fetched from the host on demand).

Guests with a view-only link can read everything live — back-transcript, streaming text, tool cards, subagent transcripts — but the host rejects prompting, interrupting, and agent control from them.

Everything that mutates the host session or machine is host-only: `/model`, `/compact`, `/resume`, `/branch`, bash (`!`), python (`$`), skills, etc. Guests keep a small local allowlist (`/dump`, `/export`, `/copy`, `/help`, `/hotkeys`, `/theme`, `/settings`, `/leave`, `/collab`, `/exit`).

Known v1 limit for guests: a turn already streaming when you join becomes visible from its next message boundary.

## Web client

`packages/collab-web` is a standalone browser client for the same links — no omp install needed on the guest side. The relay serves it at `/`, which is what makes the `/collab` deep link click-to-join: `https://<relay>/#<link>` loads the client and auto-connects from the fragment. It renders the live transcript (streaming text, thinking, tool cards), a subagent panel with on-demand transcripts, and a composer with the same guest powers (prompt, interrupt, hub actions). Run `bun run dev` in the package for a local instance, `bun run mock-host` for an offline scripted host to develop against, and `bun run build` to emit a static `dist/` deployable anywhere (HTTPS required for WebCrypto). The client never talks to anything but the relay, and the key stays in the URL fragment.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `collab.relayUrl` | `wss://my.omp.sh` | Relay used by `/collab` when no relay is passed inline |
| `collab.displayName` | OS username | Name shown to other participants |
| `share.serverUrl` | `https://my.omp.sh/s` | Share viewer/upload base used by `/share` (links are `<base>/<id>#<key>`) |
| `share.redactSecrets` | `true` | Run the secret obfuscator over `/share` snapshots before upload |

## Self-hosting the relay

The relay is a small content-blind Go service. It keeps no state beyond live connections and exposes:

- `GET /` — the static collab-web guest client (target of the `/collab` deep link),
- `GET /r/<roomId>?role=host|guest` — WebSocket upgrade,
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw` — `/share` blob upload, viewer page, and blob fetch,
- `GET /healthz` — liveness.


## Architecture notes

Hub topology — the host is authoritative, guests never peer:

1. `entry` frames — durable session entries, broadcast pre-blob-externalization so images stay inline (guests cannot resolve host blob refs). Guests append them verbatim (ids preserved) to a replica session file under `~/.omp/collab/<roomId>.jsonl` and into the agent's message array, which is why `/dump` and context estimates work.
2. `event` frames — live agent events, fed straight into the guest's normal event controller; rendering is events-only to prevent double-render.
3. `state` frames — debounced footer snapshots: streaming flag, the host's full model object and thinking level (applied to the guest's replica agent state, so model display and context-window math are native), host context numbers, and participants.
4. `bus` frames — mirrored task-subagent lifecycle/progress EventBus traffic, republished on the guest's local bus so the subagent HUD and status-line count work natively.
5. `agents` frames — agent-registry snapshots feeding a guest-local registry, so the Agent Hub table renders host subagents.

Guest→host: `hello`, `prompt`, `abort`, `agent-cmd` (hub chat/kill/revive), and `fetch-transcript` (incremental subagent-transcript reads answered by targeted `transcript` frames). The replica loads through the regular `/resume` machinery, so theming, ctrl+o, and transcript behavior are native by construction; the guest process never chdirs to host paths.
