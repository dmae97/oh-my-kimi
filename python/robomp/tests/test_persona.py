"""Coverage for the directive prompt assembly."""

from __future__ import annotations

from dataclasses import dataclass

from robomp import persona
from robomp.worker import DirectiveInfo, ThreadMessage


@dataclass(slots=True, frozen=True)
class _Repo:
    full_name: str = "octo/widget"
    default_branch: str = "main"
    clone_url: str = ""
    private: bool = False


@dataclass(slots=True, frozen=True)
class _Issue:
    repo: str = "octo/widget"
    number: int = 1080
    title: str = "broken thing"
    body: str = "the body text"
    state: str = "open"
    author: str = "alice"
    labels: tuple[str, ...] = ()
    is_pull_request: bool = False


@dataclass(slots=True, frozen=True)
class _Workspace:
    branch: str = "farm/abc/test"
    session_dir: str = "/tmp/session"
    context_dir: str = "/tmp/ctx"
    repo_dir: str = "/tmp/repo"


@dataclass(slots=True, frozen=True)
class _Pr:
    number: int = 99
    author: str = "alice"
    head_ref: str = "fix-crash"
    base_ref: str = "main"
    head_repo: str = "alice/widget"
    html_url: str = "https://github.com/octo/widget/pull/99"


@dataclass(slots=True, frozen=True)
class _Comment:
    id: int = 1
    author: str = "can1357"
    body: str = "@roboomp please fix"
    created_at: str = "2026-05-14T20:00:00Z"


def test_render_thread_empty_yields_placeholder() -> None:
    assert persona._render_thread(()).startswith("(no prior")


def test_render_thread_orders_kinds_with_appropriate_headers() -> None:
    thread = (
        ThreadMessage(kind="issue_body", author="alice", body="orig report", created_at=""),
        ThreadMessage(kind="comment", author="bob", body="me too", created_at="2026-05-01T10:00:00Z"),
        ThreadMessage(
            kind="review_comment",
            author="codex",
            body="leak here",
            created_at="2026-05-02T10:00:00Z",
            path="src/foo.py",
            line=42,
        ),
        ThreadMessage(
            kind="review",
            author="codex",
            body="two issues",
            created_at="2026-05-02T10:01:00Z",
            state="CHANGES_REQUESTED",
        ),
    )
    out = persona._render_thread(thread)
    # Issue body header (no timestamp).
    assert "### @alice — issue body" in out
    assert "orig report" in out
    # Comment header with timestamp.
    assert "### @bob — comment *(2026-05-01T10:00:00Z)*" in out
    assert "me too" in out
    # Review comment with file:line anchor.
    assert "### @codex — review comment on `src/foo.py`:L42" in out
    assert "leak here" in out
    # Review with state badge.
    assert "### @codex — review (CHANGES_REQUESTED)" in out
    assert "two issues" in out


def test_directive_prompt_embeds_thread_and_directive_body() -> None:
    thread = (
        ThreadMessage(kind="comment", author="alice", body="follow up please", created_at="2026-05-01T10:00:00Z"),
    )
    out = persona.directive(
        repo=_Repo(),
        issue=_Issue(),
        comment=_Comment(),
        workspace=_Workspace(),
        directive=DirectiveInfo(body="apply fix Y", author="can1357", thread=thread),
        pr_status="PR #1080 is open",
    )
    assert "Directive on octo/widget#1080" in out
    assert "@can1357" in out
    assert "apply fix Y" in out
    assert "follow up please" in out
    assert "PR #1080 is open" in out


def test_followup_comment_prompt_embeds_thread_context() -> None:
    thread = (
        ThreadMessage(kind="pr_body", author="roboomp", body="PR body", created_at=""),
        ThreadMessage(kind="comment", author="can1357", body="prior request", created_at="2026-05-01T10:00:00Z"),
    )
    out = persona.followup_comment(
        repo=_Repo(),
        issue=_Issue(),
        comment=_Comment(body="current request"),
        workspace=_Workspace(),
        pr_status="PR #1080 is open",
        pr_number=1080,
        thread=thread,
    )

    assert "Prior conversation" in out
    assert "PR body" in out
    assert "prior request" in out
    assert "current request" in out


def test_kickoff_directive_prompt_embeds_thread_and_classify_instruction() -> None:
    thread = (ThreadMessage(kind="issue_body", author="alice", body="failing on macos", created_at=""),)
    out = persona.kickoff_directive(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
        directive=DirectiveInfo(body="reproduce + fix", author="can1357", thread=thread),
    )
    assert "Maintainer directive on octo/widget#1080" in out
    assert "failing on macos" in out
    assert "reproduce + fix" in out
    # The kickoff variant must still tell the agent to classify first.
    assert "Classify first" in out


def test_resume_triage_renders_branch_and_issue() -> None:
    out = persona.resume_triage(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
    )
    # Working branch surfaces literally so the agent sees what it's on.
    assert "farm/abc/test" in out
    # Issue identity surfaces with the title.
    assert "octo/widget#1080" in out
    assert "broken thing" in out
    # The prompt instructs the agent to reconcile drift via fetch_issue_thread.
    assert "fetch_issue_thread" in out


def test_kickoff_pr_review_formats_head_repo_and_origin_base() -> None:
    out = persona.kickoff_pr_review(
        repo=_Repo(),
        pr=_Pr(),
        workspace=_Workspace(),
    )
    assert "`fix-crash` from `alice/widget`" in out
    assert "git diff origin/main...HEAD" in out


def test_review_completion_reminder_mentions_submit_only() -> None:
    out = persona.review_completion_reminder(
        repo=_Repo(),
        issue=_Issue(number=99, title="Fix parser"),
        workspace=_Workspace(branch="review/pr-99"),
    )
    assert "submit_pr_review" in out
    assert "gh_open_pr" not in out
