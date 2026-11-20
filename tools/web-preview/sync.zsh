#!/bin/zsh
# Refreshes build/web-preview from android/assets/journey (+ mock-host.js, en/es pages).
set -eu
root=${0:A:h:h:h}
out="$root/build/web-preview"
mkdir -p "$out"
find "$out" -mindepth 1 -delete
cp -R "$root/android/assets/journey/." "$out/"
python3 -I "$root/locales/build.py" "$out"
cp "$root/tools/web-preview/mock-host.js" "$out/"
for page in "$out"/index*.html; do
  sed -i '' 's|<script src="jsQR.js"></script>|<script src="mock-host.js"></script><script src="jsQR.js"></script>|' "$page"
done
