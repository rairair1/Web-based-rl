"""Tests for running RuneLite with a device-provided Jagex session.

Run with: python3 -m unittest discover -s tests
"""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import AioHTTPTestCase

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import app as rlweb  # noqa: E402
from supervisor import RuneLiteSupervisor, child_environment, validate_session  # noqa: E402

SESSION = {"JX_SESSION_ID": "sess", "JX_CHARACTER_ID": "123", "JX_DISPLAY_NAME": "Zezima"}


class ValidateTest(unittest.TestCase):
    def test_keeps_only_known_keys(self):
        self.assertEqual(validate_session({**SESSION, "PATH": "/evil", "LD_PRELOAD": "x"}), SESSION)

    def test_rejects_bad_input(self):
        for bad in ([], {"JX_SESSION_ID": "s"}, {**SESSION, "JX_SESSION_ID": "a\nb"}, {**SESSION, "JX_DISPLAY_NAME": 5}):
            with self.assertRaises(ValueError, msg=bad):
                validate_session(bad)

    def test_child_environment_drops_server_secrets(self):
        env = child_environment({"PATH": "/bin", "RLWEB_PASSWORD": "pw", "JX_SESSION_ID": "stale"}, SESSION)
        self.assertEqual(env, {"PATH": "/bin", **SESSION})
        self.assertEqual(child_environment({"PATH": "/bin"}, None), {"PATH": "/bin"})


class SupervisorTest(unittest.IsolatedAsyncioTestCase):
    """Runs a stand-in process that records the environment it was started with."""

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.log = Path(self.tmp.name) / "starts.jsonl"
        script = (
            "import json, os, sys, time\n"
            "keys = ['JX_DISPLAY_NAME', 'RLWEB_PASSWORD']\n"
            "with open(sys.argv[1], 'a') as f: f.write(json.dumps({k: os.environ.get(k) for k in keys}) + '\\n')\n"
            "time.sleep(60)\n"
        )
        self.sup = RuneLiteSupervisor(sys.executable, ["-c", script, str(self.log)], {"RLWEB_PASSWORD": "pw"})
        self.sup.start()

    async def asyncTearDown(self):
        await self.sup.stop()
        self.tmp.cleanup()

    async def starts(self, count):
        for _ in range(100):
            if self.log.exists() and len(self.log.read_text().splitlines()) >= count:
                return [json.loads(line) for line in self.log.read_text().splitlines()]
            await asyncio.sleep(0.05)
        self.fail(f"expected {count} starts")

    async def test_restart_with_and_without_session(self):
        self.assertEqual(await self.starts(1), [{"JX_DISPLAY_NAME": None, "RLWEB_PASSWORD": None}])
        await self.sup.restart(SESSION)
        self.assertEqual((await self.starts(2))[1], {"JX_DISPLAY_NAME": "Zezima", "RLWEB_PASSWORD": None})
        await self.sup.restart()  # keeps the session
        self.assertEqual((await self.starts(3))[2]["JX_DISPLAY_NAME"], "Zezima")
        await self.sup.restart(None)
        self.assertEqual((await self.starts(4))[3]["JX_DISPLAY_NAME"], None)

    async def test_stop_ends_the_process(self):
        await self.starts(1)
        process = self.sup.process
        await self.sup.stop()
        self.assertIsNotNone(process.returncode)


class FakeSupervisor:
    def __init__(self):
        self.session = None
        self.restarts = []

    @property
    def display_name(self):
        return (self.session or {}).get("JX_DISPLAY_NAME")

    def start(self):
        pass

    async def stop(self):
        pass

    async def restart(self, session=...):
        if session is not ...:
            self.session = session
        self.restarts.append(session)


class SessionEndpointTest(AioHTTPTestCase):
    async def get_application(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = FakeSupervisor()
        config = rlweb.Config({"RLWEB_DATA": self.tmp.name, "RLWEB_PASSWORD": "correct horse battery"})
        return rlweb.create_app(config, self.fake)

    async def asyncTearDown(self):
        await super().asyncTearDown()
        self.tmp.cleanup()

    async def test_requires_login(self):
        self.assertEqual((await self.client.get("/api/runelite/session")).status, 401)
        self.assertEqual((await self.client.put("/api/runelite/session", json=SESSION)).status, 401)

    async def test_set_status_clear(self):
        await self.client.post("/login", data={"password": "correct horse battery"}, allow_redirects=False)
        status = await (await self.client.get("/api/runelite/session")).json()
        self.assertEqual(status, {"active": False, "displayName": None})

        resp = await self.client.put("/api/runelite/session", json={**SESSION, "EXTRA": "dropped"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.fake.session, SESSION)
        status = await (await self.client.get("/api/runelite/session")).json()
        self.assertEqual(status, {"active": True, "displayName": "Zezima"})

        self.assertEqual((await self.client.put("/api/runelite/session", json={"JX_SESSION_ID": "x"})).status, 400)
        self.assertEqual((await self.client.delete("/api/runelite/session")).status, 200)
        self.assertIsNone(self.fake.session)
        self.assertEqual((await self.client.post("/api/runelite/restart")).status, 200)
        self.assertEqual(self.fake.restarts, [SESSION, None, ...])

    async def test_nothing_written_to_disk(self):
        await self.client.post("/login", data={"password": "correct horse battery"}, allow_redirects=False)
        await self.client.put("/api/runelite/session", json=SESSION)
        for path in Path(self.tmp.name).rglob("*"):
            if path.is_file():
                self.assertNotIn(b"sess", path.read_bytes().replace(b"session", b""), path)

    async def test_security_headers(self):
        resp = await self.client.get("/login")
        csp = resp.headers["Content-Security-Policy"]
        self.assertIn("script-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)


if __name__ == "__main__":
    unittest.main()
