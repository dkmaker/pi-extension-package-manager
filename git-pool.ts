import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execSync, exec } from "child_process";
import { join } from "path";
import { hostname } from "os";
import { PKG_MGR_ROOT, PACKAGES_DIR, REPOS_DIR, UPDATE_CHECK_INTERVAL_MS } from "./constants.js";
import { loadRegistry, saveRegistry, loadState, saveState } from "./registry.js";

// ============================================================================
// Device branch naming
// ============================================================================

/** Get the device branch name for this machine: device/{hostname} */
export function getDeviceBranch(): string {
  return `device/${hostname()}`;
}

// ============================================================================
// Safety guards
// ============================================================================

/** Check if there are uncommitted changes in the working tree */
function hasUncommittedChanges(): boolean {
  try {
    const status = execSync("git status --porcelain", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

/** Check if there are local commits not yet pushed to the device branch */
function hasUnpushedCommits(branch: string): boolean {
  try {
    const count = execSync(`git rev-list --count origin/${branch}..${branch}`, {
      cwd: PKG_MGR_ROOT, encoding: "utf-8",
    }).trim();
    return parseInt(count, 10) > 0;
  } catch {
    // Remote branch may not exist yet — all local commits are unpushed
    return true;
  }
}

/** Get the current branch name */
function getCurrentBranch(): string {
  return execSync("git rev-parse --abbrev-ref HEAD", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
}

/** Ensure we're on the device branch, creating it if needed */
function ensureOnDeviceBranch(): string {
  const deviceBranch = getDeviceBranch();
  const current = getCurrentBranch();

  if (current !== deviceBranch) {
    try {
      execSync(`git checkout ${deviceBranch}`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    } catch {
      // Branch doesn't exist locally — create from current HEAD
      execSync(`git checkout -b ${deviceBranch}`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    }
  }

  return deviceBranch;
}

// ============================================================================
// Commit message generation
// ============================================================================

/** Generate a meaningful commit message based on changed packages */
function generateCommitMessage(): string {
  const device = hostname();
  try {
    const diff = execSync("git diff --cached --name-only", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
    if (!diff) return `sync(${device}): no changes`;

    const changedPkgs = new Set<string>();
    for (const line of diff.split("\n")) {
      const match = line.match(/^packages\/([^/]+)\//);
      if (match) changedPkgs.add(match[1]);
    }

    if (changedPkgs.size > 0) {
      const pkgList = [...changedPkgs].sort().join(", ");
      const verb = changedPkgs.size === 1 ? "update" : "update";
      return `sync(${device}): ${verb} ${pkgList}`;
    }

    // Non-package changes (registry, gitignore, etc.)
    const files = diff.split("\n").map(f => f.split("/").pop()).filter(Boolean).slice(0, 3);
    return `sync(${device}): ${files.join(", ")}`;
  } catch {
    return `sync(${device}): package manager update`;
  }
}

// ============================================================================
// Git-enable the pool
// ============================================================================

/**
 * Initialize git in the packagemanager root and set the remote.
 * If remote exists and .git is missing, clone instead of init fresh.
 */
export function gitInitPool(remote: string): void {
  mkdirSync(PKG_MGR_ROOT, { recursive: true });

  const gitDir = join(PKG_MGR_ROOT, ".git");
  if (!existsSync(gitDir)) {
    // Try to clone from remote first to preserve history
    try {
      execSync(`git clone ${remote} "${PKG_MGR_ROOT}" --no-checkout`, { stdio: "pipe" });
      execSync("git checkout main", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    } catch {
      // Remote doesn't exist or is empty — init fresh
      execSync("git init", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    }
  }

  // Set or update remote
  try {
    execSync("git remote get-url origin", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    execSync(`git remote set-url origin ${remote}`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
  } catch {
    execSync(`git remote add origin ${remote}`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
  }

  // Save remote in registry
  const reg = loadRegistry();
  reg.gitRemote = remote;
  saveRegistry(reg);

  // Ensure gitignore is correct
  ensureGitignore();

  // Initial commit if needed
  try {
    execSync("git rev-parse HEAD", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
  } catch {
    execSync("git add -A", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    execSync('git commit -m "Initial package manager setup"', { cwd: PKG_MGR_ROOT, stdio: "pipe" });
  }

  // Switch to device branch
  ensureOnDeviceBranch();
}

// ============================================================================
// Sync — commit to device branch, pull main, push device branch
// ============================================================================

export function gitSyncPool(onProgress?: (msg: string) => void): { pulled: boolean; pushed: boolean; message: string } {
  const result = { pulled: false, pushed: false, message: "" };
  const progress = onProgress || (() => {});

  if (!isGitEnabled()) {
    result.message = "Git is not enabled for the package pool. Use /packages-git-init <remote> first.";
    return result;
  }

  const deviceBranch = ensureOnDeviceBranch();

  // Stage any changes
  progress("📦 Staging changes...");
  execSync("git add -A", { cwd: PKG_MGR_ROOT, stdio: "pipe" });

  // Commit if there are changes
  try {
    const status = execSync("git status --porcelain", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
    if (status) {
      const msg = generateCommitMessage();
      progress(`📦 Committing: ${msg}`);
      execSync(`git commit -m "${msg}"`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    } else {
      progress("📦 No local changes to commit.");
    }
  } catch {}

  // Fetch all (full depth — never shallow)
  try {
    progress("📦 Fetching from remote...");
    execSync("git fetch origin", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
  } catch (e: any) {
    result.message = `Fetch failed: ${e.message}`;
    return result;
  }

  // Merge main into device branch (safe — preserves all local commits)
  try {
    progress("📦 Merging main into device branch...");
    execSync("git merge origin/main --no-edit", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    result.pulled = true;
  } catch (e: any) {
    const conflicts = getConflictedFiles();
    if (conflicts.length > 0) {
      // Leave merge in progress — agent will resolve
      result.message = `MERGE_CONFLICT:${conflicts.join("\n")}`;
      return result;
    }
  }

  // Push device branch
  try {
    progress(`📦 Pushing ${deviceBranch}...`);
    execSync(`git push -u origin ${deviceBranch}`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    result.pushed = true;
    result.message = `Synced to ${deviceBranch}.`;
  } catch (e: any) {
    result.message = `Push failed: ${e.message}. Local changes are committed.`;
  }

  return result;
}

// ============================================================================
// Merge device branch into main (explicit, user-triggered)
// ============================================================================

export function gitMergeToMain(onProgress?: (msg: string) => void): { success: boolean; message: string; conflicts?: string } {
  const progress = onProgress || (() => {});

  if (!isGitEnabled()) {
    return { success: false, message: "Git is not enabled for the pool." };
  }

  const deviceBranch = getDeviceBranch();

  try {
    // Fetch latest
    progress("📦 Fetching latest...");
    execSync("git fetch origin", { cwd: PKG_MGR_ROOT, stdio: "pipe" });

    // Ensure device branch changes are committed
    if (hasUncommittedChanges()) {
      execSync("git add -A", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
      const msg = generateCommitMessage();
      execSync(`git commit -m "${msg}"`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    }

    // Push device branch first
    progress(`📦 Pushing ${deviceBranch}...`);
    try {
      execSync(`git push -u origin ${deviceBranch}`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    } catch {}

    // Switch to main
    progress("📦 Switching to main...");
    execSync("git checkout main", { cwd: PKG_MGR_ROOT, stdio: "pipe" });

    // Pull latest main
    execSync("git pull --ff-only origin main", { cwd: PKG_MGR_ROOT, stdio: "pipe" });

    // Merge device branch into main
    progress(`📦 Merging ${deviceBranch} into main...`);
    try {
      execSync(`git merge ${deviceBranch} --no-edit`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    } catch {
      const conflicts = getConflictedFiles();
      if (conflicts.length > 0) {
        // Leave merge in progress — agent will resolve
        return { success: false, message: `MERGE_CONFLICT:${conflicts.join("\n")}`, conflicts: conflicts.join("\n") };
      }
    }

    // Push main
    progress("📦 Pushing main...");
    execSync("git push origin main", { cwd: PKG_MGR_ROOT, stdio: "pipe" });

    // Switch back to device branch
    execSync(`git checkout ${deviceBranch}`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });

    const commit = execSync("git rev-parse --short main", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
    return { success: true, message: `Merged ${deviceBranch} into main (${commit}). Pushed to remote.` };
  } catch (e: any) {
    // Try to get back to device branch
    try { execSync(`git checkout ${deviceBranch}`, { cwd: PKG_MGR_ROOT, stdio: "pipe" }); } catch {}
    return { success: false, message: e.message };
  }
}

// ============================================================================
// Gitignore management
// ============================================================================

/**
 * Regenerate .gitignore to ignore git/npm packages and generated repos.
 * Local packages are tracked.
 */
export function ensureGitignore(): void {
  if (!isGitEnabled()) return;

  const reg = loadRegistry();
  const lines: string[] = [
    "# Auto-generated by pi-package-manager — do not edit manually",
    "# Git/npm packages are reproducible from registry.json",
    "# Local/onboarded packages are tracked in git",
    "",
    "# Generated per-machine repo packages",
    "repos/",
    "",
  ];

  // Ignore git and npm sourced packages
  const ignoredPackages: string[] = [];
  for (const [name, entry] of Object.entries(reg.packages)) {
    if (entry.sourceType === "git" || entry.sourceType === "npm") {
      ignoredPackages.push(name);
    }
  }

  if (ignoredPackages.length > 0) {
    lines.push("# Git/npm sourced packages (install from registry.json)");
    for (const name of ignoredPackages.sort()) {
      lines.push(`packages/${name}/`);
    }
    lines.push("");
  }

  writeFileSync(join(PKG_MGR_ROOT, ".gitignore"), lines.join("\n"));
}

// ============================================================================
// Push only — pushes to device branch
// ============================================================================

/**
 * Stage, commit, and push the pool to its device branch.
 */
export function gitPushPool(): { success: boolean; message: string } {
  if (!isGitEnabled()) {
    return { success: false, message: "Git is not enabled for the package pool. Use /packages-git-init <remote> first." };
  }

  const deviceBranch = ensureOnDeviceBranch();

  try {
    execSync("git add -A", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    const status = execSync("git status --porcelain", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
    if (status) {
      const msg = generateCommitMessage();
      execSync(`git commit -m "${msg}"`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    }
    execSync(`git push -u origin ${deviceBranch}`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    return { success: true, message: status ? `Committed and pushed to ${deviceBranch}.` : `Nothing to commit — pushed to ${deviceBranch}.` };
  } catch (e: any) {
    return { success: false, message: e.message };
  }
}

// ============================================================================
// Pool update check / pull — SAFE, never destructive
// ============================================================================

/**
 * Check if main has newer commits than our device branch.
 */
export function checkPoolUpdate(): boolean {
  if (!isGitEnabled()) return false;
  try {
    execSync("git fetch origin main", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    const local = execSync("git rev-parse HEAD", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
    const remote = execSync("git rev-parse origin/main", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
    // Check if remote main has commits we don't have
    const behind = execSync(`git rev-list --count HEAD..origin/main`, { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
    return parseInt(behind, 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Async pool update check with hourly interval — safe to call at session start.
 * SAFE: only fetches and notifies. Never modifies the working tree.
 */
export function checkPoolUpdateAsync(onUpdate: (msg: string) => void): void {
  if (!isGitEnabled()) return;

  const state = loadState();
  const now = Date.now();
  const last = state.poolLastUpdateCheck ? new Date(state.poolLastUpdateCheck).getTime() : 0;
  if (now - last < UPDATE_CHECK_INTERVAL_MS) return;

  // Update timestamp immediately so concurrent sessions don't double-check
  state.poolLastUpdateCheck = new Date().toISOString();
  saveState(state);

  exec("git fetch origin", { cwd: PKG_MGR_ROOT }, (err) => {
    if (err) return;
    try {
      const behind = execSync("git rev-list --count HEAD..origin/main", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
      const behindCount = parseInt(behind, 10);
      if (behindCount > 0) {
        onUpdate(`Main has ${behindCount} new commit${behindCount > 1 ? "s" : ""}. Run /packages-git-sync to pull updates.`);
      }
    } catch {}
  });
}

/**
 * Pull main into the current device branch (merge, never reset).
 */
export function gitPullPool(): { success: boolean; message: string } {
  if (!isGitEnabled()) {
    return { success: false, message: "Git is not enabled for the pool." };
  }

  const deviceBranch = ensureOnDeviceBranch();

  try {
    // Commit any uncommitted changes first to avoid losing them
    if (hasUncommittedChanges()) {
      execSync("git add -A", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
      const msg = generateCommitMessage();
      execSync(`git commit -m "${msg}"`, { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    }

    execSync("git fetch origin", { cwd: PKG_MGR_ROOT, stdio: "pipe" });

    // Merge main into device branch
    try {
      execSync("git merge origin/main --no-edit", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    } catch {
      const conflicts = getConflictedFiles();
      if (conflicts.length > 0) {
        // Leave merge in progress — agent will resolve
        return { success: false, message: `MERGE_CONFLICT:${conflicts.join("\n")}` };
      }
    }

    const commit = execSync("git rev-parse --short HEAD", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
    return { success: true, message: `Merged main into ${deviceBranch} (${commit}).` };
  } catch (e: any) {
    return { success: false, message: e.message };
  }
}

// ============================================================================
// Conflict detection & resolution
// ============================================================================

/** Get list of conflicted files during an in-progress merge */
function getConflictedFiles(): string[] {
  try {
    const output = execSync("git diff --name-only --diff-filter=U", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
    return output ? output.split("\n") : [];
  } catch {
    return [];
  }
}

/** Check if there's an in-progress merge */
export function hasMergeInProgress(): boolean {
  return existsSync(join(PKG_MGR_ROOT, ".git", "MERGE_HEAD"));
}

/** Get conflicted files for an in-progress merge (for agent to read and resolve) */
export function getMergeConflicts(): { inProgress: boolean; files: string[] } {
  if (!hasMergeInProgress()) return { inProgress: false, files: [] };
  return { inProgress: true, files: getConflictedFiles() };
}

/**
 * Finalize a resolved merge — stage all files and commit.
 * Call this after the agent has edited all conflicted files to remove markers.
 */
export function finalizeMerge(): { success: boolean; message: string } {
  if (!hasMergeInProgress()) {
    return { success: false, message: "No merge in progress." };
  }

  // Check if any conflicts remain
  const remaining = getConflictedFiles();
  if (remaining.length > 0) {
    return { success: false, message: `Unresolved conflicts remain:\n${remaining.join("\n")}` };
  }

  try {
    execSync("git add -A", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    execSync('git commit --no-edit', { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    const commit = execSync("git rev-parse --short HEAD", { cwd: PKG_MGR_ROOT, encoding: "utf-8" }).trim();
    return { success: true, message: `Merge resolved and committed (${commit}).` };
  } catch (e: any) {
    return { success: false, message: `Failed to finalize merge: ${e.message}` };
  }
}

/**
 * Abort an in-progress merge — returns to pre-merge state.
 */
export function abortMerge(): { success: boolean; message: string } {
  if (!hasMergeInProgress()) {
    return { success: false, message: "No merge in progress." };
  }

  try {
    execSync("git merge --abort", { cwd: PKG_MGR_ROOT, stdio: "pipe" });
    return { success: true, message: "Merge aborted. Working tree restored to pre-merge state." };
  } catch (e: any) {
    return { success: false, message: `Failed to abort merge: ${e.message}` };
  }
}

// ============================================================================
// Helpers
// ============================================================================

export function isGitEnabled(): boolean {
  return existsSync(join(PKG_MGR_ROOT, ".git"));
}

export function getGitRemote(): string | undefined {
  const reg = loadRegistry();
  return reg.gitRemote;
}
