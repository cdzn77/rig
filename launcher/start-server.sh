#!/bin/bash
# Starts the Rig server in the background. Called by Rig.app.
# Apps opened from the Dock get a minimal PATH, so this finds Node itself.

RIG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/Library/Logs/Rig.log"
STATE="$HOME/Library/Application Support/Rig"
mkdir -p "$STATE" "$(dirname "$LOG")"

# Keep the log from growing forever: trim to the last 256 KB once it passes 1 MB.
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -c 262144 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

find_node() {
  local c
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  # nvm: prefer the version marked default, then the newest installed.
  if [ -f "$HOME/.nvm/alias/default" ]; then
    local want; want="$(cat "$HOME/.nvm/alias/default")"
    c="$(ls -d "$HOME"/.nvm/versions/node/v"${want#v}"*/bin/node 2>/dev/null | sort -V | tail -n1)"
    [ -x "$c" ] && { echo "$c"; return 0; }
  fi
  c="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n1)"
  [ -x "$c" ] && { echo "$c"; return 0; }
  c="$(/bin/zsh -lc 'command -v node' 2>/dev/null)"
  [ -x "$c" ] && { echo "$c"; return 0; }
  return 1
}

NODE="$(find_node)" || {
  echo "$(date '+%F %T') Rig: couldn't find Node. Install it with: brew install node" >> "$LOG"
  exit 1
}

export PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# The launcher passes its own PID. The server exits if that process disappears,
# so a crash or force-quit of Rig.app never leaves the port open.
[ -n "${1:-}" ] && export RIG_PARENT_PID="$1"
echo "$(date '+%F %T') Starting Rig with $NODE" >> "$LOG"
nohup "$NODE" "$RIG_DIR/server.js" >> "$LOG" 2>&1 &
echo $! > "$STATE/server.pid"
