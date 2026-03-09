#!/usr/bin/env bash
# Sets up the local development environment by symlinking
# the repo's .ts source files into .pi/extensions/package-manager/
# so pi loads the local version instead of a git package.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$REPO_ROOT/.pi/extensions/package-manager"

echo "Setting up dev mode..."

# Create extension directory
mkdir -p "$EXT_DIR"

# Symlink all .ts files from repo root
count=0
for f in "$REPO_ROOT"/*.ts; do
  [ -f "$f" ] || continue
  ln -sf "$f" "$EXT_DIR/$(basename "$f")"
  count=$((count + 1))
done

echo "Linked $count .ts files into $EXT_DIR"

# Ensure settings.json doesn't reference the git package
SETTINGS="$REPO_ROOT/.pi/settings.json"
if [ -f "$SETTINGS" ] && grep -q '"git:' "$SETTINGS" 2>/dev/null; then
  echo '{}' > "$SETTINGS"
  echo "Removed git package reference from settings.json"
fi

# Clean up git-checked-out package if present
if [ -d "$REPO_ROOT/.pi/git" ]; then
  rm -rf "$REPO_ROOT/.pi/git"
  echo "Removed .pi/git/ folder"
fi

echo "Dev mode enabled! Restart pi to use local extension files."
