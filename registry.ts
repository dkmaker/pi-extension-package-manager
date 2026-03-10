import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import {
  PKG_MGR_ROOT,
  PACKAGES_DIR,
  REGISTRY_PATH,
  type Registry,
  type PackageEntry,
  type PackageSource,
} from "./constants.js";

// ============================================================================
// Registry CRUD
// ============================================================================

export function loadRegistry(): Registry {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return { packages: {} };
  }
}

export function saveRegistry(registry: Registry): void {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

export function getPackage(name: string): PackageEntry | undefined {
  return loadRegistry().packages[name];
}

export function addPackage(entry: PackageEntry): void {
  const reg = loadRegistry();
  reg.packages[entry.name] = entry;
  saveRegistry(reg);
}

export function removePackage(name: string): void {
  const reg = loadRegistry();
  delete reg.packages[name];
  saveRegistry(reg);
}

export function listPackages(): PackageEntry[] {
  const reg = loadRegistry();
  const order: Record<string, number> = { git: 0, npm: 1, local: 2 };
  return Object.values(reg.packages).sort((a, b) =>
    (order[a.sourceType] ?? 9) - (order[b.sourceType] ?? 9) || a.name.localeCompare(b.name)
  );
}

export function packageDir(name: string): string {
  return join(PACKAGES_DIR, name);
}

// ============================================================================
// Source parsing
// ============================================================================

export interface ParsedSource {
  type: PackageSource;
  /** For git: the URL; for npm: the package spec; for local: the path */
  value: string;
  /** Package name derived from source */
  name: string;
  /** Git/npm ref/version if specified */
  ref?: string;
}

/**
 * Parse a source string into its components.
 *
 * Supported formats:
 *   git:github.com/user/repo
 *   git:github.com/user/repo@v1.0.0
 *   git:git@github.com:user/repo
 *   https://github.com/user/repo
 *   npm:@scope/package
 *   npm:package@^1.0.0
 *   /absolute/path
 *   ./relative/path
 */
export function parseSource(source: string): ParsedSource {
  // npm
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    // Handle @scope/name@version or name@version
    let name: string;
    let ref: string | undefined;
    if (spec.startsWith("@")) {
      // Scoped: @scope/name@version
      const slashIdx = spec.indexOf("/");
      const rest = spec.slice(slashIdx + 1);
      const atIdx = rest.indexOf("@");
      if (atIdx > 0) {
        name = spec.slice(0, slashIdx + 1 + atIdx);
        ref = rest.slice(atIdx + 1);
      } else {
        name = spec;
      }
    } else {
      const atIdx = spec.indexOf("@");
      if (atIdx > 0) {
        name = spec.slice(0, atIdx);
        ref = spec.slice(atIdx + 1);
      } else {
        name = spec;
      }
    }
    // Derive a directory-safe name
    const dirName = name.replace(/^@/, "").replace(/\//g, "-");
    return { type: "npm", value: spec, name: dirName, ref };
  }

  // git
  if (source.startsWith("git:") || source.startsWith("https://") || source.startsWith("ssh://") || source.startsWith("http://")) {
    let url = source;
    if (url.startsWith("git:")) url = url.slice(4);

    // Extract ref (after @, but not in git@github.com)
    let ref: string | undefined;
    // For git@host:user/repo@ref format
    const lastAt = url.lastIndexOf("@");
    const colonIdx = url.indexOf(":");
    const slashAfterHost = url.indexOf("/", url.indexOf("//") >= 0 ? url.indexOf("//") + 2 : 0);

    if (lastAt > 0) {
      // Make sure the @ is after the repo path, not part of git@host
      const beforeAt = url.slice(0, lastAt);
      // If there's a slash or colon after a host, the @ is a ref separator
      if (beforeAt.includes("/") && lastAt > beforeAt.lastIndexOf("/")) {
        ref = url.slice(lastAt + 1);
        url = url.slice(0, lastAt);
      }
    }

    // Derive name from repo URL
    const name = extractRepoName(url);
    return { type: "git", value: url, name, ref };
  }

  // local path
  return { type: "local", value: source, name: "" };
}

function extractRepoName(url: string): string {
  // Handle various formats:
  // github.com/user/repo
  // git@github.com:user/repo
  // https://github.com/user/repo.git
  let clean = url
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  // git@github.com:user/repo → user/repo
  const colonMatch = clean.match(/:([^/]+\/[^/]+)$/);
  if (colonMatch) {
    return colonMatch[1].split("/").pop()!;
  }

  // Everything else: take last path segment
  const segments = clean.split("/").filter(Boolean);
  return segments[segments.length - 1] || "unknown";
}

// ============================================================================
// Git operations
// ============================================================================

import { execSync } from "child_process";

export function gitClone(url: string, targetDir: string, ref?: string): string {
  mkdirSync(dirname(targetDir), { recursive: true });

  // Build clone URL — add https:// if it looks like a shorthand
  let cloneUrl = url;
  if (!url.includes("://") && !url.includes("git@")) {
    cloneUrl = `https://${url}`;
  }

  execSync(`git clone --depth 1 ${ref ? `--branch ${ref}` : ""} ${cloneUrl} ${targetDir}`, {
    stdio: "pipe",
  });

  // Get current commit
  const commit = execSync("git rev-parse HEAD", { cwd: targetDir, encoding: "utf-8" }).trim();
  return commit;
}

export function gitFetchCheck(dir: string): boolean {
  try {
    execSync("git fetch --dry-run 2>&1", { cwd: dir, encoding: "utf-8", stdio: "pipe" });
    // Check if there are differences
    const local = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    const remote = execSync("git rev-parse @{u}", { cwd: dir, encoding: "utf-8", stdio: "pipe" }).trim();
    return local !== remote;
  } catch {
    // If fetch fails or no upstream, try another approach
    try {
      execSync("git remote update", { cwd: dir, stdio: "pipe" });
      const status = execSync("git status -uno", { cwd: dir, encoding: "utf-8" });
      return status.includes("behind");
    } catch {
      return false;
    }
  }
}

export function gitPull(dir: string): string {
  execSync("git pull", { cwd: dir, stdio: "pipe" });
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

export function gitPush(dir: string): void {
  execSync("git push", { cwd: dir, stdio: "pipe" });
}

export function gitGetCommit(dir: string): string {
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

/**
 * Returns how many commits local is ahead/behind the remote tracking branch.
 */
export function gitAheadBehind(dir: string): { ahead: number; behind: number } {
  try {
    execSync("git fetch", { cwd: dir, stdio: "pipe" });
    const result = execSync("git rev-list --left-right --count HEAD...@{u}", {
      cwd: dir, encoding: "utf-8", stdio: "pipe",
    }).trim();
    const [ahead, behind] = result.split("\t").map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function gitHasRemote(dir: string): boolean {
  try {
    const remotes = execSync("git remote", { cwd: dir, encoding: "utf-8", stdio: "pipe" }).trim();
    return remotes.length > 0;
  } catch {
    return false;
  }
}

/**
 * Re-copy a local source directory into the pool dir (excluding node_modules).
 */
export function recopyLocal(sourcePath: string, poolDir: string): void {
  const { cpSync, rmSync, mkdirSync } = require("fs");
  rmSync(poolDir, { recursive: true, force: true });
  mkdirSync(poolDir, { recursive: true });
  cpSync(sourcePath, poolDir, {
    recursive: true,
    filter: (src: string) => !src.includes("node_modules"),
  });
}

// ============================================================================
// npm operations
// ============================================================================

export function npmInstallPackage(spec: string, targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  // Install into target directory
  execSync(`npm pack ${spec} --pack-destination ${targetDir}`, { stdio: "pipe" });

  // Find and extract the tarball
  const { readdirSync } = require("fs");
  const tarballs = readdirSync(targetDir).filter((f: string) => f.endsWith(".tgz"));
  if (tarballs.length === 0) throw new Error(`npm pack produced no tarball for ${spec}`);

  const tarball = join(targetDir, tarballs[0]);
  execSync(`tar xzf ${tarball} --strip-components=1 -C ${targetDir}`, { stdio: "pipe" });
  execSync(`rm -f ${tarball}`, { stdio: "pipe" });

  // Run npm install for dependencies
  const pkgJsonPath = join(targetDir, "package.json");
  if (existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      execSync("npm install --production", { cwd: targetDir, stdio: "pipe" });
    }
    return pkg.version || "unknown";
  }
  return "unknown";
}

export function npmCheckUpdate(spec: string, currentVersion: string): boolean {
  try {
    // Get the base package name without version
    const name = spec.replace(/@[^@]*$/, "");
    const latest = execSync(`npm view ${name} version`, { encoding: "utf-8", stdio: "pipe" }).trim();
    return latest !== currentVersion;
  } catch {
    return false;
  }
}

// ============================================================================
// Dependency installation helper
// ============================================================================

export function installDependenciesIfNeeded(dir: string): void {
  const pkgJsonPath = join(dir, "package.json");
  if (!existsSync(pkgJsonPath)) return;

  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      const nodeModules = join(dir, "node_modules");
      if (!existsSync(nodeModules)) {
        execSync("npm install --production", { cwd: dir, stdio: "pipe" });
      }
    }
  } catch {}
}
