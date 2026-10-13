#!/usr/bin/env bash
# Starts the virtual display and the web server, which runs RuneLite and keeps
# it running. If the display or the web server dies the container exits, so the
# container restart policy can bring everything back cleanly.
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
GEOMETRY="${RLWEB_GEOMETRY:-1280x720}"
VNC_PORT="${RLWEB_VNC_PORT:-5901}"
export RUNELITE_CMD="${RUNELITE_CMD:-/opt/runelite/AppRun}"

mkdir -p "$HOME" "${RLWEB_DATA:-/data/rlweb}"

# VNC only listens on localhost and ignores VNC input: the web server is the
# only way in, and it injects input itself after checking the login.
Xvnc "$DISPLAY" \
  -geometry "$GEOMETRY" -depth 24 \
  -localhost -rfbport "$VNC_PORT" -SecurityTypes None \
  -AlwaysShared -AcceptSetDesktopSize=1 \
  -AcceptPointerEvents=0 -AcceptKeyEvents=0 -AcceptCutText=0 -SendCutText=0 \
  -nolisten tcp &

for _ in $(seq 50); do
  xdpyinfo >/dev/null 2>&1 && break
  sleep 0.2
done
xdpyinfo >/dev/null 2>&1 || { echo "X display $DISPLAY did not start" >&2; exit 1; }

# Shows every window full screen with no title bar, like a phone app.
matchbox-window-manager -use_titlebar no &

python3 "${RLWEB_SERVER:-/opt/rlweb/server/app.py}" &

wait -n
echo "A core process exited; stopping." >&2
exit 1
