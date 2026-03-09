import { join } from "path";
import { homedir } from "os";

// ============================================================================
// Paths — respects PI_CODING_AGENT_DIR if set
// ============================================================================

/**
 * Resolve the pi config base directory.
 * Follows the same logic as pi's getAgentDir():
 *   1. PI_CODING_AGENT_DIR env var (with ~ expansion)
 *   2. Falls back to ~/.pi/agent/
 *
 * The package manager lives alongside the agent dir (sibling of agent/).
 * e.g. if agent dir is ~/.pi/agent/, packagemanager is ~/.pi/packagemanager/
 */
function resolveConfigRoot(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    const expanded = envDir === "~" ? homedir()
      : envDir.startsWith("~/") ? join(homedir(), envDir.slice(2))
      : envDir;
    // Agent dir might be e.g. /custom/path/agent — go up one level
    return join(expanded, "..");
  }
  return join(homedir(), ".pi");
}

/** The pi config root (e.g. ~/.pi/) */
export const CONFIG_ROOT = resolveConfigRoot();

/** Root of the package manager's data */
export const PKG_MGR_ROOT = join(CONFIG_ROOT, "packagemanager");

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
