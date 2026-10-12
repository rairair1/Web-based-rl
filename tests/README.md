# Tests

## Unit tests

```sh
npm test                                  # web/js/gestures.js
python3 -m unittest discover -s tests     # server/app.py
```

## Full stack without Docker (Ubuntu/Debian)

`fixtures/InputProbe.java` stands in for RuneLite. It's a Swing window that prints every
mouse and key event it receives, so you can test the stack without game servers.

```sh
sudo apt-get install tigervnc-standalone-server matchbox-window-manager x11-utils \
  python3-aiohttp python3-xlib default-jdk
curl -fsSL https://registry.npmjs.org/@novnc/novnc/-/novnc-1.7.0.tgz | tar -xz -C /tmp
mv /tmp/package /tmp/novnc

export HOME=/tmp/rlweb-home RLWEB_DATA=/tmp/rlweb-data RLWEB_PASSWORD=test-pass-123
export RLWEB_WEB_ROOT="$PWD/web" RLWEB_NOVNC_ROOT=/tmp/novnc RLWEB_SERVER="$PWD/server/app.py"
export RLWEB_RUNELITE_PIDFILE=/tmp/rlweb-runelite.pid
export RUNELITE_CMD=java RUNELITE_ARGS="$PWD/tests/fixtures/InputProbe.java"
scripts/entrypoint.sh > /tmp/rlweb-stack.log 2>&1 &
```

Then run the end-to-end touch test. It emulates a phone in landscape and checks taps,
long-press, drags, pinch, menu mode, Shift, the keyboard and profile saving against what
InputProbe received:

```sh
npm install --no-save playwright
RLWEB_PASSWORD=test-pass-123 PROBE_LOG=/tmp/rlweb-stack.log node tests/e2e/touch.e2e.mjs
```
