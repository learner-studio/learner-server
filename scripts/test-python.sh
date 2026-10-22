#!/usr/bin/env bash
# The Hindsight runner tests (scripts/hindsight/*.test.py) import Hindsight itself, so they run under its venv,
# not the system python, and `bun test` cannot discover them.
set -euo pipefail
root=${HINDSIGHT_INSTALL_ROOT:-/opt/learner-hindsight}
cd "$(dirname "$0")/hindsight"
for test in *.test.py; do
  echo "== $test"
  PYTHONPATH="$root/src" "$root/venv/bin/python" -B "$test"
done
