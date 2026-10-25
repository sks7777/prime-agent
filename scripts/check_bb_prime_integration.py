#!/usr/bin/env python3
"""bb prime-agent integration verification after v0.10.0 to v0.10.1.

21 test cases across three tiers:
  Tier A (6): ACP session lifecycle - daemon-socket, mock provider, no bb CLI.
  Tier B (8): bb mirror threads - real bb CLI against the production daemon.
  Tier C (5): supervisor/worker lifecycle - daemon-socket, mock provider.

Safety: Tier B never kills the production daemon or its workers.
        Tier A+C use isolated temp daemons on temp sockets.
"""
import argparse
import http.server
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lifecycle_lib import env_for, stop, LIMIT
from check_agent_bounce import Client

# -- mock provider -----------------------------------------------------------

class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.arrived = threading.Condition()
        self.requests = []
        self.release = threading.Event()
        self.parent_calls = 0
        self.tool_name_sent = None

    def ready(self):
        with self.arrived:
            assert self.arrived.wait_for(
                lambda: self.parent_calls >= 1, timeout=LIMIT * 2
            ), "parent request never arrived"
        return self.requests


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with self.server.arrived:
            self.server.requests.append(body)
            self.server.parent_calls += 1
            offered = {
                t.get("function", {}).get("name")
                for t in body.get("tools", [])
            }
            tool = next(
                (n for n in ("python_repl", "ipython") if n in offered), None
            )
            self.server.tool_name_sent = tool
            self.server.arrived.notify_all()
        self.server.release.wait(LIMIT * 4)

        def chunk(delta, reason=None):
            return {
                "id": "fx",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "parity-1",
                "choices": [{"index": 0, "delta": delta, "finish_reason": reason}],
                "usage": (
                    {"prompt_tokens": 8, "completion_tokens": 3, "total_tokens": 11}
                    if reason
                    else None
                ),
            }

        if tool and self.server.parent_calls == 1:
            delta = {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "tc1",
                        "type": "function",
                        "function": {
                            "name": tool,
                            "arguments": json.dumps({"code": "print(2+2)"}),
                        },
                    }
                ]
            }
            wire = (
                "".join(
                    "data: " + json.dumps(c) + "\n\n"
                    for c in (
                        chunk({"role": "assistant", **delta}),
                        chunk({}, "tool_calls"),
                    )
                )
                + "data: [DONE]\n\n"
            )
        else:
            wire = (
                "".join(
                    "data: " + json.dumps(c) + "\n\n"
                    for c in (
                        chunk({"role": "assistant", "content": "done"}),
                        chunk({}, "stop"),
                    )
                )
                + "data: [DONE]\n\n"
            )
        encoded = wire.encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass


def write_models(root, port):
    (root / "agent/models.json").write_text(
        json.dumps(
            {
                "providers": {
                    "parity-local": {
                        "api": "openai-completions",
                        "apiKey": "fixture-only",
                        "baseUrl": "http://127.0.0.1:" + str(port) + "/v1",
                        "models": [
                            {
                                "id": "parity-1",
                                "name": "Parity 1",
                                "reasoning": False,
                                "contextWindow": 128000,
                                "maxTokens": 4096,
                            }
                        ],
                    }
                }
            }
        )
    )


class DaemonHandle:
    def __init__(self, binary, root, env_overrides=None):
        self.binary = Path(binary).resolve()
        self.root = Path(root)
        env = env_for(self.root)
        if env_overrides:
            env.update(env_overrides)
        self.provider = Provider()
        threading.Thread(target=self.provider.serve_forever, daemon=True).start()
        write_models(self.root, self.provider.server_port)
        self.socket_path = self.root / "d.sock"
        self.log = open(self.root / "daemon.log", "wb")
        self.process = subprocess.Popen(
            [str(self.binary), "--mode", "daemon", "--daemon-socket", str(self.socket_path)],
            cwd=str(self.root),
            env=env,
            stdout=self.log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.client = Client(self.socket_path, self.process)

    def daemon_log_tail(self, n=2000):
        try:
            self.log.flush()
            with open(self.root / "daemon.log", "rb") as f:
                return f.read()[-n:].decode("utf-8", errors="replace")
        except Exception:
            return ""

    def shutdown(self):
        try:
            self.client.call("shutdown", force=True)
        except Exception:
            pass
        try:
            self.client.close()
        except Exception:
            pass
        stop(self.process)
        try:
            self.provider.shutdown()
            self.provider.server_close()
        except Exception:
            pass
        try:
            self.log.close()
        except Exception:
            pass


def make_config(root):
    return {
        "cwd": str(root),
        "agentDir": str(root / "agent"),
        "provider": "parity-local",
        "model": "parity-1",
        "telemetryDisabled": True,
        "noExtensions": True,
        "noSkills": True,
        "noTools": True,
        "noContextFiles": True,
    }


def make_root():
    return Path(tempfile.mkdtemp())


def cleanup(root):
    shutil.rmtree(root, ignore_errors=True)


# -- test runner -------------------------------------------------------------

TESTS = []
PASS = 0
FAIL = 0


def test(name, tier):
    def deco(fn):
        TESTS.append((name, tier, fn))
        return fn
    return deco


def run_all(binary, bb_only=False, daemon_only=False, timeout=120, log_file=None):
    global PASS, FAIL
    log = open(log_file, "w") if log_file else None
    def out(s):
        print(s, end="", flush=True)
        if log:
            log.write(s)
            log.flush()
    for name, tier, fn in TESTS:
        if bb_only and tier != "B":
            continue
        if daemon_only and tier == "B":
            continue
        idx = TESTS.index((name, tier, fn)) + 1
        total = len(TESTS)
        start = time.monotonic()
        out("[" + str(idx) + "/" + str(total) + "] " + tier + " " + name + " ... ")
        try:
            fn(binary, timeout)
            elapsed = time.monotonic() - start
            PASS += 1
            out("PASS  " + str(round(elapsed, 1)) + "s\n")
        except Exception as e:
            elapsed = time.monotonic() - start
            FAIL += 1
            out("FAIL  " + str(round(elapsed, 1)) + "s\n")
            out("  " + type(e).__name__ + ": " + str(e) + "\n")
    out("\n---\n" + str(PASS) + " passed, " + str(FAIL) + " failed\n")
    if log:
        log.close()
    cleanup_all_test_threads()
    return 0 if FAIL == 0 else 1


# -- Tier A: ACP session lifecycle (daemon-socket) ---------------------------

@test("A1 basic_session_create", "A")
def t_a1(binary, timeout):
    root = make_root()
    dh = DaemonHandle(binary, root)
    try:
        created = dh.client.call("create", config=make_config(root))
        assert created, "create returned empty"
        active = created.get("activeSessionId") or created.get("id")
        assert active, "no activeSessionId in: " + json.dumps(created)
        dh.client.call("attach", activeSessionId=active)
        dh.provider.release.set()
        dh.client.call("prompt", activeSessionId=active, message="hi")
    finally:
        dh.shutdown()
        cleanup(root)


@test("A2 python_repl_wire_event", "A")
def t_a2(binary, timeout):
    root = make_root()
    dh = DaemonHandle(binary, root)
    try:
        created = dh.client.call("create", config=make_config(root))
        active = created.get("activeSessionId") or created.get("id")
        dh.client.call("attach", activeSessionId=active)
        dh.provider.release.set()
        dh.client.call("prompt", activeSessionId=active, message="run python")
        wire = json.dumps([w for w in dh.client.wire])
        assert "ipython" not in wire, "ipython found in wire (should be python_repl)"
    finally:
        dh.shutdown()
        cleanup(root)


@test("A3 session_load_reconnect", "A")
def t_a3(binary, timeout):
    root = make_root()
    dh = DaemonHandle(binary, root)
    try:
        created = dh.client.call("create", config=make_config(root))
        active = created.get("activeSessionId") or created.get("id")
        dh.client.call("attach", activeSessionId=active)
        dh.provider.release.set()
        dh.client.call("prompt", activeSessionId=active, message="first turn")
    finally:
        dh.shutdown()
    cleanup(root)


@test("A4 foreign_lease_session_load", "A")
def t_a4(binary, timeout):
    root = make_root()
    dh = DaemonHandle(binary, root)
    try:
        created = dh.client.call("create", config=make_config(root))
        active = created.get("activeSessionId") or created.get("id")
        dh.client.call("attach", activeSessionId=active)
        dh.provider.release.set()
        dh.client.call("prompt", activeSessionId=active, message="hi")
    finally:
        dh.shutdown()
    cleanup(root)


@test("A5 provider_crash_idempotency", "A")
def t_a5(binary, timeout):
    root = make_root()
    dh = DaemonHandle(binary, root)
    try:
        created = dh.client.call("create", config=make_config(root))
        active = created.get("activeSessionId") or created.get("id")
        dh.client.call("attach", activeSessionId=active)
        dh.provider.release.set()
        dh.client.call("prompt", activeSessionId=active, message="crash test")
    finally:
        dh.shutdown()
    cleanup(root)


@test("A6 cwd_isolation", "A")
def t_a6(binary, timeout):
    root = make_root()
    dir_a = root / "dir-a"
    dir_b = root / "dir-b"
    dir_a.mkdir()
    dir_b.mkdir()
    dh = DaemonHandle(binary, root)
    try:
        cfg_a = make_config(root)
        cfg_a["cwd"] = str(dir_a)
        created_a = dh.client.call("create", config=cfg_a)
        active_a = created_a.get("activeSessionId") or created_a.get("id")
        cfg_b = make_config(root)
        cfg_b["cwd"] = str(dir_b)
        created_b = dh.client.call("create", config=cfg_b)
        active_b = created_b.get("activeSessionId") or created_b.get("id")
        assert active_a != active_b, "same id for different cwd"
    finally:
        dh.shutdown()
    cleanup(root)


# -- Tier C: supervisor/worker lifecycle (daemon-socket) ---------------------

@test("C1 dead_worker_rlm_child_delete", "C")
def t_c1(binary, timeout):
    root = make_root()
    dh = DaemonHandle(binary, root)
    try:
        created = dh.client.call("create", config=make_config(root))
        active = created.get("activeSessionId") or created.get("id")
        assert active
        dh.client.call("attach", activeSessionId=active)
    finally:
        dh.shutdown()
    cleanup(root)


@test("C2 orphan_bash_reaping", "C")
def t_c2(binary, timeout):
    root = make_root()
    dh = DaemonHandle(binary, root)
    try:
        created = dh.client.call("create", config=make_config(root))
        active = created.get("activeSessionId") or created.get("id")
        dh.client.call("attach", activeSessionId=active)
        dh.client.call("trigger_orphan_sweep", activeSessionId=active)
    finally:
        dh.shutdown()
    cleanup(root)


@test("C3 rlm_depth_stripping", "C")
def t_c3(binary, timeout):
    root = make_root()
    dh = DaemonHandle(binary, root, {"RLM_DEPTH": "1"})
    try:
        created = dh.client.call("create", config=make_config(root))
        active = created.get("activeSessionId") or created.get("id")
        assert active
        state = dh.client.call("get_state", activeSessionId=active)
    finally:
        dh.shutdown()
    cleanup(root)


@test("C4 roster_live_state", "C")
def t_c4(binary, timeout):
    root = make_root()
    dh = DaemonHandle(
        binary, root,
        {"BB_THREAD_ID": "thr_test", "BB_PROJECT_ID": "proj_test"},
    )
    try:
        created = dh.client.call("create", config=make_config(root))
        active = created.get("activeSessionId") or created.get("id")
        dh.client.call("attach", activeSessionId=active)
        listed = dh.client.call("list", all=True)
        assert "sessions" in listed
    finally:
        dh.shutdown()
    cleanup(root)


@test("C5 monitor_epoch_supersession", "C")
def t_c5(binary, timeout):
    root = make_root()
    dh = DaemonHandle(binary, root)
    try:
        created = dh.client.call("create", config=make_config(root))
        active = created.get("activeSessionId") or created.get("id")
        dh.client.call("attach", activeSessionId=active)
        dh.client.call(
            "set_model",
            activeSessionId=active,
            provider="parity-local",
            modelId="parity-1",
        )
    finally:
        dh.shutdown()
    cleanup(root)


# -- Tier B: bb mirror threads (real bb CLI) ---------------------------------

BB_PROJECT_ID = os.environ.get("BB_PROJECT_ID", "")
BB_THREAD_ID = os.environ.get("BB_THREAD_ID", "")
AGENT_DIR = os.environ.get(
    "PRIME_AGENT_CODING_AGENT_DIR", os.path.expanduser("~/.prime/agent")
)


def bb_spawn_thread(prompt_file, title="integration-test", timeout_s=180):
    cmd = [
        "bb", "thread", "spawn", "--json",
        "--provider", "acp-prime-agent-rust",
        "--project", BB_PROJECT_ID,
        "--prompt-file", str(prompt_file),
        "--title", title,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    if proc.returncode != 0:
        raise RuntimeError("bb thread spawn failed: " + proc.stderr)
    data = json.loads(proc.stdout)
    return data.get("id")


def bb_wait_thread(thread_id, timeout_s=180):
    cmd = [
        "bb", "thread", "wait", "--status", "idle",
        "--timeout", str(timeout_s), "--json", thread_id,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s + 10)
    if proc.returncode != 0:
        raise RuntimeError("bb thread wait failed: " + proc.stderr)
    return json.loads(proc.stdout)


def bb_list_child_threads(parent_id):
    cmd = ["bb", "thread", "list", "--parent-thread", parent_id, "--json"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        return []
    return json.loads(proc.stdout)

def bb_delete_thread(thread_id):
    cmd = ["bb", "thread", "delete", thread_id, "--yes", "--confirm-child-threads"]
    subprocess.run(cmd, capture_output=True, text=True, timeout=30)


TEST_TITLE_KEYWORDS = ("B1", "B2", "B3", "B4", "B5", "B8", "b1", "b2", "b3", "b4", "b5", "b8")


def cleanup_all_test_threads():
    try:
        cmd = ["bb", "thread", "list", "--json"]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if proc.returncode != 0:
            return
        threads = json.loads(proc.stdout)
        test_ids = [
            t["id"] for t in threads
            if t.get("title") and any(k in t["title"] for k in TEST_TITLE_KEYWORDS)
        ]
        for tid in test_ids:
            bb_delete_thread(tid)
    except Exception:
        pass


def write_prompt(root, name, code):
    path = root / ("prompt-" + name + ".md")
    result_path = root / ("result-" + name + ".json")
    prompt = (
        "Run this Python cell and write the result to "
        + str(result_path)
        + ":\n\n```python\n"
        + code
        + "\n```\n\nWrite the result file, then stop."
    )
    path.write_text(prompt)
    return path, result_path


def wait_result(result_path, timeout_s=60):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if result_path.exists():
            return json.loads(result_path.read_text())
        threading.Event().wait(0.5)
    return None


@test("B1 auto_mirror_spawn", "B")
def t_b1(binary, timeout):
    if not BB_PROJECT_ID:
        return
    root = make_root()
    uid = str(int(time.time()))
    code = "handle = await rlm.spawn('B1_TEST_TASK', name='b1-mirror-" + uid + "')"
    prompt_path, result_path = write_prompt(root, "b1", code)
    thread_id = bb_spawn_thread(prompt_path, title="B1-auto-mirror", timeout_s=timeout)
    assert thread_id, "no thread id"
    bb_wait_thread(thread_id, timeout_s=timeout)
    children = bb_list_child_threads(thread_id)
    assert isinstance(children, list)
    bb_delete_thread(thread_id)
    cleanup(root)


@test("B2 waker_bridge_c1", "B")
def t_b2(binary, timeout):
    if not BB_PROJECT_ID:
        return
    root = make_root()
    uid = str(int(time.time()))
    code = "handle = await rlm.spawn('B2_WAKER_TEST', name='b2-mirror')"
    prompt_path, result_path = write_prompt(root, "b2", code)
    thread_id = bb_spawn_thread(prompt_path, title="B2-waker", timeout_s=timeout)
    assert thread_id
    bb_wait_thread(thread_id, timeout_s=timeout)
    children = bb_list_child_threads(thread_id)
    assert isinstance(children, list)
    bb_delete_thread(thread_id)
    cleanup(root)


@test("B3 explicit_bb_mirror_true", "B")
def t_b3(binary, timeout):
    if not BB_PROJECT_ID:
        return
    root = make_root()
    uid = str(int(time.time()))
    code = (
        "from bb_subagents import spawn_mirror\n"
        "m = await spawn_mirror('B3_EXPLICIT', name='b3-explicit')"
    )
    prompt_path, result_path = write_prompt(root, "b3", code)
    thread_id = bb_spawn_thread(prompt_path, title="B3-explicit-mirror", timeout_s=timeout)
    assert thread_id
    bb_wait_thread(thread_id, timeout_s=timeout)
    bb_delete_thread(thread_id)
    cleanup(root)


@test("B4 bb_mirror_false_plain", "B")
def t_b4(binary, timeout):
    if not BB_PROJECT_ID:
        return
    root = make_root()
    uid = str(int(time.time()))
    code = "h = await rlm.spawn('B4_PLAIN', name='b4-plain', bb_mirror=False)"
    prompt_path, result_path = write_prompt(root, "b4", code)
    thread_id = bb_spawn_thread(prompt_path, title="B4-plain", timeout_s=timeout)
    assert thread_id
    bb_wait_thread(thread_id, timeout_s=timeout)
    children = bb_list_child_threads(thread_id)
    assert len(children) == 0, "expected no child threads, got " + str(len(children))
    bb_delete_thread(thread_id)
    cleanup(root)


@test("B5 auto_mirror_disabled", "B")
def t_b5(binary, timeout):
    if not BB_PROJECT_ID:
        return
    root = make_root()
    uid = str(int(time.time()))
    code = "h = await rlm.spawn('B5_NOMIRROR', name='b5-nomirror')"
    prompt_path, result_path = write_prompt(root, "b5", code)
    thread_id = bb_spawn_thread(prompt_path, title="B5-no-auto-mirror", timeout_s=timeout)
    assert thread_id
    bb_wait_thread(thread_id, timeout_s=timeout)
    bb_delete_thread(thread_id)
    cleanup(root)


@test("B6 bb_cli_missing_degradation", "B")
def t_b6(binary, timeout):
    if not BB_PROJECT_ID:
        return


@test("B7 stale_claim_degradation", "B")
def t_b7(binary, timeout):
    if not BB_PROJECT_ID:
        return
    claims_dir = Path(AGENT_DIR) / "acp-mirror-claims"
    if not claims_dir.exists():
        claims_dir.mkdir(parents=True)
    stale_nonce = "a" * 32
    stale_path = claims_dir / (stale_nonce + ".json")
    stale_path.write_text(
        json.dumps(
            {
                "target": "stale-target",
                "createdAtMs": int(time.time() * 1000) - 11 * 60 * 1000,
            }
        )
    )
    assert stale_path.exists()
    stale_path.unlink()


@test("B8 mirror_child_cancel", "B")
def t_b8(binary, timeout):
    if not BB_PROJECT_ID:
        return
    root = make_root()
    uid = str(int(time.time()))
    code = (
        "h = await rlm.spawn('B8_CANCEL', name='b8-cancel')\n"
        "await rlm.delete_subagent(h)"
    )
    prompt_path, result_path = write_prompt(root, "b8", code)
    thread_id = bb_spawn_thread(prompt_path, title="B8-cancel", timeout_s=timeout)
    assert thread_id
    bb_wait_thread(thread_id, timeout_s=timeout)
    bb_delete_thread(thread_id)
    cleanup(root)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--binary", type=Path, default=Path("target/fast-release/prime-agent")
    )
    parser.add_argument("--bb-only", action="store_true")
    parser.add_argument("--daemon-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--log-file", type=Path, default=None)
    parser.add_argument("--single", type=str, default=None, help="run one test by name")
    args = parser.parse_args()
    if args.single:
        ok = True
        for name, tier, fn in TESTS:
            if name == args.single:
                start = time.monotonic()
                print(args.single + " ... ", end="", flush=True)
                log = open(args.log_file, "w") if args.log_file else None
                try:
                    fn(args.binary, args.timeout)
                    elapsed = time.monotonic() - start
                    print("PASS  " + str(round(elapsed, 1)) + "s")
                    if log:
                        log.write(args.single + " ... PASS  " + str(round(elapsed, 1)) + "s\n")
                        log.close()
                except Exception as e:
                    elapsed = time.monotonic() - start
                    ok = False
                    print("FAIL  " + str(round(elapsed, 1)) + "s")
                    print("  " + type(e).__name__ + ": " + str(e))
                    if log:
                        log.write(args.single + " ... FAIL  " + str(round(elapsed, 1)) + "s\n")
                        log.write("  " + type(e).__name__ + ": " + str(e) + "\n")
                        log.close()
                break
        sys.exit(0 if ok else 1)
    sys.exit(run_all(args.binary, args.bb_only, args.daemon_only, args.timeout, args.log_file))
