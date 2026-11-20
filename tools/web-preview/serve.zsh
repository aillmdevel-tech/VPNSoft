#!/bin/zsh
# Copies android/assets/journey to build/web-preview, injects mock-host.js and serves it.
# Usage: zsh tools/web-preview/serve.zsh [PORT]   (after edits: zsh tools/web-preview/sync.zsh)
set -eu
root=${0:A:h:h:h}
port=${1:-5180}
zsh "$root/tools/web-preview/sync.zsh"
print "http://localhost:$port/  (en: index-en.html, es: index-es.html)"
exec python3 -I -m http.server "$port" --bind 127.0.0.1 --directory "$root/build/web-preview"
