# Contributing to oh-my-pi

Thanks for your interest in contributing. This project uses a lightweight
**vouch** system to decide who can open pull requests. Please read this before
opening a PR.

## TL;DR

- **Issues are open to everyone.** File bugs, feature requests, and questions
  freely — they are triaged automatically.
- **Pull requests require a vouch.** A PR whose author is not vouched (or is
  denounced) is **closed automatically**. If you are not yet vouched, do **not**
  open a PR to get noticed — it will be closed on sight. Start a Discussion and
  ask to be vouched first (see below).

## Who can open PRs

A pull request is accepted when its author is any of:

- a repository collaborator (write access or above), or a bot; or
- listed — without a leading `-` — in [`.github/VOUCHED.td`](.github/VOUCHED.td).

Anyone **denounced** (prefixed with `-` in that file) is always blocked.

## Getting vouched

1. Open a [Discussion](../../discussions) (or comment on an existing one)
   describing what you'd like to contribute.
2. A maintainer vouches you by commenting **`!vouch`** (vouches the discussion
   author) or **`!vouch @your-handle`** on that discussion.
3. Once you appear in `.github/VOUCHED.td`, open your PR — it stays open and is
   reviewed.

Maintainers may also `!denounce [@user]` and `!unvouch [@user]`. Only
collaborators with admin/maintain/write can run these commands.

## What happens to your PR

| You are… | Result |
| --- | --- |
| Vouched (or a collaborator) | PR stays open → automated review → human review |
| Not vouched | PR closed with a comment — get vouched, then reopen or open a new PR |
| Denounced | PR closed |

Pushing more commits to an open, vouched PR is fine — it remains vouched.

## The VOUCHED.td file

[`.github/VOUCHED.td`](.github/VOUCHED.td) is the source of truth: one handle per
line, sorted alphabetically, optionally `platform:handle`, with `-` marking a
denouncement and an optional reason after the handle. The format follows
[mitchellh/vouch](https://github.com/mitchellh/vouch); the denouncement list is
intentionally public so other projects can reuse our prior knowledge of bad
actors.
