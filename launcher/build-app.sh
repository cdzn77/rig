#!/bin/bash
# Builds Rig.app, a Dock launcher for Rig, into ~/Applications.
# Run once. Run again any time to rebuild (for example after moving this folder).
# Uses only tools that ship with macOS: osacompile, sips, iconutil, codesign.

set -euo pipefail

RIG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/Rig.app"
BUNDLE_ID="com.chrowmdesigns.rig"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$HOME/Applications"

# Quit a running Rig.app first (this also stops its server and closes the port).
if pgrep -f "$APP/Contents/MacOS/applet" > /dev/null 2>&1; then
  echo "Quitting the running Rig app…"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" > /dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$APP/Contents/MacOS/applet" > /dev/null 2>&1 || break
    sleep 0.5
  done
fi

# Never overwrite an unrelated app that happens to be called Rig.
if [ -e "$APP" ]; then
  existing="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$existing" != "$BUNDLE_ID" ]; then
    echo "Stopped: $APP already exists and isn't this launcher. Rename or move it, then run this again."
    exit 1
  fi
  rm -rf "$APP"
fi

echo "Compiling launcher…"
sed "s|__RIG_DIR__|$RIG_DIR|g" "$RIG_DIR/launcher/Rig.applescript" > "$TMP/Rig.applescript"
# -s keeps the app open after launch, so the Dock shows it running and Quit stops Rig.
osacompile -s -o "$APP" "$TMP/Rig.applescript"

echo "Adding icon…"
cp "$RIG_DIR/launcher/icon.png" "$TMP/icon.png"
ICONSET="$TMP/Rig.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256; do
  sips -z "$s" "$s" "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}.png" > /dev/null
  d=$((s * 2))
  sips -z "$d" "$d" "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" > /dev/null
done
sips -z 512 512 "$TMP/icon.png" --out "$ICONSET/icon_512x512.png" > /dev/null
cp "$TMP/icon.png" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"
# Current macOS script apps ship an asset catalog holding the default icon, and
# Info.plist points to it by name. macOS checks that first and ignores
# applet.icns, so remove both and point the app at our .icns file.
rm -f "$APP/Contents/Resources/Assets.car"

echo "Naming the app…"
PL="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
$PB -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PL" 2>/dev/null || $PB -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$PL"
$PB -c "Set :CFBundleName Rig" "$PL" 2>/dev/null || $PB -c "Add :CFBundleName string Rig" "$PL"
$PB -c "Delete :CFBundleIconName" "$PL" 2>/dev/null || true
$PB -c "Set :CFBundleIconFile applet" "$PL" 2>/dev/null || $PB -c "Add :CFBundleIconFile string applet" "$PL"

# Changing the icon and Info.plist breaks the app's signature; re-sign it locally.
codesign --force --deep --sign - "$APP" 2> /dev/null

chmod +x "$RIG_DIR/launcher/start-server.sh" "$RIG_DIR/launcher/stop-server.sh" "$RIG_DIR/start.command" 2> /dev/null || true
# Make Finder and the Dock pick up the new icon instead of a cached one.
touch "$APP"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREG" ] && "$LSREG" -f "$APP" > /dev/null 2>&1 || true

echo ""
echo "Built $APP"
echo "Opening it in Finder now. Drag Rig onto your Dock."
open -R "$APP"
