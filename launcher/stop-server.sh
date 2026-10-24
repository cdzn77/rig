#!/bin/bash
# Stops every Rig server and confirms its port is closed. Called when you quit
# Rig.app. Covers a Rig started by the app and one started from Terminal.
# Only stops processes running this folder's server.js, never anything else
# that might be using the port.

RIG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${RIG_PORT:-4545}"
LOG="$HOME/Library/Logs/Rig.log"
PIDFILE="$HOME/Library/Application Support/Rig/server.pid"

is_rig() { ps -p "$1" -o command= 2>/dev/null | grep -qF "$RIG_DIR/server.js"; }

pids=""
[ -f "$PIDFILE" ] && pids="$(cat "$PIDFILE")"
pids="$pids $(/usr/sbin/lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)"

for pid in $pids; do
  is_rig "$pid" && kill "$pid" 2>/dev/null
done

# Give it 3 seconds to close cleanly, then force it.
for _ in 1 2 3 4 5 6; do
  /usr/sbin/lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1 || break
  sleep 0.5
done
for pid in $(/usr/sbin/lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  is_rig "$pid" && kill -9 "$pid" 2>/dev/null
done

rm -f "$PIDFILE"
if /usr/sbin/lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1; then
  echo "$(date '+%F %T') Port $PORT is still open, held by something other than Rig." >> "$LOG"
else
  echo "$(date '+%F %T') Rig stopped. Port $PORT closed." >> "$LOG"
fi
