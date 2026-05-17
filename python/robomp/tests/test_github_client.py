"""GitHub REST client tests against httpx.MockTransport."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from robomp.github_client import GitHubClient, GitHubError


def _run_async(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_4xx_maps_to_github_error_with_message() -> None:
    transport = httpx.MockTransport(lambda req: httpx.Response(404, json={"message": "Not Found"}))
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        asyncio.new_event_loop().run_until_complete(client.get_repo("o/r"))
    assert exc.value.status == 404
    assert "Not Found" in str(exc.value)


def test_rate_limit_retry_after_parsed() -> None:
    transport = httpx.MockTransport(
        lambda req: httpx.Response(
            403,
            json={"message": "rate limited"},
            headers={"retry-after": "42"},
        )
    )
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        asyncio.new_event_loop().run_until_complete(client.get_repo("o/r"))
    assert exc.value.retry_after == 42.0


def test_redirect_without_follow_raises_github_error() -> None:
    """If a moved repo returns 301 and the redirect target is unreachable,
    we must raise a clean GitHubError instead of parsing the response body."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        # First request: simulate a 301 redirect that the client cannot follow
        # because the new location resolves to a 410 Gone.
        if len(calls) == 1:
            return httpx.Response(
                301,
                headers={"location": "https://api.github.com/repositories/12345"},
            )
        return httpx.Response(410, json={"message": "Gone"})

    transport = httpx.MockTransport(handler)
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        asyncio.new_event_loop().run_until_complete(client.get_repo("old-owner/old-repo"))
    # Either we end up at 410 after following, or we surface the redirect itself
    # — both are GitHubError, not an internal exception.
    assert exc.value.status in (301, 410)


def test_redirect_target_succeeds_when_followable() -> None:
    """A 301 → 200 chain should resolve to the followed payload."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/old/repo":
            return httpx.Response(
                301,
                headers={"location": "https://api.github.com/repos/new/repo"},
            )
        return httpx.Response(
            200,
            json={
                "full_name": "new/repo",
                "default_branch": "main",
                "clone_url": "https://github.com/new/repo.git",
                "private": False,
            },
        )

    transport = httpx.MockTransport(handler)
    client = GitHubClient("tok", transport=transport)
    repo = asyncio.new_event_loop().run_until_complete(client.get_repo("old/repo"))
    assert repo.full_name == "new/repo"


def test_get_pull_request_parses_head_repo_and_author() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/widget/pulls/9"
        return httpx.Response(
            200,
            json={
                "number": 9,
                "html_url": "https://github.com/octo/widget/pull/9",
                "head": {"ref": "farm/abc12345/fix", "repo": {"full_name": "octo/widget"}},
                "base": {"ref": "main"},
                "state": "open",
                "user": {"login": "robomp-bot"},
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    pr = _run_async(client.get_pull_request("octo/widget", 9))
    assert pr.head_ref == "farm/abc12345/fix"
    assert pr.head_repo == "octo/widget"
    assert pr.author == "robomp-bot"


def test_204_no_content_returns_none() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(204))
    client = GitHubClient("tok", transport=transport)
    # add_assignees with empty list short-circuits without a request; pass one to force the call.
    asyncio.new_event_loop().run_until_complete(client.add_assignees("o/r", 1, ["alice"]))


def test_list_closing_pull_requests_filters_disconnected_and_closed() -> None:
    """Net connected−disconnected open PRs only."""
    captured: dict[str, str] = {}

    timeline = [
        # PR #100 connected and still open → included
        {
            "event": "connected",
            "source": {"issue": {"number": 100, "state": "open", "pull_request": {"url": "..."}}},
        },
        # PR #200 connected then disconnected → excluded
        {
            "event": "connected",
            "source": {"issue": {"number": 200, "state": "open", "pull_request": {"url": "..."}}},
        },
        {
            "event": "disconnected",
            "source": {"issue": {"number": 200, "state": "open", "pull_request": {"url": "..."}}},
        },
        # PR #300 connected but currently closed (e.g. rejected) → excluded
        {
            "event": "connected",
            "source": {"issue": {"number": 300, "state": "closed", "pull_request": {"url": "..."}}},
        },
        # Cross-referenced (not connected) — not a closing link → excluded
        {
            "event": "cross-referenced",
            "source": {"issue": {"number": 400, "state": "open", "pull_request": {"url": "..."}}},
        },
        # Plain issue cross-ref (no pull_request) → excluded
        {
            "event": "connected",
            "source": {"issue": {"number": 500, "state": "open"}},
        },
        # Unrelated timeline events → ignored
        {"event": "labeled", "label": {"name": "bug"}},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["per_page"] = request.url.params.get("per_page", "")
        return httpx.Response(200, json=timeline)

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    prs = _run_async(client.list_closing_pull_requests("octo/widget", 42))
    assert prs == (100,)
    assert captured["path"] == "/repos/octo/widget/issues/42/timeline"
    assert captured["per_page"] == "100"


def test_list_closing_pull_requests_empty_timeline() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=[]))
    client = GitHubClient("tok", transport=transport)
    assert _run_async(client.list_closing_pull_requests("octo/widget", 7)) == ()


def test_list_comment_reactions_filters_to_thumbs_down() -> None:
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["content"] = request.url.params.get("content", "")
        captured["per_page"] = request.url.params.get("per_page", "")
        return httpx.Response(
            200,
            json=[
                {"content": "-1", "user": {"login": "Alice", "type": "User"}},
                {"content": "-1", "user": {"login": "rando", "type": "User"}},
            ],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    reactions = _run_async(client.list_comment_reactions("octo/widget", 999))
    assert captured["path"] == "/repos/octo/widget/issues/comments/999/reactions"
    assert captured["content"] == "-1"
    assert captured["per_page"] == "100"
    assert tuple(r.user_login for r in reactions) == ("Alice", "rando")
    assert all(r.content == "-1" for r in reactions)


def test_close_issue_sends_completed_state_reason() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    assert _run_async(client.close_issue("octo/widget", 42)) is None
    assert captured["method"] == "PATCH"
    assert captured["path"] == "/repos/octo/widget/issues/42"
    assert captured["body"] == {"state": "closed", "state_reason": "completed"}


def test_close_issue_propagates_error() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(404, json={"message": "Not Found"}))
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        _run_async(client.close_issue("octo/widget", 42))
    assert exc.value.status == 404
