from __future__ import annotations

import asyncio
import importlib
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

rlm_module = importlib.import_module("rlm")

PAYLOAD = {
    "rlm_child_id": "sub-1",
    "name": "worker",
    "session_dir": "/tmp/sessions/parent/sub-1",
    "model": "omnirouter/combo/glm-5.3",
}


class RlmSpawnMirrorKwargTest(unittest.TestCase):
    def test_omits_bb_mirror_by_default_so_the_host_decides(self) -> None:
        host_request = AsyncMock(return_value=PAYLOAD)
        with patch.object(rlm_module, "host_request", host_request):
            handle = asyncio.run(rlm_module.rlm.spawn("task", name="worker"))
        self.assertIsNone(host_request.await_args.args[1]["kwargs"].get("bb_mirror"))
        self.assertEqual(handle.rlm_child_id, "sub-1")

    def test_forces_a_plain_child_on_false(self) -> None:
        host_request = AsyncMock(return_value=PAYLOAD)
        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(rlm_module.rlm.spawn("task", name="worker", bb_mirror=False))
        self.assertIs(host_request.await_args.args[1]["kwargs"]["bb_mirror"], False)

    def test_defers_admission_on_true(self) -> None:
        host_request = AsyncMock(return_value=PAYLOAD)
        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(rlm_module.rlm.spawn("task", name="worker", bb_mirror=True))
        self.assertIs(host_request.await_args.args[1]["kwargs"]["bb_mirror"], True)


if __name__ == "__main__":
    unittest.main()
