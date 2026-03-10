# Agent Notes

## Development Setup

Run `./run_pi_dev_mode.sh` to start pi in local development mode with an isolated home directory.

Pass extra pi flags directly to the script, e.g. `./run_pi_dev_mode.sh -c` to continue the last session.

## Scripts

- `run_pi_dev_mode.sh` — Starts pi with an isolated home (`PI_CODING_AGENT_DIR=.pi-home`), loads the local extension and devmode banner, and forwards any extra args to pi.
- `dev_additional_extensions.json` — Optional extra extensions/skills/prompts to load in dev mode (copy from `dev_additional_extensions.json.example`).
