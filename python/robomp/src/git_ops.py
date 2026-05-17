"""Low-level git primitives with ephemeral PAT injection.

The PAT is supplied through `git --config-env=http.extraHeader=ENVVAR`. Git
expands the env var inside the spawned process; the secret only appears in
the spawned process's environment, never in argv visible to other UIDs via
`/proc/<pid>/cmdline`. The env var is wiped from the parent after each call.

Used by:
- `robomp.sandbox.LocalGitTransport` for in-process git operations when no
  proxy is configured.
- `robomp.proxy.server` for proxied operations on the gh-proxy side.
"""

from __future__ import annotations

import base64
import logging
import os
import platform
import re
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

log = logging.getLogger(__name__)

# Per-call env var name. `git --config-env` reads the header value from this
# env entry inside the spawned process — never persisted into `.git/config`.
AUTH_ENV_VAR = "ROBOMP_GIT_HTTP_AUTH"

_CRED_URL = re.compile(r"(https?://)([^:/@\s]+):([^@/\s]+)@")
_BAD_OBJECT_REF_RE = re.compile(
    r"(?:fatal: bad object (?P<bad>refs/[^\s]+)|error: (?P<invalid>refs/[^\s]+) does not point to a valid object!)"
)
_FETCH_PRUNE_REPAIR_ATTEMPTS = 8

_SHARED_OMP_GID = 2000
_AGENT_HOME = Path("/srv/agent-home")


def _slot_permissions_active(slot_uid: int | None) -> bool:
    return slot_uid is not None and platform.system() == "Linux" and os.geteuid() == 0


def _slot_subprocess_kwargs(slot_uid: int | None) -> dict[str, Any]:
    if not _slot_permissions_active(slot_uid):
        return {}
    assert slot_uid is not None
    return {"user": slot_uid, "group": slot_uid, "extra_groups": [_SHARED_OMP_GID], "umask": 0o002}


def _append_safe_directory(env: dict[str, str], repo_dir: Path) -> None:
    count = int(env.get("GIT_CONFIG_COUNT", "0"))
    env[f"GIT_CONFIG_KEY_{count}"] = "safe.directory"
    env[f"GIT_CONFIG_VALUE_{count}"] = str(repo_dir)
    env["GIT_CONFIG_COUNT"] = str(count + 1)


def _local_remote_safe_directory(remote_url: str, *, cwd: Path) -> Path | None:
    """Return a local filesystem remote path that git may need whitelisted."""
    raw = remote_url.strip()
    if not raw:
        return None
    if raw.startswith("file://"):
        parsed = urlparse(raw)
        if parsed.netloc not in ("", "localhost"):
            return None
        return Path(parsed.path)
    if "://" in raw or re.match(r"^[^/\\s]+:", raw):
        return None
    path = Path(raw)
    return path if path.is_absolute() else (cwd / path).resolve()


def redact_credentials(text: str | None) -> str:
    """Strip `user:password@` from any embedded URL in `text`."""
    if not text:
        return text or ""
    return _CRED_URL.sub(r"\1***@", text)


def _redacted_cmd(cmd: list[str]) -> list[str]:
    return [redact_credentials(part) for part in cmd]


class GitCommandError(RuntimeError):
    """Wraps a failed git subprocess with credentials redacted from argv and stderr."""

    def __init__(self, cmd: list[str], returncode: int, stdout: str, stderr: str) -> None:
        self.returncode = returncode
        self.stdout = redact_credentials(stdout)
        self.stderr = redact_credentials(stderr)
        self.cmd = _redacted_cmd(cmd)
        msg = self.stderr.strip() or self.stdout.strip() or f"exit {returncode}"
        super().__init__(f"git {' '.join(self.cmd[1:])} failed: {msg}")


def _basic_auth_header(token: str) -> str:
    """Build the `Authorization: Basic …` header value for a PAT.

    GitHub accepts `x-access-token:<PAT>` over HTTPS Basic auth; that form
    works for fine-grained tokens, classic PATs, and GitHub App installation
    tokens alike.
    """
    raw = f"x-access-token:{token}".encode()
    return f"Authorization: Basic {base64.b64encode(raw).decode('ascii')}"


_DEFAULT_GIT_TIMEOUT_SECONDS = 120.0
"""Hard wall-clock cap on any one `git` invocation. Overridable per-call.

A hung child (auth prompt, network stall, server-side packfile generation
that never finishes) MUST NOT pin the calling thread forever — especially
when the gh-proxy invokes `_run_git` from an executor and bounds its OWN
wait via `asyncio.wait_for`. The asyncio bound returns control to the
event loop, but only this `timeout=` + kill below frees the OS process.
"""


def _run_git(
    args: list[str],
    *,
    cwd: Path | None,
    token: str | None,
    extra_env: Mapping[str, str] | None = None,
    safe_directory: Path | None = None,
    user: int | None = None,
    group: int | None = None,
    extra_groups: list[int] | tuple[int, ...] | None = None,
    umask: int | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run `git <args>` with optional PAT injection via `--config-env`.

    A returncode of 0 returns the populated `CompletedProcess`. Non-zero exit
    returns the same shape; callers either `_check` it or inspect manually
    (e.g. when probing for ref existence). Stdout/stderr are always
    credential-redacted before being returned.

    On `timeout` expiry the child (and any descendants spawned by git's
    helpers) is killed and `GitCommandError` is raised with a synthetic
    returncode (124, matching coreutils `timeout`). `None` uses
    `_DEFAULT_GIT_TIMEOUT_SECONDS`.
    """
    env: dict[str, str] = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    if user is not None and _AGENT_HOME.is_dir():
        env["HOME"] = str(_AGENT_HOME)
    if extra_env:
        env.update(extra_env)
    if safe_directory is not None:
        _append_safe_directory(env, safe_directory)

    cmd: list[str] = ["git"]
    if token:
        env[AUTH_ENV_VAR] = _basic_auth_header(token)
        cmd.extend(["--config-env", f"http.extraHeader={AUTH_ENV_VAR}"])
    cmd.extend(args)
    log.debug("git", extra={"cmd": _redacted_cmd(cmd), "cwd": str(cwd) if cwd else None})
    effective_timeout = _DEFAULT_GIT_TIMEOUT_SECONDS if timeout is None else timeout
    subprocess_kwargs: dict[str, Any] = {}
    if user is not None:
        subprocess_kwargs["user"] = user
    if group is not None:
        subprocess_kwargs["group"] = group
    if extra_groups is not None:
        subprocess_kwargs["extra_groups"] = extra_groups
    if umask is not None:
        subprocess_kwargs["umask"] = umask
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=effective_timeout,
            **subprocess_kwargs,
        )
    except subprocess.TimeoutExpired as exc:
        # `subprocess.run` already kills the direct child when the timeout
        # fires, but we explicitly re-raise as `GitCommandError` so callers
        # don't have to special-case `TimeoutExpired` alongside the regular
        # non-zero-exit error path. 124 mirrors GNU `timeout`.
        stdout = redact_credentials(exc.stdout or "") if isinstance(exc.stdout, str) else ""
        stderr_msg = f"git timed out after {effective_timeout:.0f}s: {' '.join(_redacted_cmd(cmd))}"
        raise GitCommandError(cmd, 124, stdout, stderr_msg) from exc
    if proc.stdout:
        proc.stdout = redact_credentials(proc.stdout)
    if proc.stderr:
        proc.stderr = redact_credentials(proc.stderr)
    return proc


def _check(proc: subprocess.CompletedProcess[str], cmd: list[str]) -> subprocess.CompletedProcess[str]:
    if proc.returncode != 0:
        raise GitCommandError(cmd, proc.returncode, proc.stdout, proc.stderr)
    return proc


def _git_dir(repo_dir: Path) -> Path | None:
    dot_git = repo_dir / ".git"
    if dot_git.is_dir():
        return dot_git
    if dot_git.is_file():
        try:
            text = dot_git.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        prefix = "gitdir:"
        if not text.startswith(prefix):
            return None
        git_dir = Path(text[len(prefix) :].strip())
        return git_dir if git_dir.is_absolute() else (repo_dir / git_dir).resolve()
    if (repo_dir / "HEAD").exists() and (repo_dir / "objects").is_dir():
        return repo_dir
    return None


def _resolve_alternate_path(objects_dir: Path, raw: str) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path
    return (objects_dir / path).resolve()


def _prune_missing_alternates(repo_dir: Path) -> bool:
    """Drop object alternates that point at directories no longer mounted.

    The bot never configures alternates for pool clones. If one leaks in from
    an external git invocation and points at a temp directory, every later
    fetch emits warnings and refs whose objects lived only there become
    unreadable. Removing the dead alternate lets the repair path below delete
    those broken refs and recover the pool without recloning it.
    """
    git_dir = _git_dir(repo_dir)
    if git_dir is None:
        return False
    objects_dir = git_dir / "objects"
    alternates = objects_dir / "info" / "alternates"
    try:
        lines = alternates.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return False

    kept: list[str] = []
    changed = False
    for line in lines:
        raw = line.strip()
        if not raw:
            changed = True
            continue
        if _resolve_alternate_path(objects_dir, raw).is_dir():
            kept.append(line)
        else:
            changed = True

    if not changed:
        return False
    try:
        if kept:
            alternates.write_text("\n".join(kept) + "\n", encoding="utf-8")
        else:
            alternates.unlink()
    except OSError as exc:
        log.warning("failed to prune missing git alternates", extra={"repo_dir": str(repo_dir), "error": str(exc)})
        return False
    log.warning("pruned missing git alternates", extra={"repo_dir": str(repo_dir)})
    return True


def _is_safe_ref_name(ref: str) -> bool:
    if not ref.startswith("refs/"):
        return False
    if any(ch in ref for ch in "\0\r\n\t "):
        return False
    return all(part not in ("", ".", "..") for part in ref.split("/"))


def _bad_refs_from_fetch_output(output: str) -> tuple[str, ...]:
    refs: list[str] = []
    seen: set[str] = set()
    for match in _BAD_OBJECT_REF_RE.finditer(output):
        ref = match.group("bad") or match.group("invalid") or ""
        if ref in seen or not _is_safe_ref_name(ref):
            continue
        seen.add(ref)
        refs.append(ref)
    return tuple(refs)


def _worktrees_holding_refs(repo_dir: Path, refs: tuple[str, ...]) -> dict[str, list[str]]:
    """Map each ref in ``refs`` to the worktree paths whose ``HEAD`` is on it.

    A worktree that has the soon-to-be-deleted branch checked out keeps a
    stale ``HEAD`` pointer after ``update-ref -d`` succeeds in the shared
    refs store. The next ``git fetch`` then re-reports the same "bad object"
    error because git inspects every worktree's ``HEAD`` for connectivity.
    Removing the offending worktree (or running ``git worktree remove
    --force`` on it) clears that pointer so the fetch can recover.
    """
    if not refs:
        return {}
    proc = _run_git(["worktree", "list", "--porcelain"], cwd=repo_dir, token=None)
    if proc.returncode != 0:
        return {}
    refs_set = set(refs)
    by_ref: dict[str, list[str]] = {}
    current: dict[str, str] = {}

    def _flush() -> None:
        branch = current.get("branch")
        path = current.get("worktree")
        if branch in refs_set and path:
            by_ref.setdefault(branch, []).append(path)

    for line in proc.stdout.splitlines():
        if not line.strip():
            _flush()
            current.clear()
            continue
        key, _, val = line.partition(" ")
        if key and val:
            current[key] = val
    _flush()
    return by_ref


def _remove_worktrees(repo_dir: Path, paths: list[str]) -> None:
    for path in paths:
        proc = _run_git(["worktree", "remove", "--force", path], cwd=repo_dir, token=None)
        if proc.returncode != 0:
            log.warning(
                "failed to remove worktree during fetch repair",
                extra={"repo_dir": str(repo_dir), "worktree": path, "stderr": proc.stderr[:500]},
            )
            continue
        log.warning(
            "removed worktree during fetch repair",
            extra={"repo_dir": str(repo_dir), "worktree": path},
        )
    if paths:
        _run_git(["worktree", "prune"], cwd=repo_dir, token=None)


def _delete_bad_refs(repo_dir: Path, output: str) -> bool:
    bad_refs = _bad_refs_from_fetch_output(output)
    if not bad_refs:
        return False
    holding = _worktrees_holding_refs(repo_dir, bad_refs)
    changed = False
    for ref in bad_refs:
        worktrees = holding.get(ref) or []
        if worktrees:
            _remove_worktrees(repo_dir, worktrees)
            changed = True
        proc = _run_git(["update-ref", "-d", ref], cwd=repo_dir, token=None)
        if proc.returncode == 0:
            changed = True
            log.warning(
                "deleted invalid git ref during fetch repair",
                extra={"repo_dir": str(repo_dir), "git_ref": ref},
            )
            continue
        log.warning(
            "failed to delete invalid git ref during fetch repair",
            extra={"repo_dir": str(repo_dir), "git_ref": ref, "stderr": proc.stderr[:500]},
        )
    return changed


def _repair_fetch_prune_failure(repo_dir: Path, output: str) -> bool:
    pruned_alternates = _prune_missing_alternates(repo_dir)
    deleted_refs = _delete_bad_refs(repo_dir, output)
    return pruned_alternates or deleted_refs


# ---------- Public primitives ----------


def clone(
    target: Path,
    *,
    clone_url: str,
    default_branch: str,
    token: str | None,
    safe_directory: Path | None = None,
) -> None:
    """Fresh `git clone --filter=blob:none` into `target`."""
    target.parent.mkdir(parents=True, exist_ok=True)
    args = [
        "clone",
        "--filter=blob:none",
        "--no-tags",
        "--branch",
        default_branch,
        clone_url,
        str(target),
    ]
    _check(_run_git(args, cwd=None, token=token, safe_directory=safe_directory), ["git", *args])


def fetch_prune(repo_dir: Path, *, token: str | None, safe_directory: Path | None = None) -> None:
    """`git fetch --prune origin` on the shared pool clone.

    Pool clones are long-lived. If a transient git object alternate leaks into
    the pool and later disappears, `git fetch` can fail before it has a chance
    to refresh from origin because a local ref points at an object that only
    existed in that missing alternate. Repair that exact corruption in-place:
    drop dead alternates, delete refs Git already reported as invalid, then
    retry the fetch.
    """
    args = ["fetch", "--prune", "origin"]
    _prune_missing_alternates(repo_dir)
    last_proc: subprocess.CompletedProcess[str] | None = None
    for _ in range(_FETCH_PRUNE_REPAIR_ATTEMPTS):
        proc = _run_git(args, cwd=repo_dir, token=token, safe_directory=safe_directory)
        if proc.returncode == 0:
            return
        last_proc = proc
        output = f"{proc.stderr}\n{proc.stdout}"
        if not _repair_fetch_prune_failure(repo_dir, output):
            _check(proc, ["git", *args])
    assert last_proc is not None
    _check(last_proc, ["git", *args])


def fetch_ref(repo_dir: Path, ref: str, *, token: str | None, safe_directory: Path | None = None) -> None:
    """`git fetch origin <ref>` (best-effort: caller decides to swallow)."""
    args = ["fetch", "origin", ref]
    proc = _run_git(args, cwd=repo_dir, token=token, safe_directory=safe_directory)
    if proc.returncode != 0:
        log.debug(
            "fetch_ref non-fatal failure",
            extra={"ref": ref, "stderr": proc.stderr},
        )


@dataclass(slots=True, frozen=True)
class PushResult:
    head: str
    branch: str


class HeadDriftError(GitCommandError):
    """Raised when `expected_head` no longer matches the current HEAD.

    Defends against an attacker landing a commit between the orchestrator's
    preflight gates and the actual push.
    """


def rev_parse_head(
    repo_dir: Path,
    *,
    safe_directory: Path | None = None,
    user: int | None = None,
    group: int | None = None,
    extra_groups: list[int] | tuple[int, ...] | None = None,
    umask: int | None = None,
) -> str:
    """Return the SHA of HEAD or raise GitCommandError."""
    args = ["rev-parse", "HEAD"]
    proc = _run_git(
        args,
        cwd=repo_dir,
        token=None,
        safe_directory=safe_directory,
        user=user,
        group=group,
        extra_groups=extra_groups,
        umask=umask,
    )
    if proc.returncode != 0:
        raise GitCommandError(["git", *args], proc.returncode, proc.stdout, proc.stderr)
    return proc.stdout.strip()


def push(
    repo_dir: Path,
    *,
    branch: str,
    expected_head: str | None,
    token: str | None,
    slot_uid: int | None = None,
    safe_directory: Path | None = None,
) -> PushResult:
    """`git push --force-with-lease=<ref>:<sha> --set-upstream origin <branch>` from `repo_dir`.

    The lease is pinned to whatever SHA the local `refs/remotes/origin/<branch>`
    currently records — i.e. what the workspace last fetched. The push only
    succeeds if origin's `<branch>` still matches that SHA, so a parallel
    writer to the same ref (between our last fetch and this push) is detected
    and refused even when the push is a fast-forward of HEAD. For a brand-new
    branch the local remote-tracking ref is absent, so the lease expects "no
    ref on origin" (empty expected value).

    `--force-with-lease` (vs plain `--force`) lets us recover from local
    history rewrites (e.g. the agent doing `git commit --amend --reset-author
    --no-edit` to fix author identity) while still refusing the push if origin
    has moved since our last fetch — i.e. it never clobbers work the bot
    didn't see.

    When `expected_head` is supplied, this verifies the *local* HEAD matches
    before pushing — anything else means an unexpected commit raced in inside
    our own worktree between the orchestrator's preflight and this call, and
    the push is aborted with `HeadDriftError`. This is a separate concern from
    `--force-with-lease`, which compares against the remote ref.
    """
    slot_kwargs = _slot_subprocess_kwargs(slot_uid)
    git_safe_directory = safe_directory
    if git_safe_directory is None and slot_kwargs:
        git_safe_directory = repo_dir

    head = rev_parse_head(repo_dir, safe_directory=git_safe_directory, **slot_kwargs)
    if expected_head and head != expected_head:
        raise HeadDriftError(
            ["git", "push"],
            128,
            "",
            f"HEAD changed since preflight ({expected_head[:12]} → {head[:12]}); aborting push.",
        )
    # Probe the local remote-tracking ref. Missing → first push; we pin the
    # lease to the empty value so the push only succeeds if origin still has
    # no `<branch>`. Present → pin to that SHA.
    probe = _run_git(
        ["rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{branch}"],
        cwd=repo_dir,
        token=None,
        safe_directory=git_safe_directory,
        **slot_kwargs,
    )
    expected_remote = probe.stdout.strip() if probe.returncode == 0 else ""
    push_extra_env: dict[str, str] | None = None
    origin = _run_git(
        ["remote", "get-url", "origin"], cwd=repo_dir, token=None, safe_directory=git_safe_directory, **slot_kwargs
    )
    if origin.returncode == 0:
        local_remote = _local_remote_safe_directory(origin.stdout, cwd=repo_dir)
        if local_remote is not None:
            push_extra_env = {}
            _append_safe_directory(push_extra_env, local_remote)
    lease = f"--force-with-lease=refs/heads/{branch}:{expected_remote}"
    args = ["push", lease, "--set-upstream", "origin", branch]
    _check(
        _run_git(
            args, cwd=repo_dir, token=token, extra_env=push_extra_env, safe_directory=git_safe_directory, **slot_kwargs
        ),
        ["git", *args],
    )
    return PushResult(head=head, branch=branch)


__all__ = [
    "AUTH_ENV_VAR",
    "GitCommandError",
    "HeadDriftError",
    "PushResult",
    "clone",
    "fetch_prune",
    "fetch_ref",
    "push",
    "redact_credentials",
    "rev_parse_head",
]
