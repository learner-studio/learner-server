#!/usr/bin/env bash
# Builds the Hindsight runtime learner-hindsight runs, from this repo alone:
#   vendor/hindsight (the source) + deploy/hindsight/requirements.lock (every dependency, pinned).
# Output: /opt/learner-hindsight-<lock hash>/{python,venv}, then /opt/learner-hindsight is repointed at it.
# A venv is not relocatable, so it is built in its final directory and only the symlink moves; a failed
# build leaves the running service untouched, and rollback is repointing the link.
# Run as root, then: systemctl restart learner-hindsight
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DEST=${HINDSIGHT_INSTALL_ROOT:-/opt/learner-hindsight}
PY=3.11.16
REV=$(cat "$ROOT/deploy/hindsight/requirements.lock" "$ROOT/deploy/hindsight/install.sh" | sha256sum | cut -c1-12)-$(git -C "$ROOT" log -1 --format=%h -- vendor/hindsight)
BUILD=$DEST-$REV
[ -e "$BUILD" ] && { echo "$BUILD exists; repointing only"; ln -sfn "$BUILD" "$DEST"; exit 0; }
trap 'rm -rf "$BUILD"' EXIT

# The service runs as `hindsight` under ProtectHome, so the interpreter must live outside /root.
UV_PYTHON_INSTALL_DIR=$BUILD/python uv python install "$PY"
uv venv --python "$(UV_PYTHON_INSTALL_DIR=$BUILD/python uv python find "$PY")" "$BUILD/venv"
# torch's +cpu build exists only on the PyTorch index; everything else comes from PyPI.
uv pip install --python "$BUILD/venv/bin/python" --index-url https://download.pytorch.org/whl/cpu \
  "$(rg '^torch==' "$ROOT/deploy/hindsight/requirements.lock")"
uv pip install --python "$BUILD/venv/bin/python" -r "$ROOT/deploy/hindsight/requirements.lock" --no-deps \
  --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match
uv pip install --python "$BUILD/venv/bin/python" --no-deps "$ROOT/vendor/hindsight"
"$BUILD/venv/bin/python" -c 'import hindsight_api.main, torch, sentence_transformers; print("hindsight runtime ok, torch", torch.__version__)'

chmod -R a+rX "$BUILD"
trap - EXIT
[ -e "$DEST" ] && [ ! -L "$DEST" ] && { echo "$DEST is a real directory; move it aside first"; exit 1; }
ln -sfn "$BUILD" "$DEST"
echo "installed $BUILD; $DEST -> $(readlink "$DEST")"
