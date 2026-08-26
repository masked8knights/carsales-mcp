#!/usr/bin/env bash
# Launch the local carsales-mcp server headed but OFFSCREEN, so the AI can drive
# the browser while the user never sees a window.
#
# - Ensures an Xvfb virtual display is running (CARS_DISPLAY, default :99).
# - Runs the local MCP server (dist/index.js) with CARS_DISPLAY set.
#
# Requires: Xvfb (apt-get install -y xvfb). Run once/day and reuse for speed, but
# this script is idempotent and will reuse an already-running Xvfb.
set -u

REPO="$HOME/carsales-mcp"
DISPLAY_NO="${CARS_DISPLAY_VIRTUAL_DISPLAY:-99}"
export CARS_DISPLAY=":$DISPLAY_NO"

# Start Xvfb if it isn't already serving this display. Use setsid so it is its own
# session leader and survives the lifecycle of whatever spawned the server (e.g.
# opencode restarting the MCP process). Otherwise the virtual display dies with the
# parent and Camoufox falls back to the real desktop, popping a window.
if ! xdpyinfo -display "$CARS_DISPLAY" >/dev/null 2>&1; then
  echo "[carsales-mcp] Starting Xvfb on $CARS_DISPLAY ..." >&2
  setsid Xvfb "$CARS_DISPLAY" -screen 0 1366x900x24 </dev/null >/dev/null 2>&1 &
  # Give it a moment to come up.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    xdpyinfo -display "$CARS_DISPLAY" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# Fail closed: if we were asked to run offscreen but the virtual display is NOT
# actually reachable, abort rather than let Camoufox fall back to the real desktop
# (which is what was popping windows on the user's screen).
if ! xdpyinfo -display "$CARS_DISPLAY" >/dev/null 2>&1; then
  echo "[carsales-mcp] ERROR: offscreen display $CARS_DISPLAY is not reachable even after starting Xvfb. " >&2
  echo "[carsales-mcp] Install xvfb (apt-get install -y xvfb) or run on a machine with a virtual display. " >&2
  echo "[carsales-mcp] NOT launching to avoid showing a window on the desktop. " >&2
  exit 1
fi

cd "$REPO"
echo "[carsales-mcp] Running server headed-offscreen on $CARS_DISPLAY ..." >&2

# Force the browser onto the virtual display only. Unset any inherited real
# desktop display (WSLg sets DISPLAY=:0 / WAYLAND_DISPLAY) so Camoufox can never
# leak a window onto the user's screen.
unset DISPLAY WAYLAND_DISPLAY
export DISPLAY="$CARS_DISPLAY"
export WAYLAND_DISPLAY=""

exec node dist/index.js
