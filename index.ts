import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { matchesKey, Key, truncateToWidth, Box } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { resolve, basename } from "path";
import { PACKAGES_DIR, PKG_MGR_ROOT, type PackageEntry } from "./constants.js";
import {
  loadRegistry,
  listPackages,
  addPackage,
  removePackage,
  packageDir,
  parseSource,
  getPackageState,
  setPackageState,
  gitClone,
  gitPush,
  npmInstallPackage,
  installDependenciesIfNeeded,
  isGitRepo,
  gitHasRemote,
  getMandatoryPackages,
  getFeaturedPackages,
} from "./registry.js";
import {
  loadRepoManifest,
  togglePackage,
  enablePackage,
  generatePackageJson,
  ensurePackageInSettings,
  getPackageDescription,
  getActivePackages,
  resolvePackageResources,
  repoHash,
} from "./store.js";
import { validatePackage } from "./onboard.js";
import { gitInitPool, gitSyncPool, gitPushPool, checkPoolUpdate, checkPoolUpdateAsync, gitPullPool, isGitEnabled, getGitRemote, ensureGitignore, gitMergeToMain, getDeviceBranch, hasMergeInProgress, getMergeConflicts, finalizeMerge, abortMerge } from "./git-pool.js";
import { checkAllUpdates, forceCheckAllUpdates, getPendingUpdates, applyUpdate, applyAllUpdates } from "./updates.js";

// ============================================================================
// Extension entry point
// ============================================================================

/** Filter out the package manager itself from user-facing lists */
const SELF_PACKAGE = "pi-extension-package-manager";
function userPackages() {
  return listPackages().filter(p => p.name !== SELF_PACKAGE && !p.source?.includes("pi-extension-package-manager"));
}

function pkgStatus(enabledCount: number, total: number): string {
  const pending = getPendingUpdates();
  const badge = pending.length > 0 ? ` ⬆${pending.length}` : "";
  return `📦 ${enabledCount}/${total}${badge}`;
}

/** Resolve resource types for a package and return a colored [ESPT] badge */
function getResourceBadge(pkgName: string, theme: any): string {
  const res = resolvePackageResources(pkgName);
  let badge = "";
  if (res.extensions.length) badge += theme.fg("accent", "E");
  if (res.skills.length) badge += theme.fg("success", "S");
  if (res.prompts.length) badge += theme.fg("warning" as any, "P");
  if (res.themes.length) badge += theme.fg("muted", "T");
  return badge ? `[${badge}]` : theme.fg("dim", "[-]");
}

/** Plain text version for non-TUI output */
function getResourceBadgePlain(pkgName: string): string {
  const res = resolvePackageResources(pkgName);
  let badge = "";
  if (res.extensions.length) badge += "E";
  if (res.skills.length) badge += "S";
  if (res.prompts.length) badge += "P";
  if (res.themes.length) badge += "T";
  return badge ? `[${badge}]` : "[-]";
}

/** Send a steer message to the agent to resolve merge conflicts */
function sendConflictResolutionMessage(pi: ExtensionAPI, conflictFiles: string, mergeDescription: string): void {
  const fileList = conflictFiles.split("\n").map(f => f.trim()).filter(Boolean);
  pi.sendMessage({
    customType: "packages-merge-conflict",
    display: false,
    content: [
      `⚠️ MERGE CONFLICT — merging ${mergeDescription}`,
      ``,
      `A merge is in progress in the package pool at ${PKG_MGR_ROOT}.`,
      `The following files have conflicts:`,
      ...fileList.map(f => `  - ${PKG_MGR_ROOT}/${f}`),
      ``,
      `INSTRUCTIONS:`,
      `1. Read each conflicted file listed above.`,
      `2. The files contain Git conflict markers (<<<<<<< HEAD, =======, >>>>>>> ...).`,
      `3. For each file, decide the correct resolution:`,
      `   - For JSON arrays (like plan_history.json): merge both sides — combine all entries, dedupe, sort by timestamp.`,
      `   - For JSON objects (like registry.json): merge fields from both sides. If the same key has different values, STOP and ask the user which to keep.`,
      `   - For code files (.ts, .js): analyze both versions. If the intent is clear (e.g. both sides add different features), combine them. If there's a genuine conflict where two versions of the same code exist, STOP and show both versions to the user and ask which to keep.`,
      `4. Edit each file to remove ALL conflict markers and produce the correct merged content.`,
      `5. NEVER discard changes from either side without asking the user.`,
      `6. After all files are resolved, run /packages-git-resolve to finalize the merge.`,
      `7. If you cannot resolve a conflict, explain the situation to the user and let them decide. They can also run /packages-git-resolve abort to cancel the merge entirely.`,
    ].join("\n"),
  }, {
    triggerTurn: true,
    deliverAs: "steer",
  });
}

export default function (pi: ExtensionAPI) {
  // Ensure base directories exist
  mkdirSync(PACKAGES_DIR, { recursive: true });

  // ── Session start: status + background update check ─────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const cwd = process.cwd();

    // Always regenerate repo package to pick up any package changes
    generatePackageJson(cwd);
    ensurePackageInSettings(cwd);

    const allPkgs = userPackages();
    const active = getActivePackages(cwd);
    const enabledCount = active.length;

    ctx.ui.setStatus("pkg-count", pkgStatus(enabledCount, allPkgs.length));

    // Show enabled packages briefly
    if (enabledCount > 0) {
      ctx.ui.setWidget("pkg-active", [
        `📦 ${enabledCount} managed: ${active.join(" · ")}`,
      ]);
      setTimeout(() => ctx.ui.setWidget("pkg-active", undefined), 5000);
    }

    // Async pool check — non-blocking, once per hour
    checkPoolUpdateAsync((msg) => ctx.ui.notify(`📦 ${msg}`, "info"));

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
          ctx.ui.setStatus("pkg-count", pkgStatus(enabledCount, allPkgs.length));
        }
      } catch {}
    }, 2000);
  });

  // ── /packages — interactive TUI ────────────────────────────────────────
  pi.registerCommand("packages", {
    description: "Toggle packages for the current project",
    handler: async (_args, ctx) => {
      const cwd = process.cwd();
      const allPkgs = userPackages();

      if (!allPkgs.length) {
        ctx.ui.notify(
          `No packages in pool.\nUse /packages-add <source> to add packages.\nPool: ${PACKAGES_DIR}`,
          "warning"
        );
        return;
      }

      const manifest = loadRepoManifest(cwd);
      const mandatory = getMandatoryPackages();
      const mandatorySet = new Set(mandatory);
      const featured = getFeaturedPackages();
      const featuredSet = new Set(featured);
      // Display order: featured (in registry order), then normal by source type, then mandatory at bottom
      const featuredPkgs = featured.map(name => allPkgs.find(p => p.name === name)).filter(Boolean) as typeof allPkgs;
      const normalPkgs = allPkgs.filter(p => !mandatorySet.has(p.name) && !featuredSet.has(p.name));
      const mandatoryPkgs = allPkgs.filter(p => mandatorySet.has(p.name));
      const displayPkgs = [...featuredPkgs, ...normalPkgs, ...mandatoryPkgs];
      const termRows = process.stdout.rows || 40;
      const visibleRows = Math.max(12, Math.floor(termRows * 0.6));

      const result = await ctx.ui.custom<{ changed: boolean } | null>(
        (tui, theme, _kb, done) => {
          let cursor = 0;
          let cache: string[] | undefined;
          let scrollOffset = 0;
          let changed = false;

          // Live state: track active per package (resolved from mandatory + enabled - disabled)
          const activeSet = new Set(getActivePackages(cwd, manifest));

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
              cursor = Math.min(displayPkgs.length - 1, cursor + 1);
              refresh();
              return;
            }
            if (matchesKey(data, "space")) {
              const pkg = displayPkgs[cursor];
              const nowEnabled = togglePackage(cwd, pkg.name);
              if (nowEnabled) activeSet.add(pkg.name);
              else activeSet.delete(pkg.name);
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
            add(` 📦 Package Manager    ${theme.fg("dim", `${activeSet.size} enabled · ${displayPkgs.length} total`)}`);
            add(theme.fg("accent", "─".repeat(width)));

            // Package rows — normal by source type, then mandatory at bottom
            const rows: { line: string; idx: number }[] = [];
            let lastSource = "";

            for (let i = 0; i < displayPkgs.length; i++) {
              const pkg = displayPkgs[i];
              const isMandatory = mandatorySet.has(pkg.name);
              const isFeatured = featuredSet.has(pkg.name);

              // Group headers
              if (isFeatured && (i === 0 || !featuredSet.has(displayPkgs[i - 1].name))) {
                rows.push({ line: "", idx: -1 });
                rows.push({ line: theme.fg("dim", ` ── Featured ──`), idx: -1 });
              } else if (isMandatory && (i === 0 || !mandatorySet.has(displayPkgs[i - 1].name))) {
                rows.push({ line: "", idx: -1 });
                rows.push({ line: theme.fg("dim", ` ── Auto-Enabled ──`), idx: -1 });
                lastSource = "";
              } else if (!isMandatory && !isFeatured && pkg.sourceType !== lastSource) {
                lastSource = pkg.sourceType;
                const label = pkg.sourceType === "git" ? "Git Packages" : pkg.sourceType === "npm" ? "npm Packages" : "Local Packages";
                rows.push({ line: "", idx: -1 });
                rows.push({ line: theme.fg("dim", ` ── ${label} ──`), idx: -1 });
              }

              const isCur = i === cursor;
              const enabled = activeSet.has(pkg.name);
              const icon = enabled ? theme.fg("accent", "✓") : theme.fg("dim", "·");
              const pointer = isCur ? theme.fg("accent", "▸ ") : "  ";
              const nameColor = isCur ? "accent" : enabled ? "text" : "dim";
              const nameStr = theme.fg(nameColor as any, pkg.name);
              const mandatoryBadge = isMandatory ? theme.fg("accent", "★") : " ";
              const resBadge = getResourceBadge(pkg.name, theme);
              const desc = theme.fg("dim", ` — ${getPackageDescription(pkg.name)}`);
              const updateBadge = getPackageState(pkg.name).updateAvailable ? theme.fg("warning" as any, " ⬆") : "";
              // Pad name to align badges — use raw name length for padding
              const padded = pkg.name + " ".repeat(Math.max(1, 22 - pkg.name.length));
              const paddedStr = theme.fg(nameColor as any, padded);

              rows.push({
                line: truncateToWidth(`${pointer}[${icon}]${mandatoryBadge}${paddedStr}${resBadge} ${desc}${updateBadge}`, width),
                idx: i,
              });
            }

            // Scrolling
            const listHeight = visibleRows - 7;
            let cursorRow = 0;
            for (let r = 0; r < rows.length; r++) {
              if (rows[r].idx === cursor) { cursorRow = r; break; }
            }
            if (cursorRow < scrollOffset) scrollOffset = cursorRow;
            if (cursorRow >= scrollOffset + listHeight) scrollOffset = cursorRow - listHeight + 1;
            scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, rows.length - listHeight)));

            const slice = rows.slice(scrollOffset, scrollOffset + listHeight);
            for (const row of slice) lines.push(row.line);
            while (lines.length < visibleRows - 4) lines.push("");

            // Footer
            const canUp = scrollOffset > 0;
            const canDown = scrollOffset + listHeight < rows.length;
            const scrollHint = `${canUp ? "▲" : " "} ${cursor + 1}/${displayPkgs.length} ${canDown ? "▼" : " "}`;

            add(theme.fg("accent", "─".repeat(width)));
            add(theme.fg("dim", ` ↑↓/jk move · Space toggle · q close  ${scrollHint}`));
            add(` ${theme.fg("accent", "E")}=extension ${theme.fg("success", "S")}=skill ${theme.fg("warning" as any, "P")}=prompt ${theme.fg("muted", "T")}=theme  ${theme.fg("accent", "★")}=auto-enabled`);
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
        const updatedActive = getActivePackages(cwd);
        ctx.ui.setStatus("pkg-count", pkgStatus(updatedActive.length, allPkgs.length));
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
      const allPkgs = userPackages();
      const activeSet = new Set(getActivePackages(cwd));
      const mandatoryNames = getMandatoryPackages();
      const mandatorySetList = new Set(mandatoryNames);

      if (!allPkgs.length) {
        ctx.ui.notify(`No packages in pool. Use /packages-add <source> to add.`, "warning");
        return;
      }

      const lines: string[] = [`📦 Package Manager — ${allPkgs.length} packages\n`];

      // Show mandatory packages first
      const mandatoryPkgs = allPkgs.filter(p => mandatorySetList.has(p.name));
      const normalPkgs = allPkgs.filter(p => !mandatorySetList.has(p.name));

      if (mandatoryPkgs.length > 0) {
        lines.push(`\n── Auto-Enabled ★ ──`);
        for (const pkg of mandatoryPkgs) {
          const enabled = activeSet.has(pkg.name);
          const icon = enabled ? "✓" : "·";
          const update = getPackageState(pkg.name).updateAvailable ? " ⬆" : "";
          lines.push(`  [${icon}] ★ ${pkg.name} ${getResourceBadgePlain(pkg.name)}${update} — ${getPackageDescription(pkg.name)}`);
        }
      }

      let lastSource = "";
      for (const pkg of normalPkgs) {
        if (pkg.sourceType !== lastSource) {
          lastSource = pkg.sourceType;
          const label = pkg.sourceType === "git" ? "Git" : pkg.sourceType === "npm" ? "npm" : "Local";
          lines.push(`\n── ${label} ──`);
        }
        const enabled = activeSet.has(pkg.name);
        const icon = enabled ? "✓" : "·";
        const update = getPackageState(pkg.name).updateAvailable ? " ⬆" : "";
        lines.push(`  [${icon}] ${pkg.name} ${getResourceBadgePlain(pkg.name)}${update} — ${getPackageDescription(pkg.name)}`);
        const srcPath = pkg.sourceType === "local" ? packageDir(pkg.name) : pkg.source;
        if (srcPath) lines.push(`       ${srcPath}`);
      }

      lines.push(`\n✓=enabled  ·=disabled  ★=auto-enabled  ⬆=update available\nE=extension S=skill P=prompt T=theme`);
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
          });
          setPackageState(parsed.name, { lastUpdateCheck: new Date().toISOString(), updateAvailable: false });
        } else if (parsed.type === "npm") {
          mkdirSync(dir, { recursive: true });
          const version = npmInstallPackage(parsed.value, dir);

          addPackage({
            name: parsed.name,
            sourceType: "npm",
            source: source,
            version,
            installedAt: new Date().toISOString(),
          });
          setPackageState(parsed.name, { lastUpdateCheck: new Date().toISOString(), updateAvailable: false });
        } else {
          // Local: copy into pool, store abs path for future git-pull support
          const { cpSync } = require("fs");
          const absPath = resolve(process.cwd(), parsed.value);
          cpSync(absPath, dir, {
            recursive: true,
            filter: (src: string) => !src.includes("node_modules"),
          });
          installDependenciesIfNeeded(dir);

          addPackage({
            name: parsed.name,
            sourceType: "local",
            source: absPath,
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

      ctx.ui.notify(`📦 Removing ${name}...`, "info");
      rmSync(dir, { recursive: true, force: true });
      removePackage(name);
      ensureGitignore();

      ctx.ui.notify(`✅ Removed "${name}" from pool.`, "info");
    },
  });

  // ── /packages-update — apply updates ───────────────────────────────────
  pi.registerCommand("packages-update", {
    description: "Update packages: /packages-update [name|--force|-f] — use --force/-f to bypass update cache",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const force = parts.includes("--force") || parts.includes("-f");
      const name = parts.filter(p => p !== "--force" && p !== "-f").join(" ");

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
        // Update all — check pool first
        if (isGitEnabled()) {
          ctx.ui.notify("📦 Checking pool remote...", "info");
          if (checkPoolUpdate()) {
            const pullResult = gitPullPool();
            ctx.ui.notify(pullResult.success ? `✅ Pool: ${pullResult.message}` : `❌ Pool pull failed: ${pullResult.message}`, pullResult.success ? "info" : "error");
          }
        }

        const pending = getPendingUpdates();
        if (pending.length === 0 || force) {
          // Check for updates (force bypasses the interval cache)
          ctx.ui.notify(force ? "📦 Force checking all packages..." : "📦 Checking for updates...", "info");
          const withUpdates = force ? forceCheckAllUpdates() : checkAllUpdates();
          if (withUpdates.length === 0) {
            ctx.ui.notify("✅ All packages are up to date.", "info");
            return;
          }
        }

        ctx.ui.notify(`📦 Updating ${getPendingUpdates().length} package(s)...`, "info");
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
      const allPkgs = userPackages();
      ctx.ui.setStatus("pkg-count", pkgStatus(getActivePackages(process.cwd()).length, allPkgs.length));
    },
  });

  // ── /packages-push — push pool to git remote ────────────────────────────
  pi.registerCommand("packages-push", {
    description: "Push the package pool (all local packages) to its git remote",
    handler: async (_args, ctx) => {
      if (!isGitEnabled()) {
        ctx.ui.notify("Git is not enabled for the pool. Use /packages-git-init <remote> first.", "warning");
        return;
      }
      ctx.ui.notify("📦 Pushing pool to remote...", "info");
      const result = gitPushPool();
      ctx.ui.notify(result.success ? `✅ ${result.message}` : `❌ ${result.message}`, result.success ? "info" : "error");
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
          `- Ensure it has a valid package.json with "keywords": ["pi-package"] and a pi manifest. The "keywords": ["pi-package"] is REQUIRED — always include it.`,
          `- Ensure .gitignore includes node_modules/`,
          `- Do NOT run npm install — the register tool handles dependency installation`,
          `- Disable the original source so it won't conflict (rename .ts files to .ts.bak, or rename the folder with a .bak suffix). NEVER delete originals — always back up.`,
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

        const allPkgs = userPackages();
        ctx.ui.setStatus("pkg-count", pkgStatus(getActivePackages(cwd).length, allPkgs.length));

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
      ctx.ui.notify("📦 Initializing package manager for this repo...", "info");
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

      ctx.ui.notify(`📦 Initializing git for package pool...`, "info");
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
    description: "Sync the package pool with its git remote (commits to device branch, pulls main)",
    handler: async (_args, ctx) => {
      if (!isGitEnabled()) {
        ctx.ui.notify("Git is not enabled. Use /packages-git-init <remote> first.", "warning");
        return;
      }

      const result = gitSyncPool((msg) => ctx.ui.notify(msg, "info"));
      if (result.message.startsWith("MERGE_CONFLICT:")) {
        const files = result.message.replace("MERGE_CONFLICT:", "").trim();
        ctx.ui.notify(`⚠️ Merge conflict detected. The agent will resolve it.`, "warning");
        sendConflictResolutionMessage(pi, files, "origin/main into device branch");
      } else {
        ctx.ui.notify(`📦 ${result.message}`, result.pushed ? "info" : "warning");
      }
    },
  });

  // ── /packages-git-merge — merge device branch into main ─────────────────
  pi.registerCommand("packages-git-merge", {
    description: "Merge this device's branch into main and push",
    handler: async (_args, ctx) => {
      if (!isGitEnabled()) {
        ctx.ui.notify("Git is not enabled. Use /packages-git-init <remote> first.", "warning");
        return;
      }

      const deviceBranch = getDeviceBranch();
      ctx.ui.notify(`📦 Merging ${deviceBranch} into main...`, "info");
      const result = gitMergeToMain((msg) => ctx.ui.notify(msg, "info"));
      if (result.message.startsWith("MERGE_CONFLICT:")) {
        const files = result.message.replace("MERGE_CONFLICT:", "").trim();
        ctx.ui.notify(`⚠️ Merge conflict detected. The agent will resolve it.`, "warning");
        sendConflictResolutionMessage(pi, files, `${deviceBranch} into main`);
      } else if (result.success) {
        ctx.ui.notify(`✅ ${result.message}`, "info");
      } else {
        ctx.ui.notify(`❌ ${result.message}`, "error");
      }
    },
  });

  // ── /packages-git-resolve — finalize or abort a conflicted merge ───────
  pi.registerCommand("packages-git-resolve", {
    description: "Finalize a resolved merge conflict, or abort with: /packages-git-resolve abort",
    handler: async (args, ctx) => {
      if (!hasMergeInProgress()) {
        ctx.ui.notify("No merge in progress.", "info");
        return;
      }

      if (args.trim() === "abort") {
        const result = abortMerge();
        ctx.ui.notify(result.success ? `✅ ${result.message}` : `❌ ${result.message}`, result.success ? "info" : "error");
        return;
      }

      const result = finalizeMerge();
      if (result.success) {
        ctx.ui.notify(`✅ ${result.message}`, "info");
        // Push after successful resolution
        const deviceBranch = getDeviceBranch();
        try {
          execSync(`git push -u origin ${deviceBranch}`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
          ctx.ui.notify(`📦 Pushed ${deviceBranch} to remote.`, "info");
        } catch {}
      } else {
        ctx.ui.notify(`❌ ${result.message}`, "error");
      }
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

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const dir = packageDir(entry.name);
        if (existsSync(dir)) {
          results.push(`  ⏭ ${entry.name} — already exists`);
          continue;
        }

        ctx.ui.notify(`📦 Restoring ${entry.name} (${i + 1}/${entries.length})...`, "info");
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
