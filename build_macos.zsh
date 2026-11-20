#!/bin/zsh
# Usage: zsh build_macos.zsh /path/to/engines /path/to/new-build-directory
set -euo pipefail
if (( $# != 2 )); then print -u2 'Usage: build_macos.zsh ENGINES_DIR BUILD_DIR'; exit 2; fi
src=${0:A:h}
engines=${1:A}
work=${2:A}
app="$work/Маршрут.app"
if [[ -e "$app" ]]; then print -u2 'Choose a fresh build directory'; exit 2; fi
for engine in naive xray awg mieru trusttunnel sing-box; do
  [[ -x "$engines/$engine" ]] || { print -u2 "Missing engine: $engine"; exit 2; }
done
mkdir -p "$app/Contents/"{MacOS,Resources} "$work/cache"
cd "$src"
res="$app/Contents/Resources"
cp macos/Info.plist "$app/Contents/Info.plist"
cp macos/Route.icns "$res/Route.icns"
cp -R android/assets/journey "$res/journey"
python3 locales/build.py "$res/journey" "$res"
cp -R "$engines" "$res/engines"
GOCACHE="$work/cache" CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go -C profiletool build -trimpath -ldflags '-s -w' -o "$res/profiletool" .
GOCACHE="$work/cache" GO111MODULE=off CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags '-s -w' -o "$res/route-client" .
swiftc -O -parse-as-library -target arm64-apple-macos13 -module-cache-path "$work/swift-cache" macos/Route.swift -o "$app/Contents/MacOS/Route"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
ditto -c -k --keepParent "$app" "$work/Route-macOS-arm64.zip"

