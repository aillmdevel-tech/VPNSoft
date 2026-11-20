#!/bin/zsh
set -euo pipefail
base=${0:A:h}
if (( $# < 1 )) || [[ ! -f "$1/profiles.json" ]]; then
  print -u2 "Usage: $0 PROFILE_DIRECTORY [router options]"
  exit 2
fi
profiles=${1:A}
shift
exec "$base/route-client" -config "$profiles/profiles.json" -engines "$base/engines" "$@"
