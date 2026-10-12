"""Server tests: authentication, origin checks and profile storage.

Run with: python3 -m unittest discover -s tests
"""

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

from aiohttp.test_utils import AioHTTPTestCase

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import app as rlweb  # noqa: E402

PASSWORD = "correct horse battery"


class SessionTokenTest(unittest.TestCase):
    def test_round_trip(self):
        token = rlweb.sign_session(b"k", int(time.time()) + 60)
        self.assertTrue(rlweb.session_valid(b"k", token))

    def test_rejects_wrong_key_expired_and_garbage(self):
        self.assertFalse(rlweb.session_valid(b"other", rlweb.sign_session(b"k", int(time.time()) + 60)))
        self.assertFalse(rlweb.session_valid(b"k", rlweb.sign_session(b"k", int(time.time()) - 1)))
        for bad in (None, "", "abc", "123.", ".abc", "99999999999.deadbeef"):
            self.assertFalse(rlweb.session_valid(b"k", bad), bad)


class ServerTest(AioHTTPTestCase):
    async def get_application(self):
        self.tmp = tempfile.TemporaryDirectory()
        config = rlweb.Config(
            {
                "RLWEB_DATA": self.tmp.name,
                "RLWEB_PASSWORD": PASSWORD,
                "RLWEB_NOVNC_ROOT": str(Path(self.tmp.name) / "missing"),
            }
        )
        return rlweb.create_app(config)

    async def asyncTearDown(self):
        await super().asyncTearDown()
        self.tmp.cleanup()

    async def login(self, password=PASSWORD):
        return await self.client.post("/login", data={"password": password}, allow_redirects=False)

    async def test_requires_login(self):
        resp = await self.client.get("/", allow_redirects=False)
        self.assertEqual(resp.status, 302)
        self.assertEqual(resp.headers["Location"], "/login")
        self.assertEqual((await self.client.get("/api/profiles")).status, 401)
        self.assertEqual((await self.client.get("/ws/input")).status, 401)
        self.assertEqual((await self.client.get("/login")).status, 200)

    async def test_wrong_password(self):
        resp = await self.login("nope")
        self.assertEqual(resp.headers["Location"], "/login?error=1")
        self.assertEqual((await self.client.get("/api/profiles")).status, 401)

    async def test_login_and_profiles_round_trip(self):
        resp = await self.login()
        self.assertEqual(resp.headers["Location"], "/")
        cookie = resp.cookies[rlweb.COOKIE_NAME]
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Strict")

        self.assertEqual(await (await self.client.get("/api/profiles")).json(), {"version": 1, "profiles": {}})
        doc = {"version": 1, "profiles": {"Mobile": {"longPressMs": 500}}}
        resp = await self.client.put("/api/profiles", data=json.dumps(doc))
        self.assertEqual(resp.status, 200)
        self.assertEqual(await (await self.client.get("/api/profiles")).json(), doc)

    async def test_profiles_validation(self):
        await self.login()
        self.assertEqual((await self.client.put("/api/profiles", data="not json")).status, 400)
        self.assertEqual((await self.client.put("/api/profiles", data="[]")).status, 400)
        big = json.dumps({"profiles": {"x": "y" * rlweb.MAX_PROFILES_BYTES}})
        self.assertEqual((await self.client.put("/api/profiles", data=big)).status, 413)

    async def test_cross_origin_requests_rejected(self):
        await self.login()
        evil = {"Origin": "https://evil.example"}
        resp = await self.client.put("/api/profiles", data="{}", headers=evil)
        self.assertEqual(resp.status, 403)
        resp = await self.client.get("/ws/input", headers=evil)
        self.assertEqual(resp.status, 403)
        resp = await self.client.post("/login", data={"password": PASSWORD}, headers=evil, allow_redirects=False)
        self.assertEqual(resp.status, 403)

    async def test_secret_persists(self):
        key = (Path(self.tmp.name) / "secret.key").read_bytes()
        self.assertEqual(rlweb.load_secret(Path(self.tmp.name)), key)


class InputValidationTest(unittest.TestCase):
    class FakeX:
        def __init__(self):
            self.calls = []

        def __getattr__(self, name):
            return lambda *args: self.calls.append((name, *args))

    def test_dispatch(self):
        x = self.FakeX()
        rlweb.apply_input(x, {"t": "move", "x": 1, "y": 2})
        rlweb.apply_input(x, {"t": "btn", "b": 3, "d": True})
        rlweb.apply_input(x, {"t": "wheel", "dir": "up"})
        rlweb.apply_input(x, {"t": "key", "k": "Return", "d": False})
        rlweb.apply_input(x, {"t": "text", "s": "a" * 1000})
        rlweb.apply_input(x, {"t": "release"})
        self.assertEqual(x.calls[:4], [("move", 1, 2), ("button", 3, True), ("wheel", "up"), ("key", "Return", False)])
        self.assertEqual(len(x.calls[4][1]), rlweb.MAX_TEXT_LENGTH)
        self.assertEqual(x.calls[5], ("release_all",))
        with self.assertRaises(ValueError):
            rlweb.apply_input(x, {"t": "shell", "cmd": "rm -rf /"})


if __name__ == "__main__":
    unittest.main()
