#!/usr/bin/env bash
# Starts pi with a clean home folder and only the local extension loaded.
# Additional extensions/skills/prompts can be added via dev_additional_extensions.json
set -euo pipefail

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed."
  echo "Install it with:"
  echo "  macOS:  brew install jq"
  echo "  Ubuntu: sudo apt install jq"
  echo "  Arch:   sudo pacman -S jq"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

export PI_CODING_AGENT_DIR="$REPO_ROOT/.pi-home"
mkdir -p "$PI_CODING_AGENT_DIR"

# Purge the repo's .pi/settings.json on every dev start so pi regenerates it
# without stale package manager entries from outside devmode.
if [ -f "$REPO_ROOT/.pi/settings.json" ]; then
  mv "$REPO_ROOT/.pi/settings.json" "$REPO_ROOT/.pi/settings.json.bak"
  echo "🗑  Backed up .pi/settings.json → settings.json.bak (pi will regenerate)"
fi

# Copy auth and settings on first create (so dev profile can diverge)
if [ -f "$HOME/.pi/agent/auth.json" ] && [ ! -f "$PI_CODING_AGENT_DIR/auth.json" ]; then
  cp "$HOME/.pi/agent/auth.json" "$PI_CODING_AGENT_DIR/auth.json"
fi
if [ -f "$HOME/.pi/agent/settings.json" ] && [ ! -f "$PI_CODING_AGENT_DIR/settings.json" ]; then
  jq 'del(.packages, .extensions, .skills, .prompts, .themes)' "$HOME/.pi/agent/settings.json" > "$PI_CODING_AGENT_DIR/settings.json"
fi

export PI_DEVMODE_ENABLED=1

CONFIG="$REPO_ROOT/dev_additional_extensions.json"

ARGS=(--extension "$REPO_ROOT" --extension "$REPO_ROOT/.pi/extensions/devmode.ts")

if [ -f "$CONFIG" ]; then
  while IFS= read -r ext; do
    ext="${ext/#\~/$HOME}"
    ARGS+=(--extension "$ext")
  done < <(jq -r '.extensions[]? // empty' "$CONFIG")

  while IFS= read -r skill; do
    skill="${skill/#\~/$HOME}"
    ARGS+=(--skill "$skill")
  done < <(jq -r '.skills[]? // empty' "$CONFIG")

  while IFS= read -r prompt; do
    prompt="${prompt/#\~/$HOME}"
    ARGS+=(--prompt-template "$prompt")
  done < <(jq -r '.prompts[]? // empty' "$CONFIG")
fi

exec pi "${ARGS[@]}" "$@"
