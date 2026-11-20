#!/bin/zsh
# Arguments: prepared Android work directory, bundletool-all jar, fresh output directory.
set -eu
root=${0:A:h:h}
inputs=${1:A}
bundletool=${2:A}
work=${3:A}
[[ ! -e "$work" ]] || { print -u2 'Choose a fresh output directory'; exit 1; }
sdk=${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}
bt="$sdk/build-tools/36.0.0"
platform="$sdk/platforms/android-36/android.jar"
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
mkdir -p "$work"/{classes,base/dex,base/manifest,assets}
cp -R "$root/android/assets/." "$work/assets/"
python3 "$root/locales/build.py" "$work/assets/journey"
python3 "$root/play/prepare_pages.py" "$work/assets/journey"
print -r -- '#pref-code, #code { display: none !important; }' >> "$work/assets/journey/style.css"
sources=("$root"/android/**/*.java)
sources=(${sources:#*/Provisioning.java})
sed -E 's/android:versionCode="[0-9]+"/android:versionCode="40"/; s/android:versionName="[^"]+"/android:versionName="0.40"/' "$root/android/AndroidManifest.xml" > "$work/AndroidManifest.xml"
"$JAVA_HOME/bin/javac" --release 8 -classpath "$platform" -d "$work/classes" ${sources:#*/ReleaseUpdate.java} "$root"/play/src/*.java
"$bt/d8" --min-api 30 --lib "$platform" --output "$work/base/dex" "$work"/classes/**/*.class
"$bt/aapt2" compile --dir "$root/android/res" -o "$work/res.zip"
"$bt/aapt2" link --proto-format -I "$platform" --manifest "$work/AndroidManifest.xml" -A "$work/assets" -o "$work/linked.zip" "$work/res.zip"
(cd "$work/base" && unzip -qo "$work/linked.zip" && mv AndroidManifest.xml manifest/ && cp -R "$inputs/apk/lib" . && zip -qr "$work/base.zip" .)
"$JAVA_HOME/bin/java" -jar "$bundletool" build-bundle --modules="$work/base.zip" --output="$work/Route-unsigned.aab"
"$JAVA_HOME/bin/java" -jar "$bundletool" validate --bundle="$work/Route-unsigned.aab"
