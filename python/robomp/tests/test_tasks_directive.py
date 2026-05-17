"""Verify pragmas survive the payload round-trip from server → durable queue → tasks."""

from __future__ import annotations

from robomp.tasks import _directive_from_payload


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


def test_directive_from_payload_missing_pragmas_is_empty_tuple() -> None:
    directive = _directive_from_payload({"_robomp_directive": {"body": "x", "author": "can1357"}})
    assert directive is not None
    assert directive.pragmas == ()


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


def test_directive_from_payload_returns_none_for_missing_directive() -> None:
    assert _directive_from_payload({}) is None
    assert _directive_from_payload({"_robomp_directive": "not-a-mapping"}) is None
