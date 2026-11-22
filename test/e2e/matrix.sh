#!/bin/sh
# Runs the end-to-end suites against several browser builds.
#   sh test/e2e/matrix.sh /path/to/helium-0.3.5.1/chrome /path/to/chrome-120/chrome ...
# Old Chrome for Testing builds: https://googlechromelabs.github.io/chrome-for-testing/
# Old Helium builds: https://github.com/imputnet/helium-linux/releases
set -u
cd "$(dirname "$0")/../.."
status=0
for exe in "$@"; do
  version="$("$exe" --version 2>/dev/null || echo "$exe")"
  for suite in sync lifecycle; do
    out="$(HELIUM= BROWSER="$exe" node --test --test-concurrency=1 "test/e2e/$suite.test.js" 2>&1)"
    pass="$(printf '%s\n' "$out" | sed -n 's/^# pass //p')"
    fail="$(printf '%s\n' "$out" | sed -n 's/^# fail //p')"
    printf '%-45s %-10s pass %s fail %s\n' "$version" "$suite" "${pass:-?}" "${fail:-?}"
    [ "${fail:-1}" = 0 ] || { status=1; printf '%s\n' "$out" | grep -E '^not ok|error:' | sed 's/^/    /'; }
  done
done
exit $status
