"""Runs RuneLite and restarts it when it exits.

A Jagex Account session can be handed to RuneLite the way the Jagex Launcher
does it: as JX_* environment variables. The session is kept only in memory
(here and in RuneLite's process environment) and is never written to disk.
The player's own device stores it and sends it again when needed.
"""

import asyncio
import logging
import os
import re
import signal

log = logging.getLogger(__name__)

# Variables the Jagex Launcher passes to RuneLite.
SESSION_KEYS = ("JX_SESSION_ID", "JX_CHARACTER_ID", "JX_DISPLAY_NAME", "JX_ACCESS_TOKEN", "JX_REFRESH_TOKEN")
REQUIRED_KEYS = ("JX_SESSION_ID", "JX_CHARACTER_ID")
MAX_VALUE_LENGTH = 8192
SAFE_VALUE = re.compile(r"^[\x20-\x7e]*$")
RESTART_DELAY = 2.0
STOP_TIMEOUT = 10.0


def validate_session(data):
    """Returns the allowed JX_* variables from untrusted input, or raises ValueError."""
    if not isinstance(data, dict):
        raise ValueError("expected an object of JX_* variables")
    session = {}
    for key in SESSION_KEYS:
        value = data.get(key)
        if value is None or value == "":
            continue
        if not isinstance(value, str) or len(value) > MAX_VALUE_LENGTH or not SAFE_VALUE.match(value):
            raise ValueError(f"invalid value for {key}")
        session[key] = value
    missing = [key for key in REQUIRED_KEYS if key not in session]
    if missing:
        raise ValueError("missing " + ", ".join(missing))
    return session


def child_environment(base, session):
    """RuneLite's environment: no web-server secrets, plus the session if any."""
    env = {k: v for k, v in base.items() if not k.startswith(("RLWEB_", "JX_"))}
    env.update(session or {})
    return env


class RuneLiteSupervisor:
    def __init__(self, command, args=(), base_env=None):
        self.command = command
        self.args = list(args)
        self.base_env = dict(os.environ if base_env is None else base_env)
        self.session = None
        self.process = None
        self._task = None
        self._stopping = False
        self._restart = asyncio.Event()

    @property
    def display_name(self):
        return (self.session or {}).get("JX_DISPLAY_NAME")

    def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def _run(self):
        while not self._stopping:
            self._restart.clear()
            try:
                self.process = await asyncio.create_subprocess_exec(
                    self.command,
                    *self.args,
                    env=child_environment(self.base_env, self.session),
                    start_new_session=True,
                )
            except OSError as exc:
                log.error("cannot start RuneLite (%s): %s", self.command, exc)
                await asyncio.sleep(10)
                continue
            log.info("RuneLite started (pid %d, %s)", self.process.pid, "with session" if self.session else "no session")
            code = await self.process.wait()
            log.info("RuneLite exited with status %s", code)
            if self._stopping:
                break
            if not self._restart.is_set():
                await asyncio.sleep(RESTART_DELAY)

    async def restart(self, session=...):
        """Restarts RuneLite. Pass a session dict, None to clear it, or nothing to keep it."""
        if session is not ...:
            self.session = session
        self._restart.set()
        await self._terminate()

    async def stop(self):
        self._stopping = True
        await self._terminate()
        if self._task:
            await asyncio.gather(self._task, return_exceptions=True)

    async def _terminate(self):
        process = self.process
        if process is None or process.returncode is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
            await asyncio.wait_for(process.wait(), STOP_TIMEOUT)
        except ProcessLookupError:
            pass
        except asyncio.TimeoutError:
            os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
