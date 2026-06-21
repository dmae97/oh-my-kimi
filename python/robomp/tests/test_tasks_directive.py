"""Verify pragmas survive the payload round-trip from server → durable queue → tasks."""

from __future__ import annotations

import pytest
from robomp.tasks import _attach_thread, _directive_from_payload
from robomp.worker import DirectiveInfo


def test_directive_from_payload_parses_pragmas() -> None:
    directive = _directive_from_payload(
        {
            "_robomp_directive": {
                "body": "do the thing",
                "author": "can1357",
                "pragmas": [["model", "gpt"], ["thinking", "low"]],
            }
        }
    )
    assert directive is not None
    assert directive.body == "do the thing"
    assert directive.author == "can1357"
    assert directive.pragmas == (("model", "gpt"), ("thinking", "low"))
    assert directive.authorizes_impl is False


def test_directive_from_payload_missing_pragmas_is_empty_tuple() -> None:
    directive = _directive_from_payload({"_robomp_directive": {"body": "x", "author": "can1357"}})
    assert directive is not None
    assert directive.pragmas == ()
    assert directive.authorizes_impl is False


def test_directive_from_payload_drops_malformed_pragma_entries() -> None:
    directive = _directive_from_payload(
        {
            "_robomp_directive": {
                "body": "x",
                "author": "can1357",
                "pragmas": [
                    ["model", "gpt"],
                    ["bad"],  # wrong arity
                    [1, "v"],  # non-string key
                    "string-instead-of-pair",
                ],
            }
        }
    )
    assert directive is not None
    assert directive.pragmas == (("model", "gpt"),)


def test_directive_from_payload_parses_implementation_authorization() -> None:
    directive = _directive_from_payload(
        {
            "_robomp_directive": {
                "body": "do the thing",
                "author": "can1357",
                "authorizes_impl": True,
            }
        }
    )
    assert directive is not None
    assert directive.authorizes_impl is True


def test_directive_from_payload_returns_none_for_missing_directive() -> None:
    assert _directive_from_payload({}) is None
    assert _directive_from_payload({"_robomp_directive": "not-a-mapping"}) is None


async def test_attach_thread_preserves_authorizes_impl(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_fetch_thread(*args, **kwargs):
        return ()

    monkeypatch.setattr("robomp.tasks._fetch_thread", fake_fetch_thread)

    directive = DirectiveInfo(
        body="test body",
        author="test_author",
        authorizes_impl=True,
    )
    hydrated = await _attach_thread(None, directive, "owner/repo", 42, is_pr=False)
    assert hydrated is not None
    assert hydrated.body == "test body"
    assert hydrated.author == "test_author"
    assert hydrated.authorizes_impl is True
