# Telegram completion notifier

Sends one Telegram message when an agent run settles, so a long task can be started and
walked away from.

## Setup

```bash
npm run connect -- --token '<bot id>:<secret>'   # token from @BotFather
```

Then send the bot any message from Telegram. A chat id cannot be looked up — Telegram
reveals it only once the human has written to the bot — so the script waits for that
message, writes `~/.omk/telegram.env` with mode 600, and sends a confirmation. Restart
omk afterwards: the file is read once at startup.

`npm run connect -- --test` re-sends to the stored chat without changing anything.

Environment variables still work and take precedence, which keeps a one-off
`TELEGRAM_CHAT_ID=... omk` honest and suits a server with no home directory:

```bash
export TELEGRAM_BOT_TOKEN='<bot id>:<secret>'
export TELEGRAM_CHAT_ID='<your chat id>'
```

With neither source, the extension registers nothing and the run is unaffected.
Credentials never live in the repository: a bot token in a committed config is a bot
token in everyone's checkout. The credential file is owner-only, so it is narrower than
a shell rc, which is read by every process the account starts. A file readable by group
or world still works but says so once at startup.

| Variable | Default | Does |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | Required. Bot token from @BotFather. |
| `TELEGRAM_CHAT_ID` | — | Required. Where to send. |
| `OMK_TELEGRAM_ENV_FILE` | `~/.omk/telegram.env` | Where the credentials live. |
| `OMK_TELEGRAM_NOTIFY` | on | `0` disables without unsetting credentials. |
| `OMK_TELEGRAM_MIN_DURATION_MS` | `5000` | Successful runs shorter than this stay quiet. |
| `OMK_TELEGRAM_ON_SUCCESS` | on | |
| `OMK_TELEGRAM_ON_FAILURE` | on | |
| `OMK_TELEGRAM_ON_ABORT` | on | |
| `OMK_TELEGRAM_LABEL` | — | Prefix, for telling two machines apart. |

The duration floor applies only to success. A run that fails after one second is exactly
the one worth interrupting someone for, so failures and aborts always send.

## What it sends

```
OMK completed after 4m 12s
```

Outcome and duration. That is the whole payload.

A bot chat is not a private channel, and a transcript carries source, file paths, and
whatever was pasted into the session. "It is done" needs none of that, so the payload
builder is never given the messages — there is nothing here to leak rather than a
redaction pass that has to be right every time.

## What it does not do

It is one-way. Nothing here reads Telegram, and no message can drive OMK.

Inbound control is a different feature with a different threat model: anyone who can
message the bot would get command execution on this machine, so it would need chat-id
allowlisting, per-command confirmation for anything destructive, and a sandbox. None of
that is here.

`connect.mjs` reads Telegram, but only during pairing, and only to learn a chat id. It
is a script the owner runs, not a listener the extension starts.

Telegram allows one reader per bot, so pairing fails with a 409 while a full bridge such
as `@llblab/pi-telegram` is polling the same bot. Either pair before connecting the
bridge, pass `--chat-id` and skip the wait, or give this extension its own bot. Sending
is unaffected: any number of processes may post as one bot, so a notifier and a bridge
coexist once paired.

## Rotating a leaked token

Anyone holding the token can post as the bot and read what is sent to it. Message
@BotFather, `/revoke`, then re-run `npm run connect` with the new token. The old one
stops working immediately, and the extension picks up the new one on the next start.

## Failure behaviour

Telegram being unreachable, rate limiting, or a revoked token cannot fail the run that
just finished. The request is bounded at 10 seconds and its error is swallowed rather
than surfaced, because the error message can carry the request URL, which carries the
token.
