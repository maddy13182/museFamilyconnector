#!/usr/bin/env bash
# Install the repo's git hooks (currently: pre-commit).
# Run once per clone: ./scripts/install-git-hooks.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
HOOKS_DIR="$(git rev-parse --git-dir)/hooks"
mkdir -p "$HOOKS_DIR"
for hook in scripts/git-hooks/*; do
  name=$(basename "$hook")
  ln -sf "../../$hook" "$HOOKS_DIR/$name"
  chmod +x "$hook"
  echo "installed $name -> $hook"
done
echo "done. The pre-commit hook now runs version/workflow checks on every commit."
