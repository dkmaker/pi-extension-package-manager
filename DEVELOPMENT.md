# Development Setup

## Prerequisites

- [pi coding agent](https://github.com/nicobrinkkemper/pi-coding-agent) installed

## Local Development Mode

By default, pi loads extensions from git packages. For local development, run the setup script to symlink the repo's source files directly into pi's extension directory:

```bash
bash scripts/enable_dev_mode.sh
```

This will:

1. Create `.pi/extensions/package-manager/` with symlinks to all `.ts` files in the repo root
2. Remove any git package reference from `.pi/settings.json`
3. Clean up the `.pi/git/` folder if present

After running the script, restart pi and it will load your local source files. Any edits to the `.ts` files are picked up on the next pi restart.

## Project Structure

```
constants.ts          # Shared constants (paths, intervals)
git-pool.ts           # Git tracking for the package pool
index.ts              # Extension entry point, commands, status bar
onboard.ts            # Onboard existing extensions into the pool
registry.ts           # Package registry management (add/remove/restore)
store.ts              # Per-repo manifest and package generation
updates.ts            # Background update checking and applying
scripts/              # Development scripts
  enable_dev_mode.sh  # Set up local dev symlinks
.pi/
  settings.json       # Pi settings (no git package in dev mode)
  extensions/         # Symlinked extensions (gitignored)
```
