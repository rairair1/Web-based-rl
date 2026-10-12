"""Web front end for a RuneLite instance running on a virtual X display.

Serves the touch web app, proxies the VNC video stream over a WebSocket,
injects touch-derived input, and stores device/touch profiles.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import signal
import time
from pathlib import Path

from aiohttp import WSMsgType, web

from xinput import XInput

log = logging.getLogger("rlweb")

COOKIE_NAME = "rlweb_session"
SESSION_TTL = 30 * 24 * 3600
MAX_PROFILES_BYTES = 256 * 1024
MAX_TEXT_LENGTH = 256
PUBLIC_PATHS = {"/login", "/manifest.webmanifest", "/icon.svg"}
WEAK_PASSWORDS = {"", "change-me", "changeme", "password"}

CONFIG = web.AppKey("config", object)
SECRET = web.AppKey("secret", bytes)
LOGIN_LOCK = web.AppKey("login_lock", asyncio.Lock)


class Config:
    def __init__(self, env=os.environ):
        self.host = env.get("RLWEB_HOST", "0.0.0.0")
        self.port = int(env.get("RLWEB_PORT", "8080"))
        self.data_dir = Path(env.get("RLWEB_DATA", "/data/rlweb"))
        self.web_root = Path(env.get("RLWEB_WEB_ROOT", Path(__file__).parent.parent / "web"))
        self.novnc_root = Path(env.get("RLWEB_NOVNC_ROOT", "/opt/novnc"))
        self.vnc_host = env.get("RLWEB_VNC_HOST", "127.0.0.1")
        self.vnc_port = int(env.get("RLWEB_VNC_PORT", "5901"))
        self.display = env.get("DISPLAY", ":1")
        self.runelite_pidfile = Path(env.get("RLWEB_RUNELITE_PIDFILE", "/tmp/runelite.pid"))
        self.secure_cookie = env.get("RLWEB_SECURE_COOKIE", "0") == "1"
        self.password = env.get("RLWEB_PASSWORD", "")
        # URL prefix when served under a path, e.g. "/kyle/" behind a reverse
        # proxy that strips it. Used for redirects and the cookie path.
        prefix = env.get("RLWEB_BASE_PATH", "").strip("/")
        self.base_path = f"/{prefix}/" if prefix else "/"


def load_secret(data_dir):
    """Returns the cookie-signing key, persisted so sessions survive restarts."""
    path = data_dir / "secret.key"
    if path.exists():
        return path.read_bytes()
    key = secrets.token_bytes(32)
    path.write_bytes(key)
    path.chmod(0o600)
    return key


def session_key(secret, password):
    """Binds sessions to the password, so changing it signs everyone out."""
    return hmac.new(secret, password.encode(), hashlib.sha256).digest()


def sign_session(secret, expires):
    mac = hmac.new(secret, str(expires).encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{mac}"


def session_valid(secret, token, now=None):
    if not token or "." not in token:
        return False
    expires, _, _ = token.partition(".")
    if not expires.isdigit() or int(expires) < (now or time.time()):
        return False
    return hmac.compare_digest(sign_session(secret, int(expires)), token)


def same_origin(request):
    """Rejects cross-site WebSocket and form requests (CSRF / CSWSH)."""
    origin = request.headers.get("Origin")
    if origin is None:
        return True
    return origin.split("://", 1)[-1] == request.host


@web.middleware
async def auth_middleware(request, handler):
    if request.path in PUBLIC_PATHS:
        return await handler(request)
    app = request.app
    if not session_valid(app[SECRET], request.cookies.get(COOKIE_NAME)):
        if request.path.startswith(("/api/", "/ws/")):
            raise web.HTTPUnauthorized()
        raise web.HTTPFound(app[CONFIG].base_path + "login")
    if request.method != "GET" or request.path.startswith("/ws/"):
        if not same_origin(request):
            raise web.HTTPForbidden(text="cross-origin request rejected")
    return await handler(request)


@web.middleware
async def headers_middleware(request, handler):
    response = await handler(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    if request.path == "/" or request.path.endswith(".html"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


async def login_page(request):
    return web.FileResponse(request.app[CONFIG].web_root / "login.html")


async def login_submit(request):
    if not same_origin(request):
        raise web.HTTPForbidden(text="cross-origin request rejected")
    form = await request.post()
    password = str(form.get("password", ""))
    expected = request.app[CONFIG].password
    if not hmac.compare_digest(password.encode(), expected.encode()):
        # Slow down guessing; the lock makes concurrent attempts queue up.
        async with request.app[LOGIN_LOCK]:
            await asyncio.sleep(1.5)
        raise web.HTTPFound(request.app[CONFIG].base_path + "login?error=1")
    token = sign_session(request.app[SECRET], int(time.time()) + SESSION_TTL)
    response = web.HTTPFound(request.app[CONFIG].base_path)
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_TTL,
        path=request.app[CONFIG].base_path,
        httponly=True,
        samesite="Strict",
        secure=request.app[CONFIG].secure_cookie or request.secure,
    )
    raise response


async def logout(request):
    base_path = request.app[CONFIG].base_path
    response = web.HTTPFound(base_path + "login")
    response.del_cookie(COOKIE_NAME, path=base_path)
    raise response


async def index(request):
    return web.FileResponse(request.app[CONFIG].web_root / "index.html")


async def vnc_proxy(request):
    """Bridges the noVNC WebSocket to the VNC server's TCP port."""
    config = request.app[CONFIG]
    ws = web.WebSocketResponse(protocols=("binary",), compress=False, heartbeat=30, max_msg_size=0)
    await ws.prepare(request)
    try:
        reader, writer = await asyncio.open_connection(config.vnc_host, config.vnc_port)
    except OSError as exc:
        log.warning("VNC server unavailable: %s", exc)
        await ws.close(code=1011, message=b"VNC server unavailable")
        return ws

    async def tcp_to_ws():
        try:
            while data := await reader.read(65536):
                await ws.send_bytes(data)
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            await ws.close()

    pump = asyncio.create_task(tcp_to_ws())
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                writer.write(msg.data)
                await writer.drain()
            elif msg.type == WSMsgType.ERROR:
                break
    except ConnectionError:
        pass
    finally:
        pump.cancel()
        writer.close()
    return ws


def apply_input(xinput, msg):
    kind = msg.get("t")
    if kind == "move":
        xinput.move(msg["x"], msg["y"])
    elif kind == "btn":
        xinput.button(int(msg["b"]), bool(msg["d"]))
    elif kind == "wheel":
        xinput.wheel("up" if msg.get("dir") == "up" else "down")
    elif kind == "key":
        xinput.key(str(msg["k"]), bool(msg["d"]))
    elif kind == "text":
        xinput.type_text(str(msg["s"])[:MAX_TEXT_LENGTH])
    elif kind == "release":
        xinput.release_all()
    else:
        raise ValueError(f"unknown input type {kind!r}")


async def input_socket(request):
    """Receives touch-derived input and injects it into the X display."""
    config = request.app[CONFIG]
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    try:
        xinput = XInput(config.display)
    except Exception as exc:  # The X server may still be starting.
        log.warning("cannot open X display %s: %s", config.display, exc)
        await ws.close(code=1011, message=b"X display unavailable")
        return ws
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                payload = json.loads(msg.data)
                for item in payload if isinstance(payload, list) else [payload]:
                    apply_input(xinput, item)
            except (ValueError, KeyError, TypeError) as exc:
                log.debug("rejected input %r: %s", msg.data[:200], exc)
    finally:
        xinput.close()
    return ws


async def get_profiles(request):
    path = request.app[CONFIG].data_dir / "profiles.json"
    if not path.exists():
        return web.json_response({"version": 1, "profiles": {}})
    return web.Response(text=path.read_text(), content_type="application/json")


async def put_profiles(request):
    body = await request.read()
    if len(body) > MAX_PROFILES_BYTES:
        raise web.HTTPRequestEntityTooLarge(MAX_PROFILES_BYTES, len(body))
    try:
        data = json.loads(body)
    except ValueError:
        raise web.HTTPBadRequest(text="invalid JSON")
    if not isinstance(data, dict) or not isinstance(data.get("profiles"), dict):
        raise web.HTTPBadRequest(text="expected {\"profiles\": {...}}")
    path = request.app[CONFIG].data_dir / "profiles.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)
    return web.json_response({"ok": True})


async def restart_runelite(request):
    """Stops RuneLite; the entrypoint's supervisor loop starts it again."""
    pidfile = request.app[CONFIG].runelite_pidfile
    try:
        pid = int(pidfile.read_text().strip())
        os.killpg(pid, signal.SIGTERM)
    except (OSError, ValueError) as exc:
        raise web.HTTPServiceUnavailable(text=f"RuneLite is not running: {exc}")
    return web.json_response({"ok": True})


def create_app(config):
    config.data_dir.mkdir(parents=True, exist_ok=True)
    app = web.Application(middlewares=[headers_middleware, auth_middleware])
    app[CONFIG] = config
    app[SECRET] = session_key(load_secret(config.data_dir), config.password)
    app[LOGIN_LOCK] = asyncio.Lock()
    app.router.add_get("/login", login_page)
    app.router.add_post("/login", login_submit)
    app.router.add_post("/logout", logout)
    app.router.add_get("/", index)
    app.router.add_get("/ws/vnc", vnc_proxy)
    app.router.add_get("/ws/input", input_socket)
    app.router.add_get("/api/profiles", get_profiles)
    app.router.add_put("/api/profiles", put_profiles)
    app.router.add_post("/api/runelite/restart", restart_runelite)
    if config.novnc_root.is_dir():
        app.router.add_static("/novnc/", config.novnc_root)
    app.router.add_static("/", config.web_root)
    return app


def main():
    logging.basicConfig(level=os.environ.get("RLWEB_LOG_LEVEL", "INFO"))
    config = Config()
    if config.password.lower() in WEAK_PASSWORDS:
        raise SystemExit("Set RLWEB_PASSWORD to a strong password before starting.")
    web.run_app(create_app(config), host=config.host, port=config.port, access_log=None)


if __name__ == "__main__":
    main()
