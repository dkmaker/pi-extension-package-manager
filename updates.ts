import { existsSync, rmSync, mkdirSync } from "fs";
import {
  UPDATE_CHECK_INTERVAL_MS,
  type PackageEntry,
} from "./constants.js";
import {
  loadRegistry,
  saveRegistry,
  listPackages,
  packageDir,
  gitFetchCheck,
  gitPull,
  gitGetCommit,
  gitClone,
  npmCheckUpdate,
  npmInstallPackage,
  installDependenciesIfNeeded,
  parseSource,
  isGitRepo,
  gitHasRemote,
  recopyLocal,
} from "./registry.js";

// ============================================================================
// Check for updates (non-blocking, called on session start)
// ============================================================================

/** Returns true if a local package has a git repo with a remote at its source path. */
export function isLocalGitPackage(pkg: PackageEntry): boolean {
  if (pkg.sourceType !== "local") return false;
  const sourcePath = pkg.source;
  if (!sourcePath || sourcePath === "local") return false;
  return existsSync(sourcePath) && isGitRepo(sourcePath) && gitHasRemote(sourcePath);
}

export function getPackagesNeedingCheck(): PackageEntry[] {
  const now = Date.now();
  return listPackages().filter(pkg => {
    if (pkg.sourceType === "local" && !isLocalGitPackage(pkg)) return false;
    if (!pkg.lastUpdateCheck) return true;
    return now - new Date(pkg.lastUpdateCheck).getTime() > UPDATE_CHECK_INTERVAL_MS;
  });
}

/**
 * Check a single package for updates. Updates registry but does NOT apply.
 * Returns true if update is available.
 */
export function checkPackageUpdate(pkg: PackageEntry): boolean {
  const reg = loadRegistry();
  const entry = reg.packages[pkg.name];
  if (!entry) return false;

  let updateAvailable = false;

  try {
    if (entry.sourceType === "git") {
      const dir = packageDir(pkg.name);
      if (existsSync(dir)) {
        updateAvailable = gitFetchCheck(dir);
      }
    } else if (entry.sourceType === "npm") {
      if (entry.version) {
        const parsed = parseSource(entry.source);
        updateAvailable = npmCheckUpdate(parsed.value, entry.version);
      }
    } else if (entry.sourceType === "local" && isLocalGitPackage(entry)) {
      updateAvailable = gitFetchCheck(entry.source);
    }
  } catch {
    // Silently fail — don't break session start
  }

  entry.lastUpdateCheck = new Date().toISOString();
  entry.updateAvailable = updateAvailable;
  saveRegistry(reg);

  return updateAvailable;
}

/**
 * Check all packages that need checking. Returns names of packages with updates.
 */
export function checkAllUpdates(): string[] {
  const needCheck = getPackagesNeedingCheck();
  const withUpdates: string[] = [];

  for (const pkg of needCheck) {
    if (checkPackageUpdate(pkg)) {
      withUpdates.push(pkg.name);
    }
  }

  return withUpdates;
}

/**
 * Force check all packages regardless of lastUpdateCheck interval.
 * Returns names of packages with updates.
 */
export function forceCheckAllUpdates(): string[] {
  const withUpdates: string[] = [];

  for (const pkg of listPackages()) {
    if (pkg.sourceType === "local" && !isLocalGitPackage(pkg)) continue;
    if (checkPackageUpdate(pkg)) {
      withUpdates.push(pkg.name);
    }
  }

  return withUpdates;
}

/**
 * Get all packages that have pending updates (already checked).
 */
export function getPendingUpdates(): PackageEntry[] {
  return listPackages().filter(pkg => pkg.updateAvailable);
}

// ============================================================================
// Apply updates
// ============================================================================

export interface UpdateResult {
  name: string;
  success: boolean;
  message: string;
  oldVersion?: string;
  newVersion?: string;
}

/**
 * Apply update for a single package.
 */
export function applyUpdate(name: string): UpdateResult {
  const reg = loadRegistry();
  const entry = reg.packages[name];
  if (!entry) return { name, success: false, message: "Package not found in registry" };

  const dir = packageDir(name);

  try {
    if (entry.sourceType === "git") {
      const oldCommit = entry.commit || "unknown";
      const newCommit = gitPull(dir);
      installDependenciesIfNeeded(dir);

      entry.commit = newCommit;
      entry.updateAvailable = false;
      entry.lastUpdateCheck = new Date().toISOString();
      saveRegistry(reg);

      return {
        name,
        success: true,
        message: `Updated ${oldCommit.slice(0, 7)} → ${newCommit.slice(0, 7)}`,
        oldVersion: oldCommit.slice(0, 7),
        newVersion: newCommit.slice(0, 7),
      };
    }

    if (entry.sourceType === "npm") {
      const oldVersion = entry.version || "unknown";
      // Remove and reinstall
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const parsed = parseSource(entry.source);
      const newVersion = npmInstallPackage(parsed.value, dir);

      entry.version = newVersion;
      entry.updateAvailable = false;
      entry.lastUpdateCheck = new Date().toISOString();
      saveRegistry(reg);

      return {
        name,
        success: true,
        message: `Updated ${oldVersion} → ${newVersion}`,
        oldVersion,
        newVersion,
      };
    }

    if (entry.sourceType === "local" && isLocalGitPackage(entry)) {
      const sourcePath = entry.source;
      const oldCommit = gitGetCommit(sourcePath);
      const newCommit = gitPull(sourcePath);

      if (oldCommit !== newCommit) {
        // Re-copy updated source into pool
        recopyLocal(sourcePath, dir);
        installDependenciesIfNeeded(dir);
      }

      entry.commit = newCommit;
      entry.updateAvailable = false;
      entry.lastUpdateCheck = new Date().toISOString();
      saveRegistry(reg);

      return {
        name,
        success: true,
        message: oldCommit !== newCommit
          ? `Pulled & recopied ${oldCommit.slice(0, 7)} → ${newCommit.slice(0, 7)}`
          : "Already up to date",
        oldVersion: oldCommit.slice(0, 7),
        newVersion: newCommit.slice(0, 7),
      };
    }

    return { name, success: false, message: "Local packages without a git remote cannot be updated" };
  } catch (e: any) {
    return { name, success: false, message: e.message || "Unknown error" };
  }
}

/**
 * Apply all pending updates.
 */
export function applyAllUpdates(): UpdateResult[] {
  const pending = getPendingUpdates();
  return pending.map(pkg => applyUpdate(pkg.name));
}
