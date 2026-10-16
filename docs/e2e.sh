#!/usr/bin/env bash
# Runs the production CLI against the production Worker in a fresh local
# SQLite database. Does not bind a port or touch a deployed hub.
# First: cd server && npm ci && npm test
# Then, with agent-skill/requirements.lock installed: bash docs/e2e.sh
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"
exec python3 integration/test_encryption.py
