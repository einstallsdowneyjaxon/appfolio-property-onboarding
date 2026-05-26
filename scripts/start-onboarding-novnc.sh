#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${ONBOARDING_DISPLAY:-:99}"
SCREEN_SIZE="${ONBOARDING_SCREEN_SIZE:-1440x1000x24}"
VNC_PORT="${ONBOARDING_VNC_PORT:-5901}"
NOVNC_PORT="${ONBOARDING_NOVNC_PORT:-6080}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    echo "Install with: apt-get update && apt-get install -y xvfb fluxbox x11vnc novnc websockify"
    exit 1
  fi
}

require_command Xvfb
require_command fluxbox
require_command x11vnc
require_command websockify

display_number="${DISPLAY_NUM#:}"
lock_file="/tmp/.X${display_number}-lock"

if [ ! -e "$lock_file" ]; then
  nohup Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN_SIZE" >/tmp/onboarding-xvfb.log 2>&1 &
  sleep 1
fi

if ! pgrep -f "fluxbox" >/dev/null 2>&1; then
  nohup env DISPLAY="$DISPLAY_NUM" fluxbox >/tmp/onboarding-fluxbox.log 2>&1 &
  sleep 1
fi

if ! pgrep -f "x11vnc .*${VNC_PORT}" >/dev/null 2>&1; then
  nohup x11vnc -display "$DISPLAY_NUM" -forever -shared -nopw -localhost -rfbport "$VNC_PORT" >/tmp/onboarding-x11vnc.log 2>&1 &
  sleep 1
fi

if ! pgrep -f "websockify .*${NOVNC_PORT}" >/dev/null 2>&1; then
  nohup websockify --web=/usr/share/novnc/ "127.0.0.1:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" >/tmp/onboarding-novnc.log 2>&1 &
  sleep 1
fi

cat <<EOF
noVNC is running on the VPS.

From your local computer, open an SSH tunnel:
  ssh -L ${NOVNC_PORT}:127.0.0.1:${NOVNC_PORT} root@YOUR_VPS_IP

Then open:
  http://127.0.0.1:${NOVNC_PORT}/vnc.html

In another VPS terminal, run:
  DISPLAY=${DISPLAY_NUM} npm run appfolio:onboarding-login
EOF
