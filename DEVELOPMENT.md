# Development Setup

## Prerequisites

- [pi coding agent](https://github.com/mariozechner/pi-coding-agent) installed

## Local Development Mode

Run the dev script to start pi with an isolated home directory and the local extension loaded:

```bash
./run_pi_dev_mode.sh
```

Pass extra pi flags directly, e.g.:

```bash
./run_pi_dev_mode.sh -c   # continue last session
```

The script will:

1. Create `.pi-home/` as an isolated `PI_CODING_AGENT_DIR` (auth and settings copied from `~/.pi/agent/` on first run)
2. Load the local extension from the repo root (has `package.json`)
3. Load `.pi/extensions/devmode.ts` which shows a DEVMODE banner
4. Load any extra extensions/skills/prompts from `dev_additional_extensions.json`

## Additional Extensions

Copy the example config and add any extra extensions you want in dev mode:

```bash
cp dev_additional_extensions.json.example dev_additional_extensions.json
```

`dev_additional_extensions.json` is gitignored so it won't be committed.

## Project Structure

```
index.ts                        # Extension entry point, commands, status bar
constants.ts                    # Shared constants (paths, intervals)
git-pool.ts                     # Git tracking for the package pool
onboard.ts                      # Onboard existing extensions into the pool
registry.ts                     # Package registry management (add/remove/restore)
store.ts                        # Per-repo manifest and package generation
updates.ts                      # Background update checking and applying
run_pi_dev_mode.sh              # Start pi in dev mode
dev_additional_extensions.json  # (gitignored) Extra extensions for dev mode
dev_additional_extensions.json.example
.pi/
  extensions/
    devmode.ts                  # Devmode banner extension
scripts/
  enable_dev_mode.sh            # Legacy setup script (no longer needed)
```
