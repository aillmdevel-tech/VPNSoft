#!/bin/zsh
# Builds a local arm64 APK. Runtime engine inputs are from their upstream releases.
set -euo pipefail

if (( $# != 3 )); then
  print -u2 "Usage: $0 ENGINES_ANDROID_DIR HEV_ANDROID_LIBRARY BUILD_DIR"
  exit 2
fi
source_dir=${0:A:h}
engines=${1:A}
hev=${2:A}
work=${3:A}
sdk="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
tools="$sdk/build-tools/36.0.0"
platform="$sdk/platforms/android-36/android.jar"
java_home=$(/usr/libexec/java_home -v 17)
mkdir -p "$work"/{classes,dex,apk/lib/arm64-v8a,cache}
umask 077

cd "$source_dir"
GOCACHE="$work/cache" GOOS=android GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' \
  -o "$work/apk/lib/arm64-v8a/librouter.so" main.go advanced.go proxy_listeners.go android_policy.go route_catalog.go engine_parent_android.go
for engine in xray naive trusttunnel awg mieru; do
  /bin/cp "$engines/$engine" "$work/apk/lib/arm64-v8a/lib$engine.so"
done
/bin/cp "$hev" "$work/apk/lib/arm64-v8a/libhev-socks5-tunnel.so"
GOCACHE="$work/cache" GOOS=android GOARCH=arm64 CGO_ENABLED=0 go -C profiletool build -trimpath -ldflags '-checklinkname=0 -s -w' \
  -o "$work/apk/lib/arm64-v8a/libprofiletool.so" .

sources=("$source_dir"/android/**/*.java)
"$java_home/bin/javac" --release 8 -classpath "$platform" -d "$work/classes" "${sources[@]}"
classes=("$work"/classes/**/*.class)
JAVA_HOME="$java_home" "$tools/d8" --min-api 26 --lib "$platform" --output "$work/dex" "${classes[@]}"
"$tools/aapt2" compile --dir "$source_dir/android/res" -o "$work/resources.zip"
mkdir -p "$work/assets"
cp -R "$source_dir/android/assets/." "$work/assets/"
python3 "$source_dir/locales/build.py" "$work/assets/journey"
"$tools/aapt2" link -I "$platform" --manifest "$source_dir/android/AndroidManifest.xml" \
  -A "$work/assets" -o "$work/app-unsigned.apk" "$work/resources.zip"
cp "$work/dex/classes.dex" "$work/apk/classes.dex"
(
  cd "$work/apk"
  /usr/bin/zip -q -r "$work/app-unsigned.apk" classes.dex lib
)
"$tools/zipalign" -f -P 16 4 "$work/app-unsigned.apk" "$work/app-aligned.apk"
if [[ ! -f "$work/local-signing.jks" ]]; then
  "$java_home/bin/keytool" -genkeypair -storetype JKS -keystore "$work/local-signing.jks" \
    -storepass android -keypass android -alias local-test -keyalg RSA -keysize 2048 \
    -validity 3650 -dname "CN=Local Android Test" >/dev/null 2>&1
fi
JAVA_HOME="$java_home" "$tools/apksigner" sign --ks "$work/local-signing.jks" \
  --ks-pass pass:android --ks-key-alias local-test --out "$work/Route-Android.apk" "$work/app-aligned.apk"
JAVA_HOME="$java_home" "$tools/apksigner" verify "$work/Route-Android.apk"
print -r -- "$work/Route-Android.apk"

