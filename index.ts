import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, Box } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve, basename, extname } from "path";
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
import { analyzeOnboard, executeOnboard } from "./onboard.js";
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

  // ── /packages-onboard — analyze, validate via TUI, execute ─────────────
  pi.registerCommand("packages-onboard", {
    description: "Onboard an existing extension into the pool: /packages-onboard <path>",
    handler: async (args, ctx) => {
      const sourcePath = args.trim();
      if (!sourcePath) {
        ctx.ui.notify(
          "Usage: /packages-onboard <path>\n\nExamples:\n  /packages-onboard .pi/extensions/my-ext.ts\n  /packages-onboard .pi/extensions/my-dir-ext/",
          "warning"
        );
        return;
      }

      const cwd = process.cwd();
      const analysis = analyzeOnboard(sourcePath, cwd);

      if (!analysis.valid) {
        ctx.ui.notify(`❌ Cannot onboard: ${analysis.error}`, "error");
        return;
      }

      // Show TUI validation screen
      const result = await ctx.ui.custom<{ action: "accept"; name: string } | { action: "cancel" }>(
        (tui, theme, _kb, done) => {
          let nameInput = analysis.name;
          let editing = false;
          let scroll = 0;
          let cache: string[] | undefined;

          function handleInput(data: string) {
            if (editing) {
              if (matchesKey(data, Key.escape)) {
                editing = false;
                cache = undefined;
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.enter)) {
                editing = false;
                cache = undefined;
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.backspace)) {
                nameInput = nameInput.slice(0, -1);
                cache = undefined;
                tui.requestRender();
                return;
              }
              if (data.length === 1 && data >= " ") {
                nameInput += data;
                cache = undefined;
                tui.requestRender();
              }
              return;
            }

            // Normal mode
            if (matchesKey(data, Key.escape) || data === "q") {
              done({ action: "cancel" });
              return;
            }
            if (matchesKey(data, Key.enter) || data === "y") {
              // Sanitize name before accepting
              const sanitized = nameInput
                .replace(/[^a-zA-Z0-9._-]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "")
                .toLowerCase();
              if (!sanitized) {
                cache = undefined;
                tui.requestRender();
                return;
              }
              done({ action: "accept", name: sanitized });
              return;
            }
            if (data === "e" || data === "n") {
              editing = true;
              cache = undefined;
              tui.requestRender();
              return;
            }
            if (data === "j" || matchesKey(data, Key.down)) {
              scroll++;
              cache = undefined;
              tui.requestRender();
              return;
            }
            if (data === "k" || matchesKey(data, Key.up)) {
              scroll = Math.max(0, scroll - 1);
              cache = undefined;
              tui.requestRender();
              return;
            }
          }

          function render(width: number, height: number): string[] {
            if (cache) return cache;
            const w = width - 2;
            const lines: string[] = [];
            const hr = theme.fg("accent", "─".repeat(w));

            lines.push(hr);
            lines.push(` 📦 Onboard Review`);
            lines.push(hr);
            lines.push(``);

            // Source
            lines.push(` ${theme.fg("dim", "Source:")}  ${analysis.sourcePath}`);
            lines.push(` ${theme.fg("dim", "Type:")}    ${analysis.type}`);
            lines.push(``);

            // Detected components
            if (analysis.components.length > 0) {
              lines.push(` ${theme.fg("dim", "Components:")}`);
              for (const comp of analysis.components) {
                const icon = comp.type === "extension" ? "🔌"
                  : comp.type === "skill" ? "🧠"
                  : comp.type === "theme" ? "🎨"
                  : "📝";
                const via = theme.fg("dim", `(${comp.via})`);
                lines.push(`   ${icon} ${comp.type} ${via}`);
                for (const ev of comp.evidence.slice(0, 5)) {
                  lines.push(`     ${theme.fg("dim", `→ ${ev}`)}`);
                }
                if (comp.evidence.length > 5) {
                  lines.push(theme.fg("dim", `     ... +${comp.evidence.length - 5} more`));
                }
              }
            } else {
              lines.push(` ${theme.fg("warning" as any, "⚠ No pi components detected")}`);
            }

            // Pi manifest
            if (analysis.hasPiManifest && analysis.piManifest) {
              lines.push(``);
              lines.push(` ${theme.fg("dim", "pi manifest:")}`)
              for (const [k, v] of Object.entries(analysis.piManifest)) {
                lines.push(`   ${theme.fg("accent", k)}: ${theme.fg("dim", JSON.stringify(v))}`);
              }
            }

            // pi-package keyword
            if (analysis.hasPiKeyword) {
              lines.push(` ${theme.fg("dim", "✓ has pi-package keyword")}`);
            }

            // Description
            if (analysis.description) {
              lines.push(` ${theme.fg("dim", "Desc:")}    ${analysis.description}`);
            }

            // Dependencies
            if (analysis.dependencies.length > 0) {
              lines.push(``);
              lines.push(` ${theme.fg("dim", "Dependencies:")}`);
              for (const dep of analysis.dependencies) {
                lines.push(`   • ${dep}`);
              }
            }

            // Files
            lines.push(``);
            lines.push(` ${theme.fg("dim", `Files (${analysis.files.length}):`)}`)
            const maxFiles = 15;
            const displayFiles = analysis.files.slice(0, maxFiles);
            for (const f of displayFiles) {
              const ext = extname(f);
              const color = [".ts", ".js"].includes(ext) ? "accent" : "dim";
              lines.push(`   ${theme.fg(color as any, f)}`);
            }
            if (analysis.files.length > maxFiles) {
              lines.push(theme.fg("dim", `   ... and ${analysis.files.length - maxFiles} more`));
            }

            // Steps
            lines.push(``);
            lines.push(` ${theme.fg("dim", "Will do:")}`);
            for (const step of analysis.steps) {
              lines.push(`   ${step}`);
            }

            // Git sync note
            if (isGitEnabled()) {
              lines.push(`   ${theme.fg("accent", "Git sync after onboard")}`);
            }

            // Name + controls
            lines.push(``);
            lines.push(hr);
            if (editing) {
              lines.push(` Name: ${theme.fg("accent", nameInput)}▏  ${theme.fg("dim", "(Enter to confirm, Esc to cancel)")}`);
            } else {
              lines.push(` Name: ${theme.fg("accent", nameInput)}  ${theme.fg("dim", "  [e] edit name")}`);
            }
            lines.push(``);
            lines.push(` ${theme.fg("dim", "[Enter/y] accept  [e] edit name  [q/Esc] cancel  [j/k] scroll")}`);
            lines.push(hr);

            // Apply scroll
            const maxVisible = height - 2;
            if (lines.length > maxVisible) {
              const maxScroll = Math.max(0, lines.length - maxVisible);
              scroll = Math.min(scroll, maxScroll);
              cache = lines.slice(scroll, scroll + maxVisible);
            } else {
              cache = lines;
            }
            return cache;
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
            minWidth: 60,
            anchor: "center",
          },
        },
      );

      if (result.action === "cancel") {
        ctx.ui.notify("Onboard cancelled.", "info");
        return;
      }

      // Update name if changed
      if (result.name !== analysis.name) {
        const newTarget = resolve(PACKAGES_DIR, result.name);
        if (existsSync(newTarget)) {
          ctx.ui.notify(`❌ Package "${result.name}" already exists in the pool.`, "error");
          return;
        }
        analysis.name = result.name;
        analysis.targetDir = resolve(PACKAGES_DIR, result.name);
      }

      try {
        executeOnboard(analysis, cwd);
        ctx.ui.notify(
          `✅ Onboarded "${analysis.name}" into the pool and enabled for this repo.\nRun /reload to apply.`,
          "info"
        );

        // Update status
        const allPkgs = listPackages();
        const manifest = loadRepoManifest(cwd);
        ctx.ui.setStatus("pkg-count", `📦 ${manifest.enabled.length}/${allPkgs.length}`);

        // Auto git-sync if git is enabled
        if (isGitEnabled()) {
          try {
            const syncResult = gitSyncPool();
            ctx.ui.notify(`🔄 Git sync: ${syncResult.message}`, "info");
          } catch (e: any) {
            ctx.ui.notify(`⚠️ Git sync failed: ${e.message}`, "warning");
          }
        }
      } catch (e: any) {
        ctx.ui.notify(`❌ Onboard failed: ${e.message}`, "error");
      }
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
