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
import tempfile
from pathlib import Path
from typing import Any

from rlm import host_request, list_subagents

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
    return {"BB_THREAD_ID": thread_id, "BB_PROJECT_ID": project_id}


async def _resolve_active_session_id(name: str, timeout_s: float) -> str:
    """Poll the family roster until the admitted child has a live daemon session."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    last_error = "roster never listed the child"
    while loop.time() < deadline:
        try:
            subagents = await list_subagents()
            for agent in subagents:
                if agent.session_name == name and agent.active_session_id:
                    return agent.active_session_id
            last_error = f"child {name!r} has no active session yet"
        except Exception as error:  # roster briefly unavailable during admission
            last_error = str(error)
        await asyncio.sleep(_SUBAGENT_ROSTER_POLL_S)
    raise RuntimeError(
        f"bb mirror spawn failed: {last_error} after {timeout_s:.0f}s. "
        "Delete the waiting child (rlm.delete_subagent) and spawn again, or use plain rlm.spawn."
    )


async def _run_bb(args: list[str]) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        "bb",
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"bb {' '.join(args[:2])} failed: {stderr.decode(errors='replace').strip()}")
    return json.loads(stdout.decode(errors="replace"))


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
    with an `[rlm-attach:<active_session_id>]` marker — becomes the child's
    admission turn through the mirror thread's ACP frontend. Results still
    arrive through agent_message replies or files; the parent consumes them
    with rlm.collect / list_subagents as usual.

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

    kwargs: dict[str, Any] = {"name": name, "bb_mirror": True}
    if model is not None:
        kwargs["model"] = model
    if thinking is not None:
        kwargs["thinking"] = thinking
    payload = await host_request("rlm.run", {"prompt": task, "kwargs": kwargs})
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.spawn returned an invalid spawn handle")

    active_session_id = await _resolve_active_session_id(name, _SUBAGENT_ROSTER_TIMEOUT_S)
    mirror_prompt = f"[rlm-attach:{active_session_id}]\n{_TASK_FRAME}\n\n{task}"

    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as prompt_file:
        prompt_file.write(mirror_prompt)
        prompt_path = prompt_file.name

    try:
        args = [
            "thread",
            "spawn",
            "--json",
            "--project",
            env["BB_PROJECT_ID"],
            "--parent-self",
            "--provider",
            "acp-prime-agent",
            "--title",
            title if isinstance(title, str) and title.strip() else _title_for(name, task),
            "--prompt-file",
            prompt_path,
        ]
        spawned = await _run_bb(args)
    finally:
        try:
            os.unlink(prompt_path)
        except OSError:
            pass

    thread_id = spawned.get("id") if isinstance(spawned, dict) else None
    if not (isinstance(thread_id, str) and _THREAD_ID_PATTERN.fullmatch(thread_id)):
        raise RuntimeError(f"bb thread spawn returned no thread id: {spawned!r}")

    handle = {key: payload[key] for key in ("rlm_child_id", "name", "session_dir", "model") if key in payload}
    return {
        "handle": handle,
        "active_session_id": active_session_id,
        "bb_thread_id": thread_id,
        "mirror_prompt": mirror_prompt,
    }
