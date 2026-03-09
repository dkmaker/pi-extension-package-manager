import { join } from "path";
import { homedir } from "os";

// ============================================================================
// Paths
// ============================================================================

/** Root of the package manager's data */
export const PKG_MGR_ROOT = join(homedir(), ".pi", "packagemanager");

/** Pool of all packages (git clones, npm installs, local/onboarded) */
export const PACKAGES_DIR = join(PKG_MGR_ROOT, "packages");

/** Per-repo generated packages (keyed by hash of repo path) */
export const REPOS_DIR = join(PKG_MGR_ROOT, "repos");

/** Registry file — source of truth for all packages */
export const REGISTRY_PATH = join(PKG_MGR_ROOT, "registry.json");

// ============================================================================
// Types
// ============================================================================

export type PackageSource = "git" | "npm" | "local";

export interface PackageEntry {
  /** Package name (= directory name under packages/) */
  name: string;
  /** Source type */
  sourceType: PackageSource;
  /** Full source string (e.g. "git:github.com/user/repo", "npm:@scope/pkg@^1.0", or "local") */
  source: string;
  /** Git ref if pinned (e.g. "v1.0.0") */
  ref?: string;
  /** Current git commit hash */
  commit?: string;
  /** Current npm version */
  version?: string;
  /** Original path if onboarded */
  onboardedFrom?: string;
  /** ISO timestamp of installation */
  installedAt: string;
  /** ISO timestamp of last update check */
  lastUpdateCheck?: string;
  /** Whether an update is available */
  updateAvailable?: boolean;
}

export interface Registry {
  /** Optional git remote for the pool itself */
  gitRemote?: string;
  /** All managed packages */
  packages: Record<string, PackageEntry>;
}

export interface RepoManifest {
  /** Absolute path to the repo */
  repoPath: string;
  /** List of enabled package names */
  enabled: string[];
}

/** What a package provides (resolved from pi manifest or convention dirs) */
export interface PackageResources {
  extensions: string[];
  skills: string[];
  prompts: string[];
}

/** 24 hours in milliseconds */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
