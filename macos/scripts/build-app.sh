#!/usr/bin/env bash
# Builds macos/build/AvityOne.app and AvityOne.dmg (Apple Silicon, macOS 14+): the SwiftUI app, its PDFKit helper,
# Node 24 (pinned and checksummed) and the engine (src/ + web UI). Ad hoc signature: no Apple developer account needed.
set -euo pipefail
cd "$(dirname "$0")/.."
MACOS="$PWD"
ROOT="$(cd .. && pwd)"
BUILD="$MACOS/build"
APP="$BUILD/AvityOne.app"
NODE_VERSION=24.22.0
NODE_SHA256=6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5
NODE_DIST="node-v$NODE_VERSION-darwin-arm64"

VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json")"
BUILD_NUMBER="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
ARCH=()
[[ "$(uname -m)" == arm64 ]] || ARCH=(--triple arm64-apple-macosx14.0)

echo "→ Swift (release)"
# Bash 3.2 (macOS) treats an empty array as unset under `set -u`.
swift build -c release ${ARCH[@]+"${ARCH[@]}"} --product AvityOne
swift build -c release ${ARCH[@]+"${ARCH[@]}"} --product pdftotext
BIN="$(swift build -c release ${ARCH[@]+"${ARCH[@]}"} --show-bin-path)"

echo "→ Node $NODE_VERSION"
mkdir -p "$BUILD/cache"
ARCHIVE="$BUILD/cache/$NODE_DIST.tar.gz"
[[ -f "$ARCHIVE" ]] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIST.tar.gz" -o "$ARCHIVE"
echo "$NODE_SHA256  $ARCHIVE" | shasum -a 256 -c -
rm -rf "$BUILD/cache/$NODE_DIST"
tar -xzf "$ARCHIVE" -C "$BUILD/cache"

echo "→ Interface web (servie par le moteur, pour le téléphone via Tailscale)"
if [[ ! -f "$ROOT/web/dist/index.html" ]]; then (cd "$ROOT" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent); fi

echo "→ AvityOne.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources/engine/web" "$APP/Contents/Resources/node"
cp "$BIN/AvityOne" "$APP/Contents/MacOS/AvityOne"
cp "$BIN/pdftotext" "$APP/Contents/Helpers/pdftotext"
# SwiftPM resource bundles of the dependencies (SwiftTerm looks for them in Contents/Resources).
for bundle in "$BIN"/*.bundle; do [[ -e "$bundle" ]] && cp -R "$bundle" "$APP/Contents/Resources/"; done
sed -e "s/@VERSION@/$VERSION/" -e "s/@BUILD@/$BUILD_NUMBER/" "$MACOS/Resources/Info.plist" > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# The engine, exactly as on the servers. Never under node_modules: Node refuses to strip types there.
cp -R "$ROOT/src" "$APP/Contents/Resources/engine/src"
cp "$ROOT/package.json" "$ROOT/LICENSE" "$APP/Contents/Resources/engine/"
cp -R "$ROOT/web/dist" "$APP/Contents/Resources/engine/web/dist"
# Node and npm (agent installs); headers and man pages are not needed.
cp -R "$BUILD/cache/$NODE_DIST/bin" "$BUILD/cache/$NODE_DIST/lib" "$APP/Contents/Resources/node/"
cp "$BUILD/cache/$NODE_DIST/LICENSE" "$APP/Contents/Resources/node/LICENSE"

echo "→ Icône"
ICONSET="$BUILD/AppIcon.iconset"
rm -rf "$ICONSET"
swift "$MACOS/scripts/make-icon.swift" "$ICONSET"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

echo "→ Signature ad hoc"
# Node keeps its own Developer ID signature; the helper and the app are signed ad hoc.
codesign --force --sign - "$APP/Contents/Helpers/pdftotext"
codesign --force --sign - --identifier fr.avityone.AvityOne "$APP"
codesign --verify --verbose=1 "$APP"

echo "→ AvityOne.dmg"
STAGE="$BUILD/dmg"
rm -rf "$STAGE" "$BUILD/AvityOne.dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname AvityOne -srcfolder "$STAGE" -ov -format UDZO "$BUILD/AvityOne.dmg"
rm -rf "$STAGE"
echo "AvityOne $VERSION ($BUILD_NUMBER) : $APP"
echo "                     $BUILD/AvityOne.dmg"
