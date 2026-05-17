"""Typed webhook payload parsing + dispatch routing."""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from robomp.db import issue_key
from robomp.pragmas import parse_pragmas

log = logging.getLogger(__name__)

Decision = Literal["queue", "skip"]


@dataclass(slots=True, frozen=True)
class RouteDecision:
    decision: Decision
    task: str | None
    repo: str | None
    issue_key: str | None
    reason: str
    submitter: str | None = None
    association: str | None = None
    directive: bool = False
    directive_body: str | None = None
    directive_author: str | None = None
    directive_pragmas: tuple[tuple[str, str], ...] = ()

    @property
    def should_queue(self) -> bool:
        return self.decision == "queue"


def verify_signature(secret: str, body: bytes, signature_header: str | None) -> bool:
    """Constant-time HMAC-SHA256 verification of `X-Hub-Signature-256`."""
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    provided = signature_header.removeprefix("sha256=")
    return hmac.compare_digest(expected, provided)


def _repo_full_name(payload: Mapping[str, Any]) -> str | None:
    repo = payload.get("repository")
    if isinstance(repo, dict):
        full = repo.get("full_name")
        if isinstance(full, str):
            return full
    return None


PrIssueResolver = Callable[[str, int], str | None] | None


def _is_bot_account(user: Mapping[str, Any] | None, bot_login: str) -> bool:
    if not isinstance(user, Mapping):
        return False
    login = str(user.get("login") or "")
    if not login:
        return False
    if login == bot_login:
        return True
    if login.endswith("[bot]"):
        return True
    if str(user.get("type") or "") == "Bot":
        return True
    return False


def _submitter_info(obj: Mapping[str, Any] | None) -> tuple[str | None, str | None]:
    """Extract `(login, author_association)` from an issue/comment object."""
    if not isinstance(obj, Mapping):
        return None, None
    user = obj.get("user")
    login: str | None = None
    if isinstance(user, Mapping):
        raw = user.get("login")
        if isinstance(raw, str) and raw:
            login = raw
    assoc = obj.get("author_association")
    return login, (str(assoc) if isinstance(assoc, str) and assoc else None)


def extract_mention(body: str | None, bot_login: str) -> str | None:
    """Return `body` with `@<bot_login>` mentions stripped, or None if no mention.

    Match is case-insensitive and word-boundary aware (hyphens in logins are
    part of the token, so `@robomp-bot` does NOT match `@robomp-bot-extra`).
    """
    if not isinstance(body, str) or not body:
        return None
    login = bot_login.strip()
    if not login:
        return None
    pattern = re.compile(
        rf"(?<![A-Za-z0-9_-])@{re.escape(login)}(?![A-Za-z0-9_-])",
        re.IGNORECASE,
    )
    if not pattern.search(body):
        return None
    stripped = pattern.sub("", body)
    # Collapse the whitespace the strip leaves behind without mangling the rest.
    stripped = re.sub(r"[ \t]+", " ", stripped)
    stripped = re.sub(r"\n[ \t]+", "\n", stripped)
    return stripped.strip()


def is_maintainer(
    login: str | None,
    association: str | None,
    *,
    maintainers: frozenset[str],
) -> bool:
    """A maintainer is anyone in `maintainers` or with a trusted association."""
    if isinstance(login, str) and login and login.lower() in maintainers:
        return True
    if isinstance(association, str) and association.upper() in TRUSTED_ASSOCIATIONS:
        return True
    return False


def route(
    event_type: str,
    payload: Mapping[str, Any],
    *,
    allowlist: frozenset[str],
    bot_login: str,
    maintainers: frozenset[str] = frozenset(),
    reviewer_bots: frozenset[str] = frozenset(),
    resolve_issue_from_pr: PrIssueResolver = None,
) -> RouteDecision:
    """Decide whether and how to handle a webhook event.

    `resolve_issue_from_pr(repo, pr_number)` maps a PR number back to its
    originating-issue key (e.g. `octo/widget#42`). PR-derived events prefer
    that key so follow-ups serialize with the original issue. If the mapping
    is missing, the event is still actionable and falls back to the PR's own
    issue key (`octo/widget#1080`).
    """
    repo = _repo_full_name(payload)
    if repo is None or repo.lower() not in allowlist:
        return RouteDecision("skip", None, repo, None, "repo not on allowlist")

    action = str(payload.get("action") or "")

    def _resolve_pr_key(pr_number: int) -> str:
        if resolve_issue_from_pr is not None:
            resolved = resolve_issue_from_pr(repo, pr_number)  # type: ignore[arg-type]
            if resolved:
                return resolved
        return issue_key(repo, pr_number)  # type: ignore[arg-type]

    def _reviewer_bot_login(user: Mapping[str, Any] | None) -> str | None:
        """Return the lowercased login if this user is a configured reviewer bot."""
        if not isinstance(user, Mapping):
            return None
        login = str(user.get("login") or "").lower()
        return login if login and login in reviewer_bots else None

    def _directive_kwargs(comment: Mapping[str, Any] | None, login: str | None, assoc: str | None) -> dict[str, Any]:
        """Decide whether this comment is a directive (reviewer-bot OR maintainer-mention)."""
        if not isinstance(comment, Mapping):
            return {}
        body = str(comment.get("body") or "")
        rb_login = _reviewer_bot_login(comment.get("user"))
        if rb_login is not None:
            # Reviewer bots like chatgpt-codex-connector speak authoritatively
            # already — no `@bot` mention required; pass the full body through.
            cleaned, pragmas = parse_pragmas(body)
            return {
                "directive": True,
                "directive_body": cleaned,
                "directive_author": rb_login,
                "directive_pragmas": pragmas,
            }
        if not is_maintainer(login, assoc, maintainers=maintainers):
            return {}
        stripped = extract_mention(body, bot_login)
        if stripped is None:
            return {}
        cleaned, pragmas = parse_pragmas(stripped)
        return {
            "directive": True,
            "directive_body": cleaned,
            "directive_author": login,
            "directive_pragmas": pragmas,
        }

    if event_type == "issues":
        issue = payload.get("issue") or {}
        if "pull_request" in issue:
            return RouteDecision("skip", None, repo, None, "issue is a pull request")
        number = issue.get("number")
        if not isinstance(number, int):
            return RouteDecision("skip", None, repo, None, "issue missing number")
        key = issue_key(repo, number)
        if action == "opened":
            login, assoc = _submitter_info(issue)
            return RouteDecision(
                "queue", "triage_issue", repo, key, "issues.opened", submitter=login, association=assoc
            )
        if action == "closed":
            # Cleanup is a lifecycle event, not a user submission; no rate-limit subject.
            return RouteDecision("queue", "cleanup_workspace", repo, key, "issues.closed")
        return RouteDecision("skip", None, repo, key, f"issues.{action} ignored")

    if event_type == "issue_comment" and action == "created":
        comment = payload.get("comment") or {}
        rb_login = _reviewer_bot_login(comment.get("user"))
        if rb_login is None and _is_bot_account(comment.get("user"), bot_login):
            return RouteDecision("skip", None, repo, None, "bot/self comment")
        issue = payload.get("issue") or {}
        number = issue.get("number")
        if not isinstance(number, int):
            return RouteDecision("skip", None, repo, None, "comment missing issue number")
        if "pull_request" in issue:
            # Conversation comment on a PR. The PR number lives at issue.number
            # on this payload type. Prefer the originating issue key when the
            # DB has it, but do not drop bot-authored follow-ups just because
            # the PR mapping was lost; the worker can recover from the PR
            # branch or handle the PR directly.
            key = _resolve_pr_key(number)
            login, assoc = _submitter_info(comment)
            return RouteDecision(
                "queue",
                "handle_pr_conversation",
                repo,
                key,
                f"issue_comment.created on PR #{number}",
                submitter=login,
                association=assoc,
                **_directive_kwargs(comment, login, assoc),
            )
        key = issue_key(repo, number)
        login, assoc = _submitter_info(comment)
        return RouteDecision(
            "queue",
            "handle_comment",
            repo,
            key,
            "issue_comment.created",
            submitter=login,
            association=assoc,
            **_directive_kwargs(comment, login, assoc),
        )

    if event_type == "pull_request_review_comment" and action == "created":
        comment = payload.get("comment") or {}
        rb_login = _reviewer_bot_login(comment.get("user"))
        if rb_login is None and _is_bot_account(comment.get("user"), bot_login):
            return RouteDecision("skip", None, repo, None, "bot/self review comment")
        pr = payload.get("pull_request") or {}
        pr_user = pr.get("user") or {}
        if str(pr_user.get("login") or "") != bot_login:
            return RouteDecision("skip", None, repo, None, "PR not authored by bot")
        number = pr.get("number")
        if not isinstance(number, int):
            return RouteDecision("skip", None, repo, None, "PR missing number")
        key = _resolve_pr_key(number)
        login, assoc = _submitter_info(comment)
        return RouteDecision(
            "queue",
            "handle_review",
            repo,
            key,
            "pull_request_review_comment.created",
            submitter=login,
            association=assoc,
            **_directive_kwargs(comment, login, assoc),
        )

    if event_type == "pull_request" and action == "closed":
        pr = payload.get("pull_request") or {}
        pr_user = pr.get("user") or {}
        if str(pr_user.get("login") or "") != bot_login:
            return RouteDecision("skip", None, repo, None, "PR not bot-authored")
        if not bool(pr.get("merged")):
            return RouteDecision("skip", None, repo, None, "PR closed without merge")
        number = pr.get("number")
        if not isinstance(number, int):
            return RouteDecision("skip", None, repo, None, "PR missing number")
        return RouteDecision("queue", "cleanup_workspace", repo, _resolve_pr_key(number), "pull_request.merged")

    return RouteDecision("skip", None, repo, None, f"{event_type}.{action} not handled")


TRUSTED_ASSOCIATIONS: frozenset[str] = frozenset({"OWNER", "MEMBER", "COLLABORATOR"})
"""GitHub `author_association` values that bypass per-user rate limiting."""


def rate_limit_cap(
    login: str,
    association: str | None,
    *,
    unlimited: frozenset[str],
    default: int,
    contributor: int,
) -> int | None:
    """Return the per-window submission cap for a submitter, or `None` for unlimited.

    Precedence: explicit `unlimited` allowlist > trusted GitHub association
    (`OWNER`/`MEMBER`/`COLLABORATOR`) > `CONTRIBUTOR` tier > default tier.
    """
    if login.lower() in unlimited:
        return None
    if association:
        upper = association.upper()
        if upper in TRUSTED_ASSOCIATIONS:
            return None
        if upper == "CONTRIBUTOR":
            return contributor
    return default


__all__ = [
    "Decision",
    "RouteDecision",
    "TRUSTED_ASSOCIATIONS",
    "extract_mention",
    "is_maintainer",
    "rate_limit_cap",
    "route",
    "verify_signature",
]
