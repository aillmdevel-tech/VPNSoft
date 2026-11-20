#!/bin/zsh
# Retry ~/.local/bin/resource-run while both slots are busy. Usage: zsh tools/rr.zsh LOG cmd args...
log=$1; shift
for i in $(seq 1 60); do
  ~/.local/bin/resource-run "$@" > "$log" 2>&1; code=$?
  grep -q "slots are busy" "$log" || exit $code
  sleep 10
done
exit 75
