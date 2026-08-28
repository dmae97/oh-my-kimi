# Telegram completion notifier

Sends one Telegram message when an agent run settles, so a long task can be started and
walked away from.

## Setup

```bash
export TELEGRAM_BOT_TOKEN='<bot id>:<secret>'   # from @BotFather
export TELEGRAM_CHAT_ID='<your chat id>'        # message the bot, then read it from
                                                # https://api.telegram.org/bot<token>/getUpdates
```

Without both, the extension registers nothing and the run is unaffected. Credentials are
read from the environment only: a bot token in a committed config is a bot token in
everyone's checkout.

| Variable | Default | Does |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | Required. Bot token from @BotFather. |
| `TELEGRAM_CHAT_ID` | — | Required. Where to send. |
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

## Failure behaviour

Telegram being unreachable, rate limiting, or a revoked token cannot fail the run that
just finished. The request is bounded at 10 seconds and its error is swallowed rather
than surfaced, because the error message can carry the request URL, which carries the
token.
