"""RLM subagents surfaced as bb mirror threads (PRIME-11).

`spawn_mirror` combines the RLM spawn path with a real bb child thread: the
subagent keeps running as a daemon-hosted RLM session (kernel, agent_message,
rlm.collect unchanged), while the mirror thread streams its live transcript in
bb's general thread list. Requires a daemon-backed depth-0 session inside bb
(`BB_THREAD_ID` set) and the `acp-prime-agent` provider.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import time
from typing import Any

from rlm import host_request, list_subagents, spawn as rlm_spawn

_SUBAGENT_ROSTER_POLL_S = 0.3
_SUBAGENT_ROSTER_TIMEOUT_S = 20.0
_THREAD_ID_PATTERN = re.compile(r"thr_[A-Za-z0-9]+")
_TASK_FRAME = "[task from parent]"


def _bb_env() -> dict[str, str]:
    thread_id = os.environ.get("BB_THREAD_ID")
    project_id = os.environ.get("BB_PROJECT_ID")
    if not thread_id or not project_id:
        raise RuntimeError(
            "bb_subagents.spawn_mirror requires a bb thread environment (BB_THREAD_ID/BB_PROJECT_ID); "
            "use plain rlm.spawn outside bb"
        )
    env = {"BB_THREAD_ID": thread_id, "BB_PROJECT_ID": project_id}
    # Pin the mirror thread to the parent's environment so its frontend boots in
    # the parent's checkout: the rebind validation requires matching cwds, and
    # bb's remembered defaults may otherwise give the mirror a fresh worktree.
    environment_id = os.environ.get("BB_ENVIRONMENT_ID")
    if environment_id:
        env["BB_ENVIRONMENT_ID"] = environment_id
    return env


async def _resolve_active_session_id(handle: Any, timeout_s: float) -> str:
    """Poll the family roster until the admitted child has a live daemon session.

    Matches by rlm_child_id first, then by session name (a same-named passive
    row cannot shadow the exact child id).
    """
    child_id = getattr(handle, "rlm_child_id", "")
    name = getattr(handle, "name", "")
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    last_error = "roster never listed the child"
    while loop.time() < deadline:
        try:
            subagents = await list_subagents()
            for agent in subagents:
                if agent.active_session_id and (agent.rlm_child_id == child_id or agent.session_name == name):
                    return agent.active_session_id
            last_error = f"child {name!r} ({child_id}) has no active session yet"
        except Exception as error:  # roster briefly unavailable during admission
            last_error = str(error)
        await asyncio.sleep(_SUBAGENT_ROSTER_POLL_S)
    raise RuntimeError(
        f"bb mirror spawn failed: {last_error} after {timeout_s:.0f}s. "
        f"Delete the waiting child (rlm.delete_subagent('{child_id}')) and spawn again, or use plain rlm.spawn."
    )


def _write_mirror_claim(nonce: str, target: str) -> None:
    """Write the single-use claim the ACP frontend consumes on boot.

    The claim carries a 10-minute TTL server-side (acp-mode validates it), so
    the skill does not need to clean it up: a claim whose thread never boots
    expires on its own.
    """
    agent_dir = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.path.expanduser("~/.prime/agent")
    claims_dir = os.path.join(agent_dir, "acp-mirror-claims")
    os.makedirs(claims_dir, exist_ok=True)
    with open(os.path.join(claims_dir, f"{nonce}.json"), "w", encoding="utf-8") as claim_file:
        json.dump({"target": target, "createdAtMs": int(time.time() * 1000)}, claim_file)


async def _delete_waiting_child(handle: Any) -> None:
    """Best-effort cleanup of a deferred child whose mirror thread never existed."""
    child_id = getattr(handle, "rlm_child_id", None)
    if not child_id:
        return
    try:
        await host_request("rlm.delete_subagent", {"target": child_id})
    except Exception:
        pass


class BbSpawnFailed(RuntimeError):
    """`bb thread spawn` itself failed; no mirror thread exists."""


async def _run_bb(args: list[str], stdin_text: str | None = None) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        "bb",
        *args,
        stdin=asyncio.subprocess.PIPE if stdin_text is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate(stdin_text.encode() if stdin_text is not None else None)
    if proc.returncode != 0:
        raise BbSpawnFailed(f"bb {' '.join(args[:2])} failed: {stderr.decode(errors='replace').strip()}")
    try:
        return json.loads(stdout.decode(errors="replace"))
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"bb {' '.join(args[:2])} returned invalid JSON: {error}; stderr: {stderr.decode(errors='replace').strip()[:400]}"
        ) from error


def _title_for(name: str, task: str) -> str:
    summary = " ".join(task.split())[:60]
    return f"{name} · {summary}" if summary else name


async def spawn_mirror(
    task: str,
    name: str,
    *,
    model: str | None = None,
    thinking: str | None = None,
    title: str | None = None,
) -> dict[str, Any]:
    """Spawn an RLM subagent and a visible bb mirror thread that drives it.

    The child is admitted with its admission prompt deferred (`rlm.spawn`
    `bb_mirror=True`); the mirror thread's first prompt — the task, prefixed
    with an `[rlm-mirror:<nonce>]` marker resolving a single-use claim file —
    becomes the child's admission turn through the mirror thread's ACP
    frontend. Results still arrive through agent_message replies or files; the
    parent consumes them with rlm.collect / list_subagents as usual.

    Args:
        task: The subagent task text (also the mirror thread's prompt body).
        name: Unique sibling name for the subagent.
        model: Optional exact provider/model selector for the child.
        thinking: Optional child reasoning level.
        title: Optional mirror thread title; defaults to `<name> · <task summary>`.

    Returns:
        {"handle": rlm spawn handle fields, "active_session_id", "bb_thread_id", "mirror_prompt"}.
    """
    env = _bb_env()
    if not isinstance(task, str) or not task.strip():
        raise TypeError("task must be a non-empty string")
    if not isinstance(name, str) or not name.strip():
        raise TypeError("name must be a non-empty string")

    handle = await rlm_spawn(task, name=name, model=model, thinking=thinking, bb_mirror=True)
    # The daemon worker boots asynchronously; the admission payload carries no
    # live session id, so resolve it from the parent-scoped roster.
    active_session_id = await _resolve_active_session_id(handle, _SUBAGENT_ROSTER_TIMEOUT_S)

    nonce = secrets.token_hex(16)
    _write_mirror_claim(nonce, active_session_id)
    mirror_prompt = f"[rlm-mirror:{nonce}]\n{_TASK_FRAME}\n\n{task}"

    try:
        spawned = await _run_bb(
            [
                "thread",
                "spawn",
                "--json",
                "--project",
                env["BB_PROJECT_ID"],
                *(
                    ["--environment", env["BB_ENVIRONMENT_ID"]]
                    if env.get("BB_ENVIRONMENT_ID")
                    else []
                ),
                "--parent-self",
                "--provider",
                "acp-prime-agent",
                "--title",
                title if isinstance(title, str) and title.strip() else _title_for(name, task),
                "--prompt-file",
                "-",
            ],
            stdin_text=mirror_prompt,
        )
    except BbSpawnFailed:
        # No thread was created, so nothing will ever prompt the deferred child:
        # delete it and surface the failure.
        await _delete_waiting_child(handle)
        raise

    thread_id = spawned.get("id") if isinstance(spawned, dict) else None
    if not (isinstance(thread_id, str) and _THREAD_ID_PATTERN.fullmatch(thread_id)):
        # The thread exists (it will consume the claim and rebind); do NOT retry
        # blindly — that would create a second live child + mirror thread.
        raise RuntimeError(
            f"bb thread spawn succeeded but returned no thread id: {spawned!r}; "
            "the mirror thread exists — reuse it instead of spawning again"
        )

    return {
        "handle": {
            "rlm_child_id": handle.rlm_child_id,
            "name": handle.name,
            "session_dir": str(handle.session_dir),
            "model": handle.model,
        },
        "active_session_id": active_session_id,
        "bb_thread_id": thread_id,
        "mirror_prompt": mirror_prompt,
    }
