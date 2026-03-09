import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { matchesKey, Key, truncateToWidth, Box } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve, basename } from "path";
import { PACKAGES_DIR, PKG_MGR_ROOT, type PackageEntry } from "./constants.js";
import {
  loadRegistry,
  listPackages,
  addPackage,
  removePackage,
  packageDir,
  parseSource,
  gitClone,
  npmInstallPackage,
  installDependenciesIfNeeded,
} from "./registry.js";
import {
  loadRepoManifest,
  togglePackage,
  enablePackage,
  generatePackageJson,
  ensurePackageInSettings,
  getPackageDescription,
  repoHash,
} from "./store.js";
import { validatePackage } from "./onboard.js";
import { gitInitPool, gitSyncPool, isGitEnabled, getGitRemote, ensureGitignore } from "./git-pool.js";
import { checkAllUpdates, getPendingUpdates, applyUpdate, applyAllUpdates } from "./updates.js";

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Ensure base directories exist
  mkdirSync(PACKAGES_DIR, { recursive: true });

  // ── Session start: status + background update check ─────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const cwd = process.cwd();
    const allPkgs = listPackages();
    const manifest = loadRepoManifest(cwd);
    const enabledCount = manifest.enabled.length;

    ctx.ui.setStatus("pkg-count", `📦 ${enabledCount}/${allPkgs.length}`);

    // Show enabled packages briefly
    if (enabledCount > 0) {
      ctx.ui.setWidget("pkg-active", [
        `📦 ${enabledCount} managed: ${manifest.enabled.join(" · ")}`,
      ]);
      setTimeout(() => ctx.ui.setWidget("pkg-active", undefined), 5000);
    }

    // Background update check (non-blocking)
    setTimeout(() => {
      try {
        const updated = checkAllUpdates();
        const pending = getPendingUpdates();
        if (pending.length > 0) {
          ctx.ui.notify(
            `📦 ${pending.length} package update${pending.length > 1 ? "s" : ""} available: ${pending.map(p => p.name).join(", ")}\nRun /packages-update to apply.`,
            "info"
          );
          ctx.ui.setStatus("pkg-count", `📦 ${enabledCount}/${allPkgs.length} ⬆${pending.length}`);
        }
      } catch {}
    }, 2000);
  });

  // ── /packages — interactive TUI ────────────────────────────────────────
  pi.registerCommand("packages", {
    description: "Toggle packages for the current project",
    handler: async (_args, ctx) => {
      const cwd = process.cwd();
      const allPkgs = listPackages();

      if (!allPkgs.length) {
        ctx.ui.notify(
          `No packages in pool.\nUse /packages-add <source> to add packages.\nPool: ${PACKAGES_DIR}`,
          "warning"
        );
        return;
      }

      const manifest = loadRepoManifest(cwd);
      const termRows = process.stdout.rows || 40;
      const visibleRows = Math.max(12, Math.floor(termRows * 0.6));

      const result = await ctx.ui.custom<{ changed: boolean } | null>(
        (tui, theme, _kb, done) => {
          let cursor = 0;
          let cache: string[] | undefined;
          let scrollOffset = 0;
          let changed = false;

          // Live state: track enabled per package
          const enabledSet = new Set(manifest.enabled);

          function refresh() { cache = undefined; tui.requestRender(); }

          function handleInput(data: string) {
            if (matchesKey(data, Key.escape) || data === "q") {
              done({ changed });
              return;
            }
            if (matchesKey(data, Key.up) || data === "k") {
              cursor = Math.max(0, cursor - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down) || data === "j") {
              cursor = Math.min(allPkgs.length - 1, cursor + 1);
              refresh();
              return;
            }
            if (matchesKey(data, "space")) {
              const pkg = allPkgs[cursor];
              const nowEnabled = togglePackage(cwd, pkg.name);
              if (nowEnabled) enabledSet.add(pkg.name);
              else enabledSet.delete(pkg.name);
              changed = true;
              refresh();
              return;
            }
          }

          function render(width: number): string[] {
            if (cache) return cache;
            const lines: string[] = [];
            const add = (s: string) => lines.push(truncateToWidth(s, width));

            // Header
            add(theme.fg("accent", "─".repeat(width)));
            add(` 📦 Package Manager    ${theme.fg("dim", `${enabledSet.size} enabled · ${allPkgs.length} total`)}`);
            add(theme.fg("accent", "─".repeat(width)));

            // Package rows
            const rows: { line: string; idx: number }[] = [];
            let lastSource = "";
            for (let i = 0; i < allPkgs.length; i++) {
              const pkg = allPkgs[i];

              // Group header by source type
              if (pkg.sourceType !== lastSource) {
                lastSource = pkg.sourceType;
                const label = pkg.sourceType === "git" ? "Git Packages" : pkg.sourceType === "npm" ? "npm Packages" : "Local Packages";
                rows.push({ line: "", idx: -1 });
                rows.push({ line: theme.fg("dim", ` ── ${label} ──`), idx: -1 });
              }

              const isCur = i === cursor;
              const enabled = enabledSet.has(pkg.name);
              const icon = enabled ? theme.fg("accent", "✓") : theme.fg("dim", "·");
              const pointer = isCur ? theme.fg("accent", "▸ ") : "  ";
              const nameColor = isCur ? "accent" : enabled ? "text" : "dim";
              const nameStr = theme.fg(nameColor as any, pkg.name);
              const desc = theme.fg("dim", ` — ${getPackageDescription(pkg.name)}`);
              const updateBadge = pkg.updateAvailable ? theme.fg("warning" as any, " ⬆") : "";

              rows.push({
                line: truncateToWidth(`${pointer}[${icon}] ${nameStr}${desc}${updateBadge}`, width),
                idx: i,
              });
            }

            // Scrolling
            const listHeight = visibleRows - 6;
            let cursorRow = 0;
            for (let r = 0; r < rows.length; r++) {
              if (rows[r].idx === cursor) { cursorRow = r; break; }
            }
            if (cursorRow < scrollOffset) scrollOffset = cursorRow;
            if (cursorRow >= scrollOffset + listHeight) scrollOffset = cursorRow - listHeight + 1;
            scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, rows.length - listHeight)));

            const slice = rows.slice(scrollOffset, scrollOffset + listHeight);
            for (const row of slice) lines.push(row.line);
            while (lines.length < visibleRows - 3) lines.push("");

            // Footer
            const canUp = scrollOffset > 0;
            const canDown = scrollOffset + listHeight < rows.length;
            const scrollHint = `${canUp ? "▲" : " "} ${cursor + 1}/${allPkgs.length} ${canDown ? "▼" : " "}`;

            add(theme.fg("accent", "─".repeat(width)));
            add(theme.fg("dim", ` ↑↓/jk move · Space toggle · q close  ${scrollHint}`));
            add(theme.fg("accent", "─".repeat(width)));

            cache = lines;
            return lines;
          }

          const content = { render, invalidate: () => { cache = undefined; } };
          const box = new Box(1, 1, (text: string) => `\x1b[48;5;237m${text}\x1b[49m`);
          box.addChild(content);
          (box as any).handleInput = handleInput;
          return box;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "80%",
            minWidth: 50,
            anchor: "center",
          },
        },
      );

      if (result?.changed) {
        const added = ensurePackageInSettings(cwd);
        const updatedManifest = loadRepoManifest(cwd);
        ctx.ui.setStatus("pkg-count", `📦 ${updatedManifest.enabled.length}/${allPkgs.length}`);
        ctx.ui.notify(
          `Package state updated.${added ? " Added to .pi/settings.json." : ""}\nRun /reload to apply changes.`,
          "info"
        );
      }
    },
  });

  // ── /packages-list — text listing ───────────────────────────────────────
  pi.registerCommand("packages-list", {
    description: "List all packages in the pool and their status",
    handler: async (_args, ctx) => {
      const cwd = process.cwd();
      const allPkgs = listPackages();
      const manifest = loadRepoManifest(cwd);
      const enabledSet = new Set(manifest.enabled);

      if (!allPkgs.length) {
        ctx.ui.notify(`No packages in pool. Use /packages-add <source> to add.`, "warning");
        return;
      }

      const lines: string[] = [`📦 Package Manager — ${allPkgs.length} packages\n`];
      let lastSource = "";
      for (const pkg of allPkgs) {
        if (pkg.sourceType !== lastSource) {
          lastSource = pkg.sourceType;
          const label = pkg.sourceType === "git" ? "Git" : pkg.sourceType === "npm" ? "npm" : "Local";
          lines.push(`\n── ${label} ──`);
        }
        const enabled = enabledSet.has(pkg.name);
        const icon = enabled ? "✓" : "·";
        const update = pkg.updateAvailable ? " ⬆" : "";
        const src = pkg.sourceType !== "local" ? ` (${pkg.source})` : "";
        lines.push(`  [${icon}] ${pkg.name}${update} — ${getPackageDescription(pkg.name)}${src}`);
      }

      lines.push(`\n✓=enabled for this repo  ·=available  ⬆=update available`);
      if (isGitEnabled()) {
        lines.push(`Git pool: ${getGitRemote() || "enabled"}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /packages-add — add a package to the pool ──────────────────────────
  pi.registerCommand("packages-add", {
    description: "Add a package to the pool: /packages-add git:github.com/user/repo | npm:@scope/pkg | /local/path",
    handler: async (args, ctx) => {
      const source = args.trim();
      if (!source) {
        ctx.ui.notify("Usage: /packages-add <source>\n\nExamples:\n  /packages-add git:github.com/user/repo\n  /packages-add npm:@scope/pkg\n  /packages-add /path/to/local/package", "warning");
        return;
      }

      const parsed = parseSource(source);

      if (parsed.type === "local") {
        // For local, resolve path and derive name
        const absPath = resolve(process.cwd(), parsed.value);
        if (!existsSync(absPath)) {
          ctx.ui.notify(`Path does not exist: ${absPath}`, "error");
          return;
        }
        parsed.name = basename(absPath).toLowerCase().replace(/[^a-z0-9._-]/g, "-");
      }

      if (!parsed.name) {
        ctx.ui.notify(`Could not derive package name from source: ${source}`, "error");
        return;
      }

      // Check if already exists
      const dir = packageDir(parsed.name);
      if (existsSync(dir)) {
        ctx.ui.notify(`Package "${parsed.name}" already exists. Remove it first.`, "warning");
        return;
      }

      ctx.ui.notify(`📦 Adding ${parsed.name} from ${source}...`, "info");

      try {
        if (parsed.type === "git") {
          const commit = gitClone(parsed.value, dir, parsed.ref);
          installDependenciesIfNeeded(dir);

          addPackage({
            name: parsed.name,
            sourceType: "git",
            source: source,
            ref: parsed.ref,
            commit,
            installedAt: new Date().toISOString(),
            lastUpdateCheck: new Date().toISOString(),
            updateAvailable: false,
          });
        } else if (parsed.type === "npm") {
          mkdirSync(dir, { recursive: true });
          const version = npmInstallPackage(parsed.value, dir);

          addPackage({
            name: parsed.name,
            sourceType: "npm",
            source: source,
            version,
            installedAt: new Date().toISOString(),
            lastUpdateCheck: new Date().toISOString(),
            updateAvailable: false,
          });
        } else {
          // Local: copy into pool
          const { cpSync } = require("fs");
          const absPath = resolve(process.cwd(), parsed.value);
          cpSync(absPath, dir, { recursive: true });
          installDependenciesIfNeeded(dir);

          addPackage({
            name: parsed.name,
            sourceType: "local",
            source: "local",
            installedAt: new Date().toISOString(),
          });
        }

        // Update pool gitignore
        ensureGitignore();

        ctx.ui.notify(`✅ Added "${parsed.name}". Use /packages to enable it for this repo.`, "info");
      } catch (e: any) {
        // Clean up on failure
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        ctx.ui.notify(`❌ Failed to add package: ${e.message}`, "error");
      }
    },
  });

  // ── /packages-remove — remove from pool ────────────────────────────────
  pi.registerCommand("packages-remove", {
    description: "Remove a package from the pool: /packages-remove <name>",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /packages-remove <name>", "warning");
        return;
      }

      const dir = packageDir(name);
      if (!existsSync(dir)) {
        ctx.ui.notify(`Package "${name}" not found in pool.`, "warning");
        return;
      }

      rmSync(dir, { recursive: true, force: true });
      removePackage(name);
      ensureGitignore();

      ctx.ui.notify(`✅ Removed "${name}" from pool.`, "info");
    },
  });

  // ── /packages-update — apply updates ───────────────────────────────────
  pi.registerCommand("packages-update", {
    description: "Update packages: /packages-update [name] or /packages-update (all)",
    handler: async (args, ctx) => {
      const name = args.trim();

      if (name) {
        // Update single package
        ctx.ui.notify(`📦 Updating ${name}...`, "info");
        const result = applyUpdate(name);
        if (result.success) {
          ctx.ui.notify(`✅ ${result.name}: ${result.message}. Run /reload to apply.`, "info");
        } else {
          ctx.ui.notify(`❌ ${result.name}: ${result.message}`, "error");
        }
      } else {
        // Update all
        const pending = getPendingUpdates();
        if (pending.length === 0) {
          // Force check first
          ctx.ui.notify("📦 Checking for updates...", "info");
          const withUpdates = checkAllUpdates();
          if (withUpdates.length === 0) {
            ctx.ui.notify("✅ All packages are up to date.", "info");
            return;
          }
        }

        const results = applyAllUpdates();
        const success = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        const lines: string[] = [];
        if (success.length > 0) {
          lines.push(`✅ Updated ${success.length} package(s):`);
          for (const r of success) lines.push(`  ${r.name}: ${r.message}`);
        }
        if (failed.length > 0) {
          lines.push(`❌ Failed ${failed.length} package(s):`);
          for (const r of failed) lines.push(`  ${r.name}: ${r.message}`);
        }
        if (success.length > 0) lines.push("\nRun /reload to apply changes.");

        ctx.ui.notify(lines.join("\n"), success.length > 0 ? "info" : "error");
      }

      // Update status
      const allPkgs = listPackages();
      const manifest = loadRepoManifest(process.cwd());
      const pendingNow = getPendingUpdates();
      const badge = pendingNow.length > 0 ? ` ⬆${pendingNow.length}` : "";
      ctx.ui.setStatus("pkg-count", `📦 ${manifest.enabled.length}/${allPkgs.length}${badge}`);
    },
  });

  // ── /packages-onboard — agent-driven review & onboard ──────────────────
  pi.registerCommand("packages-onboard", {
    description: "Onboard a pi package into the pool: /packages-onboard <path>",
    handler: async (args, ctx) => {
      const sourcePath = args.trim();
      if (!sourcePath) {
        ctx.ui.notify(
          "Usage: /packages-onboard <path>\n\nExamples:\n  /packages-onboard ~/.pi/agent/available/extensions/my-ext/\n  /packages-onboard .pi/extensions/my-ext.ts",
          "warning"
        );
        return;
      }

      const poolDir = PACKAGES_DIR;
      const gitEnabled = isGitEnabled();

      ctx.ui.notify(`📦 Reviewing ${sourcePath} for onboarding...\nThe agent will analyze the source, propose a name, and ask for your confirmation.`, "info");

      pi.sendMessage({
        customType: "packages-onboard",
        display: false,
        content: [
          `📦 Onboard Request — review and onboard \`${sourcePath}\` into the pool at \`${poolDir}\`.`,
          ``,
          `Step 1 — Review the source:`,
          `- Read the files at the path. If it's a directory, list contents and read key files.`,
          `- If a single file is given, check its parent directory — it may be part of a larger package (look for package.json, other .ts/.js files, imports). If so, onboard the whole directory instead.`,
          `- Determine what pi components it contains:`,
          `  • Extensions — .ts/.js files, extensions/ dir, or pi.extensions in package.json`,
          `  • Skills — SKILL.md files, skills/ dir, or pi.skills in package.json`,
          `  • Prompts — .md templates, prompts/ dir, or pi.prompts in package.json`,
          `  • Themes — .json theme files, themes/ dir, or pi.themes in package.json`,
          `- Check for package.json, dependencies, description`,
          `- Summarize findings and propose a package name (lowercase, hyphenated, concise)`,
          `- Ask the user to confirm before proceeding`,
          ``,
          `Step 2 — After user confirms, do the onboard yourself:`,
          `- Copy/move the source into ${poolDir}/<name>/ — EXCLUDE node_modules/ (never copy it)`,
          `- Ensure it has a valid package.json with "keywords": ["pi-package"] and a pi manifest`,
          `- Ensure .gitignore includes node_modules/`,
          `- Do NOT run npm install — the register tool handles dependency installation`,
          `- Remove the original source`,
          ``,
          `Step 3 — Register and validate:`,
          `- Use the packages_register tool with the package name to register it and enable for this repo`,
          `- Use the packages_validate tool to verify everything is correct`,
          `${gitEnabled ? `- Run /packages-git-sync to sync the pool to git` : ""}`,
          `- Report the result to the user`,
        ].join("\n"),
      }, {
        triggerTurn: true,
        deliverAs: "steer",
      });
    },
  });

  // ── packages_register — tool for agent to register a pool package ──────
  pi.registerTool({
    name: "packages_register",
    label: "Register Package",
    description: "Register a package that exists in the pool directory and enable it for the current repo. Call this after placing package files in the pool.",
    parameters: Type.Object({
      name: Type.String({ description: "Package name (must match folder name in pool)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { name } = params;
      const dir = resolve(PACKAGES_DIR, name);

      if (!existsSync(dir)) {
        return { content: [{ type: "text", text: `❌ Package directory not found: ${dir}` }], details: {} };
      }

      const cwd = process.cwd();

      try {
        addPackage({
          name,
          sourceType: "local",
          source: "local",
          onboardedFrom: "onboarded",
          installedAt: new Date().toISOString(),
        });

        // Install dependencies if package.json has them
        let depsInstalled = false;
        const pkgJsonPath = resolve(dir, "package.json");
        if (existsSync(pkgJsonPath)) {
          try {
            const pkg = JSON.parse(require("fs").readFileSync(pkgJsonPath, "utf-8"));
            if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
              installDependenciesIfNeeded(dir);
              depsInstalled = true;
            }
          } catch {}
        }

        enablePackage(cwd, name);
        generatePackageJson(cwd);
        ensurePackageInSettings(cwd);
        ensureGitignore();

        const allPkgs = listPackages();
        const manifest = loadRepoManifest(cwd);
        ctx.ui.setStatus("pkg-count", `📦 ${manifest.enabled.length}/${allPkgs.length}`);

        const msg = `✅ Registered "${name}" and enabled for this repo.` +
          (depsInstalled ? ` Dependencies installed.` : ``) +
          ` Run /reload to apply.`;
        return { content: [{ type: "text", text: msg }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `❌ Register failed: ${e.message}` }], details: {} };
      }
    },
  });

  // ── packages_validate — tool for agent to validate a pool package ─────
  pi.registerTool({
    name: "packages_validate",
    label: "Validate Package",
    description: "Validate a package in the pool: checks structure, paths, package.json, pi manifest, skill frontmatter (name must match folder), dependencies, and jiti load for extensions.",
    parameters: Type.Object({
      name: Type.String({ description: "Package name to validate" }),
    }),
    async execute(_toolCallId, params) {
      const { name } = params;
      const result = await validatePackage(name);

      const lines: string[] = [
        `📦 Validation: ${name} — ${result.valid ? "✅ PASS" : "❌ FAIL"}`,
        ``,
      ];

      if (result.errors.length) {
        lines.push(`Errors:`);
        for (const e of result.errors) lines.push(`  ❌ ${e}`);
        lines.push(``);
      }
      if (result.warnings.length) {
        lines.push(`Warnings:`);
        for (const w of result.warnings) lines.push(`  ⚠️ ${w}`);
        lines.push(``);
      }
      if (result.info.length) {
        lines.push(`Info:`);
        for (const i of result.info) lines.push(`  ${i}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ── /packages-init — wire up current repo ──────────────────────────────
  pi.registerCommand("packages-init", {
    description: "Initialize package manager for current repo",
    handler: async (_args, ctx) => {
      const cwd = process.cwd();
      generatePackageJson(cwd);
      const added = ensurePackageInSettings(cwd);
      const hash = repoHash(cwd);
      ctx.ui.notify(
        `Package generated at ~/.pi/packagemanager/repos/${hash}/\n` +
        (added ? `Added to .pi/settings.json. Run /reload to apply.` : `Already in .pi/settings.json.`),
        "info"
      );
    },
  });

  // ── /packages-git-init — enable git for the pool ───────────────────────
  pi.registerCommand("packages-git-init", {
    description: "Enable git tracking for the package pool: /packages-git-init <remote>",
    handler: async (args, ctx) => {
      const remote = args.trim();
      if (!remote) {
        ctx.ui.notify(
          "Usage: /packages-git-init <remote>\n\nExample:\n  /packages-git-init git@github.com:user/pi-packages.git",
          "warning"
        );
        return;
      }

      try {
        gitInitPool(remote);
        ctx.ui.notify(
          `✅ Git enabled for package pool.\n  Remote: ${remote}\n  Path: ${PKG_MGR_ROOT}\n\nGit/npm packages are gitignored. Local packages are tracked.\nUse /packages-git-sync to push/pull.`,
          "info"
        );
      } catch (e: any) {
        ctx.ui.notify(`❌ Git init failed: ${e.message}`, "error");
      }
    },
  });

  // ── /packages-git-sync — push/pull the pool ────────────────────────────
  pi.registerCommand("packages-git-sync", {
    description: "Sync the package pool with its git remote",
    handler: async (_args, ctx) => {
      if (!isGitEnabled()) {
        ctx.ui.notify("Git is not enabled. Use /packages-git-init <remote> first.", "warning");
        return;
      }

      ctx.ui.notify("📦 Syncing package pool...", "info");
      const result = gitSyncPool();
      ctx.ui.notify(`📦 ${result.message}`, result.pushed ? "info" : "warning");
    },
  });

  // ── /packages-restore — recreate git/npm packages from registry ────────
  pi.registerCommand("packages-restore", {
    description: "Restore git/npm packages from registry.json (for new machine setup)",
    handler: async (_args, ctx) => {
      const reg = loadRegistry();
      const entries = Object.values(reg.packages).filter(
        p => p.sourceType === "git" || p.sourceType === "npm"
      );

      if (entries.length === 0) {
        ctx.ui.notify("No git/npm packages to restore.", "info");
        return;
      }

      ctx.ui.notify(`📦 Restoring ${entries.length} package(s)...`, "info");
      const results: string[] = [];

      for (const entry of entries) {
        const dir = packageDir(entry.name);
        if (existsSync(dir)) {
          results.push(`  ⏭ ${entry.name} — already exists`);
          continue;
        }

        try {
          if (entry.sourceType === "git") {
            const parsed = parseSource(entry.source);
            gitClone(parsed.value, dir, entry.ref);
            installDependenciesIfNeeded(dir);
            results.push(`  ✅ ${entry.name} — cloned`);
          } else if (entry.sourceType === "npm") {
            mkdirSync(dir, { recursive: true });
            const parsed = parseSource(entry.source);
            npmInstallPackage(parsed.value, dir);
            results.push(`  ✅ ${entry.name} — installed`);
          }
        } catch (e: any) {
          results.push(`  ❌ ${entry.name} — ${e.message}`);
        }
      }

      ctx.ui.notify(`📦 Restore complete:\n${results.join("\n")}`, "info");
    },
  });
}
