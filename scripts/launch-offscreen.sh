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

cd "$REPO"
echo "[carsales-mcp] Running server headed-offscreen on $CARS_DISPLAY ..." >&2
exec node dist/index.js
