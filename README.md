# Pi Package Manager

A package manager for [pi](https://github.com/badlogic/pi) that manages extensions, skills, and prompts across projects using pi's native package system.

## How It Works

Instead of symlinking or manually copying resources, this extension:

1. Maintains a **pool** of packages at `~/.pi/packagemanager/packages/`
2. Packages come from **git**, **npm**, or **local** sources
3. Per-repo, you toggle which packages are enabled
4. Generates a **pi-native package** per repo that pi loads automatically
5. On machines without the package manager, the path silently skips — no errors

## Installation

```bash
pi install git:github.com/dkmaker/pi-extension-package-manager
```

## Directory Structure

```
~/.pi/packagemanager/
├── .git/                           ← optional (git-enabled pool)
├── .gitignore                      ← auto-managed
├── registry.json                   ← source of truth for all packages
├── packages/                       ← the pool
│   ├── pi-ext-project-mgmt/       ← git clone
│   │   ├── .git/
│   │   ├── package.json
│   │   └── index.ts
│   ├── some-npm-pkg/              ← npm install
│   │   ├── package.json
│   │   └── extensions/
│   └── my-local-tools/            ← local/onboarded
│       ├── package.json
│       └── extensions/
└── repos/                          ← auto-generated per-repo
    └── <hash>/
        ├── manifest.json           ← which packages enabled
        └── package.json            ← generated pi package
```

## Commands

| Command | Description |
|---------|-------------|
| `/packages` | Interactive TUI — toggle packages for current project |
| `/packages-list` | List all packages and their status |
| `/packages-add <source>` | Add a package from git, npm, or local path |
| `/packages-remove <name>` | Remove a package from the pool |
| `/packages-update [name]` | Apply pending updates (or check + update all) |
| `/packages-onboard <path>` | Absorb an existing extension into the pool |
| `/packages-init` | Initialize package manager for current repo |
| `/packages-git-init <remote>` | Enable git tracking for the pool |
| `/packages-git-sync` | Push/pull the pool repo |
| `/packages-restore` | Recreate git/npm packages from registry on a new machine |

## Workflows

### Adding packages

```
/packages-add git:github.com/user/cool-extension
/packages-add npm:@scope/pi-tools
/packages-add /path/to/local/package
```

### Enabling for a project

```
/packages          ← opens interactive TUI
                   ← space to toggle, q to close
/reload            ← apply changes
```

### Onboarding an existing extension

Move an extension you've been developing locally into the managed pool:

```
/packages-onboard .pi/extensions/my-cool-ext/
```

This:
1. Validates the extension
2. Shows what will happen (with confirmation)
3. Moves it to `~/.pi/packagemanager/packages/my-cool-ext/`
4. Removes the original
5. Enables it for the current repo
6. Adds `.gitignore` for `node_modules/`
7. Runs `npm install` if needed

### Updates

Packages are checked for updates every 24 hours (background, on session start). When updates are detected, you'll see a notification. To apply:

```
/packages-update              ← update all
/packages-update my-package   ← update one
```

### Git-enabled pool

Track your local packages in git so they sync across machines:

```
/packages-git-init git@github.com:user/pi-packages.git
/packages-git-sync
```

- **Local packages** → tracked in git (your custom code)
- **Git/npm packages** → gitignored (reproducible from `registry.json`)
- **`repos/`** → gitignored (generated per-machine)

On a new machine:
```
git clone <your-pool-repo> ~/.pi/packagemanager
/packages-restore    ← clones/installs all git/npm packages from registry
```

## Status Bar

Shows `📦 3/7` (enabled/total) with `⬆2` badge when updates are available.
