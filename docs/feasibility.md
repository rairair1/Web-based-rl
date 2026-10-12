# Feasibility: RuneLite in a Browser for Phones and Handhelds

**Question:** Can RuneLite, the third-party Old School RuneScape (OSRS) client, run in a
web browser, with saved profiles for settings and plugins? The main targets are phones
and handheld devices, with touch controls close to the official OSRS mobile client.

**Short answer:**

| Approach | Technically possible? | Allowed by Jagex? | Verdict |
|---|---|---|---|
| **A. Port RuneLite to run in the browser** (JVM in WebAssembly) | Partly. A large, fragile engineering effort, with poor performance expected on phones | **No.** It would be an unapproved third-party client | Don't build it |
| **B. Stream real, unmodified RuneLite to a touch-first web app** (self-hosted) | **Yes.** Every piece already exists | Grey area. It uses the approved client, but see the risks below | **Recommended** |
| C. Run RuneLite natively on Android (JVM + X server) | Yes, on Android only | Same as B | Not a browser solution, and no iOS |

The rest of this document explains how we reached this verdict, then sketches the
architecture for approach B.

> **Status:** approach B is implemented in this repository. See the [README](../README.md).
> The first version streams video over VNC (noVNC) instead of WebRTC, which is simpler
> and fast enough for OSRS's 600 ms ticks. WebRTC remains a possible upgrade.

---

## 1. The constraints that decide this

### 1.1 Jagex's client policy is the main blocker
- Jagex allows only its official clients (desktop and mobile) and **two approved
  third-party clients: RuneLite and HDOS**. Playing through any other third-party
  software breaks the Rules of RuneScape and can get the account banned.
- Approval covers the client as RuneLite ships it, not anything built from RuneLite's
  code. RuneLite is BSD-licensed, so forking it is legal. A fork would still count as
  an unapproved client.
- RuneLite lists **"Mobile Client"** and **"Touchscreen/Controller plugins"** on its own
  *Rejected or Rolled Back Features* page. For touch and controller plugins, the stated
  reason is that they "would likely trigger Jagex's macro detection". RuneLite will not
  build or accept either one.
- Jagex had been working on a plugin API for its own client, which would have brought
  plugins to mobile. It **paused that work at the Winter Summit on 25 January 2026** to
  focus on HD and mobile improvements. The official mobile app includes built-in
  versions of a few RuneLite-style features, but has no plugin system.

**Conclusion:** anything that changes or re-hosts the client code puts users' accounts
at risk. A viable design must run the **genuine RuneLite build, unmodified**.

### 1.2 How RuneLite works
- **Java desktop app:** Swing/AWT UI, an embedded JRE and LWJGL/OpenGL. The GPU plugin
  needs **OpenGL 4.3 compute shaders**.
- **Jagex's code is downloaded at runtime:** the launcher downloads Jagex's vanilla
  "gamepack" and patches it on the user's machine, so RuneLite never redistributes
  Jagex's proprietary code. Any web host serving a pre-patched client would be
  redistributing Jagex's code.
- **Game traffic uses raw TCP** to world servers (for example, port 43594). Browsers
  cannot open raw TCP sockets.
- **Login through the Jagex Launcher:** for Jagex Accounts, the launcher handles OAuth
  and passes session credentials to RuneLite through environment variables (for example,
  `JX_SESSION_ID`). A web app has no approved way to get these tokens. Re-using the
  launcher's OAuth client would mean impersonating Jagex software.
- **Plugin Hub:** plugins are JARs that the client downloads and loads at runtime. Some
  depend on native libraries or desktop APIs.
- **Profiles already exist:** RuneLite has config profiles, and can sync them to the
  cloud through a RuneLite account.

---

## 2. Approach A: Run RuneLite itself in the browser

### What it would take
| Problem | Browser option | Status |
|---|---|---|
| JVM | **CheerpJ** (a WebAssembly JVM with a JIT; Swing and AWT fully supported; Java 8 and 11 supported; Java 17 in preview as of 4.x). **TeaVM** compiles ahead of time, so it can't load Plugin Hub JARs at runtime and is ruled out | Plausible |
| Raw TCP to game servers | A WebSocket-to-TCP relay (websockify-style) or CheerpJ's Tailscale-based networking. The **Direct Sockets API** exists only for Chrome Isolated Web Apps (ChromeOS/desktop), not mobile Safari or Chrome | Needs a server; all players share its IP address |
| Rendering | The software renderer would run inside a WebAssembly JVM. The GPU plugin would have to be rewritten for **WebGPU**, because WebGL2 has no compute shaders | Very heavy; likely slow on phones |
| Natives (LWJGL, JNA, Discord RPC…) | None in the browser | Many core and hub plugins break |
| Memory | RuneLite normally uses roughly 0.5–1 GB of heap. iOS Safari kills tabs at around 1–1.5 GB | High risk of the tab being killed |
| Jagex login | No approved web OAuth flow | **Blocker** |
| Gamepack | Must be downloaded and patched on the client side, or the host redistributes Jagex's code | Legal and ToS risk |
| Policy | The result is a modified, re-hosted client, which makes it unapproved | **Blocker** |

### Verdict
It might be possible to get it working as a research toy, but it can't be shipped. Two
hard blockers (an unapproved client and no legitimate login path) apply even if every
technical problem is solved. Performance on phone CPUs, running a JIT-compiled JVM in
WebAssembly with a software rasterizer, is also unproven. Expect weeks of porting before
the first frame, and ongoing breakage every Wednesday game update.

---

## 3. Approach B (recommended): Stream real RuneLite to a touch-first web app

Run the **official, unmodified RuneLite** on a machine the player controls, such as a
home PC, mini-PC or personal cloud VM. The phone opens a **web app (PWA)** that:
1. shows the RuneLite window as a low-latency video stream, and
2. turns touch gestures into ordinary mouse and keyboard input, the same way a Windows
   touchscreen laptop or a Steam Deck already does for RuneLite.

This setup already works today with general-purpose tools such as Moonlight/Sunshine,
Parsec or Steam Link. The project's value is a **purpose-built, OSRS-aware touch layer
and profile system** on top of that.

```
 ┌────────────── Phone / handheld (browser, PWA) ─────────────┐
 │  <video> (WebRTC)                                           │
 │  Touch overlay ── gesture engine ──► input events (JSON)    │
 │  UI chrome: keyboard, F-key bar, sidebar drawer, settings   │
 │  Local prefs: IndexedDB (layout, sensitivity, profile id)   │
 └──────────────▲─────────────────────────────┬────────────────┘
                │ video (H.264/AV1, WebRTC)   │ WebRTC DataChannel
 ┌──────────────┴─────────────────────────────▼────────────────┐
 │  Host agent (home PC / VM)                                  │
 │  • Captures the RuneLite window (or a dedicated X/Wayland   │
 │    display) and encodes it in hardware                      │
 │  • Injects input at the OS level (uinput/xdotool,           │
 │    Windows SendInput)                                       │
 │  • Manages RuneLite profiles (~/.runelite)                  │
 │  • Launches RuneLite via the Jagex Launcher (or a supported │
 │    Linux launcher)                                          │
 └─────────────────────────────────────────────────────────────┘
```

### Why this approach works
- **Policy:** it runs the approved client, unmodified, launched through Jagex's own login
  flow. Nothing is injected into the client. Input arrives through the operating system,
  the same way it does for a remote desktop or a touchscreen PC.
- **Plugins:** the full Plugin Hub works, including GPU, 117 HD and native-dependent
  plugins, because it is the real desktop client.
- **Updates:** RuneLite updates itself as usual. There is nothing to port after each game
  update.
- **Latency:** OSRS runs on 600 ms game ticks, so 30–80 ms of streaming latency is barely
  noticeable. It is much more forgiving than action games.
- **Device reach:** anything with a modern browser, including iOS Safari, Android
  Chrome, Steam Deck, tablets and ChromeOS.

### Risks to state honestly to users
- Jagex hasn't publicly ruled on streaming RuneLite from your own PC. People commonly
  play this way with Parsec, Moonlight or Steam Link, but there is no explicit approval.
- **Never host it as a shared service.** Running many people's accounts on servers you
  control would cause IP concentration, look like a bot farm, and put you in custody of
  their sessions. Keep it **self-hosted, one player per host**.
- **The touch layer must map one gesture to one input.** No macros, no input sequences
  started by a single tap, and no automatic actions. This keeps the project clear of the
  macro-detection concern RuneLite cites (see §4.3).
- The host machine must stay on. For players without a PC, a personal cloud GPU VM costs
  money.

---

## 4. Touch input design (matching the official mobile client)

### 4.1 Gesture map
The defaults follow the official mobile client, so players don't need to relearn
anything. Every mapping is a single input from a single gesture.

| Gesture (game viewport) | Sends | Mobile-client equivalent |
|---|---|---|
| Tap | Move the cursor there, then left-click | Tap |
| Long-press (default 400 ms, adjustable) | Right-click at the press point, which opens the menu | Long-press for menu |
| Tap a menu entry | Left-click | Same |
| One-finger drag on the 3D world | Middle-mouse drag, so RuneLite's camera plugin rotates the camera | Drag to rotate |
| Pinch | Mouse-wheel steps for zoom (scroll-to-zoom) | Pinch zoom |
| Two-finger drag up or down | Arrow Up/Down (camera pitch) | Camera tilt |
| Drag in inventory or bank | Left-button drag: press, move, release | Drag items |
| "Menu mode" toggle button | The next tap becomes a right-click | Single-tap menu toggle |
| Tap with "shift" button held | Shift + left-click (shift-drop or a custom swap) | Tap-to-drop |

Gestures over RuneLite's **side panel** (plugin panels) behave like a normal touchscreen:
tap is a click, drag scrolls (sent as wheel events), and long-press is a right-click.

### 4.2 UI chrome around the stream
- **Landscape-first layout:** the game fills the screen. RuneLite's sidebar becomes a
  **slide-out drawer** from the right edge. The host either resizes the RuneLite window
  or crops the stream to the panel.
- Recommended RuneLite settings for small screens, saved in a "Mobile" profile: resizable
  mode, *Stretched Mode* or interface scaling, larger fonts, and *Camera* plugin
  middle-mouse rotation.
- An **on-screen keyboard button** opens the native keyboard through a hidden `<input>`,
  for chat and bank searches. A **thin F-key and Esc bar** handles tab switching. Both
  can be hidden.
- **Cursor indicator:** a small ring shows where the last input landed, which helps when
  the stream is scaled.
- **Coordinate mapping:** the video's letterboxing and scaling must be inverted exactly
  (`object-fit` math). This is the most common source of "misclick" bugs in streaming
  setups.
- **Haptics:** `navigator.vibrate` on Android when a long-press fires. iOS has no
  equivalent web API, so show a visual pulse instead.
- **Controllers and handhelds:** use the Gamepad API to move a cursor with the stick,
  with A as left-click and B as right-click. This is mainly useful for Steam Deck and
  similar devices when not running RuneLite natively.

### 4.3 What not to build
To stay clear of the macro-detection concern RuneLite gives in its rejection notice:
- no tap that sends more than one click, and no "tap-to-repeat" or auto-click
- no input timing randomization or "humanization" (it implies automation)
- no reading of game state to decide which inputs to send

---

## 5. Profile saving (settings + plugins)

Use three layers and lean on what RuneLite already does instead of reinventing it:

| Layer | What it stores | Where |
|---|---|---|
| **RuneLite profiles** | Plugin on/off states, plugin configs, Plugin Hub installs | RuneLite's own profile system on the host (`~/.runelite`), optionally synced with a **RuneLite account**, so the same profile also works on the player's desktop |
| **Host agent profile** | Which RuneLite profile to launch, window size, stream quality, launch flags | A JSON file on the host, selectable from the web app |
| **Device / touch profile** | Gesture timings, button layout, drawer side, haptics, sensitivity | Browser IndexedDB, keyed per device. Export and import as JSON, and optionally mirror to the host so a new phone picks it up |

Flow: open the web app → pick a profile ("Mobile – Skilling", "Mobile – Bossing") → the
host launches RuneLite with that profile (or switches to it) → the device restores its
own touch layout.

---

## 6. Suggested build plan for approach B

1. **Spike (1–2 weeks):** stream RuneLite with an existing WebRTC streamer to a minimal
   web page. Add a touch overlay that does tap → left-click and long-press → right-click.
   Measure latency and misclick rate on an iPhone and an Android phone.
2. **Gesture engine:** a pointer-event state machine (tap, long-press, drag, pinch,
   two-finger drag) with a mapping table that can be configured. Write unit tests for
   gesture classification and coordinate inversion.
3. **Host agent:** WebRTC signalling, input injection through a DataChannel (uinput on
   Linux, SendInput on Windows), RuneLite launch and profile selection, and auth
   (pairing code plus TLS; it must never be exposed unauthenticated).
4. **Mobile UI:** sidebar drawer, keyboard and F-key bar, settings screen, PWA manifest
   for full-screen "Add to Home Screen".
5. **Profiles:** device layouts in IndexedDB with import and export; the host lists and
   switches RuneLite profiles.
6. **Polish:** gamepad support, haptics, adaptive bitrate, reconnect without losing the
   RuneLite session.

### Candidate building blocks
- Streaming: Selkies-GStreamer, Sunshine (host) with a WebRTC bridge, or a small custom
  Pion (Go) or aiortc (Python) server with hardware encoding.
- Front end: TypeScript, Pointer Events, WebRTC, IndexedDB and the Gamepad API. No game
  code runs in the browser.

---

## 7. Open questions
- Should the project ask Jagex or the RuneLite team for a view on streamed play before a
  public release? This is recommended if it will be promoted widely.
- Hosting: home PC only, or also document a personal cloud VM setup (cost, GPU
  availability, regions close to OSRS worlds)?
- Is RuneLite account cloud sync enough for profiles, or should profiles also work
  without a RuneLite account?

## Sources
- RuneLite wiki, *Rejected or Rolled Back Features* (Mobile Client; Touchscreen/Controller plugins): https://github.com/runelite/runelite/wiki/Rejected-or-Rolled-Back-Features
- Jagex, *Third Party Clients Update*: https://secure.runescape.com/m=news/third-party-clients-update?oldschool=1
- OSRS Wiki, *Third Party Client Guidelines* and *Code of Conduct*: https://oldschool.runescape.wiki/w/Update:Third_Party_Client_Guidelines · https://oldschool.runescape.wiki/w/Code_of_Conduct
- OSRS Wiki, *Upcoming updates* (plugin API pause, Winter Summit 2026): https://oldschool.runescape.wiki/w/Upcoming_updates
- Jagex Support, *Using RuneLite via the Jagex Launcher*: https://support.runescape.com/hc/en-gb/articles/33992401505937-Using-RuneLite-via-the-Jagex-Launcher
- CheerpJ compatibility (Java versions, Swing and AWT, networking caveats): https://cheerpj.com/compatibility/ · https://labs.leaningtech.com/blog/cheerpj-4.1.html
- RuneLite launcher configuration: https://github.com/runelite/runelite/wiki/RuneLite-Launcher-Configuration
- RuneLite GPU plugin requirements (OpenGL 4.3): https://runelite.net/blog/show/2018-11-16-1.5.0-Release
