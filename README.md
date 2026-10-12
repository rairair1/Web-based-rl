# RuneLite Web

Play the **official RuneLite client**, with all its plugins, from a phone, tablet
or handheld browser. Touch controls follow the official OSRS mobile client.

RuneLite runs unmodified on a machine you own. This project shows it in the browser
and turns touch gestures into normal mouse and keyboard input, the way a touchscreen
laptop or remote desktop does.

```
 Phone browser (PWA)                       Your PC / server (Docker)
 ┌──────────────────────┐   WebSocket    ┌──────────────────────────────────┐
 │ video (noVNC canvas) │ ◄────────────  │ Xvnc virtual display             │
 │ touch → gesture      │ ─────────────► │ web server → XTEST input         │
 │ engine, keyboard,    │   input JSON   │ RuneLite launcher (from GitHub)  │
 │ toolbar, profiles    │                │  └ downloads current RuneLite    │
 └──────────────────────┘                └──────────────────────────────────┘
```

- **Always current:** the image installs the official launcher from
  [runelite/launcher releases](https://github.com/runelite/launcher/releases). The
  launcher downloads the current RuneLite client on every start, just like on a
  desktop.
- **Everything is saved:** RuneLite's settings, profiles and Plugin Hub plugins live in
  `~/.runelite` on a Docker volume. Touch and display settings are saved as named
  profiles on the host, and each device remembers which profile it uses.

See [docs/feasibility.md](docs/feasibility.md) for why this streams the client instead
of porting RuneLite to WebAssembly.

> **Hosting for friends?** See [deploy/README.md](deploy/README.md). It gives each
> person their own RuneLite at `play.yourdomain.com/<name>/` with automatic HTTPS. Read
> its risks section first: Jagex hasn't said anything about streaming RuneLite, and
> whoever runs the server can reach every player's logged-in game.

## Quick start

Requires Docker with Compose. Works on x86-64 and ARM64 hosts.

```sh
git clone https://github.com/rairair1/Web-based-rl.git && cd Web-based-rl
echo "RLWEB_PASSWORD=$(openssl rand -base64 18)" > .env   # your web login password
cat .env
docker compose up -d --build
```

Open `http://<host-ip>:8080` on your phone, sign in, then **Add to Home Screen** for a
full-screen app. The server refuses to start without a strong `RLWEB_PASSWORD`.

To update the launcher, run `docker compose build --pull && docker compose up -d`.
The RuneLite client itself updates on every restart (Settings → **Restart
RuneLite**). To pin a launcher version, run
`docker compose build --build-arg RUNELITE_LAUNCHER_VERSION=<tag>`.

### Use HTTPS when away from home

Don't expose port 8080 to the internet directly. The easiest secure option is
[Tailscale](https://tailscale.com):

```sh
tailscale serve --bg 8080      # https://<machine>.<tailnet>.ts.net
```

Set `RLWEB_SECURE_COOKIE: "1"` in `docker-compose.yml` when you use HTTPS. Any reverse
proxy with TLS (Caddy, nginx) also works, as long as it forwards WebSockets.

## Logging in to the game

- **Legacy (non-Jagex) accounts:** log in on RuneLite's login screen as usual.
- **Jagex Accounts:** these normally log in through the Jagex Launcher, which runs on
  Windows and macOS. RuneLite's
  [documented developer option](https://github.com/runelite/runelite/wiki/Using-Jagex-Accounts)
  can save the launcher's session for reuse:
  1. On a Windows or Mac PC, open RuneLite's configure window (Windows: Start menu →
     *RuneLite (configure)*; macOS: run `RuneLite --configure`). Add
     `--insecure-write-credentials` to **Client arguments** and save.
  2. Start RuneLite once from the Jagex Launcher. This writes
     `.runelite/credentials.properties`.
  3. Copy that file to the server:
     ```sh
     docker compose cp credentials.properties runelite-web:/data/home/.runelite/credentials.properties
     docker compose exec -u root runelite-web chown runelite: /data/home/.runelite/credentials.properties
     ```
  4. Remove the client argument on the PC again.

  Treat the file like a password: anyone who has it can log in to your account
  without your password. You can revoke it at any time with **End sessions** in your
  account settings on runescape.com.

## Touch controls

| Gesture | Does | Like the mobile client's |
|---|---|---|
| Tap | Left-click | Tap |
| Long-press, then lift | Right-click (opens the menu) | Long-press |
| Long-press, then drag | Drag with the left button (move inventory or bank items) | Hold and drag |
| Drag | Rotate or tilt the camera (middle-mouse drag) | Drag |
| Pinch | Zoom (mouse wheel) | Pinch |
| Two-finger drag up or down | Scroll lists, the bank and RuneLite panels | Scroll |

A ring shows where each tap landed. It turns orange once a long-press registers.

**Toolbar** (☰ collapses it): ⌨ keyboard · ☷ make the next tap a right-click · ⇧ / Ctl
hold Shift or Ctrl (for shift-drop and swaps) · Esc · Fn (F-key bar) · ⛶ full screen ·
⚙ settings.

Each gesture sends exactly one ordinary input. The touch layer never repeats clicks,
never adds automation, and never reads game state.

**Settings** (⚙) include long-press time, camera drag speed, tap tolerance, pinch step,
haptics, display mode, resolution scale, image quality and toolbar side. You can save
them as named profiles, export or import them as JSON, and restart RuneLite from there.

### Recommended RuneLite settings for phones
Save these in a RuneLite profile (for example, "Mobile") so the desktop setup stays
untouched:
- *Game client layout*: resizable mode.
- *OSRS settings → Controls*: middle-mouse camera control **on**, scroll-wheel zoom
  **on**.
- Turn on *Stretched Mode* if the interface is too small. You can also raise
  **Resolution scale** in this app's settings, which gives RuneLite more pixels and
  makes text smaller, or lower it for larger text.
- Leave the **GPU plugin off** unless the host has a GPU passed through. The container
  renders OpenGL on the CPU.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RLWEB_PASSWORD` | (required) | Web login password |
| `RLWEB_GEOMETRY` | `1280x720` | Starting virtual screen size; resize mode changes it to fit each device |
| `RLWEB_SECURE_COOKIE` | `0` | Set to `1` when served over HTTPS |
| `RUNELITE_ARGS` | (empty) | Extra launcher arguments |
| `RLWEB_PORT` | `8080` | Web server port inside the container |
| `RLWEB_BASE_PATH` | `/` | URL prefix when a reverse proxy serves the app under a path (for example `/kyle/`) |

Data lives on the `rlweb-data` volume. `/data/home/.runelite` holds RuneLite's own data.
`/data/rlweb` holds web profiles and the session signing key.

## Development

```sh
npm test                                    # gesture engine unit tests
python3 -m unittest discover -s tests       # server tests (needs python3-aiohttp)
```

[`tests/README.md`](tests/README.md) explains how to run the whole stack without Docker.
It uses a small Swing app that stands in for RuneLite, plus an end-to-end touch test
with Playwright.

```
server/app.py         aiohttp server: login, VNC WebSocket proxy, input, profiles
server/xinput.py      XTEST mouse/keyboard injection
web/js/gestures.js    touch gesture engine (DOM-free, unit tested)
web/js/keyboard.js    on-screen and physical keyboard handling
web/js/profiles.js    profile storage (host + per-device choice)
web/js/main.js        wiring: video, toolbar, settings
scripts/entrypoint.sh starts Xvnc, the window manager, the server and RuneLite
```
